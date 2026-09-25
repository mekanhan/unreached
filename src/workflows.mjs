/**
 * Read `.github/workflows/*.yml` and answer, per workflow: does it run without a human?
 *
 * ── The rule this file exists to obey ────────────────────────────────────────────
 *
 * The consumer of this tool's output may DELETE a test. That makes the two errors
 * wildly unequal:
 *
 *   saying "never runs" about a test that runs   -> someone deletes live coverage
 *   saying "I cannot tell"  about a test that runs -> someone looks for 30 seconds
 *
 * So this parser must never turn "I found nothing" into "there is nothing". Anything it
 * cannot read with confidence is reported as UNCERTAIN, and uncertainty is carried all
 * the way to the verdict, where it blocks the claim "unreachable" rather than allowing it.
 *
 * ── Why it is hand-written, and what that costs ──────────────────────────────────
 *
 * No runtime dependencies. YAML, though, has block scalars, flow style, anchors, tags,
 * multiple documents and quoting — a line reader cannot be SOUND about it. The honest
 * resolution is not to pretend otherwise: this parser recognises a specific, common
 * subset, and says so out loud whenever it meets something outside it.
 *
 * Measured against js-yaml (a dev dependency, never shipped) over 81 workflow files from
 * six large public projects: agreement on 80. The one disagreement was `on:` followed by
 * a block sequence, which this file now handles — and which previously produced
 * "parsed fine, no triggers", i.e. silently wrong in the dangerous direction.
 * `test/oracle.test.mjs` keeps that comparison running.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Triggers that fire without a person.
 *
 * `workflow_run` belongs here — a workflow chained off another's completion is fully
 * automatic — and its absence previously made every test in such a job read as
 * unreachable.
 *
 * Deliberately excluded: `issue_comment`, `issues`, `pull_request_review`,
 * `pull_request_review_comment`, `delete`. Each fires because a person did something.
 * For this tool's question — is this test a gate on a code change — that is a button
 * press by another name.
 */
export const AUTOMATIC = new Set([
    'push', 'pull_request', 'pull_request_target', 'merge_group', 'workflow_run',
    'schedule', 'release', 'check_suite', 'check_run', 'repository_dispatch', 'workflow_call',
]);

const indentOf = line => line.length - line.trimStart().length;
const isBlank = line => !line.trim() || line.trim().startsWith('#');

