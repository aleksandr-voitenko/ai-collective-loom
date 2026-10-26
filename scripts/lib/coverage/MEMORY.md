# Coverage and parallel CI

`coverage.mjs` retains sequential local execution. `coverage-ci.mjs` implements
ADR-037's prepare/collect/report boundaries; the workflow uses four native and
four browser groups, independent smoke/persistence, and the existing required
`local-integration` name for its always-running final gate. Whole browser files
retain fresh processes, one worker and zero retries. Never share a checkout's
dist, browser-diagnostics or approved output between simultaneous collectors.

`ci-plan.mjs` discovers every PostgreSQL script and complete browser inventory.
Scheduling weights affect placement only; new entries must never be omitted.
Plans bind tested commit, base, run attempt, runtime/platform, all repository input
hashes and full dist hashes. Each job regenerates the plan after building and
rechecks inputs/build after measurement. Job labels may differ; authority does not.
Rerun the whole workflow, not only failed jobs, because attempts cannot mix evidence.

`portable.mjs` is the explicit approved numeric transport boundary. Closed fields
contain indices into the verified plan, numeric V8 trees, numeric source mapping
segments/line lengths and identity hashes. Strip names, source content, URLs and
raw profiles. Reconstruct private local maps from current verified source only.
Node and browser V8 ranges must merge BEFORE source remapping. Independently mapping
each shard and exact-merging source ranges changes branch population; do not use it.
Premerging group-local V8 also changes c8's incremental block/function flags. Keep
individual process measurements, original stage order and lexical process order.
Browser exports retain per-test entry order and merge only once centrally.
`inputs.mjs` remains the pinned c8 normalization/source identity boundary, and
`report.mjs` shares denominator/gates/report publication between both command paths.

Admission: 2 MiB plan, nine exact evidence names at 64 MiB/document, regular files
only; numeric collections/positions also have independent bounds. No partial report
may survive missing/failed/malformed groups. All four dependency results must be
success, then complete group membership and the browser union must validate before
reporting. Keep baseline ratios and four gates unchanged. Raw intermediates remain
ignored/private; upload only ci-export, final approved reports and separately
validated diagnostics. The final report contains authored source and numeric data.

`tests/bootstrap/coverage-ci.test.mjs` covers identity, completeness, counter/map
bounds, path/link/foreign data and unsuccessful upstream states. `tests/coverage/verify.ts`
uses actual Node/Chromium execution to compare transported and sequential compiler
ranges, line hits and browser pre-remap union, plus existing lifecycle/source canaries.
Hosted workflow completion is required evidence for job/artifact wiring and duration.
