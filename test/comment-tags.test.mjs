/**
 * The near-miss check: a tag CI greps for, written where `--grep` cannot see it.
 *
 * This check shipped a FALSE POSITIVE on its first real run — it accused ten correctly
 * tagged files, because the file list and the tag index resolved the same path two
 * different ways and no key ever matched. So the important test here is not that it
 * finds the bad file; it is that it leaves the good ones alone, and that it can still
 * tell "nothing wrong" apart from "the check is broken".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentOnlyTags, liveTagIndex } from '../src/comment-tags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const spec = n => path.join(FIX, n);

/**
 * What `playwright --list` would return for these three fixtures: the titles it
 * actually collected. Only the two files whose tag is in a TITLE contribute a tag.
 */
const collected = new Map([
    ['a', { file: 'tagged-in-title.spec.ts', title: '@regression @ui @hermetic VAL-070 an unread title is labelled › VAL-070: the spec strip says NOT VERIFIED' }],
    ['b', { file: 'tagged-only-in-comment.spec.ts', title: 'the extension card renders its fee panel › the fee row shows a total' }],
    ['c', { file: 'noise-in-comments.spec.ts', title: '@hermetic the settings matrix holds its shape › a corrupt blob does not crash the panel' }],
]);

const resolveSpec = f => spec(f);
const CI_TAGS = ['@hermetic', '@contract'];

test('UNR-030: a tag written ONLY in a comment is found', () => {
    const found = commentOnlyTags(
        [spec('tagged-only-in-comment.spec.ts')],
        liveTagIndex(collected, resolveSpec), CI_TAGS, FIX);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].tags, ['@hermetic']);
});

test('UNR-031: a tag in BOTH a comment and the describe title is NOT a finding', () => {
    const found = commentOnlyTags(
        [spec('tagged-in-title.spec.ts')],
        liveTagIndex(collected, resolveSpec), CI_TAGS, FIX);
    assert.deepEqual(found, [], 'this file is correctly tagged — reporting it is the false positive');

    // CONTROL ARM — the shipped bug, executed. The tag index resolved against the
    // config dir while the file list resolved against testDir, so no key matched and
    // every tagged file looked comment-only. Reproduce that and show it still accuses.
    const mismatched = liveTagIndex(collected, f => path.join(FIX, 'tests', f));
    const wrong = commentOnlyTags([spec('tagged-in-title.spec.ts')], mismatched, CI_TAGS, FIX);
    assert.equal(wrong.length, 1, 'the old resolver must still produce the false positive');
});

test('UNR-032: comment tags CI does not grep for are ignored', () => {
    // `@ts-ignore` and an email address are not near misses. A report that is mostly
    // noise gets switched off, and then it catches nothing at all.
    const found = commentOnlyTags(
        [spec('noise-in-comments.spec.ts')],
        liveTagIndex(collected, resolveSpec), CI_TAGS, FIX);
    assert.deepEqual(found, []);

    // And prove the filter is what excluded them, not an empty scan: widen the CI tag
    // list to include @ts-ignore and the same file DOES report.
    const widened = commentOnlyTags(
        [spec('noise-in-comments.spec.ts')],
        liveTagIndex(collected, resolveSpec), ['@ts-ignore'], FIX);
    assert.deepEqual(widened[0].tags, ['@ts-ignore']);
});

test('UNR-033: a file that does not exist is skipped, not thrown on', () => {
    // This check is a secondary signal. It must never be the reason the audit dies —
    // which it was, with an ENOENT, on the first repo it met.
    assert.doesNotThrow(() => commentOnlyTags([spec('nope.spec.ts')], new Set(), CI_TAGS, FIX));
    assert.deepEqual(commentOnlyTags([spec('nope.spec.ts')], new Set(), CI_TAGS, FIX), []);
});

test('UNR-034: an empty result means clean, and the scan can prove it ran', () => {
    // Zero findings across all three fixtures is the right answer. The previous test
    // pins that the SAME inputs produce a finding when one is due, so this zero is a
    // measurement rather than a scan that silently did nothing.
    const all = [...collected.values()].map(t => spec(t.file));
    assert.deepEqual(commentOnlyTags(all, liveTagIndex(collected, resolveSpec), ['@contract'], FIX), []);
    assert.equal(commentOnlyTags(all, liveTagIndex(collected, resolveSpec), CI_TAGS, FIX).length, 1);
});
