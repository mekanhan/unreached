/**
 * Conformance to the findings contract, v1.
 *
 * These assert the CLAUSES, not this tool's own opinions — so when the second tool is
 * retrofitted, this file is the template and any clause it cannot satisfy is a flaw in
 * the contract rather than in the tool.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toContract } from '../src/contract.mjs';

const t = (project, file, title = 'a test') => ({ project, file, line: 1, title });

const audit = (over = {}) => ({
    total: 10, reached: 4,
    dead: [t('flows', 'flows/core.spec.ts'), t('flows', 'flows/core.spec.ts')],
    nearMisses: [],
    invocations: [
        { workflow: '.github/workflows/ci.yml', automatic: true, projects: ['api'],
          grep: ['@contract'], grepInvert: ['@api'], paths: [], unknownFlags: [], ok: true },
    ],
    workflows: [],
    ...over,
});

// ── C-001 envelope ────────────────────────────────────────────────────────────

test('C-001: the envelope carries contract, tool, version, target and summary', () => {
    const e = toContract(audit(), { repo: '/tmp/r', ref: 'abc123' });
    assert.equal(e.contract, 1);
    assert.equal(e.tool, 'unreached');
    assert.ok(e.version);
    assert.match(e.ran_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(e.target, { kind: 'repo', id: '/tmp/r', ref: 'abc123' });
    for (const k of ['blocker', 'warn', 'info', 'skipped']) assert.equal(typeof e.summary[k], 'number');
    assert.ok(Array.isArray(e.findings) && Array.isArray(e.skipped));
});

test('C-001: summary counts match the arrays — a summary that can drift is not a summary', () => {
    const e = toContract(audit(), { repo: '/tmp/r' });
    assert.equal(e.summary.blocker, e.findings.filter(f => f.severity === 'blocker').length);
    assert.equal(e.summary.warn, e.findings.filter(f => f.severity === 'warn').length);
    assert.equal(e.summary.skipped, e.skipped.length);
});

// ── C-002 / C-003 ─────────────────────────────────────────────────────────────

test('C-002: every finding carries the five required fields', () => {
    const e = toContract(audit({ nearMisses: [{ file: 'a.spec.ts', tags: ['@hermetic'] }] }), { repo: '/tmp/r' });
    assert.ok(e.findings.length);
    for (const f of e.findings)
        for (const k of ['id', 'severity', 'title', 'observed', 'next'])
            assert.ok(f[k], `finding ${f.id} is missing ${k}`);
});

test('C-003: every finding names an artifact that was READ', () => {
    // A finding derived only from what a config says should be true is not a finding.
    const e = toContract(audit({ nearMisses: [{ file: 'a.spec.ts', tags: ['@hermetic'] }] }), { repo: '/tmp/r' });
    for (const f of e.findings) {
        assert.ok(f.observed.what, `${f.id}: no 'what'`);
        assert.ok(f.observed.where, `${f.id}: no 'where' — nothing was pointed at`);
        assert.notEqual(f.observed.where.trim(), '', `${f.id}: empty 'where'`);
    }
});

// ── C-004 severity ────────────────────────────────────────────────────────────

test('C-004: severity is one of exactly three values', () => {
    const e = toContract(audit({ nearMisses: [{ file: 'a.spec.ts', tags: ['@hermetic'] }] }), { repo: '/tmp/r' });
    for (const f of e.findings) assert.ok(['blocker', 'warn', 'info'].includes(f.severity), f.severity);
});

test('C-004: a project no workflow names at all is a BLOCKER; manual-only is a WARN', () => {
    // The distinction is load-bearing. "Nothing runs these" and "a person runs these"
    // have different fixes, and collapsing them overstates the problem.
    const nothing = toContract(audit(), { repo: '/tmp/r' });
    assert.equal(nothing.findings.find(f => f.id === 'UNR-001')?.severity, 'blocker');

    const manual = toContract(audit({
        invocations: [
            ...audit().invocations,
            { workflow: '.github/workflows/e2e.yml', automatic: false, projects: [],
              grep: [], grepInvert: [], paths: [], unknownFlags: [] },
        ],
    }), { repo: '/tmp/r' });
    const f = manual.findings.find(x => x.id === 'UNR-003');
    assert.equal(f.severity, 'warn');
    assert.match(f.title, /presses a button/);
});

// ── C-005 skipped ─────────────────────────────────────────────────────────────

test('C-005: an unmodelled flag lands in `skipped` with a reason, and never passes silently', () => {
    const e = toContract(audit({
        invocations: [{ workflow: '.github/workflows/ci.yml', automatic: true, projects: ['flows'],
                        grep: [], grepInvert: [], paths: [], unknownFlags: ['--last-failed'], ok: true }],
    }), { repo: '/tmp/r' });
    assert.equal(e.skipped.length, 1);
    assert.ok(e.skipped[0].reason.includes('--last-failed'));
    assert.ok(e.skipped[0].id);

    // CONTROL ARM: dropping the skip entirely leaves a clean report over an incomplete
    // measurement, which is the exact failure the clause exists to prevent.
    const silent = { ...e, skipped: [] };
    assert.equal(silent.skipped.length, 0, 'the broken shape still reports nothing wrong');
    assert.notEqual(e.skipped.length, 0);
});

test('C-005: an unreadable workflow is skipped, not counted as manual', () => {
    const e = toContract(audit({
        invocations: [{ workflow: '.github/workflows/x.yml', automatic: null, projects: [],
                        grep: [], grepInvert: [], paths: [], unknownFlags: [] }],
    }), { repo: '/tmp/r' });
    assert.ok(e.skipped.some(s => /could not read the triggers/.test(s.reason)));
});

// ── C-006 / C-008 / C-009 ─────────────────────────────────────────────────────

test('C-006: confidence is stated on every finding', () => {
    const e = toContract(audit(), { repo: '/tmp/r' });
    for (const f of e.findings) assert.ok(['observed', 'inferred'].includes(f.confidence), f.id);
});

test('C-008: IDs match the stable format', () => {
    const e = toContract(audit({ nearMisses: [{ file: 'a.spec.ts', tags: ['@hermetic'] }] }), { repo: '/tmp/r' });
    for (const f of e.findings) assert.match(f.id, /^[A-Z][A-Z0-9]{1,7}-[0-9]{3}$/);
});

test('C-009: 177 unreachable tests collapse to a handful of findings, not 177', () => {
    // The clause exists because emitting one finding per test satisfies the schema and
    // is useless — the reader gets a wall instead of an answer.
    const many = Array.from({ length: 177 }, (_, i) => t('ui-extension', `ui/s${i}.spec.ts`));
    const e = toContract(audit({ dead: many }), { repo: '/tmp/r' });
    assert.ok(e.findings.length <= 3, `expected grouping, got ${e.findings.length} findings`);
    assert.equal(e.findings[0].count, 177, 'the count has to survive the grouping');
});

test('C-009: a fingerprint is stable and carries no timestamp or run number', () => {
    const a = toContract(audit(), { repo: '/tmp/r' });
    const b = toContract(audit(), { repo: '/tmp/r' });
    assert.deepEqual(a.findings.map(f => f.fingerprint), b.findings.map(f => f.fingerprint));
    for (const f of a.findings) {
        assert.doesNotMatch(f.fingerprint, /\d{4}-\d{2}-\d{2}/, 'a date makes it un-groupable');
        assert.doesNotMatch(f.fingerprint, /\/(Users|home)\//, 'a machine path makes it un-groupable');
    }
});

// ── C-011 ─────────────────────────────────────────────────────────────────────

test('C-011: `next` names an action, and is not a restatement of the title', () => {
    const e = toContract(audit({ nearMisses: [{ file: 'a.spec.ts', tags: ['@hermetic'] }] }), { repo: '/tmp/r' });
    for (const f of e.findings) {
        assert.ok(f.next.length > 40, `${f.id}: 'next' is too short to be an instruction`);
        assert.notEqual(f.next, f.title);
    }
});
