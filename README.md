# unreached

**Which of your tests does CI never run?**

You have a test suite. You have CI. You assume the second runs the first.

Between them sit `--grep`, `--project`, a `paths:` filter, and a workflow whose only
trigger is `workflow_dispatch`. Each is reasonable on its own. Together they decide
which of your tests are protection and which are files.

Nothing tells you which is which. Both kinds are green.

## What it does

Asks Playwright to collect every test. Then asks Playwright again, once per automatic
workflow invocation, with that invocation's exact flags. Everything in the first set
and none of the second has never run in CI and never will.

```
  reached by an automatic run     72   28.9%
  NEVER RUN BY CI                177   71.1%
```

Both numbers come from the same binary that runs in CI, so there is no model of
Playwright here that can drift from Playwright.

## Install

```bash
npm i -g unreached     # or run it from a clone: node bin/unreached.mjs
```

Node 18+. No dependencies. It runs `playwright --list`, which starts no browser and
executes no test.

## Use it

```bash
cd your-repo
unreached
```

```
  config        apps/e2e/playwright.config.ts
  total tests   249   (collected by playwright, not counted from source)

  workflows that run playwright:

    AUTOMATIC  .github/workflows/ci.yml  (pull_request, merge_group)
        52 tests  npx playwright test --project=ui-extension --grep @hermetic
        17 tests  npx playwright test --project=api --grep @contract --grep-invert "@api|@admin"

    MANUAL     .github/workflows/e2e.yml  (workflow_dispatch only)
           —      npx playwright test

  reached by an automatic run     72   28.9%
  NEVER RUN BY CI                177   71.1%
```

A workflow whose only trigger is `workflow_dispatch` does not count. A suite that runs
when somebody remembers is not a gate.

### As a gate

```bash
unreached --ci         # exit 1 only on a BLOCKER — put it first in the pipeline
unreached --strict     # blunter: exit 1 if anything at all is unreachable
```

`--ci` fires only when a project is named by **no workflow at all**. Tests that a manual
workflow runs, or that a tag filter excludes, are warnings — a repo can legitimately hold
those, and a gate that fires on them gets switched off inside a week.

`--strict` keeps the blunt meaning if you want it. Most repos should not turn either on the
day they install it: run it, read the list, decide what is deliberate, then gate.

Exit codes follow the findings contract: `0` ran cleanly, `1` found blockers, **`2` the tool
itself failed**. A pipeline that treats every non-zero as a failed check will read a broken
tool as a broken build.

### Other flags

```bash
unreached --repo ../some-other-repo    # audit a repo you are not standing in
unreached --json                       # findings-contract v1 envelope on stdout
unreached --quiet                      # no progress line, for logs and pipes
```

`--json` emits exactly one object on stdout and nothing else; progress goes to stderr, so it
pipes cleanly. The 177 unreachable tests in the example above come back as **three findings**
grouped by cause, each with a stable `fingerprint` — so a fleet of repos collapses into
"3 causes affecting N repos" rather than a wall.

## The near miss

```js
// @hermetic — no network, safe for the PR gate
test.describe('the extension card renders its fee panel', () => {
```

`--grep` matches the **title chain** — the describe titles and the test title. It never
sees a comment. That file reads as tagged to every human who opens it, is not tagged,
and its job reports success having run zero of its tests.

`unreached` reports those separately, and only for tags your CI actually greps on:

```
  NEAR MISSES — a tag CI greps for, written where --grep cannot see it:

    tests/regression/extension-fee-panel.spec.ts   @hermetic appears only in a comment
```

## What it will not tell you

- **Only Playwright today.** Jest, vitest and `node:test` have the same disease and are
  not covered yet. The runner seam is one file.
- **A `paths:` filter is reported, not modelled.** A job that only fires on changes to
  `server/**` is counted as automatic, because it is — but it will not run on a PR that
  touches nothing there. The report names the filter so you can judge it.
- **An unrecognised flag makes the count a ceiling.** If an invocation passes something
  this tool does not model, it says so rather than quietly treating its own number as
  exact.
- **Reachable is not the same as useful.** A test CI runs can still be a test that
  cannot fail. That is a different instrument —
  [control-arm](https://github.com/mekanhan/control-arm) asks whether a test would have
  caught the bug it was written for.

## Why you should believe it

Both sides of the subtraction are produced by `playwright --list`, and the parse
cross-checks itself against Playwright's own printed `Total:` — if the two disagree the
tool refuses to answer rather than report the difference as a finding.

The suite keeps a **control arm** for every bug found so far: the broken implementation,
executed on the same input, asserted to still get the answer wrong. Three of them are
real bugs this tool shipped with and hit on its first real repo:

| bug | what it did | found by |
|---|---|---|
| keyed tests by `file:line:col` | a 16-test `for` loop collapsed to 1; 249 tests read as 206 | disagreeing with `--list`'s own total |
| two path resolvers, one check | accused **10 correctly tagged files** of a mistake they did not make | opening one of the files |
| `working-directory` leaked between steps | an explicit spec path resolved against the wrong root | a workflow with three steps |

None were found by the unit tests. All were found by pointing it at a real repository.

**That is the argument for running this on your own code before believing any number it
prints.**

MIT.
