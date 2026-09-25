/**
 * The collected set, parsed from real `playwright --list` output.
 *
 * Every case here is recorded from an actual run, not invented, because the two bugs
 * this file pins were both invisible in hand-written fixtures and obvious the moment
 * the tool met a real suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListOutput } from '../src/list.mjs';

/**
 * A parameterised loop. All four tests are emitted at the SAME file:line:col, because
 * in the source they are one `test(` inside a `for`.
 */
const PARAMETERISED = `
Listing tests:
  [api] › contract/settings-matrix.spec.ts:42:5 › @contract settings › profile default
  [api] › contract/settings-matrix.spec.ts:42:5 › @contract settings › profile partial
  [api] › contract/settings-matrix.spec.ts:42:5 › @contract settings › profile corrupt
  [api] › contract/settings-matrix.spec.ts:42:5 › @contract settings › profile empty
Total: 4 tests in 1 file
`;

test('UNR-020: tests sharing a line:col are four tests, not one', () => {
    const r = parseListOutput(PARAMETERISED);
    assert.equal(r.ok, true);
    assert.equal(r.tests.size, 4);

    // CONTROL ARM — the shipped bug, executed. Keying on position alone collapses the
    // loop to a single entry. On the first real repo this turned 249 tests into 206 and
    // silently inflated the "unreachable" count by everything it swallowed.
    const positionOnly = new Map();
    for (const line of PARAMETERISED.split('\n')) {
        const m = /^\s*\[([^\]]+)\]\s+›\s+(\S+?\.spec\.ts):(\d+):(\d+)\s+›\s+(.*)$/.exec(line);
        if (m) positionOnly.set(`${m[1]}|${m[2]}:${m[3]}:${m[4]}`, m[5]);
    }
    assert.equal(positionOnly.size, 1, 'the old key must still lose three of the four');
});

test('UNR-021: a parse that disagrees with playwright\'s own Total refuses to answer', () => {
    // Two listed, Total says three: a line we failed to match. The honest output is an
    // error, not a set that is quietly one short.
    const r = parseListOutput([
        '  [api] › a.spec.ts:1:1 › one',
        '  [api] › b.spec.ts:2:1 › two',
        'Total: 3 tests in 2 files',
    ].join('\n'));
    assert.equal(r.ok, false);
    assert.match(r.error, /parsed 2 tests but playwright reported 3/);

    // CONTROL ARM: without the cross-check the same input returns ok with 2 tests, and
    // the missing one is reported to the user as never run by CI — a false accusation.
    assert.equal(r.tests.size, 2, 'the wrong answer is still reachable, it is just not returned as ok');
});

test('UNR-022: the same file under two projects is two runs', () => {
    const r = parseListOutput([
        '  [api] › smoke/health.spec.ts:3:1 › @smoke health',
        '  [flows] › smoke/health.spec.ts:3:1 › @smoke health',
        'Total: 2 tests in 1 file',
    ].join('\n'));
    assert.equal(r.tests.size, 2);
    assert.deepEqual([...r.tests.values()].map(t => t.project), ['api', 'flows']);
});

test('UNR-023: an empty result is a real answer, not a failure', () => {
    const r = parseListOutput('Total: 0 tests in 0 files\n');
    assert.equal(r.ok, true);
    assert.equal(r.tests.size, 0);
});

test('UNR-024: titles containing › and : survive the parse', () => {
    const r = parseListOutput([
        '  [api] › contract/x.spec.ts:9:3 › @contract a › CHAIN-001 title: it restores 1:1',
        'Total: 1 test in 1 file',
    ].join('\n'));
    assert.equal(r.ok, true);
    assert.equal([...r.tests.values()][0].title, '@contract a › CHAIN-001 title: it restores 1:1');
});
