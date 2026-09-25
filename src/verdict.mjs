/**
 * Three values, never two.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────────
 *
 * Someone reading "these 177 tests never run" may delete them. That single fact sets
 * the whole design:
 *
 *   wrongly saying UNREACHABLE  -> live coverage is deleted, silently, forever
 *   wrongly saying UNPROVEN     -> somebody looks for thirty seconds
 *
 * So `unreachable` is a POSITIVE CLAIM that has to be earned. Absence of evidence that
 * something runs a test is not evidence that nothing does.
 *
 * ── The part that is easy to get backwards ───────────────────────────────────────
 *
 * Uncertainty does not simply "fail closed" in one direction. Which claim it blocks
 * depends on which way the unknown cuts:
 *
 *   A workflow we could NOT READ might run tests we never accounted for.
 *     -> it makes UNREACHABLE unprovable. It cannot make anything reached.
 *
 *   A job behind `if:` or `paths:` might NOT run on a given change.
 *     -> it makes REACHED unprovable. It cannot make anything unreachable.
 *
 * Treating both the same would either hide real gaps or invent them. So they are
 * tracked separately, and each blocks only the claim it actually undermines.
 */

export const REACHED = 'reached';
export const UNREACHABLE = 'unreachable';
export const UNPROVEN = 'unproven';

/**
 * @param {object[]} invocations  parsed playwright invocations, annotated by audit()
 * @returns {{blocksUnreachable: object[], conditional: object[]}}
 *   blocksUnreachable — unknowns that might select tests we did not see
 *   conditional       — automatic runs that might not happen on a given change
 */
export function classifyUncertainty(invocations, workflows) {
    const blocksUnreachable = [];
    const conditional = [];

    // A workflow whose triggers could not be read might be automatic and might run
    // anything. Until that is settled, nothing can be called unreachable.
    for (const w of workflows) {
        if (w.automatic === null)
            blocksUnreachable.push({ what: w.file, why: w.why ?? 'triggers could not be read' });
    }

    for (const inv of invocations) {
        if (inv.automatic !== true) continue;

        // A flag we do not model may narrow OR widen what the run selects. Either way we
        // cannot claim to know the full reached set, so it blocks the negative claim.
        if (inv.unknownFlags?.length)
            blocksUnreachable.push({ what: inv.workflow, why: `unmodelled flag ${inv.unknownFlags.join(' ')} — the selection may be wider than measured` });

        if (inv.ok === false)
            blocksUnreachable.push({ what: inv.workflow, why: `the runner could not enumerate this invocation: ${inv.error ?? 'unknown'}` });

        // Conditions narrow. They can stop a job running, never start one.
        if (inv.if)
            conditional.push({ what: inv.workflow, why: `runs only when: ${inv.if}` });
        if (inv.pathFilters?.length)
            conditional.push({ what: inv.workflow, why: `runs only on changes to ${inv.pathFilters.join(', ')}` });
    }

    return { blocksUnreachable, conditional };
}

/**
 * The verdict for one test.
 *
 * @param {boolean} selectedByUnconditional  an automatic run with no condition selects it
 * @param {boolean} selectedByConditional    only a conditional automatic run selects it
 * @param {boolean} anyBlocker               something unreadable exists anywhere
 */
export function verdictFor({ selectedByUnconditional, selectedByConditional, anyBlocker }) {
    // Proven by a run that always happens. Nothing unknown can take this away — an
    // unreadable workflow elsewhere can only ADD coverage, never remove it.
    if (selectedByUnconditional) return { verdict: REACHED, why: null };

    // Only a conditional run selects it, so on some changes it runs and on others it
    // does not. That is neither "covered" nor "dead".
    if (selectedByConditional)
        return { verdict: UNPROVEN, why: 'only a conditional job selects this — it runs on some changes and not others' };

    // Nothing we can see selects it. Whether that means "nothing does" depends entirely
    // on whether we saw everything.
    if (anyBlocker)
        return { verdict: UNPROVEN, why: 'no run we could read selects this, but some workflows could not be read' };

    return { verdict: UNREACHABLE, why: 'every workflow was read, and no automatic run selects this' };
}
