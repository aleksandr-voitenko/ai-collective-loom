# ADR-037: Parallel verification with complete numeric evidence

Status: Accepted for implementation; hosted acceptance is required before merge.

## Context

PR #28's sequential hosted coverage took approximately 29 minutes for native
suites and 24 minutes for Chromium. Both integration jobs exceeded their 60-minute
containing budget. The PR run completed coverage and smoke but was cancelled during
persistence verification. Local passes did not prove hosted pipeline completion.
Preserve every suite, real PostgreSQL/storage/HTTPS checks, browser inventory,
exact source-range coverage method, baseline and thresholds, and private diagnostics.

The earlier whole-spec process boundary (LC-20261023-KA7X) releases V8-retained
server schemas. Keep that boundary and one browser worker with zero retries.
A diagnostic comparison also showed that mapping Node ranges independently and
then combining source results can change branch membership. Distributed collection
must retain the existing merge-before-remapping order, not average percentages.
A full-capture replay also rejected premerging Node counters within a group: c8's
incremental merge can change block/function flags. Preserve individual process
samples, original stage order and lexical process order through central normalization.
Browser samples likewise retain test/page/entry order and merge only once centrally.

## Decision

`coverage-ci.mjs` prepares one plan after measured checks and a verified build.
It discovers all `test:*:postgres` scripts and the entire browser test inventory.
Four native groups and four whole-spec browser groups are assigned deterministically
using measured scheduling weights; unknown suites/specs remain included. Each job
uses its own checkout, build, diagnostics and disposable native services. Smoke then
persistence run on a separate job's ephemeral Compose stack. No retained local
stack or credentials are selected. The sequential local `coverage` command remains.

Each group rebuilds and regenerates the plan, requiring identical tested commit,
comparison base, runtime/platform, workflow run/attempt, source/input manifest,
compiled output hashes and complete inventory. The group export binds the plan
digest, group identity and exact successful stages. Browser exports retain complete
validated successful test identities and bounded counts; omissions, foreign tests,
retries, failed status and missing captures refuse export. Concurrent changes to
inputs or compiled output invalidate collection.

The approved transport contains only a closed numeric projection: known script and
source indices, mapping-identity hashes, generated line lengths, decoded numeric
mapping segments, numeric process-order tuples and anonymous V8 range trees. Browser ranges bind the plan's exact
bundle identities. Original source text is loaded only from the verified receiving
checkout. Raw V8 documents, source-map names/content, runtime URLs, function names,
logs, screenshots and credentials remain private. Hashes preserve cross-job mapping
consistency without transmitting names. Local validation precedes export and receiving
validation precedes reconstruction. Decoding restores private local inputs for the
same pinned normalizer and source mapper, retaining cold-source discovery and the
complete denominator. Function coverage remains outside the report.

Plan admission is at most 2 MiB. Each of nine evidence documents is at most 64 MiB;
filenames/count are exact, regular files are required, and links/unknown documents
are rejected. Numeric collections independently bound stages (128), processes (10,000/stage),
scripts (4096/stage), functions
(100,000/script), ranges (1,000,000/script), mapping segments (1,000,000/script),
generated source extent (16 MiB/script) and counters (10^12). Positions must fit
known generated/source bounds; range trees must nest without crossing. Vite config
compiler mappings for injected path variables may have virtual columns beyond the
authored first line, bounded by the generated extent. This exception is restricted
to the config compiler/source; final reported ranges must still fit authored source. Existing
browser capture, diagnostic, byte and inventory bounds remain unchanged.

The always-running `local-integration` job retains the existing check name and
requires checks, both full matrices and storage to succeed. It rejects missing,
duplicate, stale, foreign, malformed or inconsistent evidence, checks the complete
browser union, merges V8 before remapping and applies all four unchanged gates.
Incomplete reports replace prior output with a fixed failure status. Failed/cancelled/
skipped dependencies cannot produce green coverage. Fail-fast is disabled for matrices,
so an early failure does not conceal the remaining groups' results. Rerun the entire
workflow after failure: successful jobs from an earlier attempt are not reusable.

Only validated exports, final reports and existing approved browser diagnostics
are uploaded, with three-day retention. PR validation, `main` pushes and manual runs
retain full checks; feature-branch pushes no longer duplicate PR runs. The manual
controlled failure-upload probe remains on browser group zero and must fail its job
and final gate while retaining approved failure diagnostics. Checks/storage/aggregation
have 15-minute budgets and native/browser groups have 30-minute budgets; these do not
change test-level timeouts, retry policy or assertions.

## Verification and reconsideration

Behavioral tests exercise plan/source/build/runtime/run mismatches; missing, foreign,
truncated, linked and malformed evidence; changed membership; failing dependencies;
numeric bounds and secret canaries. Real Node/Chromium probes compare the private
sequential path with export/import across compiler variants and browser groups.
Normal checks, full local coverage and the hosted workflow must complete before
claiming acceptance. A passing subset cannot replace the full final gate.

Reassess group weights and containing budgets from hosted durations as suites grow.
Compiler/converter changes require projection/denominator probes. Changes to the
export boundary require explicit schema and disclosure review; do not add arbitrary
strings or upload raw captures to debug a failed group. Production application,
publication, retention and deployment behavior are unchanged.
