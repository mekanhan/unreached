/**
 * The near miss: a tag written where the matcher cannot see it.
 *
 *   // @hermetic — runs without a network
 *   test.describe('the extension card renders', () => { … })
 *
 * That reads as tagged to every human who opens the file, and to every reviewer. It is
 * not tagged. `--grep` matches the TITLE CHAIN — describe titles plus the test title —
 * and a comment is not a title. The suite stays green, the job runs 0 of those tests,
 * and nothing anywhere says so.
 *
 * This is worse than an untagged file, because an untagged file looks untagged.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const TAG = /@[\w-]+/g;

/**
 * @param {string[]} files          absolute paths to spec files
 * @param {Set<string>} liveTags    tags that appear in a real title, from playwright --list
 * @param {string[]} ciTags         tags any automatic invocation greps for
 */
export function commentOnlyTags(files, liveTags, ciTags, repo) {
    const findings = [];
    for (const f of files) {
        // A path we cannot resolve is not a finding. This check is a secondary signal;
        // it must never be the reason the whole audit dies.
        if (!existsSync(f)) continue;
        const src = readFileSync(f, 'utf8');
        const inComments = new Set();
        for (const m of src.match(COMMENT) ?? [])
            for (const t of m.match(TAG) ?? []) inComments.add(t);
        if (!inComments.size) continue;

        // Only the tags CI actually filters on matter. `// @ts-ignore` and an email
        // address in a comment are not near misses; reporting them is noise, and a
        // report that is mostly noise gets switched off.
        const missed = [...inComments].filter(t => ciTags.includes(t) && !liveTags.has(`${f}|${t}`));
        if (missed.length) findings.push({ file: path.relative(repo, f), tags: missed });
    }
    return findings;
}

/**
 * Tags that appear in a real, collected title — keyed by absolute file.
 *
 * Takes the SAME resolver the caller uses to find the files on disk. When these two
 * resolved paths independently (one against the config dir, one against testDir) no key
 * ever matched, and the check reported ten files as tagged-only-in-a-comment whose tag
 * was sitting in the describe title one screen down. A false positive here accuses
 * someone of a mistake they did not make, which is how a report gets switched off.
 */
export function liveTagIndex(tests, resolveSpec) {
    const idx = new Set();
    for (const t of tests.values())
        for (const tag of t.title.match(TAG) ?? [])
            idx.add(`${resolveSpec(t.file)}|${tag}`);
    return idx;
}
