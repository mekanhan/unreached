/**
 * Package-script expansion — the bug that only appeared outside this author's repos.
 *
 * Across 81 workflow files from six public projects, DIRECT `playwright test` calls: zero.
 * Every one went through `pnpm run test:e2e` or similar. Without expansion the tool reports
 * that nothing runs your tests, on almost every real repository, with total confidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expandScripts } from '../src/scripts.mjs';
import { parseInvocation } from '../src/reach.mjs';

function repoWith(scripts, extra = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'unreached-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
    for (const [rel, pkg] of Object.entries(extra)) {
        mkdirSync(path.join(dir, rel), { recursive: true });
        writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify(pkg));
    }
    return dir;
}

test('UNR-050: `pnpm run test:e2e` resolves to the playwright call behind it', () => {
    const repo = repoWith({ 'test:e2e': 'playwright test --project=chromium' });
    const out = expandScripts('pnpm run test:e2e', repo);
    assert.ok(out.some(c => parseInvocation(c)), 'the playwright call must be found');
    assert.deepEqual(parseInvocation(out.find(c => parseInvocation(c))).projects, ['chromium']);

    // CONTROL ARM — the shipped behaviour. Looking only at the workflow line finds
    // nothing, and "nothing runs these tests" is then reported with total confidence.
    assert.equal(parseInvocation('pnpm run test:e2e'), null,
        'the old path must still see no playwright invocation');
});

test('UNR-051: every package manager spelling resolves', () => {
    const repo = repoWith({ e2e: 'playwright test' });
    for (const cmd of ['npm run e2e', 'yarn e2e', 'yarn run e2e', 'pnpm e2e', 'pnpm run e2e', 'bun run e2e'])
        assert.ok(expandScripts(cmd, repo).some(c => parseInvocation(c)), `failed for: ${cmd}`);
});

test('UNR-052: a chained script body is split, not swallowed', () => {
    // `tsc && playwright test` is one script and two commands.
    const repo = repoWith({ ci: 'tsc --noEmit && playwright test --grep @smoke' });
    const inv = expandScripts('npm run ci', repo).map(parseInvocation).find(Boolean);
    assert.ok(inv);
    assert.deepEqual(inv.grep, ['@smoke']);
});

test('UNR-053: a script that calls another script is followed', () => {
    const repo = repoWith({ test: 'npm run test:e2e', 'test:e2e': 'playwright test --project=api' });
    const inv = expandScripts('npm run test', repo).map(parseInvocation).find(Boolean);
    assert.deepEqual(inv.projects, ['api']);
});

test('UNR-054: a script that calls itself terminates', () => {
    // A cycle must not hang the tool. This is the check that turns a clever feature
    // into one that can be left running unattended.
    const repo = repoWith({ loop: 'npm run loop' });
    assert.doesNotThrow(() => expandScripts('npm run loop', repo));
    const repo2 = repoWith({ a: 'npm run b', b: 'npm run a' });
    assert.doesNotThrow(() => expandScripts('npm run a', repo2));
});

test('UNR-055: `npm install` is not treated as a script called "install"', () => {
    const repo = repoWith({ install: 'playwright test' });   // pathological but legal
    const out = expandScripts('npm install', repo);
    assert.deepEqual(out, ['npm install'], 'a package-manager verb must not be expanded');
});

test('UNR-056: --workspace moves which package.json defines the script', () => {
    const repo = repoWith(
        { e2e: 'echo root' },
        { 'apps/e2e': { name: 'e2e', scripts: { e2e: 'playwright test --project=ui' } } },
    );
    const inv = expandScripts('npm run e2e --workspace apps/e2e', repo).map(parseInvocation).find(Boolean);
    assert.ok(inv, 'the workspace package.json should have been read');
    assert.deepEqual(inv.projects, ['ui']);
});

test('UNR-057: a command with no script behind it is returned unchanged', () => {
    const repo = repoWith({ build: 'tsc' });
    assert.deepEqual(expandScripts('npx playwright test', repo), ['npx playwright test']);
    assert.deepEqual(expandScripts('echo hello', repo), ['echo hello']);
});

test('UNR-058: `npx playwright install` is never mistaken for a test run', () => {
    // Seen twice in the wild. It installs browsers; it runs no test.
    assert.equal(parseInvocation('npx playwright install --with-deps chromium'), null);
    assert.equal(parseInvocation('npx playwright install --with-deps'), null);
});
