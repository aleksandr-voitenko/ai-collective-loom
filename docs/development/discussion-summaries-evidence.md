# Discussion summary verification

Worktree baseline: `5edfeca53562a12ab3863550c9a33b59365e7a5f` (merged PR #7).
Local execution uses Node 24.19.0, macOS arm64, disposable PostgreSQL 18.4 containers,
real HTTPS, native search-worker processes and Chromium virtual WebAuthn. No existing
development database, user account or production service was reset or deployed.
Imported specification, architecture and UI baselines remain unchanged.

## PR #8 CI follow-up — 16 October 2026

The [pull-request workflow](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38815305699)
failed one of 62 browser tests on `72feec4`: summary conflict comparison recovery.
The [push workflow](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38815287042)
passed, including the later migration, integration and persistence steps skipped
by the failed PR job. The PR merge ref and branch head have the same source tree.
The [approved hosted failure](discussion-summaries-evidence/ci-followup/hosted-failure/run.json)
is retained with its bounded diagnostic bundle before hosted artifact expiry.

The fixture removed its comparison-fetch fault after checking restored draft text
on reload. That text comes from the local journal and can render before the
asynchronous comparison request. In the hosted failure, the first request was
aborted, the reload request returned 200, and the test then spent the unchanged
15-second action deadline waiting for the error-only retry button. This is a test
ordering defect; the passing push run alone was not treated as a repair.

A controlled barrier delayed the reload request's route decision until after the
old fixture cleared its fault. The [local reproduction](discussion-summaries-evidence/ci-followup/reproduction/run.json)
failed with the same successful reload request and missing retry button. The fixed
test keeps the fault until the reload reaches its retry UI, asserts correction is
disabled both while the request is pending and after failure, then explicitly
allows retry. It releases its barrier in `finally`. Application code, browser
deadlines, workers, retries and diagnostic/disclosure guards are unchanged.

The focused command
`npm run test:e2e -- tests/e2e/summaries.spec.ts --grep 'summary conflict comparison failure'`
then [passed](discussion-summaries-evidence/ci-followup/targeted/run.json).
The complete normal `npm run test:e2e` subsequently
[passed 62/62](discussion-summaries-evidence/ci-followup/browser-full/run.json),
with one worker, zero retries and no omitted tests. `npm run check` also
[passed](discussion-summaries-evidence/ci-followup/check.txt), including the 46
development application tests, typecheck and build. These local runs used the
same synthetic environment described above. No runtime or database code changed.
The original CI failure and controlled reproduction remain recorded separately
from passing verification. Hosted verification of the fix is pending at commit
preparation and will be recorded on the PR.

## Review fixes — 16 October 2026

The self-review found three browser gaps: a completed summary edit prevented a
later revision, UTF-16 truncation could split the generated title's final emoji,
and successful creation left the optional summary section showing absence.
Existing browser coverage stopped after the first update, replaced the default
title with short ASCII text, and navigated away immediately after creation.

Three new regressions were added before the fixes. The command
`npm run test:e2e -- tests/e2e/summaries.spec.ts --grep 'summary review regression'`
[failed all three](discussion-summaries-evidence/review-fixes/red/run.json) at the
expected assertions: missing new-revision action, publication acknowledgement after
the invalid generated title, and the missing canonical summary link after creation.
The approved failure bundles and [command output](discussion-summaries-evidence/review-fixes/red-command.txt) are retained.
The same command [passed all three after the fixes](discussion-summaries-evidence/review-fixes/targeted/run.json).

The new-revision test publishes a browser update, reopens the completed editor,
and creates a later administrator revision while that view is open. Starting
another revision fetches that current title, body, mentions and references, and
saves a new request key/base plus whole-declaration carry-forward before retiring
the old local record. Injected fetch and local-save failures leave the complete old
record intact. Keyboard activation, reload, a second browser update and durable
revision 4 are checked; a newly arrived comment remains uncovered. This is an
explicit new draft, never a change to an uncertain publication.

The title case publishes without editing a generated title from 150 ASCII
characters followed by an emoji, and checks the durable valid title. The creation
case checks the canonical summary link, removal of the absent/create state, and
the unchanged discussion route without a reload. The new lookup refresh only
remounts the optional summary section, preserving the publication result and
ordinary discussion interaction.

| Follow-up command | Observed result |
|---|---|
| `npm run check` | Passed docs, bootstrap, hooks, typecheck, 46 application tests and build; [output](discussion-summaries-evidence/review-fixes/check.txt) |
| `npm run test:e2e` | [62/62 passed](discussion-summaries-evidence/review-fixes/browser-full/run.json), including all existing summary and PR #7 legacy cases, with one worker, zero retries and unchanged deadlines |
| `npm run test:summaries:postgres` | [14 passed](discussion-summaries-evidence/review-fixes/postgres-summaries.txt) |
| `npm run test:participation:postgres` | [12 passed](discussion-summaries-evidence/review-fixes/postgres-participation.txt) |
| `npm run test:references:postgres` | [26 passed](discussion-summaries-evidence/review-fixes/postgres-references.txt) |
| `npm run test:browser-diagnostics` | [Passed](discussion-summaries-evidence/review-fixes/diagnostics-command.txt): eight expected child failures and canary/bounds/lifecycle plus four fail-closed validation cases |

The guide, ADR-010 and participation/test memory describe the explicit new-draft
transition and regression boundaries. Root memory's summary overview still matches
the implementation. No API, schema, migration, publication identity or lifecycle
guard changed in this follow-up. Other PostgreSQL suites retain their earlier
results below and were not rerun for these browser-only fixes. No hosted CI or
representative human/provider-agent validation is claimed. At the review checkpoint,
the implementation and fixes were left unstaged and uncommitted.

The sections below retain the original implementation's verification and failure
history; the follow-up results above are the latest browser verification.

## Direct outcome evidence

`npm run test:summaries:postgres` passed [14 tests](discussion-summaries-evidence/logs/summaries-final.txt). The tests
inspect durable rows and complete API responses, not only status codes:

| Supported requirement portion | Observed behavior |
|---|---|
| KNW-01–04/07; AC51/52 | Optional canonical creation, one winner/editor/publication, safe loser, duplicate-free exact retry; explicit human/agent editing rights and administrator reassignment |
| AC10/51/59 source population | A barrier after the single source SELECT permits a new comment and covered edit before preparation finishes; publication still reports one uncovered/one changed, with exact declared/current source routes |
| AC31; OPS-03/05 recovery | Stage-injected rollback leaves no partial summary; browser/API conflict recovery, lost publication acknowledgement, concurrent exact retry, server/client restart and independent cleanup preserve exact identity/membership |
| AC37/55/57 summary containment | Source/summary/discussion/exact suppression and restoration, including both resource guard orders; hidden coverage IDs/counts withheld, independent prose retained, discussion restore does not restore a separately suppressed comment |
| AC38 editor authority | Creator/listed-editor/administrator grants, administrator-only reassignment, editor removal and credential revocation are enforced with attribution and no discussion-author or archivist privilege |
| API-03/04/08 bounded discovery | Oversized full preparation refuses; explicit partial/unknown/work-limited states, owner quotas, byte-bounded pages, caller/filter/boundary mismatch and restart invalidation |
| KNW-03; SRCH-02/06/07 integration | Summary resource/exact references and backlinks; current authored search, native worker interruption/rebuild, discussion-derived placement and no dependence of coverage on indexing |
| AC54 summary prototype portion | Scripted browser create/inspect/update/maintenance, keyboard/narrow layout, preserved drafts and recovery; standalone bounded HTTPS client with no model runtime |
| Existing-data preservation | Populated pre-0010 upgrade leaves text/references/Saved/organization/search/outcome rows unchanged; v1/v2 exact retries retain prior revision and operation identity |

The measured maintenance fixture has 12 summaries, including a discussion over the
100-source limit. A two-item request selected ten candidate summaries and executed
251 SQL statements; the largest returned SQL batch was 120 owner-plan rows (the
independent guard cap is 3,840), while source probes stayed at most 101. Its complete
JSON was 2,991 bytes within an 8,192-byte budget; a one-member page was 1,593 bytes
within 4,096 bytes. UUID order can change which candidates are inspected; these are
observations of this synthetic fixture, not production throughput guarantees.

The standalone client test starts fresh OS processes for prepare/inspect/publication/
status/retry and restarts the HTTPS application twice against retained PostgreSQL.
It preserves exact authored references and coverage identity through acknowledgement
loss. Ordinary restart is distinct from destructive restore recovery.

## Browser and development lifecycle

Four summary Chromium scenarios passed the targeted rerun with the standard one
worker, zero retries, 90-second deadline and normal action/navigation limits. They
exercise create/inspect/partial update/maintenance, administrator editor removal,
keyboard focus/narrow layout, typing during delayed preparation, comparison-fetch
failure, correction-save failure, reload, two tabs, persistent browser restart,
failed preparation and uncertain expired-publication correction. The complete normal
suite subsequently passed all 59 tests, including the PR #7 legacy regressions,
under the same settings. Screenshot inspection found missing coverage-card spacing;
after the focused presentation correction, the complete normal suite again passed
[59/59](discussion-summaries-evidence/browser-full/run.json), with no omissions or
retries. The final [desktop](discussion-summaries-evidence/screens/summary-desktop.png)
and [390-pixel mobile](discussion-summaries-evidence/screens/summary-mobile.png)
screens were visually inspected: the coverage card has readable internal spacing,
wrapped controls and text, and visible source-heading focus. The narrow-layout
assertion also confirmed no horizontal overflow. These are agent inspections of
scripted synthetic screens, not representative human usability observations.

`npm run test:app` (within the final `npm run check`) passed 46 tests, including source-page StrictMode setup/cleanup,
local failed-page retry/focus, account/route response ownership, and coexistence of
partial/unknown/measured gaps. The optional summary section separately exercises
absent, unavailable and failed lookup states with local retry under StrictMode.
These development React tests are separate from the
production browser bundle. Existing PR #7 legacy tests remain in the full suite.

## Required command results

All ten PostgreSQL scripts use isolated real databases. The final results total
179 passing tests (including the runner's nested-test counts); no test is skipped.
The broader suites establish preservation beyond the summary-specific cases above.

| Command | Observed result |
|---|---|
| `npm run check` | Passed docs/baseline, bootstrap, hooks, typecheck, 46 application tests and build; [output](discussion-summaries-evidence/logs/check.txt) |
| `npm run test:migrations:postgres` | [9 passed](discussion-summaries-evidence/logs/migrations.txt) |
| `npm run test:app:postgres` | [9 passed](discussion-summaries-evidence/logs/app.txt) |
| `npm run test:publication:postgres` | [16 passed](discussion-summaries-evidence/logs/publication.txt) |
| `npm run test:identity:postgres` | [22 passed](discussion-summaries-evidence/logs/identity.txt) |
| `npm run test:participation:postgres` | [12 passed](discussion-summaries-evidence/logs/participation.txt) |
| `npm run test:saved-items:postgres` | [10 passed](discussion-summaries-evidence/logs/saved-items.txt) |
| `npm run test:organization:postgres` | [15 passed](discussion-summaries-evidence/logs/organization.txt) |
| `npm run test:references:postgres` | [26 passed](discussion-summaries-evidence/logs/references.txt) |
| `npm run test:summaries:postgres` | [14 passed](discussion-summaries-evidence/logs/summaries-final.txt) |
| `npm run test:search:postgres` | [46 passed](discussion-summaries-evidence/logs/search-final.txt), after the unsupported-kind fixture correction below |
| `npm run test:e2e` | [59 passed on the final UI](discussion-summaries-evidence/browser-full/run.json); same settings as the [earlier complete pass](discussion-summaries-evidence/browser-full-before-spacing/run.json) |
| `npm run test:browser-diagnostics` | [Passed](discussion-summaries-evidence/logs/diagnostics.txt): eight controlled failures, full upload-candidate canaries/bounds, lifecycle and four fail-closed validation cases |

The diagnostic harness intentionally produces a failed eight-probe child run;
its enclosing verification command exits zero only when those failures and the
disclosure/lifecycle checks match the expected contract. Its retained
[approved child evidence](discussion-summaries-evidence/diagnostics/run.json)
is therefore distinct from an ordinary failed browser acceptance run.

## Failure evidence and limits

The [initial six-case database run](discussion-summaries-evidence/logs/summaries-initial-failure.txt) failed a new revocation test that used the wrong
endpoint and search with a duplicate SQL alias. Correcting the fixture endpoint
and source alias produced six passes. The [expanded run](discussion-summaries-evidence/logs/summaries-expanded-failure.txt) then exposed two incorrect
test expectations: owner-plan rows were compared with the source-row cap, and
revocation after HTTP authentication was expected to return 401 rather than the
existing transaction-level safe 404. Separate measured bounds and the actual guarded
refusal are asserted; production guards were unchanged. The next 13-case run passed.

The [initial browser run](discussion-summaries-evidence/browser-initial/run.json)
had three failures: a new fixture used the wrong maintenance action label, another
selected an arbitrary same-kind journal instead of the original key, and summary
legacy correction failed to adopt a v2 comparison base. The first two fixture
assertions were corrected; the composer now applies the existing reference-preserving
correction to summary revisions. The targeted rerun passed all four tests without
changing concurrency/timeouts/retries. Failure bundles remain in that directory.

The [initial full search PostgreSQL suite](discussion-summaries-evidence/logs/search-initial-failure.txt) failed its previous rejection expectation
for `kind=summary`, now intentionally supported. Its unsupported-kind case now uses
`file`; summary acceptance is directly exercised by the summary search journey.

Task-relevant memory was reconciled at root, participation, search and tests scopes
against the final contracts, guard ordering, typed search population and assertions.
ADR-010 records the bounds and single-API continuation assumption. The seed-plan
increase supports the bounded maintenance batch while retaining the existing total
guard cap; reference input limits and diagnostic guards were not relaxed.

Coverage percentages were not measured. As the suite grows, consider a separate CI
coverage gate for the summary modules (initial targets: 80% statements and 75%
branches, calibrated against a measured baseline); keep the behavioral race and
recovery assertions regardless of percentage.

No hosted CI execution, representative human observation, physical passkey device,
provider-agent/model-runtime or cross-machine trial is claimed. KNW-05 change notes
and ordinary change-account metadata, notification/Updates/Following/read delivery,
private notes, files, reservations, full moderation UI, retained-data restore and
production capacity remain open. The listed AC portions do not complete their
broader deferred journeys. The implementation was submitted for review before
finalization.
