# Search and worker verification evidence

Implementation and review verification ran in an isolated managed worktree based on
`9f16709d84427f014e9ab30f00845f4758e3218f`. At the review checkpoint, the original
checkout was clean at `e1f2a9a66a6cf756878c0656000cab43c2747945` and the work was
unstaged and uncommitted. The user subsequently authorized finalization, commit and
PR creation. Existing development data was not migrated or reset.

Environment: Node 24.19.0, macOS arm64, Docker Desktop engine 29.8.2, pinned
PostgreSQL 18.4 in disposable tmpfs containers, actual loopback HTTPS and native
Node workers. Browser runs used Playwright 1.64.0/Chromium 156.0.8078.4.
These are same-machine synthetic checks, not cross-machine agent trials.

## Acceptance evidence

| Behavior | Observed evidence |
|---|---|
| Populated upgrade and initial indexing | `search-worker.test.ts` creates sources before 0007, applies migrations twice and compares retained resources, revisions, scopes, intents, outcomes, editors and Saved rows. Repeated discovery deduplicates the initial work. |
| Claim ownership and source ordering | A native process pauses after preparation through its actual PostgreSQL lease deadline. B reclaims and commits; resumed A changes neither output nor B's job row. Separate R2-before-R1 work leaves R2 indexed. Valid renewal succeeds; expired renewal fails. |
| Atomic finalization and process loss | Deterministic native barriers kill before and after the real output COMMIT. Before-COMMIT work rolls back; after-COMMIT work remains successful and deduplicated. Output associations and job completion are inspected together. |
| Retry and failure recovery | Three attempts/backoff retain failed rows. Ordinary participants cannot inspect/retry them. Repeated administrator retry advances the fence once; an unsupported event/intent pair remains a closed-category failure rather than unrelated successful processing. |
| Stopped/restarted worker | Committed publication/outbox rows survive without index output. Direct exact reads remain available. A restarted built Node worker catches up. The actual synthetic preview command accepts terminal worker stop/start while HTTPS stays ready and removes its temporary resources on shutdown. |
| Rebuild with concurrent publication | Repeated/concurrent rebuild requests converge. A scan interrupted after two batches resumes through a new worker. An edit deliberately targets a source already behind the stored scan cursor; event discovery finds its new revision. A new concurrent artifact is also found. Prior revision bytes, activity, intents and Saved rows are compared after recovery. |
| Shared current search | Actual human cookie and agent bearer clients return identical result identities. Opening/title matching produces one discussion result. Original-author, publisher attribution, date, kind, topic and descendant meanings are asserted. Exact body/browser links identify the matching revision. |
| Current authorization | An unindexed R2 never returns R1 as current. Source/revision/discussion suppression with stale index rows withholds results. Eligible replies and independent quotations survive parent-comment suppression. Restoration works with explicit cursor invalidation. Suspended authors retain publications; revoked callers cannot reuse cursors or status. |
| Placement and preservation | Discussion, artifact and subtree moves change fresh scoped results without reindexing. Old publication event scopes and Saved references remain unchanged. Contribution closure leaves reading/search available. |
| Independent bounds | UTF-8 query/input limits, lexical node limits, 200-match window, UUID ties, multibyte response bytes, cursor owner/query binding, five-minute expiry and API restart are asserted. A real database statement timeout returns 503 rather than empty success. A one-item request still fails above the 5,000-source cap; the retained-job cap refuses discovery without eviction. |
| Browser behavior | Production Chromium exercises exact navigation, query/filter URL state, reload/back, keyboard submission/focus, 390px layout, empty/incomplete states, refresh/pagination, delayed query/page/account responses and administrator rebuild. Searching leaves activity and Saved state unchanged. React development StrictMode is tested separately. |
| Diagnostic safety | Closed route/control/source categories strip query/cursor values. Intentional failure probes verify original failures, canary exclusion, unchanged byte envelopes, lifecycle evidence and fail-closed validation. No raw queries, authored bodies, tokens, storage dumps or unrestricted traces are retained in the approved evidence. |

