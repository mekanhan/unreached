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
import { commentOnlyTags, liveTagIndex } from './comment-tags.mjs';

const CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'];

/** Best-effort `testDir` from the config text. Only used to resolve a path, never a verdict. */
function readTestDir(configPath) {
    try {
        const src = readFileSync(configPath, 'utf8');
        return src.match(/testDir:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? '.';
    } catch { return '.'; }
}

export function findConfig(repo) {
    const dirs = [repo];
    for (const d of ['apps', 'packages', 'e2e', 'tests']) {
        const p = path.join(repo, d);
        if (!existsSync(p)) continue;
        dirs.push(p, ...readdirSync(p, { withFileTypes: true })
            .filter(e => e.isDirectory()).map(e => path.join(p, e.name)));
    }
    for (const dir of dirs) for (const n of CONFIGS) {
        const p = path.join(dir, n);
        if (existsSync(p)) return p;
    }
    return null;
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
    const configPath = findConfig(repo);
    if (!configPath) return { error: `no playwright.config.* found under ${repo}` };
    const projectRoot = path.dirname(configPath);

    onStep('collecting every test');
    const all = await listTests(projectRoot, []);
    if (!all.ok) return { error: `playwright --list failed: ${all.error}` };

    const workflows = loadWorkflows(repo);
    const invocations = [];
    for (const wf of workflows) {
        // A workflow rarely calls playwright directly — it calls a package script that
        // does. Expand the script before looking, or the tool reports that nothing runs
        // your tests on almost every real repository.
        const expanded = wf.commands.flatMap(({ cmd, cwd }) =>
            expandScripts(cmd, repo, cwd).map(c => ({ cmd: c, cwd })));
        for (const { cmd, cwd } of expanded) {
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
                pathFilters: wf.filters?.pull_request?.paths ?? wf.filters?.push?.paths ?? null,
            });
        }
    }

    const reached = new Set();
    for (const inv of invocations) {
        if (inv.automatic !== true) continue;
        onStep(`resolving ${inv.workflow}`);
        const r = await listTests(projectRoot, filterArgs(inv));
        inv.ok = r.ok;
        inv.error = r.error;
        inv.count = r.tests.size;
        for (const k of r.tests.keys()) reached.add(k);
    }

    const dead = [...all.tests].filter(([k]) => !reached.has(k)).map(([, v]) => v);

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
        reached: reached.size,
        dead,
        nearMisses,
        ciTags,
        invocations,
        workflows,
    };
}
