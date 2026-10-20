# Combined application coverage

Run the same measurement locally and in CI with Node from `.nvmrc`, installed
dependencies, Docker access and Playwright Chromium:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run coverage -- --base origin/main
```

The command runs the real Node/Chromium measurement probes, `npm run check`, every
`test:*:postgres` package script, and the complete Chromium suite through the normal
containing runner. It builds first through `check`, then adds hidden Vite source
maps for browser remapping. Do not run it alongside another browser command or
rebuild in the same checkout. PostgreSQL suites use disposable databases; the
command does not stop or modify the development stack.

Open `coverage/approved/index.html` for source lines and branch ranges. The directory
also contains `summary.json` (scope totals, gates, suite results and limitations),
`coverage.json` (per-file lines and branch ranges), and `lcov.info` (lines/branches).
An incomplete run replaces these reports with a fixed `status.json`; it cannot
reuse a previous passing measurement. A completed measurement that misses a gate
retains its reports and exits unsuccessfully.

## Gates and scope

Application source is all `src/**/*.ts` and `src/**/*.tsx`, excluding declaration
files. Unexecuted files stay in the denominator. Tooling (`scripts`, `.githooks`,
and Vite configuration) is reported separately and in the all-source total.
Tests, generated bundles and dependencies are excluded after source remapping.
The gates apply to **application source**:

| Gate | Requirement |
|---|---|
| Changed reportable lines | At least 90% |
| Combined branch ranges | At least 85% |
| Combined application lines | No decline from 15,097 / 15,586 (96.86%) |
| Combined application branch ranges | No decline from 10,914 / 12,531 (87.09%) |

The measured baseline is in `config/coverage-baseline.json`. Comparisons use exact
integer ratios, with no rounding allowance. The branch baseline is currently
stricter than the independent 85% floor. Baseline updates require explicit review;
the command never refreshes it automatically and rejects a lower baseline than
the comparison commit. Adding tests does not automatically raise the baseline.

Changed lines are added/modified reportable source lines relative to the merge
base with `--base`, `COVERAGE_BASE_SHA`, or `origin/main`, in that order. New files
include all reportable lines; removed lines do not count. A change with no
reportable application lines passes that gate as inapplicable, while overall gates
still apply. CI fetches full history and supplies the PR base SHA or the preceding
push SHA. A first branch push with an all-zero preceding SHA uses `origin/main`.
An unresolved comparison ref fails the measurement.

The original combined capture reported 88.56% branches. Review reproduced an
Istanbul merge error inside c8: tsx and tsc ranges for the same source inherited
hits from enclosing ranges. Reprocessing those **same original captures** with
exact merging throughout yields 10,914 / 12,531 (87.09%); line coverage is unchanged.
Method `v8-exact-source-ranges-2` records this correction. The baseline was not
remeasured from newer application changes to conceal a decline.

## Measurement contract

Node V8 counters include JSDOM, PostgreSQL and Node processes launched by Chromium
scenarios. Chromium contributes its actual compiled client execution, collected
with a continuous CDP profiler per page. Sampling happens before explicit full
navigation and disposal, including persistent contexts and native `Browser.close`.
A failed capture must fail measurement while still allowing resource disposal.
Each test must have a matching complete capture and a passed result. HTTP-only
scenarios may have no pages; the combined run must still observe every application
bundle. A missing capture is always an error.

Source maps and bundle hashes must match the measured inputs. Tracked and
non-ignored untracked repository files must stay unchanged through report
publication, including newly added tests/configuration. Ignored generated reports
are excluded. Original source
lines without a generated mapping receive **no browser hits**: otherwise the
converter's defaults would count tree-shaken code as covered. Counters for the same
bundle bytes merge before remapping. Different compilers' remapped counters, including tsx versus compiled Node, merge
only at identical source locations; an enclosing executed range cannot grant
coverage to an untaken nested range. The cold-file placeholder contributes zero
lines but does not add synthetic branches once real execution exists.

Branches are V8 source ranges, not every logical condition combination or possible
race. Different compiler ranges remain distinct. Function coverage is deliberately
outside this report. Intentionally killed Node children can lose unflushed counters;
the report never guesses that execution. These limits mean coverage complements
assertions and review, and is not a correctness or privacy guarantee.

`npm run test:coverage` exercises the actual Node/Chromium/remapping pipeline with
opposite branches, tsx/tsc branch overlap, an unused function, tree-shaken code, repeated navigation,
sibling pages, persistent/native closure, numeric-only captures and failed-capture
disposal. Bootstrap regressions cover exact gates, baseline protection, changed
lines, missing/stale inputs, coordinate normalization and report escaping.

## CI and artifact boundary

The integration job installs Chromium, verifies sanitized browser diagnostics,
then runs `npm run coverage`. Its 45-minute job budget includes all suites and
report generation; normal test, action and navigation deadlines, one worker and
zero retries remain unchanged. Existing local-service smoke and persistence checks
still run afterward. Any suite, collector, integrity check or gate failure fails CI.

The only coverage upload directory is `coverage/approved/`, with three-day
retention and a pinned upload action. It contains authored repository source and
numeric reports, or the fixed incomplete status. Raw Node counters, source maps,
browser profiles, intermediate logs and raw captures stay in ignored local output
and are never uploaded. Browser collection persists only verified own-asset names,
hashes and numeric ranges, without origins, queries, script bodies, function names,
storage or anonymous scripts. Existing browser diagnostic uploads remain limited
to their separately validated `browser-diagnostics/approved/*.json` schema.

Changes to the compiler, converter or source-map method require rerunning the
measurement probes and reviewing denominator differences before changing a
baseline. Do not lower gates or add rounding tolerances to conceal such differences.
