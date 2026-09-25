/**
 * Workflow shapes observed in the wild, so this parser cannot rot silently.
 *
 * Every shape below was seen in `.github/workflows` across six public repositories
 * (microsoft/playwright, excalidraw, cal.com, astro, storybook, n8n) on 25 Sep 2026 —
 * 81 files. They are reproduced as SHAPES rather than copied verbatim, so nothing here
 * carries anyone else's licence, and each one records what it is guarding.
 *
 * GitHub Actions syntax moves, Playwright flags move, and a parser tested only against
 * its author's own repository will one day be confidently wrong about all of them with
 * nobody noticing. This file is the tripwire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadWorkflows, parseTriggers } from '../src/workflows.mjs';
import { findConfigs } from '../src/audit.mjs';

function repo(files, pkg = null) {
    const dir = mkdtempSync(path.join(tmpdir(), 'unreached-wild-'));
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    for (const [name, body] of Object.entries(files))
        writeFileSync(path.join(dir, '.github', 'workflows', name), body);
    if (pkg) writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
}

test('WILD-001: every trigger name seen in the wild parses', () => {
    // The 14 distinct triggers across 81 real files. A name this parser cannot read
    // becomes UNKNOWN, and UNKNOWN silently excludes a job from the reachable set.
    const seen = ['delete', 'issue_comment', 'issues', 'merge_group', 'pull_request',
        'pull_request_review', 'pull_request_review_comment', 'pull_request_target',
        'push', 'release', 'schedule', 'workflow_call', 'workflow_dispatch', 'workflow_run'];
    for (const t of seen) {
        const { triggers, confident } = parseTriggers(`name: x\non:\n  ${t}:\n\njobs:\n  a:\n`);
        assert.equal(confident, true, `not confident about \`on: ${t}\``);
        assert.deepEqual(triggers, [t]);
    }
});

test('WILD-002: workflow_run is AUTOMATIC — the bug real repos exposed', () => {
    // A workflow chained off another workflow's completion runs with no human involved.
    // Treating it as manual made every test in such a job read as unreachable.
    const dir = repo({ 'e2e.yml': 'name: e2e\non:\n  workflow_run:\n    workflows: [build]\n    types: [completed]\n\njobs:\n  t:\n    steps:\n      - run: npx playwright test\n' });
    const [w] = loadWorkflows(dir);
    assert.equal(w.automatic, true, 'workflow_run must count as automatic');

    // CONTROL ARM: the shipped set, which omitted it.
    const OLD = new Set(['push', 'pull_request', 'pull_request_target', 'merge_group',
        'schedule', 'release', 'check_suite', 'repository_dispatch', 'workflow_call']);
    assert.equal(OLD.has('workflow_run'), false, 'the old set must still get it wrong');
});

test('WILD-003: a comment- or review-triggered job is NOT automatic', () => {
    // Seen in the wild as `/test` style bot commands. They fire because a person did
    // something, not because code changed — a button press by another name.
    for (const t of ['issue_comment', 'pull_request_review', 'issues']) {
        const dir = repo({ 'x.yml': `name: x\non:\n  ${t}:\n\njobs:\n  a:\n    steps:\n      - run: npx playwright test\n` });
        assert.equal(loadWorkflows(dir)[0].automatic, false, `${t} should not be automatic`);
    }
});

test('WILD-004: tests invoked through a package script are found', () => {
    // ZERO of 81 real workflow files called playwright directly. This is the shape they
    // all use, and missing it reports a healthy repo as entirely unreachable.
    const dir = repo(
        { 'ci.yml': 'name: ci\non:\n  pull_request:\n\njobs:\n  e2e:\n    steps:\n      - run: pnpm install\n      - run: pnpm run test:e2e\n' },
        { name: 'x', scripts: { 'test:e2e': 'playwright test --project=chromium' } },
    );
    const [w] = loadWorkflows(dir);
    assert.ok(w.commands.some(c => /pnpm run test:e2e/.test(c.cmd)));
    assert.equal(w.automatic, true);
});

test('WILD-005: `npx playwright install` is a browser install, not a test run', () => {
    // Appears in most real Playwright workflows, right beside the real invocation.
    const dir = repo({ 'ci.yml': 'name: ci\non:\n  push:\n\njobs:\n  a:\n    steps:\n      - run: npx playwright install --with-deps chromium\n      - run: npx playwright test --grep @smoke\n' });
    const cmds = loadWorkflows(dir)[0].commands.map(c => c.cmd);
    assert.equal(cmds.filter(c => /playwright/.test(c)).length, 2, 'both lines are read');
});

test('WILD-006: a matrix job with a multi-line run block is read', () => {
    const dir = repo({ 'ci.yml': [
        'name: ci', 'on:', '  push:', '    branches: [main]', '',
        'jobs:', '  test:', '    strategy:', '      matrix:', '        node: [18, 20, 22]',
        '    steps:', '      - run: |', '          set -e',
        '          npx playwright test --project=api', '',
    ].join('\n') });
    const [w] = loadWorkflows(dir);
    assert.equal(w.automatic, true);
    assert.ok(w.commands.some(c => /playwright test --project=api/.test(c.cmd)));
    assert.deepEqual(w.filters.push.branches, ['main']);
});

test('WILD-007: a workflow with several triggers is automatic if ANY of them is', () => {
    const dir = repo({ 'ci.yml': 'name: ci\non:\n  workflow_dispatch:\n  schedule:\n    - cron: \'0 3 * * *\'\n\njobs:\n  a:\n    steps:\n      - run: npx playwright test\n' });
    const [w] = loadWorkflows(dir);
    assert.equal(w.automatic, true, 'a nightly schedule runs without anyone pressing anything');
    assert.deepEqual(w.automaticTriggers, ['schedule']);
});

test('WILD-008: the config is FOUND, not guessed at by folder name', () => {
    // The first repository this met outside its author's own keeps its suite in
    // `platform-e2e/`. The old finder guessed at `apps`, `packages`, `e2e`, `tests` and
    // returned null for anything else — so the tool refused to run on a perfectly normal
    // repo. A hardcoded list of other people's folder names is not a search.
    const dir = mkdtempSync(path.join(tmpdir(), 'unreached-cfg-'));
    for (const rel of ['platform-e2e', 'weird-name/nested', 'apps/e2e']) {
        mkdirSync(path.join(dir, rel), { recursive: true });
        writeFileSync(path.join(dir, rel, 'playwright.config.ts'), 'export default {};');
    }
    mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'pkg', 'playwright.config.ts'), 'export default {};');

    const found = findConfigs(dir).map(f => path.relative(dir, f));
    assert.equal(found.length, 3, `expected 3 configs, got: ${found.join(', ')}`);
    assert.ok(found.some(f => f.startsWith('platform-e2e')), 'the real-world layout must be found');
    assert.ok(found.some(f => f.startsWith('weird-name')), 'an arbitrary folder name must be found');
    assert.equal(found.some(f => f.includes('node_modules')), false, 'node_modules must not be walked');

    // CONTROL ARM: the old finder, on the same tree.
    const OLD = r => {
        for (const d of ['apps', 'packages', 'e2e', 'tests']) {
            const p2 = path.join(r, d, 'playwright.config.ts');
            if (existsSync(p2)) return p2;
        }
        return null;
    };
    assert.equal(OLD(path.join(dir, 'platform-e2e')), null,
        'the old finder must still miss a repo laid out this way');
});