The absence of read/notification/subscription tables and writers is a code boundary;
these unsupported features are not presented as live integrations. Durable source
and Saved comparisons exercise the implemented side-effect boundaries.

## Initial implementation commands and results

These results precede the review repairs below; they did not exercise the missing
unchanged-row lock wait, split-intent page, unfinished native rebuild or concurrent
authorization interleavings. Passing them did not establish those properties.

| Command | Observed result |
|---|---|
| `npm ci --ignore-scripts` | Installed 217 packages; zero reported vulnerabilities. |
| `npm run check` | Passed document/baseline checks, 64 bootstrap tests, 5 hook tests, 38 application tests, all typechecks and production build. Includes three development StrictMode search tests. |
| `npm run test:search:postgres` | Initial complete suite: 27/27 passed, including native processes and actual 30-second lease expiry. |
| `npm run test:migrations:postgres` | 9/9 passed: additive migration execution, repeatability, rollback/history and role separation. |
| `npm run test:app:postgres` | 9/9 passed: actual runtime/SQL/HTTP, readiness, loss, shutdown and Vite proxy behavior. |
| `npm run test:publication:postgres` | 16/16 passed: retained transaction/authority/COMMIT-tail contracts. |
| `npm run test:identity:postgres` | 22/22 passed: identity authority, lifecycle, credentials and disclosure. |
| `npm run test:participation:postgres` | 12/12 passed: actual HTTPS, exact history, reply traversal and standalone client recovery. |
| `npm run test:saved-items:postgres` | 10/10 passed: private ownership, version ordering, recovery, bounds and client journal. |
| `npm run test:organization:postgres` | 15/15 passed: populated upgrade, hierarchy/placement, source preservation and concurrent publication. |
| `npm run test:e2e -- tests/e2e/search.spec.ts` | 4/4 passed after the fixture correction described below. |
| `npm run test:e2e` | 45/45 passed under normal one-worker, zero-retry settings and unchanged deadlines; approved diagnostics validated. |
| `npm run test:browser-diagnostics` | Passed eight intentionally failing child scenarios, candidate canaries/bounds/lifecycle and four fail-closed validation cases. The verifier exits successfully only when those child failures remain failures. |
| `git diff --check`; changed diagnostic scripts' `node --check` | Passed. |

The new search suite is included in CI; normal browser discovery includes its spec.
No existing check, timeout, retry setting or assertion was weakened.

## Review repairs and deterministic verification

The review found three defects: renewal could evaluate an unexpired lease before
waiting on an unchanged locked row; unsupported intent work could collide with a
revision backfill job and disappear as event discovery advanced; and the browser
author picker used an active-account directory that omitted suspended authors with
readable publications. Inspection found the same lock-wait defect in failure
transitions and the same discovery gap when a batch split an event's intents.

The gaps were missing interleavings and an incorrect fixture population. Earlier
lease tests expired the row before renewal began, discovery fixtures had one intent
per event, and browser author fixtures only used active accounts. Earlier native
COMMIT-loss checks covered completed discovery rather than killing an unfinished
rebuild; authorization tests mutated state between requests rather than while a
page was being constructed.

The new regression files first ran against the reviewed code. The expected renewal
and failure assertions returned true instead of false; unsupported work count was
zero instead of one; and the new author endpoint was absent. The run reported five
failed tests including the parent lease test. The new browser regression also
failed because the suspended author's button was absent after loading completed.
Its approved [run](search-evidence/review-fix-red/run.json) and
[failure bundle](search-evidence/review-fix-red/c7c6520d1ff5a275efb16435f6318f56909389c5f60880080770260aaddaaac7-0-0.json)
were preserved before rerunning. A later typecheck caught an overly generic barrier
release type in the new test harness; it was corrected to `void`.

