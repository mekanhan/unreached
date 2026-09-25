#!/usr/bin/env node
/**
 * unreached — which of your tests does CI never run?
 */

import path from 'node:path';
import { audit } from '../src/audit.mjs';
import { toContract } from '../src/contract.mjs';
import { FLAGS, FLAG_NAMES, BIN } from '../src/cli-spec.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = n => argv.includes(`--${n}`);

const usage = () => `
  ${BIN} — which of your tests does CI never run?

    ${BIN} [${FLAG_NAMES.filter(f => f !== 'help').map(f => FLAGS[f].takesValue ? `--${f} <v>` : `--${f}`).join('] [')}]

  Every test your config collects, minus everything your AUTOMATIC workflows collect.
  A workflow that only runs on \`workflow_dispatch\` does not count: a suite that runs
  when someone remembers is not a gate.

${FLAG_NAMES.map(f => `    --${f.padEnd(8)} ${FLAGS[f].help}`).join('\n')}
`;

if (has('help') || argv[0] === 'help') { console.log(usage()); process.exit(0); }

// A mistyped flag must not be silently ignored — `--stict` returning a clean report is
// how someone concludes their suite is fine when they never ran the check they meant to.
const unknown = argv.filter(a => a.startsWith('--') && !FLAG_NAMES.includes(a.slice(2).split('=')[0]));
if (unknown.length) {
    console.error(`${BIN}: unknown flag ${unknown.join(' ')}\n${usage()}`);
    process.exit(2);
}

const repo = path.resolve(flag('repo', process.cwd()));
const quiet = has('quiet') || has('json');
const r = await audit(repo, { onStep: s => quiet || process.stderr.write(`  … ${s}\r`) });
if (!quiet) process.stderr.write(' '.repeat(60) + '\r');

if (r.error) { console.error(`unreached: ${r.error}`); process.exit(2); }

if (has('json')) {
    // C-001: exactly one object on stdout, nothing else. Progress went to stderr.
    const env = toContract(r, { repo });
    console.log(JSON.stringify(env, null, 2));
    // C-007: 1 means blockers were found, and is reachable only under --ci. Exit 2 is
    // reserved for the tool failing, and is raised above where that happens.
    process.exit(has('ci') && env.summary.blocker ? 1 : 0);
}

const pct = n => `${((n / r.total) * 100).toFixed(1)}%`;

// Colour only when a human is looking. A pipe, a log file or a CI transcript gets plain
// text, because escape codes in a build log are noise someone has to grep around.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, t) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
const c = {
    bold: t => wrap(1, t),
    grey: t => wrap(90, t),
    yellow: t => wrap(33, t),
};

console.log(`\n  unreached — ${path.basename(repo)}\n`);
console.log(`  config        ${path.relative(repo, r.configPath)}`);
console.log(`  total tests   ${r.total}   (collected by playwright, not counted from source)\n`);

console.log('  workflows that run playwright:\n');
const seen = new Map();
for (const i of r.invocations) {
    if (!seen.has(i.workflow)) seen.set(i.workflow, []);
    seen.get(i.workflow).push(i);
}
for (const [wf, list] of seen) {
    const a = list[0].automatic;
    const mark = a === true ? 'AUTOMATIC ' : a === null ? 'UNKNOWN   ' : 'MANUAL    ';
    const trig = list[0].triggers?.length ? list[0].triggers.join(', ') : 'workflow_dispatch only';
    console.log(`    ${mark} ${wf}  (${trig})`);
    if (list[0].pathFilters?.length)
        console.log(`               only on changes to: ${list[0].pathFilters.join(', ')}`);
    for (const i of list) {
        const n = i.automatic === true ? `${String(i.count).padStart(4)} tests` : '     —    ';
        console.log(`      ${n}  ${i.cmd}`);
    }
    console.log();
}

// THREE numbers. `unreachable` is a positive claim and has to be earned; anything this
// tool could not establish is its own bucket, reported FIRST, because a reader who
// skims must not mistake "I could not tell" for "this is dead".
console.log(`  proven reached                ${String(r.reached).padStart(4)}   ${pct(r.reached)}`);
console.log(`  UNPROVEN                      ${String(r.unproven.length).padStart(4)}   ${pct(r.unproven.length)}`);
console.log(`  proven unreachable            ${String(r.unreachable.length).padStart(4)}   ${pct(r.unreachable.length)}\n`);

if (r.blocksUnreachable.length) {
    console.log(`  ${c.yellow('NOTHING can be called unreachable while these are unread:')}\n`);
    for (const b of r.blocksUnreachable) console.log(`    ${b.what}\n      ${c.grey(b.why)}`);
    console.log();
}

if (r.unproven.length) {
    const reasons = new Map();
    for (const t of r.unproven) reasons.set(t.why, (reasons.get(t.why) ?? 0) + 1);
    console.log(`  ${c.bold('UNPROVEN')} ${c.grey('— neither covered nor dead. Look before acting on these.')}\n`);
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1]))
        console.log(`    ${String(n).padStart(4)}  ${why}`);
    for (const cnd of r.conditional) console.log(`          ${c.grey(cnd.what + ' — ' + cnd.why)}`);
    console.log();
}

if (r.unreachable.length) {
    const byFile = new Map();
    for (const t of r.unreachable) byFile.set(t.file, (byFile.get(t.file) ?? 0) + 1);
    console.log(`  ${c.bold('PROVEN UNREACHABLE')} ${c.grey('— every workflow was read, and no automatic run selects these')}\n`);
    for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]))
        console.log(`    ${String(n).padStart(4)}  ${f}`);
    console.log();
    console.log(c.grey('  This is a triage list, not a delete list. A test that no job runs may still be'));
    console.log(c.grey('  the one someone runs by hand before a release.\n'));
}

if (r.nearMisses?.length) {
    console.log(`  NEAR MISSES — a tag CI greps for, written where --grep cannot see it:\n`);
    for (const n of r.nearMisses)
        console.log(`    ${n.file}   ${n.tags.join(' ')} appears only in a comment`);
    console.log();
}

const approx = r.invocations.filter(i => i.automatic === true && i.unknownFlags?.length);
if (approx.length) {
    console.log('  flags this tool does not model — the counts above are a CEILING:\n');
    for (const i of approx) console.log(`    ${i.workflow}   ${i.unknownFlags.join(' ')}`);
    console.log();
}

// C-007. `--ci` gates on BLOCKERS, not on any finding: a repo can legitimately hold
// tests that only a manual workflow runs, and a gate that fires on those gets switched
// off in a week. `--strict` keeps the older, blunter meaning for anyone already using it.
if (has('ci')) {
    const env = toContract(r, { repo });
    if (env.summary.blocker) process.exit(1);
}
if (has('strict') && r.dead.length) process.exit(1);
