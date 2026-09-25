/**
 * The whole question, in one pass:
 *
 *   everything Playwright would collect
 *   MINUS the union of what each AUTOMATIC workflow invocation collects
 *   = the tests no CI run can reach.
 *
 * Both sides come from the same binary, so there is no model of Playwright here that
 * can drift from Playwright.
 */

import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadWorkflows } from './workflows.mjs';
import { parseInvocation } from './reach.mjs';
import { expandScripts } from './scripts.mjs';
import { listTests } from './list.mjs';
import { classifyUncertainty, verdictFor, REACHED, UNREACHABLE, UNPROVEN } from './verdict.mjs';
import { commentOnlyTags, liveTagIndex } from './comment-tags.mjs';

const CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'];

/** Best-effort `testDir` from the config text. Only used to resolve a path, never a verdict. */
function readTestDir(configPath) {
    try {
        const src = readFileSync(configPath, 'utf8');
        return src.match(/testDir:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? '.';
    } catch { return '.'; }
}

/** Directories that never hold a project's own config, and are expensive to walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage',
    '.next', '.turbo', '.cache', 'vendor', 'target', '.venv', '__pycache__']);

/**
 * Find EVERY playwright config in the tree.
 *
 * This used to guess at directory names — `apps`, `packages`, `e2e`, `tests` — and
 * returned null for anything else. The first repository it met outside its author's own
 * keeps its suite in `platform-e2e/`, so the tool simply refused to run. A hardcoded list
 * of other people's folder names is not a search.
 *
 * Returning ALL of them matters as much as finding one: in a monorepo, a config this tool
 * did not analyse can select tests it is about to call unreachable. Those become blockers
 * rather than being silently ignored.
 */
export function findConfigs(repo, maxDepth = 4) {
    const found = [];
    const walk = (dir, depth) => {
        if (depth > maxDepth) return;
        let entries = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isFile() && CONFIGS.includes(e.name)) found.push(path.join(dir, e.name));
            else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
                walk(path.join(dir, e.name), depth + 1);
        }
    };
    walk(repo, 0);
    // Shallowest first, so the root-level config of a normal repo is the one chosen.
    return found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
}

/** Backwards-compatible single answer. */
export function findConfig(repo) {
    return findConfigs(repo)[0] ?? null;
}

/** Rebuild the flag list CI passes, dropping only what cannot affect WHICH tests run. */
export function filterArgs(inv) {
    const args = [];
    for (const p of inv.projects) args.push(`--project=${p}`);
    for (const g of inv.grep) args.push('--grep', g);
    for (const g of inv.grepInvert) args.push('--grep-invert', g);
    args.push(...inv.paths);
    return args;
}

export async function audit(repo, { onStep = () => {} } = {}) {
    const configs = findConfigs(repo);
    if (!configs.length) return { error: `no playwright.config.* found under ${repo}` };
    const configPath = configs[0];
    const projectRoot = path.dirname(configPath);
    // A config we did not analyse may select tests we are about to call unreachable.
    const otherConfigs = configs.slice(1);

    onStep('collecting every test');
    const all = await listTests(projectRoot, []);
    if (!all.ok) return { error: `playwright --list failed: ${all.error}` };

    const workflows = loadWorkflows(repo);
    const invocations = [];
    for (const wf of workflows) {
        // A workflow rarely calls playwright directly — it calls a package script that
        // does. Expand the script before looking, or the tool reports that nothing runs
        // your tests on almost every real repository.
        const expanded = wf.commands.flatMap(({ cmd, cwd, if: stepIf }) =>
            expandScripts(cmd, repo, cwd).map(c => ({ cmd: c, cwd, if: stepIf })));
        for (const { cmd, cwd, if: cmdIf } of expanded) {
            const inv = parseInvocation(cmd);
            if (!inv) continue;
            // An explicit path on the command line is written relative to the step's
            // working-directory, which is usually the playwright root but need not be.
            const stepDir = path.resolve(repo, cwd || '.');
            const rebased = inv.paths.map(p =>
                path.relative(projectRoot, path.resolve(stepDir, p)));
            invocations.push({
                ...inv, paths: rebased, workflow: wf.file,
                automatic: wf.automatic, triggers: wf.automaticTriggers,
                confident: wf.confident, why: wf.why,
                // A step-level `if:` and a trigger-level `paths:` both mean "might not
                // run". They are carried, never evaluated — evaluating them needs the
                // event context, which does not exist outside an actual run.
                if: cmdIf ?? null,
                pathFilters: wf.filters?.pull_request?.paths ?? wf.filters?.push?.paths ?? null,
            });
        }
    }

    // Two sets, not one. A test selected only by a CONDITIONAL job is not covered and is
    // not dead — collapsing them into one "reached" set is what lets a conditional job
    // masquerade as coverage.
    const byUnconditional = new Set();
    const byConditional = new Set();

    for (const inv of invocations) {
        if (inv.automatic !== true) continue;
        onStep(`resolving ${inv.workflow}`);
        const r = await listTests(projectRoot, filterArgs(inv));
        inv.ok = r.ok;
        inv.error = r.error;
        inv.count = r.tests.size;
        const target = (inv.if || inv.pathFilters?.length) ? byConditional : byUnconditional;
        for (const k of r.tests.keys()) target.add(k);
    }

    const { blocksUnreachable, conditional } = classifyUncertainty(invocations, workflows);
    for (const c of otherConfigs)
        blocksUnreachable.push({
            what: path.relative(repo, c),
            why: 'a second playwright config this run did not analyse — it may select tests listed below',
        });
    const anyBlocker = blocksUnreachable.length > 0;

    const verdicts = [...all.tests].map(([k, t]) => ({
        ...t,
        ...verdictFor({
            selectedByUnconditional: byUnconditional.has(k),
            selectedByConditional: byConditional.has(k),
            anyBlocker,
        }),
    }));

    const reachedTests = verdicts.filter(v => v.verdict === REACHED);
    const unreachable = verdicts.filter(v => v.verdict === UNREACHABLE);
    const unproven = verdicts.filter(v => v.verdict === UNPROVEN);

    // Kept for the report and the older callers. `dead` now means PROVEN unreachable —
    // never "we did not find a run for it".
    const dead = unreachable;
    const reached = byUnconditional;

    // The near miss: a tag CI greps for, written in a comment instead of a title.
    const ciTags = [...new Set(invocations
        .filter(i => i.automatic === true)
        .flatMap(i => [...i.grep, ...i.grepInvert])
        .flatMap(g => g.match(/@[\w-]+/g) ?? []))];
    // `--list` prints paths relative to testDir, not to the config's directory. Rather
    // than parse testDir out of a config that may compute it, try both and keep the one
    // that is a real file.
    // ONE resolver, used by both sides. When the file list and the tag index resolved
    // the same path two different ways, nothing matched and every tagged file looked
    // tagged-only-in-a-comment.
    const testDir = readTestDir(configPath);
    const resolveSpec = f => {
        const direct = path.resolve(projectRoot, f);
        return existsSync(direct) ? direct : path.resolve(projectRoot, testDir, f);
    };
    const files = [...new Set([...all.tests.values()].map(t => resolveSpec(t.file)))];
    const nearMisses = commentOnlyTags(files, liveTagIndex(all.tests, resolveSpec), ciTags, repo);

    return {
        repo, configPath, projectRoot,
        total: all.tests.size,
        reached: reachedTests.length,
        verdicts, unreachable, unproven,
        blocksUnreachable, conditional,
        dead,
        nearMisses,
        ciTags,
        invocations,
        workflows,
    };
}
