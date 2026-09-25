#!/usr/bin/env node
/**
 * unreached — which of your tests does CI never run?
 */

import path from 'node:path';
import { audit } from '../src/audit.mjs';
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
    console.log(JSON.stringify({
        total: r.total, reached: r.reached, unreached: r.dead.length,
        dead: r.dead,
        invocations: r.invocations.map(i => ({
            workflow: i.workflow, cmd: i.cmd, automatic: i.automatic,
            triggers: i.triggers, count: i.count ?? null,
        })),
    }, null, 2));
    process.exit(has('strict') && r.dead.length ? 1 : 0);
}

const pct = n => `${((n / r.total) * 100).toFixed(1)}%`;

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

console.log(`  reached by an automatic run   ${String(r.reached).padStart(4)}   ${pct(r.reached)}`);
console.log(`  NEVER RUN BY CI               ${String(r.dead.length).padStart(4)}   ${pct(r.dead.length)}\n`);

if (r.dead.length) {
    const byFile = new Map();
    for (const t of r.dead) byFile.set(t.file, (byFile.get(t.file) ?? 0) + 1);
    for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]))
        console.log(`    ${String(n).padStart(4)}  ${f}`);
    console.log();
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

if (has('strict') && r.dead.length) process.exit(1);
