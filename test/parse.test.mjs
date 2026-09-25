/**
 * Every test here is paired with a CONTROL ARM: the broken implementation, executed on
 * the same input, asserted to still get the answer wrong. A test that passes on both
 * the fix and the bug proves nothing, and this tool exists to say so about other
 * people's suites.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTriggers, parseRunCommands } from '../src/workflows.mjs';
import { parseInvocation, argvOf } from '../src/reach.mjs';

// ───────────────────────────── triggers ─────────────────────────────

test('UNR-001: a workflow_dispatch-only workflow is NOT automatic', () => {
    const { triggers } = parseTriggers('name: e2e\non:\n  workflow_dispatch:\n\njobs:\n  a:\n');
    assert.deepEqual(triggers, ['workflow_dispatch']);
});

test('UNR-002: pull_request and merge_group are both automatic', () => {
    const src = 'on:\n  pull_request:\n    branches: [develop, main]\n  merge_group:\n  workflow_dispatch:\n\njobs:\n';
    const { triggers, filters } = parseTriggers(src);
    assert.deepEqual(triggers, ['pull_request', 'merge_group', 'workflow_dispatch']);
    assert.deepEqual(filters.pull_request.branches, ['develop', 'main']);
});

test('UNR-003: the inline spellings parse too', () => {
    assert.deepEqual(parseTriggers('on: push\n').triggers, ['push']);
    assert.deepEqual(parseTriggers('on: [push, pull_request]\n').triggers, ['push', 'pull_request']);
});

test('UNR-004: a paths: filter is captured, because it narrows when the job runs', () => {
    const src = [
        'on:', '  pull_request:', '    paths:',
        "      - 'server/**'", "      - 'apps/e2e/**'", '', 'jobs:',
    ].join('\n');
    assert.deepEqual(parseTriggers(src).filters.pull_request.paths, ['server/**', 'apps/e2e/**']);
});

test('UNR-005: an `on:` block we cannot read reports UNKNOWN, never automatic', () => {
    // No `on:` at all — a composite action, a fragment, something unexpected.
    const a = parseTriggers('runs:\n  using: composite\n');
    assert.equal(a.found, false);
    assert.equal(a.confident, false);
    assert.deepEqual(a.triggers, []);

    // And the case that matters more: an `on:` block that IS there and cannot be read.
    // "I found nothing" must never become "there is nothing", because downstream that
    // becomes "manual only", which becomes "these tests are dead".
    const b = parseTriggers('on:\n  {{ templated }}\n\njobs:\n');
    assert.equal(b.found, true, 'the block is there');
    assert.equal(b.confident, false, 'and it could not be read');
    assert.ok(b.why, 'the reason must be stated, not implied');
});

// ──────────────────────── run: and working-directory ────────────────────────

test('UNR-006: a run command carries the working-directory of ITS step', () => {
    const src = [
        'jobs:', '  a:', '    steps:',
        '      - name: install', '        run: npm ci',
        '      - name: specs', '        working-directory: apps/e2e',
        '        run: npx playwright test tests/smoke/x.spec.ts',
        '      - name: after', '        run: echo done',
    ].join('\n');
    const cmds = parseRunCommands(src);
    assert.deepEqual(cmds.find(c => c.cmd.includes('playwright')).cwd, 'apps/e2e');

    // CONTROL ARM: the first version had no step boundary, so working-directory leaked
    // forward to every later step. Reproduce that and show it gets `echo done` wrong.
    let leaked = '';
    const naive = src.split('\n').map(l => {
        const wd = l.trim().match(/^working-directory:\s*(\S+)/);
        if (wd) { leaked = wd[1]; return null; }
        const r = l.match(/run:\s*(.*)$/);
        return r ? { cmd: r[1], cwd: leaked } : null;
    }).filter(Boolean);
    assert.equal(naive.find(c => c.cmd === 'echo done').cwd, 'apps/e2e');   // wrong
    assert.equal(cmds.find(c => c.cmd === 'echo done').cwd, '');            // right
});

test('UNR-007: `run: |` block scalars are read, not skipped', () => {
    const src = [
        'jobs:', '  a:', '    steps:', '      - run: |',
        '          set -e', '          npx playwright test --project=api',
    ].join('\n');
    assert.ok(parseRunCommands(src).some(c => c.cmd.includes('playwright')));
});

// ───────────────────────────── invocations ─────────────────────────────

test('UNR-008: quoted regex arguments survive argv splitting', () => {
    assert.deepEqual(
        argvOf('npx playwright test --grep-invert "@api|@admin"'),
        ['npx', 'playwright', 'test', '--grep-invert', '@api|@admin']);
});

test('UNR-009: project, grep and grep-invert are all extracted', () => {
    const inv = parseInvocation('npx playwright test --project=api --grep @contract --grep-invert "@api|@admin"');
    assert.deepEqual(inv.projects, ['api']);
    assert.deepEqual(inv.grep, ['@contract']);
    assert.deepEqual(inv.grepInvert, ['@api|@admin']);
    assert.deepEqual(inv.paths, []);
});

test('UNR-010: a flag that takes a VALUE does not leave its value looking like a path', () => {
    const inv = parseInvocation('npx playwright test --project=api tests/smoke/x.spec.ts --reporter=list');
    assert.deepEqual(inv.paths, ['tests/smoke/x.spec.ts']);

    // CONTROL ARM: with `--reporter` treated as a boolean, `list` becomes a positional
    // and the run looks restricted to a file named "list" — which collects nothing and
    // would report the whole suite as unreachable.
    const naive = 'npx playwright test --project=api tests/smoke/x.spec.ts --reporter list'
        .split(' ').slice(3).filter(a => !a.startsWith('-'));
    assert.deepEqual(naive, ['tests/smoke/x.spec.ts', 'list']);
    assert.equal(parseInvocation('npx playwright test tests/smoke/x.spec.ts --reporter list').paths.length, 1);
});

test('UNR-011: an unmodelled flag is recorded, so the count can be called a ceiling', () => {
    const inv = parseInvocation('npx playwright test --project=api --last-failed');
    assert.deepEqual(inv.unknownFlags, ['--last-failed']);
});

test('UNR-012: a command that is not a playwright run returns null', () => {
    assert.equal(parseInvocation('npm ci'), null);
    assert.equal(parseInvocation('echo "playwright test"'), null, 'a mention in a string is not a run');
});
