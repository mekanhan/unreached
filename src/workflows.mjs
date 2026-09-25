/**
 * Read .github/workflows/*.yml and answer one question per workflow:
 * does it run WITHOUT a human pressing a button?
 *
 * No YAML dependency — this family of tools ships zero dependencies, and a workflow
 * file is regular enough to read line-wise. What it must never do is guess: anything
 * it cannot parse is reported as UNKNOWN and excluded, never assumed automatic.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Triggers that fire on their own. `workflow_dispatch` is a human; it does not count.
 *
 * `workflow_run` was MISSING here until this parser met real repositories. A workflow
 * chained off another workflow's completion is fully automatic, and leaving it out made
 * every test in such a job read as unreachable — a false positive, which is the worst
 * output a diagnostic can produce.
 *
 * Deliberately NOT automatic: `issue_comment`, `issues`, `pull_request_review`,
 * `pull_request_review_comment`, `delete`. All were seen in the wild, and all fire
 * because a person did something, not because code changed. For the question this tool
 * asks — does CI run this test as a gate on a change — that is a human pressing a button
 * by another name.
 */
const AUTOMATIC = new Set([
    'push', 'pull_request', 'pull_request_target', 'merge_group', 'workflow_run',
    'schedule', 'release', 'check_suite', 'repository_dispatch', 'workflow_call',
]);

const indentOf = line => line.length - line.trimStart().length;

/**
 * The top-level `on:` block. Handles all three YAML spellings:
 *   on: push
 *   on: [push, pull_request]
 *   on:
 *     push:
 *       branches: [main]
 */
export function parseTriggers(src) {
    const lines = src.split('\n');
    const i = lines.findIndex(l => /^on:/.test(l));
    if (i === -1) return { triggers: [], filters: {}, parsed: false };

    const inline = lines[i].slice(3).trim();
    if (inline && !inline.startsWith('#')) {
        const names = inline.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
        return { triggers: names, filters: {}, parsed: true };
    }

    const triggers = [];
    const filters = {};
    let current = null;
    for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const ind = indentOf(line);
        if (ind === 0) break;                              // left the `on:` block
        const key = line.trim().match(/^([a-z_]+):/)?.[1];
        if (ind === 2 && key) { current = key; triggers.push(key); filters[key] = {}; continue; }
        // One level deeper: `branches:`, `paths:`, `cron:` belonging to `current`.
        if (ind >= 4 && current) {
            const sub = line.trim().match(/^([a-z-]+):\s*(.*)$/);
            if (sub) (filters[current][sub[1]] ||= []).push(...listValues(sub[2], lines, j));
            const item = line.trim().match(/^-\s*'?([^'#]+)'?/);
            if (item && !sub) filters[current]._items = (filters[current]._items || []).concat(item[1].trim());
        }
    }
    return { triggers, filters, parsed: true };
}

/** `[a, b]` inline, or a `- item` list on the following lines. */
function listValues(inline, lines, at) {
    if (inline && inline.startsWith('[')) {
        return inline.replace(/^\[|\].*$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    const out = [];
    const base = indentOf(lines[at]);
    for (let j = at + 1; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim() || l.trim().startsWith('#')) continue;
        if (indentOf(l) <= base) break;
        const m = l.trim().match(/^-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
        if (!m) break;
        out.push(m[1].trim());
    }
    return out;
}

/**
 * Every shell command a workflow runs, each paired with the `working-directory` of the
 * step that runs it. The cwd is not cosmetic: `npx playwright test tests/smoke/x.spec.ts`
 * under `working-directory: apps/e2e` names a different file than the same string at the
 * repo root, and resolving it wrong turns a reached test into a finding.
 *
 * Covers `run: cmd` and `run: |` block scalars.
 */
export function parseRunCommands(src) {
    const lines = src.split('\n');
    const out = [];
    let cwd = '';
    let stepIndent = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const ind = indentOf(line);

        // A new list item at or above the current step's indent starts a new step,
        // and `working-directory` does not carry across steps.
        if (/^\s*-\s/.test(line) && (stepIndent === null || ind <= stepIndent)) {
            stepIndent = ind; cwd = '';
        }
        const wd = line.trim().match(/^working-directory:\s*['"]?([^'"#\s]+)/);
        if (wd) { cwd = wd[1]; continue; }

        const m = line.match(/^(\s*)-?\s*run:\s*(.*)$/);
        if (!m) continue;
        const [, indent, rest] = m;
        if (rest && !['|', '>', '|-', '>-', '|+', '>+'].includes(rest.trim())) {
            out.push({ cmd: rest, cwd });
            continue;
        }
        const base = indent.length;
        for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].trim()) continue;
            if (indentOf(lines[j]) <= base) break;
            out.push({ cmd: lines[j].trim(), cwd });
        }
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
            const { triggers, filters, parsed } = parseTriggers(src);
            const automatic = triggers.filter(t => AUTOMATIC.has(t));
            return {
                file: `.github/workflows/${f}`,
                triggers,
                filters,
                // UNKNOWN, not false: an unparsed `on:` block must not silently
                // turn every test it runs into a finding.
                automatic: parsed ? automatic.length > 0 : null,
                automaticTriggers: automatic,
                commands: parseRunCommands(src),
            };
        });
}
