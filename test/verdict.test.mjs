/**
 * The three-valued verdict, and the asymmetry it exists to protect.
 *
 * Someone reading "these tests never run" may delete them. So `unreachable` is a
 * positive claim that must be earned, and every test below is really asking the same
 * question: can an unknown ever produce that claim?
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictFor, classifyUncertainty, REACHED, UNREACHABLE, UNPROVEN } from '../src/verdict.mjs';

const wf = (over = {}) => ({ file: '.github/workflows/ci.yml', automatic: true, why: null, ...over });
const inv = (over = {}) => ({ workflow: '.github/workflows/ci.yml', automatic: true, unknownFlags: [], ok: true, if: null, pathFilters: null, ...over });

// ── the verdict itself ────────────────────────────────────────────────────────

test('VERD-001: selected by an unconditional automatic run is REACHED', () => {
    assert.equal(verdictFor({ selectedByUnconditional: true, selectedByConditional: false, anyBlocker: false }).verdict, REACHED);
});

test('VERD-002: an unreadable workflow elsewhere cannot take REACHED away', () => {
    // An unknown can only ADD coverage. Proof that something runs a test is not weakened
    // by a workflow we could not read — that workflow could only run it too.
    assert.equal(verdictFor({ selectedByUnconditional: true, selectedByConditional: false, anyBlocker: true }).verdict, REACHED);
});

test('VERD-003: selected ONLY by a conditional job is UNPROVEN, never REACHED', () => {
    // This is coverage that exists on some changes and not others. Counting it as
    // covered is how a `paths:`-filtered job masquerades as a gate.
    const v = verdictFor({ selectedByUnconditional: false, selectedByConditional: true, anyBlocker: false });
    assert.equal(v.verdict, UNPROVEN);
    assert.match(v.why, /conditional/);
});

test('VERD-004: nothing selects it AND everything was read -> UNREACHABLE', () => {
    const v = verdictFor({ selectedByUnconditional: false, selectedByConditional: false, anyBlocker: false });
    assert.equal(v.verdict, UNREACHABLE);
    assert.match(v.why, /every workflow was read/);
});

test('VERD-005: nothing selects it BUT something was unreadable -> UNPROVEN', () => {
    // THE LOAD-BEARING TEST. This is the difference between a triage list and a tool
    // that tells someone to delete a live test.
    const v = verdictFor({ selectedByUnconditional: false, selectedByConditional: false, anyBlocker: true });
    assert.equal(v.verdict, UNPROVEN);
    assert.notEqual(v.verdict, UNREACHABLE);

    // CONTROL ARM — the two-valued model this replaced. `!reached` meant "dead", so an
    // unreadable workflow anywhere produced a confident accusation about every test it
    // might have run.
    const twoValued = ({ selected }) => (selected ? 'reached' : 'unreachable');
    assert.equal(twoValued({ selected: false }), 'unreachable',
        'the old model must still make the dangerous claim');
});

// ── what counts as an unknown, and which claim it blocks ──────────────────────

test('VERD-010: a workflow whose triggers could not be read blocks UNREACHABLE', () => {
    const { blocksUnreachable, conditional } = classifyUncertainty([], [wf({ automatic: null, why: 'unreadable `on:`' })]);
    assert.equal(blocksUnreachable.length, 1);
    assert.equal(conditional.length, 0, 'it is not conditional — it is unknown');
    assert.match(blocksUnreachable[0].why, /unreadable/);
});

test('VERD-011: an unmodelled flag blocks UNREACHABLE — the selection may be wider', () => {
    const { blocksUnreachable } = classifyUncertainty([inv({ unknownFlags: ['--last-failed'] })], []);
    assert.equal(blocksUnreachable.length, 1);
    assert.match(blocksUnreachable[0].why, /wider than measured/);
});

test('VERD-012: `if:` and `paths:` are CONDITIONAL, not blockers', () => {
    // They narrow. A condition can stop a job running; it can never start one, so it
    // cannot hide a test from us. Filing it as a blocker would suppress real findings.
    const { blocksUnreachable, conditional } = classifyUncertainty(
        [inv({ if: "github.event_name == 'push'" }), inv({ pathFilters: ['server/**'] })], []);
    assert.equal(blocksUnreachable.length, 0, 'a condition must not block the unreachable claim');
    assert.equal(conditional.length, 2);
});

test('VERD-013: a manual workflow is neither — it simply does not reach anything', () => {
    const { blocksUnreachable, conditional } = classifyUncertainty([inv({ automatic: false })], [wf({ automatic: false })]);
    assert.deepEqual(blocksUnreachable, []);
    assert.deepEqual(conditional, []);
});

test('VERD-014: a runner that could not enumerate an invocation blocks UNREACHABLE', () => {
    const { blocksUnreachable } = classifyUncertainty([inv({ ok: false, error: 'config threw' })], []);
    assert.equal(blocksUnreachable.length, 1);
    assert.match(blocksUnreachable[0].why, /could not enumerate/);
});

test('VERD-015: a clean, fully-read repo produces no uncertainty at all', () => {
    // The check must be able to tell zero from broken. VERD-010..014 prove it fires.
    const { blocksUnreachable, conditional } = classifyUncertainty([inv()], [wf()]);
    assert.deepEqual(blocksUnreachable, []);
    assert.deepEqual(conditional, []);
});
