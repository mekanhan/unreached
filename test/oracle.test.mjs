/**
 * The hand parser, checked against a REAL YAML parser.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────
 *
 * The parser was once validated by running it over 81 real workflow files and observing
 * that none of them failed to parse. That measured DID-NOT-CRASH, not DID-IT-AGREE — and
 * one of those 81 was read incorrectly while reporting success. `on:` followed by a block
 * sequence yielded "parsed fine, no triggers", which downstream became "manual only",
 * which becomes "these tests are dead". Silent, confident, and in the dangerous direction.
 *
 * File coverage is not semantic coverage. So the health metric is now agreement with an
 * implementation that actually implements YAML.
 *
 * js-yaml is a DEV dependency. It is never shipped, never imported by `src/`, and never
 * appears in the published tarball — the zero-runtime-dependency promise is intact. Using
 * it as an oracle is the opposite of depending on it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseTriggers, AUTOMATIC } from '../src/workflows.mjs';

const require = createRequire(import.meta.url);
let yaml = null;
try { yaml = require('js-yaml'); } catch { /* dev dependency absent */ }

/** What a real YAML parser says the triggers are. `on` is a YAML 1.1 boolean → key `true`. */
function truth(src) {
    const doc = yaml.load(src);
    if (!doc || typeof doc !== 'object') return null;
    const on = doc.on ?? doc[true];
    if (on === undefined) return [];
    if (typeof on === 'string') return [on];
    if (Array.isArray(on)) return on.map(String);
    return Object.keys(on);
}

/**
 * Shapes taken from real workflow files, plus the ones that broke the parser. Each is
 * legal YAML, so the oracle and the hand parser must agree on every one.
 */
const SHAPES = {
    'block mapping, 2-space': 'on:\n  pull_request:\n\njobs:\n  a:\n',
    'block mapping, 4-space': 'on:\n    pull_request:\n\njobs:\n  a:\n',
    'block mapping, 6-space': 'on:\n      schedule:\n        - cron: "0 3 * * *"\n\njobs:\n  a:\n',
    'block SEQUENCE': 'on:\n  - pull_request_target\n\njobs:\n  a:\n',
    'block sequence, several': 'on:\n  - push\n  - pull_request\n\njobs:\n  a:\n',
    'flow sequence': 'on: [push, pull_request]\n\njobs:\n  a:\n',
    'bare scalar': 'on: push\n\njobs:\n  a:\n',
    'quoted key': '"on":\n  pull_request:\n\njobs:\n  a:\n',
    'single-quoted key': "'on':\n  push:\n\njobs:\n  a:\n",
    'trailing space after on:': 'on: \n  push:\n\njobs:\n  a:\n',
    'comments interleaved': '# top\non:\n  # which events\n  push:\n    branches: [main]\n\njobs:\n  a:\n',
    'several triggers with filters': 'on:\n  push:\n    branches: [main]\n  pull_request:\n    paths:\n      - "src/**"\n  workflow_dispatch:\n\njobs:\n  a:\n',
    'name above on': 'name: CI\non:\n  merge_group:\n\njobs:\n  a:\n',
};

test('ORACLE-001: the hand parser agrees with js-yaml on every real-world shape', { skip: !yaml && 'js-yaml not installed' }, () => {
    const disagreements = [];
    for (const [label, src] of Object.entries(SHAPES)) {
        const real = [...truth(src)].sort().join(',');
        const mine = [...parseTriggers(src).triggers].sort().join(',');
        if (real !== mine) disagreements.push(`${label}\n      js-yaml: ${real || '(none)'}\n      ours:    ${mine || '(none)'}`);
    }
    assert.deepEqual(disagreements, [], `\n  ${disagreements.join('\n  ')}\n`);
});

test('ORACLE-002: CONTROL ARM — the shape that shipped wrong is still caught', { skip: !yaml && 'js-yaml not installed' }, () => {
    // `on:` + block sequence. The old parser handled the inline `[a, b]` spelling and not
    // this one, and reported "parsed, zero triggers" — which the tool then called manual.
    const src = 'on:\n  - pull_request_target\n\njobs:\n  a:\n';
    assert.deepEqual(truth(src), ['pull_request_target']);
    assert.deepEqual(parseTriggers(src).triggers, ['pull_request_target']);

    // The old implementation, run on the same input, asserted to still get it wrong.
    const OLD = s => {
        const lines = s.split('\n');
        const i = lines.findIndex(l => /^on:/.test(l));
        if (i === -1) return { triggers: [], parsed: false };
        const out = [];
        for (let j = i + 1; j < lines.length; j++) {
            const ind = lines[j].length - lines[j].trimStart().length;
            if (!lines[j].trim()) continue;
            if (ind === 0) break;
            const key = lines[j].trim().match(/^([a-z_]+):/)?.[1];
            if (ind === 2 && key) out.push(key);
        }
        return { triggers: out, parsed: true };
    };
    const old = OLD(src);
    assert.equal(old.parsed, true, 'the old parser claimed success');
    assert.deepEqual(old.triggers, [], 'and found nothing — silently, in the dangerous direction');
});

test('ORACLE-003: a shape it cannot read is UNCONFIDENT, not empty-and-confident', () => {
    // The property that makes the parser safe is not that it reads everything. It is that
    // it knows when it has not.
    for (const src of ['on:\n  ${{ templated }}\n\njobs:\n', 'on:\n  &anchor\n\njobs:\n']) {
        const r = parseTriggers(src);
        if (r.triggers.length) continue;               // if it read it, fine
        assert.equal(r.confident, false, `silently empty for:\n${src}`);
        assert.ok(r.why, 'and it must say why');
    }
});

test('ORACLE-004: every trigger this tool calls automatic is a real GitHub event', { skip: !yaml && 'js-yaml not installed' }, () => {
    // Guards a typo in the AUTOMATIC set, which would silently drop a whole trigger type.
    const real = new Set(['push', 'pull_request', 'pull_request_target', 'merge_group',
        'workflow_run', 'schedule', 'release', 'check_suite', 'check_run',
        'repository_dispatch', 'workflow_call', 'workflow_dispatch', 'issue_comment',
        'issues', 'pull_request_review', 'pull_request_review_comment', 'delete',
        'create', 'fork', 'gollum', 'label', 'milestone', 'page_build', 'project',
        'public', 'registry_package', 'status', 'watch', 'deployment',
        'deployment_status', 'discussion', 'discussion_comment', 'branch_protection_rule',
        'merge_queue_entry', 'project_card', 'project_column', 'repository_import']);
    for (const t of AUTOMATIC) assert.ok(real.has(t), `"${t}" is not a GitHub event name — typo?`);
});