Renewal and failure now lock the job before checking time and ownership. Additive
0008 records intent identity, narrows revision deduplication to revision work, and
resumes discovery with an event/intent pair. It preserves applied 0007 and existing
job attempts/outcomes/documents while replaying only event discovery. Author
selection now uses a bounded, currently authorized publication-author directory;
it works before indexing, includes suspended authors, and excludes authors with no
readable supported publication. The active-participant directory is unchanged.

| Acceptance behavior | Deterministic evidence |
|---|---|
| Lease expires during a lock wait | `search-recovery.test.ts` observes the actual `pg_blocking_pids` dependency while the lease is live, waits to its stored PostgreSQL deadline, then releases the unchanged row. Both renew and fail return false with the entire job row unchanged. |
| Intent collision and pagination | A 50-intent batch ends between an unsupported and valid intent for one revision. The unsupported job survives backfill collision, remaining intent discovery is reported incomplete, repeated discovery deduplicates, and unsupported pairs retain separate three-attempt failures. |
| Populated 0007 upgrade | Existing successful output and failed work retain IDs, attempts, outcomes and document associations through two migration runs. Bounded replay creates only the previously skipped intent job; immutable sources and Saved rows remain unchanged. |
| Concurrent claims | Two claim calls meet at a query barrier, then claim 25 distinct jobs each. All 50 persisted claims have the expected independent owner, generation and attempt. |
| Unfinished native rebuild | A real child process is killed before and after its second discovery-batch COMMIT while scanning is still incomplete. Restart retains the corresponding cursor/job state, recovers an edit behind the scan cursor and a new publication, completes current coverage, and preserves prior immutable source/Saved rows. |
| Suppression during page construction | Actual HTTPS and application-role SQL barriers cover resource, exact-revision and discussion suppression in both commit orders. A winning suppression produces a closed error with no result metadata; a reader holding source guards completes before the blocked writer. Later cursors fail and fresh pages withhold the source. |
| Revocation during page construction | Actual administrator HTTPS revocation commits between initial authentication and search authorization, or blocks behind an authorized reader. The first ordering denies the page; the second permits that page and denies continuation/status after revocation. |
| Author selection | HTTP checks cover indexing independence, suspended/hidden/unpublished authors, page/byte limits, exact lookup, caller-bound cursors and suppression invalidation. Chromium selects a suspended author by keyboard and retains the filter and label across reload. |

The new recovery/authorization files passed **19/19** after the fixes and added race
coverage. The focused author browser regression passed under the same runner and
deadlines that produced its red result. Full-suite results are recorded below.

| Repair verification command | Observed result |
|---|---|
| `npm run check` | Passed document checks, 64 bootstrap, 5 hook and 38 application/StrictMode tests, all typechecks and production build. |
| `npm run test:search:postgres` | **46/46 passed**, including all new deterministic races and retained native lease/finalization checks. |
| `npm run test:migrations:postgres` | **9/9 passed**. |
| `npm run test:publication:postgres` | **16/16 passed**. |
| `npm run test:app:postgres` | **9/9 passed**. |
| `npm run test:identity:postgres` | **22/22 passed**. |
| `npm run test:participation:postgres` | **12/12 passed**. |
| `npm run test:saved-items:postgres` | **10/10 passed**. |
| `npm run test:organization:postgres` | **15/15 passed**. |
| `npm run test:e2e` | **46/46 passed**, normal one-worker, zero-retry settings and unchanged deadlines; approved diagnostics validated. |
| `npm run test:browser-diagnostics` | Passed eight intentional child failures, upload-candidate canary/bound/lifecycle checks and four fail-closed validation cases. |
| Final document, whitespace and evidence validation | Document checks and tracked/new-file whitespace checks passed; all 12 retained repair diagnostic documents pass their closed validators. At the review checkpoint the staging area was empty and both checkout HEADs were unchanged. Finalization also validated all 24 retained diagnostic documents, including initial implementation evidence. |

