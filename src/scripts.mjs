/**
 * Resolve `npm run test:e2e` into the command it actually runs.
 *
 * FOUND BY RUNNING THIS AGAINST REPOSITORIES NOBODY HERE WROTE. Across 81 workflow files
 * from six public projects, the number of DIRECT `playwright test` invocations was ZERO.
 * Real repositories run their tests through a package script:
 *
 *     run: pnpm run test:e2e
 *     run: yarn test
 *     run: npm run test-extension
 *
 * Without this file the tool looks at those, finds no playwright invocation, and reports
 * that NOTHING runs your tests — a total false positive on almost every real repository.
 * It passed on auctionmate only because auctionmate happens to call playwright directly.
 *
 * That is the whole argument for testing a tool somewhere its author has never been.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** `npm run x` · `npm run x --workspace y` · `yarn x` · `yarn run x` · `pnpm x` · `pnpm run x` */
const RUNNER = /^\s*(?:npm|yarn|pnpm|bun)\s+(run\s+|run-script\s+)?([A-Za-z0-9:._-]+)/;

/** Things that are a package manager verb, not a script name. */
const NOT_A_SCRIPT = new Set([
    'install', 'i', 'ci', 'add', 'remove', 'up', 'update', 'exec', 'dlx', 'why',
    'publish', 'pack', 'link', 'audit', 'config', 'cache', 'init', 'create', 'set', 'get',
]);

function readScripts(dir) {
    const f = path.join(dir, 'package.json');
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')).scripts ?? {}; } catch { return null; }
}

/**
 * Expand a workflow command into every command it can reach through package scripts.
 * Returns the original plus any resolved bodies.
 *
 * @param {string} cmd   the `run:` line
 * @param {string} repo  repository root
 * @param {string} cwd   the step's working-directory, relative to repo
 */
export function expandScripts(cmd, repo, cwd = '') {
    const out = [cmd];
    const seen = new Set();

    const walk = (command, dir, depth) => {
        // A script that calls itself, or a pair that call each other, would loop forever.
        // Depth is capped as well, because a chain that long is not worth following.
        if (depth > 4) return;
        const m = RUNNER.exec(command);
        if (!m) return;
        const explicitRun = !!m[1];
        const name = m[2];
        // `npm ci` is a package-manager verb; `npm run ci` is a script called "ci".
        // The `run` keyword is what tells them apart, and without this check a script
        // named ci/test/start/build was silently skipped — which is most repos.
        if (!explicitRun && NOT_A_SCRIPT.has(name)) return;

        // `--workspace x` / `-w x` moves which package.json defines the script.
        const ws = /(?:--workspace[= ]|--filter[= ]|-w\s+)([^\s]+)/.exec(command)?.[1];
        const dirs = ws
            ? [path.join(repo, ws), path.join(repo, 'packages', ws), path.join(repo, 'apps', ws), dir]
            : [dir];

        for (const d of dirs) {
            const scripts = readScripts(d);
            const body = scripts?.[name];
            if (!body) continue;
            const key = `${d}|${name}`;
            if (seen.has(key)) return;
            seen.add(key);

            // A script body can chain: `tsc && playwright test`, `a; b`, `x || y`.
            for (const part of body.split(/&&|\|\||;/)) {
                const p = part.trim();
                if (!p) continue;
                out.push(p);
                walk(p, d, depth + 1);
            }
            return;
        }
    };

    walk(cmd, path.resolve(repo, cwd || '.'), 0);
    return out;
}
