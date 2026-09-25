/**
 * The CLI's surface, as data.
 *
 * It lives here rather than inline in `bin/` so a test can read the REAL list instead
 * of a copy of it. A copy drifts, and a test asserting against a copy passes while the
 * README documents a flag the binary has never heard of.
 *
 * That is not hypothetical: the sibling tool shipped a README whose very first command
 * did not exist, through a rewrite, a review, a release and an npm publish, because
 * nothing anywhere executed the README.
 */

/** Flags the binary reads. Anything documented and not here is a documentation bug. */
export const FLAGS = Object.freeze({
    repo: { takesValue: true, help: 'audit a repo other than the current directory' },
    json: { takesValue: false, help: 'machine-readable, every unreachable test individually' },
    strict: { takesValue: false, help: 'exit 1 if anything is unreachable' },
    quiet: { takesValue: false, help: 'no progress line' },
    ci: { takesValue: false, help: 'exit 1 when a BLOCKER is found — put it first in the pipeline' },
    help: { takesValue: false, help: 'this text' },
});

export const FLAG_NAMES = Object.freeze(Object.keys(FLAGS));

/** The binary's own name, as the README must spell it. */
export const BIN = 'unreached';