/** Strip a trailing `# comment` that is not inside quotes. Cheap, and good enough here. */
const decomment = s => s.replace(/\s+#.*$/, '').trim();

/** `on:` · `"on":` · `'on':` — the key is a YAML 1.1 boolean, so quoting it is legitimate. */
const ON_KEY = /^(?:on|["']on["']|true)\s*:(.*)$/;

/**
 * The top-level `on:` block. Four spellings are legal and all four appear in the wild:
 *
 *   on: push                  scalar
 *   on: [push, pull_request]  flow sequence
 *   on:                       block MAPPING
 *     push:
 *   on:                       block SEQUENCE   <- this one was missing
 *     - pull_request_target
 *
 * @returns {{triggers: string[], filters: object, found: boolean, confident: boolean, why: string|null}}
 *   `found`     an `on:` key was located at all
 *   `confident` the triggers below it were read with confidence. FALSE means "I saw the
 *               block and could not read it" — which must never be reported as manual.
 */
export function parseTriggers(src) {
    const lines = src.split('\n');
    const i = lines.findIndex(l => indentOf(l) === 0 && ON_KEY.test(l.trim()));
    if (i === -1) return { triggers: [], filters: {}, found: false, confident: false, why: 'no top-level `on:` key' };

    const inline = decomment(ON_KEY.exec(lines[i].trim())[1] ?? '');

    if (inline.startsWith('[')) {
        const names = inline.replace(/^\[|\].*$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        return names.length
            ? { triggers: names, filters: {}, found: true, confident: true, why: null }
            : { triggers: [], filters: {}, found: true, confident: false, why: 'empty flow sequence after `on:`' };
    }
    if (inline) return { triggers: [inline.replace(/^['"]|['"]$/g, '')], filters: {}, found: true, confident: true, why: null };

    // Block form. Find the first non-blank child and take ITS indent as the child level,
    // rather than assuming two spaces — four-space files are equally legal YAML, and
    // assuming two made them parse to zero triggers and report as manual.
    let j = i + 1;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j >= lines.length || indentOf(lines[j]) === 0)
        return { triggers: [], filters: {}, found: true, confident: false, why: '`on:` has no readable children' };

    const childIndent = indentOf(lines[j]);
    const triggers = [];
    const filters = {};
    let current = null;
    let sawUnreadable = null;

    for (; j < lines.length; j++) {
        const line = lines[j];
        if (isBlank(line)) continue;
        const ind = indentOf(line);
        if (ind === 0) break;                       // left the block
        if (ind < childIndent) break;

        const body = line.trim();

        if (ind === childIndent) {
            // `- pull_request_target` — the block-sequence spelling.
            const seq = /^-\s*['"]?([A-Za-z_]+)['"]?\s*$/.exec(decomment(body));
            if (seq) { triggers.push(seq[1]); current = null; continue; }

            const key = /^['"]?([a-z_]+)['"]?\s*:/.exec(body)?.[1];
            if (key) { current = key; triggers.push(key); filters[key] = {}; continue; }

            // Something at trigger level we do not recognise. Record it — this is the
            // difference between "no triggers here" and "I could not read this".
            sawUnreadable ??= body.slice(0, 60);
            continue;
        }

        if (current) {
            const sub = /^([a-z-]+):\s*(.*)$/.exec(body);
            if (sub) {
                const vals = listValues(decomment(sub[2]), lines, j, ind);
                if (vals.length) (filters[current][sub[1]] ??= []).push(...vals);
            }
        }
    }

    if (!triggers.length)
        return { triggers: [], filters, found: true, confident: false,
                 why: sawUnreadable ? `unreadable entry under \`on:\`: ${sawUnreadable}` : '`on:` block yielded no triggers' };

    return { triggers, filters, found: true, confident: true, why: sawUnreadable ? `also saw an unreadable entry: ${sawUnreadable}` : null };
}

/** `[a, b]` inline, or a `- item` list on the following lines. */
function listValues(inline, lines, at, atIndent) {
    if (inline.startsWith('['))
        return inline.replace(/^\[|\].*$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (inline) return [inline.replace(/^['"]|['"]$/g, '')];

    const out = [];
    for (let j = at + 1; j < lines.length; j++) {
        if (isBlank(lines[j])) continue;
        if (indentOf(lines[j]) <= atIndent) break;
        const m = /^-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(decomment(lines[j].trim()));
        if (!m) break;
        out.push(m[1].trim());
    }
    return out;
}

/**
 * Every shell command the workflow runs, each with the `working-directory` of its step
 * and any `if:` guarding it.
 *
 * `if:` is NOT evaluated — it cannot be, without the event context. It is RECORDED, so
 * that a command behind a condition can never contribute to the claim "this test is
 * covered". 152 conditions appear across 54 of 81 real workflow files; ignoring them
 * silently is how a conditional job gets counted as always running.
 */
export function parseRunCommands(src) {
    const lines = src.split('\n');
    const out = [];
    let cwd = '', stepIf = null, stepIndent = null;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) { i++; continue; }
        const ind = indentOf(line);
        const body = line.trim();

        // A new list item at or above the current step's indent starts a new step.
        if (/^-\s/.test(body) && (stepIndent === null || ind <= stepIndent)) {
            stepIndent = ind; cwd = ''; stepIf = null;
        }

        const wd = /^-?\s*working-directory:\s*['"]?([^'"#\s]+)/.exec(body);
        if (wd) { cwd = wd[1]; i++; continue; }

        const cond = /^-?\s*if:\s*(.+)$/.exec(body);
        if (cond) { stepIf = decomment(cond[1]) || '(multiline)'; i++; continue; }

        const run = /^(\s*)-?\s*run:\s*(.*)$/.exec(line);
        if (!run) { i++; continue; }

        const rest = run[2].trim();
        if (rest && !['|', '>', '|-', '>-', '|+', '>+'].includes(rest)) {
            out.push({ cmd: rest, cwd, if: stepIf });
            i++; continue;
        }

        // Block scalar. Consume its body HERE and advance past it, so its lines are never
        // re-scanned as YAML — a bash list inside a `run: |` was previously read as a new
        // step and reset the working directory for everything after it.
        const base = run[1].length;
        let j = i + 1;
        for (; j < lines.length; j++) {
            if (!lines[j].trim()) continue;
            if (indentOf(lines[j]) <= base) break;
            out.push({ cmd: lines[j].trim(), cwd, if: stepIf });
        }
        i = j;
    }
    return out;
}

export function loadWorkflows(repo) {
    const dir = path.join(repo, '.github', 'workflows');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter(f => /\.ya?ml$/.test(f))
        .map(f => {
            const src = readFileSync(path.join(dir, f), 'utf8');
            const t = parseTriggers(src);
            const automaticTriggers = t.triggers.filter(x => AUTOMATIC.has(x));

            // THREE values, never two. `null` is not "probably manual" — it is a refusal
            // to answer, and downstream it blocks the unreachable claim rather than
            // supporting it.
            const automatic = !t.confident ? null : automaticTriggers.length > 0;

            return {
                file: `.github/workflows/${f}`,
                triggers: t.triggers,
                filters: t.filters,
                automatic,
                automaticTriggers,
                confident: t.confident,
                why: t.why,
                commands: parseRunCommands(src),
            };
        });
}