Approved repair-run evidence is retained in
[normal browser results](search-evidence/review-fix-normal/run.json) and
[diagnostic probes](search-evidence/review-fix-diagnostics/run.json). The latter's
eight expected failures verify containment. These local runs had no unresolved
application failures; the later hosted navigation failure is recorded below.

Memory reconciliation updates root migration context, `src/server/modules/search/MEMORY.md`
for intent/lease/author invariants, `src/server/modules/participation/MEMORY.md` for
the separate author-directory meaning, and `tests/MEMORY.md` for the real SQL/process
barriers. These claims were checked against 0008, worker/search implementations and
the corresponding durable-row/HTTPS/browser assertions. ADR-006/012, database and
search guides, README and executable guide describe the same contracts.

## Measurements and lexical behavior

The measured corpus contains 215 typed current sources: one overview artifact,
one opening, two comments and 211 other artifacts. Queries return default pages
of 12 through same-machine HTTPS, including authorization/result construction.
Each query has ten samples; the reported p95 is the highest of these ten samples.
The final complete search run observed common-term p50/p95 **50/55 ms** and
artifact/topic-filtered common-term p50/p95 **54/83 ms**. An earlier run observed
50/57 ms and 50/53 ms respectively. Worker correctness fixtures ran in separate
databases during the suite. These small synthetic measurements are not a production
capacity or latency approval.
The complete repair run observed **58/111 ms** and **65/121 ms**, respectively;
migration/publication and browser suites also ran on the same machine. These are
observations under that load, not a before/after performance claim.

Actual PostgreSQL assertions match `running`, Alice, café, Привет, 東京,
`foo_bar`, `foo.bar` and `C++`, while `run`, `runn`, `caf` and 京 do not match
the fixture. This establishes only the tested lexical behavior. It does not
establish universal multilingual segmentation, stemming, substring search or
distinguishing punctuation-heavy language names such as C/C++/C#.

## Failures and corrections

Initial typechecks caught an ES library mismatch for `isWellFormed` (reused the
existing Unicode validator), an unused import, a default batch parameter inferred
as literal 25 (made numeric), and a missing explicit array type in the new limit
fixture. Each was corrected; the final required check passed.
An unprivileged build could not write the managed worktree's generated output;
the same build passed with authorized filesystem access.

Initial StrictMode tests exposed duplicate old-query dispatch during route
transition. Refresh now triggers separately only when the URL is unchanged.
The test environment also needed JSDOM FormData/Event constructors instead of
Node's incompatible constructors. The corrected three tests pass.

The first focused browser run had three passes and one failure at the new
fresh-search scenario. A prior-view indexing notice already satisfied the fixture's
wait, so it entered a new query before navigation finished. The fixture now waits
for the destination result and disappearance of the restart action. Assertions and
deadlines remain unchanged. Its approved original
[run](search-evidence/browser-first-failure/run.json) and
[failure bundle](search-evidence/browser-first-failure/5c9cec1da65688f3f2efb49e7de0587807398bb12a3ada6d87debb3fe866d233-0-0.json)
were preserved before rerunning. The focused rerun and complete normal suite passed.

A tightened HTTP assertion reproduced acceptance of `descendants=false` without a
topic (200 rather than the documented 400). Validation previously checked only
`true`; it now requires a topic whenever the option is supplied. The final complete
search suite passes both forms. The rebuild and revoked-credential assertions also
pass; they were added to cover missing boundary cases, not to change expectations.

Approved normal-run evidence is in
[browser-normal](search-evidence/browser-normal/run.json).
The eight expected diagnostic failures are separately retained in
[diagnostics-validation](search-evidence/diagnostics-validation/run.json).
Those probe failures are successful verification of failure handling, not unresolved
application failures.

## Hosted CI and PR #6 follow-up

