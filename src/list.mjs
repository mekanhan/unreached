/**
 * Enumerate tests by asking PLAYWRIGHT, not by parsing the source.
 *
 * The first draft of this file reimplemented `--grep`, `--grep-invert` and `--project`
 * against titles it scraped itself. It was wrong twice over on the first real repo:
 * it counted 185 cases where Playwright counts 249 (a `for (…) test(…)` loop is one
 * `test(` in the source and N tests at runtime), and a single
 * `test.describe.configure({ mode: 'serial' })` popped a describe off its stack and
 * orphaned nine tests from the tag that reaches them.
 *
 * Neither bug is fixable by a better regex, because the thing being modelled is a
 * program. So: run the real matcher with the real flags. `--list` executes no test and
 * launches no browser — it loads the config, collects the files and prints what WOULD
 * run. That is exactly the question.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

/** `[project] › dir/file.spec.ts:12:3 › describe › title` */
const LINE = /^\s*\[([^\]]+)\]\s+›\s+(\S+?\.spec\.[jt]s):(\d+):(\d+)\s+›\s+(.*)$/;

/**
 * @param {string} cwd    the playwright project root (where the config lives)
 * @param {string[]} args extra flags, exactly as CI passes them
 * @returns {Promise<{tests: Map<string,object>, raw: string, ok: boolean, error?: string}>}
 */
export async function listTests(cwd, args = []) {
    let stdout = '';
    try {
        ({ stdout } = await run('npx', ['playwright', 'test', '--list', '--reporter=list', ...args],
            { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 180_000 }));
    } catch (e) {
        // A filter that matches nothing exits non-zero with "no tests found". That is a
        // real, meaningful answer — an empty set — not a failure to answer.
        stdout = e.stdout ?? '';
        if (!/Total:|no tests found/i.test(stdout + (e.stderr ?? '')))
            return { tests: new Map(), raw: stdout, ok: false, error: (e.stderr || e.message || '').trim().split('\n')[0] };
    }

    return { ...parseListOutput(stdout), raw: stdout };
}

/**
 * Pure: `--list` stdout in, the collected set out. Split out from the process call so
 * it can be tested against recorded output without a browser or a repo.
 */
export function parseListOutput(stdout) {
    const tests = new Map();
    for (const line of stdout.split('\n')) {
        const m = LINE.exec(line);
        if (!m) continue;
        const [, project, file, ln, col, title] = m;
        // Key on the TITLE as well as the position. `for (const c of cases) test(...)`
        // emits every one of its tests at the same file:line:col, so a position-only key
        // silently collapses a 16-test loop into one entry — which is how this tool first
        // reported 206 tests where Playwright reports 249.
        // Project belongs in the key too: one file matched by two projects is two runs,
        // and a filter can reach it in one and miss it in the other.
        tests.set(`${project}|${file}:${ln}:${col}|${title}`, { project, file, line: +ln, title });
    }

    // Playwright prints its own count. If ours disagrees, the parse is lying and every
    // number downstream of it is worthless — say so rather than report the difference
    // as a finding.
    const claimed = /Total:\s*(\d+)\s+test/.exec(stdout);
    const reported = claimed ? +claimed[1] : null;
    if (reported !== null && reported !== tests.size)
        return {
            tests, ok: false,
            error: `parsed ${tests.size} tests but playwright reported ${reported} — the --list parse is incomplete`,
        };

    return { tests, ok: true, reported };
}
