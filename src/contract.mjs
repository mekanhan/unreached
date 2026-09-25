/**
 * The findings contract, v1 — see SPEC.md in the findings-contract repo.
 *
 * This is the first tool to conform, so it is the one that finds the contract's flaws.
 * Two showed up immediately and are recorded here rather than papered over:
 *
 *  1. 177 unreachable tests are NOT 177 findings. Emitting one per test satisfies the
 *     schema and is useless — the reader gets a wall. C-009's fingerprint exists for
 *     exactly this, so findings are grouped by CAUSE and carry their count.
 *  2. "Reachable by a manual-only workflow" is a different fact from "reachable by
 *     nothing", and collapsing them would overstate the problem. They are separate IDs.
 */

const PROJECT_UNRUN = 'UNR-001';
const FILTERED_OUT = 'UNR-002';
const MANUAL_ONLY = 'UNR-003';
const COMMENT_TAG = 'UNR-010';
const UNMODELLED = 'UNR-020';

/** C-004: severity is about whether a build can succeed, never about tidiness. */
export const BLOCKER = 'blocker', WARN = 'warn', INFO = 'info';

const sample = (list, n = 3) => {
    const files = [...new Set(list.map(t => t.file))];
    return files.length <= n ? files.join(', ')
        : `${files.slice(0, n).join(', ')} and ${files.length - n} more`;
};

/**
 * @param {object} r  the audit result
 * @returns {object}  a contract-v1 envelope
 */
export function toContract(r, { repo, ref = null } = {}) {
    const findings = [];
    const skipped = [];

    const automatic = r.invocations.filter(i => i.automatic === true);
    const manual = r.invocations.filter(i => i.automatic === false);
    const unknown = r.invocations.filter(i => i.automatic === null);

    // Which projects does any automatic run even name? A project no job names is a
    // different problem from a project whose jobs filter you out, and it has a different
    // fix — one is a missing job, the other is a missing tag.
    const namedByAutomatic = new Set(automatic.flatMap(i => i.projects));
    const anyAutomaticTakesAllProjects = automatic.some(i => i.projects.length === 0);

    const byProject = new Map();
    for (const t of r.dead) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);

    for (const [project, tests] of byProject) {
        const named = anyAutomaticTakesAllProjects || namedByAutomatic.has(project);

        // Could a MANUAL workflow have run it? That changes the sentence from "nothing
        // runs these" to "only a person clicking a button runs these".
        const manualCovers = manual.some(i => i.projects.length === 0 || i.projects.includes(project));

        if (!named) {
            findings.push({
                id: manualCovers ? MANUAL_ONLY : PROJECT_UNRUN,
                severity: manualCovers ? WARN : BLOCKER,
                title: manualCovers
                    ? `Project "${project}" runs only when someone presses a button`
                    : `No workflow runs the "${project}" project at all`,
                observed: {
                    what: `${tests.length} collected test${tests.length === 1 ? '' : 's'} in project "${project}"`,
                    where: sample(tests),
                    value: manualCovers
                        ? `reached only by ${manual.filter(i => i.projects.length === 0 || i.projects.includes(project)).map(i => i.workflow).join(', ')} (workflow_dispatch)`
                        : 'named by no playwright invocation in any automatic workflow',
                },
                next: manualCovers
                    ? `Add "--project=${project}" to a job that runs on push or pull_request, or accept that these are manual and say so in the workflow's name. A suite that runs when somebody remembers is not a gate.`
                    : `No job names --project=${project}. Either add one, or delete the project from playwright.config if it is dead.`,
                confidence: 'observed',
                fingerprint: `${manualCovers ? MANUAL_ONLY : PROJECT_UNRUN}:${project}`,
                count: tests.length,
            });
            continue;
        }

        // The project IS run automatically — so these tests were filtered out by the flags.
        const jobs = automatic.filter(i => i.projects.length === 0 || i.projects.includes(project));
        const filters = jobs.flatMap(i => [
            ...i.grep.map(g => `--grep ${g}`),
            ...i.grepInvert.map(g => `--grep-invert ${g}`),
            ...(i.paths.length ? [`only ${i.paths.join(' ')}`] : []),
        ]);
        findings.push({
            id: FILTERED_OUT,
            severity: WARN,
            title: `${tests.length} test${tests.length === 1 ? '' : 's'} in "${project}" are filtered out of every automatic run`,
            observed: {
                what: `${tests.length} collected tests that no automatic invocation selects`,
                where: sample(tests),
                value: `jobs that run this project apply: ${[...new Set(filters)].join(' · ') || '(no filters — check paths)'}`,
            },
            next: `These are collected by playwright and selected by nothing. Either tag them so an existing job picks them up, or add a job without that filter. Deciding they are deliberately manual is also an answer — but it should be a decision, not a leftover.`,
            confidence: 'observed',
            fingerprint: `${FILTERED_OUT}:${project}`,
            count: tests.length,
        });
    }

    // C-003: a tag that exists only in a comment, with the file it is in.
    for (const n of r.nearMisses ?? []) {
        findings.push({
            id: COMMENT_TAG,
            severity: WARN,
            title: `${n.tags.join(' ')} is written where --grep cannot see it`,
            observed: {
                what: 'a tag CI filters on, found only inside a comment',
                where: n.file,
                value: n.tags.join(' '),
            },
            next: `--grep matches the title chain — the describe titles and the test title — and never a comment. Move ${n.tags.join(' ')} into the test.describe() title, or this file's tests run in no job while looking correctly tagged.`,
            confidence: 'observed',
            fingerprint: `${COMMENT_TAG}:${n.file}:${n.tags.join('+')}`,
        });
    }

    // C-005: anything we could not evaluate says so, with a reason. It never passes.
    for (const i of automatic.filter(x => x.unknownFlags?.length)) {
        skipped.push({
            id: UNMODELLED,
            reason: `${i.workflow} passes ${i.unknownFlags.join(' ')}, which this tool does not model — its reached count is a ceiling`,
            requires: 'support for that flag',
        });
    }
    for (const i of unknown) {
        skipped.push({
            id: UNMODELLED,
            reason: `could not read the triggers of ${i.workflow}, so it was counted as neither automatic nor manual`,
            requires: 'a parseable `on:` block',
        });
    }
    for (const i of automatic.filter(x => x.ok === false)) {
        skipped.push({
            id: UNMODELLED,
            reason: `playwright --list failed for ${i.workflow}: ${i.error ?? 'unknown'}`,
            requires: 'a runnable playwright config',
        });
    }

    const count = s => findings.filter(f => f.severity === s).length;
    return {
        contract: 1,
        tool: 'unreached',
        version: '0.1.0',
        ran_at: new Date().toISOString(),
        target: { kind: 'repo', id: repo, ref },
        findings: findings.sort((a, b) =>
            ({ blocker: 0, warn: 1, info: 2 })[a.severity] - ({ blocker: 0, warn: 1, info: 2 })[b.severity]),
        skipped,
        summary: {
            blocker: count(BLOCKER), warn: count(WARN), info: count(INFO),
            skipped: skipped.length,
            // Tool-specific extras are allowed alongside the required counts.
            tests_total: r.total, tests_reached: r.reached, tests_unreached: r.dead.length,
        },
    };
}