The [review of `6934ea2`](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/6#pullrequestreview-5530807988)
found no source-level merge-blocking defect and requested an unchanged CI rerun,
retention of the original failure evidence and an updated hosted-CI summary.
There were no inline review threads or conversation comments at the scheduled
15 October follow-up. Local and remote branch heads both remained
`6934ea2c6322e15fc5e21b3fedac506755aa3953`; the worktree was clean.

The [push workflow](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38709239068)
passed on that head. The [first PR attempt](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38709283437/attempts/1)
tested merge ref `6ef0d4429ab27ea47799ca96de7c15339bd29e9d` on Ubuntu 24.04 x64,
Node 24.19.0 and Chromium 156.0.8078.4. It passed the database/worker suites and
diagnostic verification, but the complete browser suite finished **45/46 passed**.
All five search browser scenarios passed. Migration, retained-service SQL/S3 and
persistence checks were skipped after the browser failure in that attempt.

The [failed run manifest](search-evidence/ci-first-failure/run.json) and
[failure bundle](search-evidence/ci-first-failure/8685ad81a7ac6788948a46bc66e677e697e11351871eec58b5003969fe4fb3c3-0-0.json)
identify `participation.spec.ts:170`, with the failed step at line 45:
initial navigation to `/loom`. The request failed with `network_changed` before
the application shell or enrollment loaded. Capture completed without issues and
context/server teardown completed. This identifies the failure location/category;
the underlying transport cause remains unresolved.

The [second PR attempt](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38709283437/attempts/2)
reran the failed integration job without changing code, assertions, timeouts,
worker count or retry policy. Both workflow jobs passed. Its inspected job log
records runtime **9**, publication **16**, identity **22**, participation **12**,
Saved **10**, organization **15** and search/worker **46** passing tests, followed
by diagnostic verification (eight controlled failures and four fail-closed cases).
The complete normal browser suite passed **46/46**; the
[retained manifest](search-evidence/ci-rerun/run.json) identifies the same merge ref.
Migration **9/9**, retained-service SQL/S3 and stop/start/container-recreation
persistence also passed. Those hosted checks used the ephemeral runner's services,
not existing local development data. A passing rerun closes that immediate
validation gate; it does not establish a repair for intermittent navigation.

Both approved artifacts were downloaded and their ZIP SHA-256 digests verified:

| Artifact | SHA-256 |
|---|---|
| First attempt, `11960227580` | `9771d56c17956b688d6bf3e0e696b9d0c8a097d4308af07e315074915d82d414` |
| Second attempt, `11961316594` | `315e4d979b3021b3b25c7bf9a0248034e780609367283d1d3218f3022df7eacb` |

The five JSON documents, including both approval records, are retained byte for
byte beyond the three-day hosted expiry. The repository's closed validator accepted
both complete candidates and regenerated matching approval records. No raw browser
reports, queries, bodies, tokens, storage or traces are included. This follow-up
changes evidence documentation only; no runtime behavior or test configuration
changed, and no speculative application patch or new regression test was needed.

## Review boundaries

Implementation choices include current-only lexical search, original-author
filtering, explicit selection invalidation and inherited single-API-process cursor
key custody. Multiple worker instances use database claims; this does not establish
multi-API cursor routing. Synthetic source/job/query caps, retention/pruning, real
identity policy and a production operating envelope remain unapproved.

Hosted CI/upload for the implementation head is recorded above, separately from
local execution. Cross-machine agents, physical-device/accessibility studies,
production load and retained-data upgrades/restores remain unverified. Local
development-volume S3 smoke/persistence commands were not run: this task changes
no S3 behavior and does not authorize interruption of existing development services.
The hosted runner's isolated S3/persistence checks passed as described above.

Imported product/architecture digests remain unchanged. ADR-012/006, related ADRs,
guides/backlog and root/scoped memory now describe the implemented subset. The
[search guide](search.md#supported-requirement-portions) states the supported
SRCH-01–07 portions and open work; no broad product acceptance case is marked complete.
