/**
 * Turn a shell command from a workflow into the filters it passes to Playwright.
 *
 * Only the flags that change WHICH tests are collected are kept. `--reporter`,
 * `--workers`, `--retries` and friends change how a run behaves, not what it contains,
 * and passing them through to `--list` would be noise at best.
 */

/** Split a shell command into argv, respecting quotes. No shell, no substitution. */
export function argvOf(cmd) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}

/** Flags that take a value but do not affect which tests are collected. */
const VALUED_IGNORED = new Set([
    'reporter', 'workers', 'timeout', 'output', 'config', 'retries',
    'repeat-each', 'max-failures', 'shard', 'trace', 'update-snapshots',
]);
/** Boolean flags that do not affect which tests are collected. */
const BOOLEAN_IGNORED = new Set([
    'list', 'headed', 'ui', 'debug', 'quiet', 'forbid-only', 'fully-parallel',
    'pass-with-no-tests', 'ignore-snapshots', 'x',
]);

/**
 * Recognise `playwright test …` anywhere in a command. Returns null if it is not one.
 *
 * `--shard` is deliberately treated as ignorable: a sharded run splits the same
 * collected set across machines, so for reachability the union is the whole set. If a
 * repo ran only shard 1 of 3 that would be a real gap, but it would also be visible as
 * a missing job, and assuming otherwise would report two thirds of a healthy suite as
 * dead.
 */
export function parseInvocation(cmd) {
    if (!/\bplaywright\s+test\b/.test(cmd)) return null;
    const argv = argvOf(cmd);
    const at = argv.findIndex((a, i) => /playwright$/.test(a) && argv[i + 1] === 'test');
    if (at === -1) return null;
    const rest = argv.slice(at + 2);

    const inv = { projects: [], grep: [], grepInvert: [], paths: [], cmd, unknownFlags: [] };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith('-')) { inv.paths.push(a); continue; }
        const eq = a.indexOf('=');
        const name = eq === -1 ? a.replace(/^--?/, '') : a.slice(a.startsWith('--') ? 2 : 1, eq);
        const inlineVal = eq === -1 ? null : a.slice(eq + 1);
        const take = () => inlineVal ?? rest[++i];

        if (name === 'project') inv.projects.push(take());
        else if (name === 'grep' || name === 'g') inv.grep.push(take());
        else if (name === 'grep-invert') inv.grepInvert.push(take());
        else if (VALUED_IGNORED.has(name)) take();
        else if (BOOLEAN_IGNORED.has(name)) { /* nothing */ }
        // An unrecognised flag could narrow the run in a way we cannot model. Record it
        // so the report can flag the invocation as approximate rather than quietly
        // treating its result as exact.
        else inv.unknownFlags.push(a);
    }
    return inv;
}
