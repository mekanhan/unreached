/**
 * Execute the README.
 *
 * The sibling tool shipped a README whose first command — `ca probe` — did not exist.
 * It survived a full rewrite, a review pass, a GitHub release, a Marketplace listing
 * and an npm publish, and landed on the npm front page. Nothing caught it because
 * nothing in any suite knew the README existed.
 *
 * This is the cheapest possible gate against that: read the fenced shell blocks, take
 * every line that invokes this binary, and check each flag against the REAL flag table
 * the binary uses. No network, no subprocess, no browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAGS, FLAG_NAMES, BIN } from '../src/cli-spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Every line inside a ```bash / ```sh fence. Comments stripped. */
function shellLines(md) {
    const out = [];
    for (const m of md.matchAll(/```(?:bash|sh|console|shell)\n([\s\S]*?)```/g))
        for (const raw of m[1].split('\n')) {
            const line = raw.replace(/\s+#.*$/, '').trim();
            if (line && !line.startsWith('#')) out.push(line);
        }
    return out;
}

/** The lines that invoke THIS binary — not `npm`, not `cd`, not `npx playwright`. */
const invocations = shellLines(README).filter(l =>
    new RegExp(`(^|[\\s/])${BIN}(\\s|$)`).test(l) && !l.startsWith('npm '));

test('UNR-040: the README actually invokes the binary somewhere', () => {
    // A README that documents nothing passes every check below vacuously. Refuse that.
    assert.ok(invocations.length >= 3,
        `expected the README to show at least 3 ${BIN} commands, found ${invocations.length}`);
});

test('UNR-041: every flag the README shows is one the binary reads', () => {
    const undocumented = [];
    for (const line of invocations)
        for (const m of line.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g))
            if (!FLAG_NAMES.includes(m[1])) undocumented.push({ line, flag: `--${m[1]}` });

    assert.deepEqual(undocumented, [],
        `the README shows flags the binary does not read:\n` +
        undocumented.map(u => `    ${u.flag}   in: ${u.line}`).join('\n'));
});

test('UNR-042: a flag that takes a VALUE is shown with one', () => {
    const bare = [];
    for (const line of invocations) {
        const argv = line.split(/\s+/);
        argv.forEach((a, i) => {
            const name = a.startsWith('--') && !a.includes('=') ? a.slice(2) : null;
            if (!name || !FLAGS[name]?.takesValue) return;
            const next = argv[i + 1];
            if (!next || next.startsWith('-')) bare.push(`${a} in: ${line}`);
        });
    }
    assert.deepEqual(bare, [], `these need a value:\n    ${bare.join('\n    ')}`);
});

test('UNR-043: CONTROL ARM — a README with a command that does not exist FAILS', () => {
    // The exact bug, reproduced. If this assertion ever stops holding, the check above
    // has been weakened into decoration.
    const broken = '```bash\nunreached --probe\nunreached --repo .\nunreached --json\n```';
    const found = [];
    for (const line of shellLines(broken))
        for (const m of line.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g))
            if (!FLAG_NAMES.includes(m[1])) found.push(`--${m[1]}`);

    assert.deepEqual(found, ['--probe'], 'the check must catch a flag that does not exist');

    // And the real README must be clean by the same code path — otherwise this test
    // proves only that the checker works on a string literal.
    assert.equal(invocations.some(l => /--probe\b/.test(l)), false);
});

test('UNR-044: every flag the binary reads is documented in the README', () => {
    // The other direction. An undocumented flag is not a crash, but it is a feature
    // nobody can find, which is the same as not shipping it.
    const shown = new Set(invocations.flatMap(l =>
        [...l.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)].map(m => m[1])));
    const missing = FLAG_NAMES.filter(f => f !== 'help' && !shown.has(f) && !README.includes(`\`--${f}\``));
    assert.deepEqual(missing, []);
});
