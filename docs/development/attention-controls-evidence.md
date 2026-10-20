# Attention controls verification

Worktree baseline: main `8cf9048d25e9ac45905ff0333f47bc6e799c8979`, newer than the
handoff's PR13 baseline. PR14/15 reading cleanup and sibling-key fixes are preserved.
All test execution uses Node 24.19.0, macOS arm64, disposable Docker PostgreSQL and fixture
HTTPS/Chromium. Existing development data and credentials are untouched. No hosted
CI run has been dispatched for this unstaged change.
The original implementation runs are recorded below; the later review corrections
and their separate verification are recorded at the end.

**Current status, 20 October:** the latest review repaired a P2 dismissal-recovery
gap by sharing canonical input comparisons across the journal and controls, without
rewriting saved command bytes. Sixteen new regressions failed before the fix and
passed afterward; an additional pending-journal concurrency regression also passes.
The final application check, 16 native suites, full128 Chromium run, diagnostic
verifier and disposable storage checks pass. Final self-review found no remaining
actionable issue in this pass. The independent session/content/settlement effects
and query dispatch leases remain intact. Earlier stopped reviews remain historical
evidence, not current status.

## Direct acceptance evidence

`tests/integration/attention*.test.ts` checks complete independent event/delivery
sets, populated 0016 all-prior-table digests and old tokens/retries, initial negative
fences, original/current replay, atomic overlap under actual owner guards, both
source/revision/credential guard orders, source privacy, parent-only suppression,
late delivery, continuing claims/new notes, event-time moves and old unknown impacts.
It separately tests selection expiry/custody loss, exact complete paths, pagination,
quotas/rollback and native process death after COMMIT with replacement credentials.
The digest comparison across attention mutations covers every non-attention table,
including reading, Saved, Following, publications, both clocks, claims/deliveries
and summary coverage; retrieval custody is exercised separately.

Nine `web/attention.test.tsx` StrictMode cases passed: durable-before-dispatch,
monotonic lookups, both cross-target conflict/success response orders, failed saves,
late route/account responses, absent-status uncertainty, exact group retry/Undo and
bounded stale-tab recovery, total journal bytes and first-dispatch versus uncertain
retry expiry. The existing 87 application/contract/web cases also passed
before these additions; the final normal check passed 96 application/contract/web
cases. Broader results appear below.

The focused compiled run passed 11/11 cases (`attention.spec.ts` plus `updates.spec.ts`)
with the normal one-worker, zero-retry runner. It checks keyboard Undo and stable
viewport, independent mute after restore, all-retained exact revision links,
failed-save prevention, COMMIT response loss/reload/exact retry, later revision
eligibility, stale tabs and sign-out behind a real Web Lock. Existing tokenless
nondefault gap, ready unknown-history baseline, expansion/reload and fixed-bound
Updates cases exercise the new default routine contract. Approved run metadata is
in [focused-browser/run.json](evidence/attention/focused-browser/run.json).

The final complete normal browser run passed 106/106, including the additional
legacy compatibility case. It reopens a saved v1 view with its original Following
scope after Unfollow, alongside separate v2 custody with the current empty scope.
Workers, retries and deadlines are unchanged. Approved metadata is in
[full-browser/run.json](evidence/attention/full-browser/run.json).

Rendered 1440px desktop and 390px narrow states were inspected after keyboard restore;
text and controls wrap, the Undo focus indicator remains visible and complete
retrieval stays discoverable. Recoverable synthetic captures:
[desktop](evidence/attention/attention-desktop.png),
[narrow](evidence/attention/attention-narrow.png). These are scripted Chromium
observations, not representative human/device/provider acceptance.

## Measurements and failures retained

An actual 101-record discussion refuses whole-card selection rather than truncating.
Its explicitly selected 100-member command measured 21,799 request UTF-8 bytes,
25,080 response bytes and11,115 selection bytes; PostgreSQL outcome storage was
4,224 bytes in the final run (4,240–4,254 in two earlier runs). The batch, refresh, list traversal and
restore sequence measured 989–1,675ms in two earlier runs and 5,074ms in the final run while other suites
were active (not isolated query latency or a production capacity claim). The final remaining routine set was independently
asserted as exactly the omitted input. An 803-byte Unicode mute list fit 4KiB; a 5,385-byte deep-path list refused that
budget without skipping its first entry, then succeeded at the larger budget.
Capacity-counter injection checks retention
ceilings; it does not claim 50,000 actual stored decisions or representative load.

A new expiry test first failed: attention_refresh inherited the generic recovery
bypass and accepted an expired descriptor. The old suite had no attention action,
and the new tests initially checked selection expiry separately. The minimal fix
required explicit renew before attention refresh. That regression subsequently
passed, but review found that this separation deadlocked when policy changed too;
the review correction below supersedes that descriptor-renewal decision. A second first-failing StrictMode
case exposed a definite first-dispatch expiry remaining unconfirmed indefinitely.
It now becomes explicitly dismissible refusal feedback; the companion uncertain
retry case still retains exact custody. Both passed.

The first 16-case PostgreSQL run passed 15 and rejected one new fixture's v2 edit
against an existing v3 source, correctly returning change_format_required. The
fixture now retains explicit v3 fields. The new sizing fixture also initially
exceeded the existing 160-unit title or 12-level hierarchy constraints, and its
discovery assertion expected numeric 12 instead of the declared string. Those
fixtures now stay inside existing limits; no guard or contract was relaxed. Subsequent new-case failures corrected
oracles that used display filter names instead of direct_reply/main_mention and
expected an artifact move wholly outside a muted ancestor to be hidden. A further
fixture tried to attach a revision note to a reply, which the preserved publication
contract correctly rejected; it now uses an artifact revision. These are fixture
corrections, not weakened product assertions or claimed product regressions.

The first focused Updates browser run passed 7/8 and failed while its expiry helper
decrypted a version 2 token with version 1 AAD. The fixture now names version 2; the
next normal focused run passed 11/11. Approved failed diagnostics were copied before
the rerun to [updates-first](evidence/attention/updates-first/run.json). This failure
is distinct from the server descriptor-expiry regression above.

The first full browser run completed 105 cases: 103 passed, two Following cases failed
because the new mute descendant label also matched the existing Include subtopics
locator. The focused attention tests had only artifact controls, and existing
StrictMode Following fixtures did not advertise the new feature. The mute label is
now distinct (Mute descendant topics), preserving the existing tests unchanged.
Approved failures are retained in [full-first/run.json](evidence/attention/full-first/run.json).
The next full run completed 106 cases: 105 passed, including every Following case.
The newly added legacy-browser compatibility case failed because its zero-card
assertion could pass during the new routine request, before recovery was saved.
Approved request lifecycle evidence showed that query still in flight. Two focused
trials then exposed the same readiness helper inspecting the prior route before
the new contract rendered, skipping bounded preparation. The fixture now waits for
the rendered contract and saved page before preparing, then for the displayed empty
result before inspecting storage. It changes no runtime behavior or old-scope/
contract assertion. The focused compatibility case subsequently passed 1/1.
These failed runs are retained in
[full-legacy-first](evidence/attention/full-legacy-first/run.json),
[legacy-second](evidence/attention/legacy-second/run.json) and
[legacy-third](evidence/attention/legacy-third/run.json); the focused pass is in
[legacy-focused](evidence/attention/legacy-focused/run.json).
The final full browser run passed 106/106 under the normal conditions. The outer
diagnostic verification also passed; its eight child failures are intentional.

## Completion checks and scope

- `npm run check`: passed (docs, bootstrap units, hooks, typechecking, 96 application/
  contract/web cases and production build).
- `npm run test:attention:postgres`: passed 24/24. Actual measurements are in
  [attention-results.json](evidence/attention/attention-results.json).
- Existing PostgreSQL suites passed 217/217, run sequentially through their unchanged
  package scripts: Updates 23, reading 15, Following 18, notifications 16, participation 12,
  Saved 10, changes 12, references 26, summaries 14, organization 15, publication 16,
  identity 22, application 9 and migrations 9. See
  [postgres-regressions.json](evidence/attention/postgres-regressions.json).
- `npm run test:e2e`: passed 106/106 under the complete normal runner.
- `npm run test:browser-diagnostics`: passed, including eight controlled child
  failures, complete upload-candidate canary/bounds checks, lifecycle assertions
  and four fail-closed validation cases. See
  [diagnostics-result.json](evidence/attention/diagnostics-result.json) and
  [approved child run](evidence/attention/diagnostics/run.json).
- Final fixture edits also passed application/server/test typechecking; final
  documentation/link checks and `git diff --check` passed. No files are staged.

CI adds only the focused attention suite; existing migration, SQL/S3 and persistence
steps, workers/retries/deadlines and approved-artifact validation are retained. The
closed diagnostic vocabulary gains only fixed route/spec names; private query/body
values remain excluded. Hosted CI/upload were not run for this unstaged work. The
local SQL/S3 and development-volume restart commands were not rerun: this increment
changes no storage adapter or bootstrap/persistence scripts and the task authorizes
isolated synthetic state only. Disposable migration/application persistence tests
above did run.

These checks cover the implemented attention portions of product §12.3, AC43/46,
ATT/MEN/API/privacy/recovery scenarios. They do not close compound acceptance
scenarios or an absent requirements workbook. Limits are finite/no-eviction
synthetic choices; retained-data/erasure, destructive restore, multi-API-process key
custody and representative human/provider/cross-machine trials remain unapproved.
No production deployment, files/packages/attachments, private notes, reservations,
full moderation management, timed snooze, push/email/webhooks, automatic
acknowledgement, universal reviewed flag or recommendation inference is included.

Memory reconciliation: root guide/status and affected Following/notifications
open-feature claims were compared with migration 0017, private services, v2
retrieval and exact test assertions. The new scoped attention memory owns details;
Updates, participation and tests memories retain integration/compatibility pointers.
Imported product/architecture/design and prior evidence are unchanged.

Suggested later CI work: establish measured line/branch coverage and fail on any
decrease from that baseline. Keep behavioral assertions as the acceptance evidence;
this increment makes no measured coverage-percentage claim.

## Review corrections — 18 October 2026

The follow-up fixes the four reviewed defects without staging or committing the
increment. It preserves the original task scope, private ownership, immutable
commands, current authorization, independent state and complete retrieval.

| Finding | Regression and correction |
|---|---|
| Undo adopted newer dismissal versions | The StrictMode exact-retry case now returns original result version 1 alongside current version 3, and requires Undo to save/send expected version 1. The old client instead performed a lookup to rebase. Undo now uses original applied result versions. Chromium applies restore/re-dismiss between the original action and Undo, verifies version 3 remains dismissed after conflict, then verifies an explicitly prepared new choice. |
| Expiry and changed policy caused a recovery loop | A PostgreSQL/HTTPS case expires the descriptor, changes mute and Following settings, and publishes later activity. It first failed with `updates_descriptor_expired` after renewal had required attention refresh. Explicit attention refresh now renews an expired descriptor within the unchanged custody deadline while preserving scope, definitions, reason and both intervals. Complete retrieval returns only the captured original revision. History gaps and expired custody still refuse recovery. Dismissal-selection expiry is unchanged. Chromium exercises the actual renewal/refresh buttons after reload. |
| Initial settings mutes stayed disabled | The StrictMode settings-page case first failed because Unmute remained disabled. A stronger follow-up assertion exposed that merely clearing loading still discarded a newer lookup version. Applying the initial snapshot before starting the mount lookup fixes both; the mutation uses the newer returned version. Chromium verifies keyboard Unmute immediately after first loading settings. |
| Conflict acknowledgement stranded the card | The StrictMode case first failed because the mounted card had no dismissal action after acknowledgement. Only applied results now occupy the saved-result UI; retained conflict custody gates new preparation until acknowledged. The test then prepares and saves a fresh command with a new key and reviewed version. Chromium verifies this on the same card after stale Undo conflicts. |

All four regression oracles failed against the unfixed code and passed after the
repairs. The full attention StrictMode file passed 11/11. Existing tests missed the
bugs through an incorrect Undo oracle, expiry tested without policy change, and
missing initial-settings/dismissal-conflict interaction coverage.

Local checks executed for this correction:

- `npm run check`: passed, including 98 application/contract/web tests,
  typechecking and production build.
- `npm run test:attention:postgres`: passed 25/25, including the new expiry/policy
  case and the existing selection-expiry, independent-state, authorization,
  delayed-delivery, atomicity, quota and recovery checks.
- `npm run test:updates:postgres`: passed 23/23, preserving legacy contracts,
  frozen intervals, custody, guard ordering and native recovery.
- `npm run test:e2e`: passed 109/109 under the complete normal runner, including
  all seven attention cases. See the [approved run](evidence/attention/review-fixes-browser/run.json).
- `npm run test:browser-diagnostics`: passed, including eight intentional child
  failures, full upload-candidate canary/bounds and lifecycle checks, and four
  fail-closed validation cases. The [approved child run](evidence/attention/review-fixes-diagnostics/run.json)
  records those intentional failures; the outer verification passed.

The initial full-browser launch did not execute because automatic approval review
timed out. Its permitted retry passed normally; this was a launch interruption,
not an observed browser-test failure. No guards, deadlines, workers or retries were
changed. Hosted CI and the broader unrelated PostgreSQL/SQL/S3/persistence commands
were not rerun for these corrections; their earlier results remain separate above.

The guide, ADR-027 and attention/Updates/tests memory now describe original-version
Undo, actionable conflict/settings recovery and explicit descriptor refresh within
existing custody. The earlier renew-first design is superseded because simultaneous
policy change and expiry made it unusable. No API shape, migration, selection-token
expiry, retention quota or complete-feed meaning changed.

## Second review corrections — 18 October 2026

The next four findings are corrected within the same unstaged increment. Exact
commands, owner authorization, original Undo version fences, fixed intervals,
Complete retrieval and independent mutes/reading remain preserved.

| Finding | Regression and correction |
|---|---|
| Partial routine membership passed as a complete card | The real PostgreSQL/HTTPS regression creates 101 personal inputs in one group. Filtered members, reasons and selection now refuse an absent projection, a 100-of-101 partial scan and a ready projection for an earlier policy. All three reads require ready attention custody at the cursor policy version before source reads. `updates_attention_preparing` (409) directs same-selection preparation/refresh. Complete still returns all 101; after preparation, whole-card selection refuses the cardinality and an explicit 100-input subset succeeds. The browser recovery test sends overview refresh rather than retrying incomplete member reads. |
| A cursor switch stranded pending dismissal preparation | The StrictMode regression changes the cursor on the same mounted card before the first selection response arrives. The stale response is ignored, busy state clears, and another explicit preparation uses the new cursor. A subsequent switch also clears the unconfirmed selection. Saved commands remain independent. Chromium holds the old real selection response across Highlights-to-Complete switching. |
| Successful Undo never offered Dismiss again | Successful restoration now keeps feedback separately from the saved dismissal and focuses a fresh Dismiss action without scrolling. StrictMode repeats Dismiss/Undo/Dismiss on the same card, requiring a fresh selection/key and reviewed version 2; original-version Undo remains covered separately. Chromium exercises the keyboard sequence and verifies desired states true/false/true at versions 0/1/2. |
| Mutation/recovery access failures retained cached mute details | A shared failure callback withdraws source/overlap details and feedback and invalidates earlier lookups on unavailable, forbidden, invalid-actor or unauthenticated responses. StrictMode exercises first dispatch, status and uncertain retry, then releases an older successful lookup and checks that it cannot restore metadata. A fresh successful lookup may reauthorize it; the original command and rejected/uncertain classification remain intact. Chromium suppresses the actual source before mutation and verifies metadata withdrawal and retained refusal custody. |

The new regression oracles failed against unfixed code: six new attention UI
cases failed while the prior eleven passed, and the PostgreSQL projection case
received HTTP 200 where refusal was required. After correction, attention UI tests
passed 17/17 and Updates UI tests 12/12. The earlier tests covered only ready
projections, route unmounts, Undo submission or conflict, and lookup access errors;
they omitted these preparation and successful-recovery transitions.

During red testing, failed assertions comparing complete React DOM objects caused
test reporting to stall. One still-running test child was stopped; boolean presence
assertions then produced the expected failures normally. The first standard check
also caught an unsupported Testing Library `exact` option in the new test; it was
removed. Neither issue required changing production guards or test deadlines.

Local checks executed for this correction:

- `npm run check`: passed, including 105 application/contract/web tests, 64 bootstrap
  tests, 5 hook tests, typechecking and production build.
- `npm run test:attention:postgres`: passed 26/26, including projection readiness,
  version matching, independent state, authorization, atomicity and native recovery.
- `npm run test:updates:postgres`: passed 23/23, including legacy pre-attention
  fixtures, fixed intervals, concurrency guards and native recovery.
- `npm run test:e2e`: passed 112/112 under the complete normal runner, including
  all ten attention cases. The [approved run](evidence/attention/second-review-fixes-browser/run.json)
  records zero retries and no omitted tests.
- `npm run test:browser-diagnostics`: passed eight controlled child failures,
  complete upload-candidate canary/bounds and lifecycle assertions, and four
  fail-closed validation cases. The [approved child run](evidence/attention/second-review-fixes-diagnostics/run.json)
  records the intentional failures; the outer verification passed.
- Final document checks and `git diff --check`: passed. The index remains empty.

These are local synthetic checks. Hosted CI and the broader unrelated PostgreSQL,
SQL/S3 and development-volume persistence commands were not rerun for this
correction; their earlier results remain separate above. No guards, worker counts,
retry policies or deadlines were changed. No staging or committing was performed.

The executable guide, developer guide, ADR-027 and attention/Updates/tests memory
were reconciled against the source and regression assertions. Root memory and
README retain accurate feature summaries; no extra change was needed there for
this correction. No schema, migration, quota, retained command shape, source clock,
delivery identity or complete-feed meaning changed.

## Third review corrections — 18 October 2026

The four remaining browser findings are corrected in the unstaged increment.
Exact saved commands, original Undo versions, private ownership, independent state
and complete retrieval retain their existing meaning.

| Finding | Regression and correction |
|---|---|
| Delayed mutation metadata restored a withdrawn preview | Three StrictMode cases hold first-dispatch, status and retry results across a newer unavailable lookup. Results now settle safe settings only and keep the completion-triggered lookup live. Old titles and overlap details stay withdrawn; a fresh authorized lookup can restore them. Chromium holds an actual committed mutation response, suppresses the source, completes the newer lookup, then releases the old response and verifies the final lookup remains effective. |
| Parent list snapshots bypassed withdrawal | StrictMode holds list responses across both an authorization refusal and a newer unavailable lookup at the same private version. List snapshots now trigger fresh lookup instead of supplying preview metadata. Chromium holds the real list and subsequent revalidation responses around source suppression and checks that the old title never returns. |
| Global recovery failures retained settings previews | The settings page now withdraws its protected page and fences outstanding list requests on access refusal from shared recovery. StrictMode covers status and retry, immutable uncertain intent, delayed lists and later fresh authorization. Chromium revokes the actual browser participant's credentials, checks global recovery, and releases the earlier list without restoring the protected controls. |
| New overlapping groups omitted recovery controls | Matching records are derived from the bounded journal on render, including after preparation discovers new input identities. The card exposes the original command and blocks replacement confirmation. StrictMode verifies no replacement dispatch and exact retry. Chromium starts an overlapping retained-history traversal with a different group ID, then retries only the saved original command and verifies its persisted input/version. |

The eight new StrictMode oracles failed against the unfixed code while all prior
17 tests passed. After correction, the attention file passed 25/25. These tests
address missing response-path and changing-overlap coverage; the earlier tests
fenced lookup replies but not mutation replies, parent snapshots or global
recovery, and only matched recovery against the original group. The four added
Chromium cases were run after the repair and are separate integration evidence.
An initial typecheck caught a self-referential test-helper parameter annotation;
renaming the parameter corrected it before the successful standard check.

Local verification on Node 24.19.0/macOS arm64 with disposable PostgreSQL/HTTPS:

- `npm run check`: passed 113 application/contract/web tests, 64 bootstrap tests,
  5 hook tests, typechecking and production build.
- `npm run test:attention:postgres`: passed 26/26, including source/credential
  races, exact recovery, independent state, atomicity, quotas and complete sets.
- `npm run test:updates:postgres`: passed 23/23, including frozen intervals,
  legacy compatibility, grouping custody and native recovery.
- `npm run test:e2e`: passed 116/116, including all 14 attention scenarios, with
  zero retries or omitted tests under the complete normal runner. See the
  [approved run](evidence/attention/third-review-fixes-browser/run.json).
- `npm run test:browser-diagnostics`: passed eight controlled child failures,
  upload-candidate canary/bounds and lifecycle assertions, and four fail-closed
  validation cases. The [approved child run](evidence/attention/third-review-fixes-diagnostics/run.json)
  records the intentional failures; the outer verification passed.
- Final document and diff whitespace checks passed; the index remains empty.

The browser guide, ADR-027 and attention/tests memory now distinguish private
setting versions from source visibility and describe fresh preview authorization,
global recovery withdrawal and newly discovered overlap recovery. Root memory,
README and the API guide remain accurate without further changes. No API schema,
migration, retained-command shape, quota, clock or complete-feed meaning changed.
No guards, retry policies, workers or deadlines were weakened.

Hosted CI and the broader unrelated PostgreSQL/SQL/S3/development-volume persistence
commands were not rerun for these client fixes. These are local synthetic checks,
not production or cross-machine acceptance. Nothing was staged or committed.

## Fourth review corrections — 18 October 2026

This correction addresses the three remaining Updates interactions. It preserves
the existing server contracts, frozen selection bounds, exact command custody,
original Undo versions and independent source/delivery/reading/private state.

| Finding | Regression and correction |
|---|---|
| An attention refusal left the enclosing card visible | Mute and dismissal controls report access failures and unavailable-source results to Updates. The view withdraws its overview and expansion, fences pending reads and queued recovery saves, and permits explicit fresh authorization. Four StrictMode cases cover mute lookup/mutation and dismissal preparation/mutation while a page is pending; exact refused commands and previously saved traversal requests survive. Another case holds an older member response across a new reauthorization request, verifying that its completion cannot release the newer request's busy guard. Chromium suppresses the actual source while member retrieval is held, checks the enclosing card/expansion withdrawal, then restores the source and explicitly replays without losing the command. |
| A recovered subset blocked dismissal of a mixed group's remaining inputs | The latest applied receipt retains its originating selection separately from the current card. After an explicit refresh, remaining inputs can be reviewed and dismissed while the original receipt's Undo keeps its original versions. StrictMode recovers A from a new A+B group, refreshes, and sends a new command containing only B. Chromium publishes B, recovers A exactly, prepares the same view through another client, then refreshes the still-mounted card and dismisses only B. Both persisted input rows have independent version 1. |
| An older page cleared a newer attention-change notice | Page loads capture the attention-event generation and clear the notice only if no later event occurred during the read/save. StrictMode covers local mutation completion and another tab's storage event, followed by an explicit successful refresh. Chromium holds an actual ready page response across a committed mute, verifies the notice remains, and refreshes with unchanged traversal identity and shared/personal bounds. |

The first seven new StrictMode cases failed against the unfixed code while the
12 existing Updates cases passed. The additional member-completion ownership case
was added after the repair. The final focused attention/Updates run passed 45/45.
The earlier tests checked isolated control previews, stopped immediately after
overlap recovery, or omitted policy changes during page transport. A multi-step
attention refresh can remount the card and conceal the stale-receipt bug; the new
browser overlap case deliberately exercises an already prepared projection.

The first complete normal browser run passed 116/117. The existing keyboard Undo
case failed its unchanged viewport assertion after the new identity disclosure was
removed on restoration. The receipt now retains the last restored identities too,
avoiding that extra height collapse. The [initial approved run](evidence/attention/fourth-review-fixes-initial-browser/run.json)
and its failed-case diagnostic are retained. No test tolerance, worker, retry,
deadline or execution guard was weakened.

Local verification on Node 24.19.0/macOS arm64 with isolated PostgreSQL/HTTPS:

- Final `npm run check`: passed 121 application/contract/web tests, 64 bootstrap
  tests, 5 hook tests, typechecking and production build.
- `npm run test:attention:postgres`: passed 26/26.
- `npm run test:updates:postgres`: passed 23/23.
- Final `npm run test:e2e`: passed 117/117, including all 15 attention cases,
  with zero retries or omitted tests under the complete normal runner. The
  [approved run](evidence/attention/fourth-review-fixes-browser/run.json) is retained.
- `npm run test:browser-diagnostics`: passed eight controlled child failures,
  upload-candidate canary/bounds and lifecycle assertions, and four fail-closed
  validation cases. The [approved child run](evidence/attention/fourth-review-fixes-diagnostics/run.json)
  records the intentional failures; the outer verification passed.
- Final document and diff whitespace checks passed; the index remains empty.

The public guide, ADR-027 and scoped attention/Updates/tests memory are reconciled
with the enclosing-view withdrawal, receipt ownership and event-ordering behavior.
Root memory, README and the executable API guide remain accurate without further
changes. No API, migration, retained-command shape, quota or independent state
semantics changed. Hosted CI and broader unrelated PostgreSQL/SQL/S3/development-
volume persistence checks were not rerun for this client correction. These are
synthetic local checks, not production or cross-machine acceptance.
Nothing was staged or committed; the correction stops for user review.

## Fifth review corrections — 18 October 2026

The four remaining findings concern parent privacy boundaries, changing source
membership, selection recovery and completion after same-owner navigation. The
corrections preserve exact saved commands, original Undo versions, fixed traversal
bounds, independent private state and safe removal of known unavailable entries.

| Finding | Regression and correction |
|---|---|
| Embedded controls did not invalidate their parent views | Following propagates mute source/access failures through its control to the collection, removing cached titles/paths and fencing older list responses. Settings propagates child credential/access failures to all previews, while source unavailability alone retains safe Unmute/Restore. StrictMode holds parent lists across both failures and checks exact uncertain command retention, fresh unavailable Unfollow, and unavailable settings restoration. Chromium uses actual source suppression and credential revocation while older HTTPS list responses are held. |
| Expanded source inputs could retain a previous Complete selection | Dismissal preparation is fenced by the explicit shared/personal input identities as well as the group cursor. StrictMode checks both a prepared choice and an outstanding lookup, preserving a choice on an equivalent rerender. The Updates host and Chromium replace a Complete shared+personal source with its routine personal-only representation on the same event. The old confirmation disappears and the new command changes only the personal delivery. |
| Preparation errors offered no appropriate view recovery | Changed-policy, unfinished-projection and descriptor-expiry errors now reach Updates' explicit refresh/renew actions. StrictMode tests each code with a pending unseen successor and verifies recovery uses the displayed token and budgets before new preparation. Chromium creates a real remote policy change, then checks explicit refresh preserves traversal identity and both stream bounds. |
| A completion after route navigation silently left the new view stale | Successful decisions notify the current identity even when their originating control has unmounted; component liveness still gates its own state. StrictMode checks same-owner navigation separately from identity invalidation, including zero policy notifications after identity invalidation. Chromium holds mutation dispatch before COMMIT, navigates away and back so the new view loads old policy, then verifies the late completion clears the journal, updates mute state and offers selection refresh. |

The first eight new StrictMode oracles failed against the unfixed code while all
55 prior tests passed. They then passed after the repair. Two further cases cover
pending source lookup replacement and safe unavailable settings removal; existing
new cases were strengthened with pending parent lists and unseen successors. The
final focused attention/Updates/Following command passed 65/65. A strengthened
assertion initially matched both legitimate error alerts; scoping it to the expected
credential message corrected that test ambiguity. These additional assertions and
the five Chromium cases are post-fix preservation/integration evidence, not new
claims of pre-fix red results.

The first complete normal browser run passed 121/122. The new selection-recovery
test compared the sent cursor to a separately reissued inspection token; AES-GCM
encoding gives that token a fresh nonce. Its exact-token assertion now compares
against the displayed page's saved request. The product correctly retained that
original cursor. The [initial approved run](evidence/attention/fifth-review-fixes-initial-browser/run.json)
and its failed assertion diagnostic are retained. The complete suite was rerun after
this oracle correction, without changing execution conditions or product code.

The second complete run also passed 121/122; all five new cases passed. An existing
lost-response/reload case failed because its unscoped Attention settings locator
matched both the navigation and in-page links after reload. It now selects the
named Community navigation region and waits for scope refresh to be enabled after
returning to Updates. Its exact-command and later-revision assertions are unchanged.
The [second approved run](evidence/attention/fifth-review-fixes-second-browser/run.json)
and failed selector diagnostic are retained. This is a demonstrated test-selector
ambiguity; no product repair or relaxed timing/retry condition was inferred from it.

The prior tests exercised isolated previews, cursor changes instead of explicit
source-input changes, or navigation together with sign-out. They did not exercise
the remaining parent boundaries, preparation-to-recovery callback, or same-owner
unmount/completion ordering. No server contract, migration, command shape, quota,
clock, complete-feed meaning, execution guard, retry policy or deadline changed.

Observed local checks on Node 24.19.0/macOS arm64 with isolated PostgreSQL/HTTPS:

- `npm run check`: passed 131 application/contract/web tests, 64 bootstrap tests,
  5 hook tests, typechecking and production build.
- `npm run test:attention:postgres`: passed 26/26.
- `npm run test:updates:postgres`: passed 23/23.
- `npm run test:following:postgres`: passed 18/18.
- Final `npm run test:e2e`: passed 122/122, including all 20 attention cases,
  with zero retries or omitted tests under the complete normal runner. The
  [approved run](evidence/attention/fifth-review-fixes-browser/run.json) is retained.
- `npm run test:browser-diagnostics`: passed eight controlled child failures,
  upload-candidate canary/bounds and lifecycle assertions, and four fail-closed
  validation cases. The [approved child run](evidence/attention/fifth-review-fixes-diagnostics/run.json)
  records the intentional failures; the outer verifier passed.
- Document and diff whitespace checks passed; the index remains empty and HEAD
  remains `8cf9048d25e9ac45905ff0333f47bc6e799c8979`.

The public attention/Following guides, ADR-027 and scoped attention/Updates/Following/
tests memory now describe these parent boundaries, source membership, recovery and
notification ownership. Root memory, README and the executable API guide remain
accurate without additional changes. Hosted CI and broader unrelated PostgreSQL/
SQL/S3/development-volume persistence checks were not rerun for these client fixes.
Local synthetic results do not establish production, representative human or
cross-machine acceptance. Nothing was staged or committed; the correction stops
for user review.

## Authorization boundary — 19 October 2026

The task replaces optional host privacy callbacks with a mandatory authorization
context, covering each attention host and lookup, preparation, mutation, status,
retry and Undo paths. Preserve exact commands and original Undo versions, safe
unavailable Unfollow/Unmute/Restore, fixed traversal positions/budgets, independent
private state and server contracts. Stop for review without staging or committing;
a new P1 in the final self-review requires stopping repair and examining its cause.

The previous full-artifact self-review failure showed that isolated controls could
withdraw their own previews while leaving enclosing text visible. The gap was an
unenforced embedding contract plus independent read lifetimes. The boundary now
owns the protected subtree and a shared read generation. Attention controls require
that context; source refusal withdraws the content host, while settings invalidate
preview generations and retain safe private removal state. Owner refusal enters the
existing shell identity fence, including late refusal after same-owner navigation.
Older identities cannot revoke a replacement identity. Withdrawal runs before
journal settlement locks; exact commands can remain uncertain if the identity fence
prevents a local rejection write. A confirmed source-unavailable result can settle
its journal without reauthorizing source metadata.

Full-source page components own their boundaries. Community overview has one around
its embedded artifact and proposal form. The final host inventory is eight: area,
discussion, artifact, Community overview, Following, Updates, Mentions/replies and
attention settings/global recovery. The earlier seven-host inventory counted only
direct artifact-route use and missed the overview embedding. Required context
failed closed there during the complete browser suite; placing ownership in the
source components avoids dependence on selected route callers. Updates retains its
bounded attempted expansion request outside the withdrawn subtree so fresh retry
reauthorizes the saved overview before that expansion. Missing individual revisions
keep independently authorized retained history.

Regression evidence is layered: a StrictMode matrix covers mute/dismiss lookup,
mutation, status and retry against source refusal, owner refusal and unavailable
success results, plus group preparation, immediate withdrawal behind blocked Web
Locks, late-owner refusal, prior-identity isolation and missing-context refusal.
Actual Following, Updates, notification and settings hosts add pending parent reads,
queued saves, global recovery, Undo and safe removal assertions. Chromium exercises
real source suppression and credential revocation on full-source hosts, including
all four mute transport paths and exact-command recovery. This is shared-path
coverage plus host integration, not every response permutation on every route.

Three full-source Chromium cases were first run against the unfixed code; all failed
because the enclosing heading remained visible after source suppression. The
[approved red run](evidence/attention/authorization-boundary-red/run.json) is retained.
The initial focused run passed 19/24: the new source withdrawal assertions passed,
but repeated sign-in in three credential fixtures hit the existing active-session
cap; the fixture now restores the credential and reloads instead of creating more
sessions. A known-unavailable Following entry with no mute state incorrectly withdrew
on its mute lookup's 404; an explicit source-only exception preserves safe Unfollow.
A delayed-settings-list case timed out because the new generation fence discards
that response instead of using it to request fresh previews; the test now explicitly
requests fresh lookup after asserting the old list cannot restore metadata.
[Initial focused diagnostics](evidence/attention/authorization-boundary-initial-browser/run.json)
are retained; no session limit, runner guard, retry policy, worker count, timeout or
asserted privacy guarantee was weakened.

The first complete browser run also exposed a temporary Following recovery control
that lost the collection's known-unavailable state during Unfollow dispatch. Its
mute lookup hid the completion feedback, although Unfollow committed. A focused
StrictMode regression reproduced the withdrawal, then passed after the recovery
control inherited the collection state. Existing overview/proposal browser cases
exposed the missing indirect boundary described above. These corrections preserve
safe removal and existing artifact/proposal behavior rather than changing their
acceptance criteria. The initial application check passed 178 tests; after the
additional Unfollow regression, the application suite passed 179 tests and
source/test typechecking passed. Final execution and self-review results follow.

The first complete run finished 119/126, with one Following dispatch-feedback
failure and six overview/proposal failures. Its [approved diagnostics](evidence/attention/authorization-boundary-first-full-browser/run.json)
are retained. After the corrections, `npm run check` passed with 179 application
cases, 64 bootstrap cases, 5 hook cases, typechecking and the production build.
That pass predates the additional failing self-review regression below.

### Self-review stop: P1 source-visibility exception survives reauthorization

A settings page can load two mutes while their parent topic is unavailable, then
freshly authorize both previews after restoration. If the parent becomes unavailable
again, refreshing one control still treats it as known unavailable because
`initial.source.state` has not changed. `MuteControl` skips the host generation
invalidation even though its preview was authorized in the meantime. Its own title
is removed, but the sibling's title/overlap preview stays visible. The StrictMode
regression `a source restored after an unavailable settings snapshot cannot bypass
later host withdrawal` fails at the sibling-withdrawal assertion. This is a new
review finding, left unfixed in accordance with the user's P1 stop instruction.

The cause is incomplete ownership of authorization decisions: the shared boundary
owns rendering and read cancellation, but controls can still suppress withdrawal
using a stale presentation prop. Safe private removal eligibility and current source
visibility are distinct facts. The known-unavailable exception conflates them, and
response-path tests from a single initial visibility state did not exercise the
restoration/revocation sequence. The recommended next change is to centralize
source-visibility transitions as well as cancellation, keep removal eligibility
independent, and extend acceptance to sequences of visibility changes with sibling
and pending reads. This recommendation is not an implemented repair or new approval.

With the failing reproducer retained, the current `npm run check` fails: 179 of 180
application tests pass, with this one assertion failing. Documentation, bootstrap,
hooks and typechecking pass; this invocation stops before its build step. The
production build passed immediately before adding the test, with the same product
source. No further product edits were made after the finding. The source-level
self-review stopped at this P1; it does not certify that no other issues remain.

Affected PostgreSQL checks completed successfully against isolated fixtures:
`test:attention:postgres` 26/26, `test:updates:postgres` 23/23,
`test:following:postgres` 18/18 and `test:notifications:postgres` 16/16.
They cover retained independent identities, source/owner races, fixed bounds,
private recovery and native process/credential continuity; they do not exercise
this browser-only stale exemption. All 83 passed without changing their guards.

The complete browser rerun passed 127/127 with zero retries and no omitted tests;
[approved run metadata](evidence/attention/authorization-boundary-browser/run.json)
is retained. This run started before the separate self-review browser case was
added. That new case was then run through the same normal runner with an explicit
name filter and **failed at the expected sibling-title assertion**. The fixture
suppresses the actual common parent topic, restores it and explicitly refreshes
both mute previews, then suppresses it again. A fresh HTTPS lookup confirms the
sibling's source is unavailable; refreshing the first control removes only its own
title, while the sibling title remains. There were no pending requests at capture.
The [approved failing self-review run](evidence/attention/authorization-boundary-self-review/run.json)
and bounded failure diagnostic are retained. Current source therefore has both a
failing StrictMode reproducer and a failing real Chromium/HTTPS reproducer. The
127-case pass is broader preservation evidence, not a claim of a green final diff.

`npm run test:browser-diagnostics` passed the outer verifier: eight controlled
child failures, full upload-candidate canary/bounds and lifecycle assertions, and
four fail-closed validation cases. The [approved controlled child run](evidence/attention/authorization-boundary-diagnostics/run.json)
records its intentional failures. Final document and tracked/untracked text
whitespace checks passed. The index is empty and HEAD remains
`8cf9048d25e9ac45905ff0333f47bc6e799c8979`.

ADR-027, the public attention/Following/Updates/notification guides, root README
and memory, and attention/Following/Updates/notifications/participation/tests memory
were reconciled with the boundary, safe-removal exception, host inventory and
recovery behavior. Attention/ADR/tests notes explicitly retain the unresolved P1;
they do not weaken the intended withdrawal requirement to match the failing code.
No server contract, schema, quota, command shape or source/delivery clock changed
in this boundary increment. These local synthetic checks do not establish hosted
CI, production, representative-human or cross-machine acceptance. Broader unrelated
PostgreSQL, SQL/S3 and development-volume persistence suites were not rerun.
Nothing was staged or committed. Implementation remains stopped for review because
of the confirmed P1, with both new failing reproductions left in the diff.

## Boundary-owned visibility transitions — 19 October 2026

The next authorized increment addresses that confirmed P1 structurally. The brief
is to move visibility transitions into the boundary while preserving safe removal,
exact command custody, original Undo versions, owner isolation and fixed traversal
bounds. Exercise repeated transitions, siblings and pending responses through every
attention response path; run the relevant checks and self-review, then stop without
staging or committing. Server contracts, schema, quotas and retained data are unchanged.

`AuthorizationBoundary` now consumes validated private collection, lookup, selection
and command responses. It records only target identities/availability, up to the
sum of the existing retained mute/Follow caps. A first unavailable collection entry
can preserve safe removal. Fresh available evidence closes that exception; a later
negative attention response invalidates the shared generation. At capacity, new
targets remain protected without evicting known exposure. Controls no longer pass a
known-unavailable Boolean or decide whether an attention response revokes access.
Updating that Boolean locally was rejected because the same authority must cover
sibling controls, recovery and enclosing content, including remounted controls.

Fresh mute reads are sequenced per target and carry their authorization generation
through the caller's await. Settings and preview state are separate: source fencing
can preserve stripped private settings from a pending read under the same owner,
but never grants that response a preview lease. Fresh preview authorization is not
ordered by the private choice version. Mutation/status/retry/Undo results pass
through the boundary before journal settlement; an old result can settle the exact
command without changing current visibility. Owner refusal still fences the shell
immediately, including after same-owner navigation and behind blocked journal locks.

Private collection snapshots are the initial unavailable authority. Positive Follow
lookups close an existing exception; negative nested Follow lookups cannot create
one for their enclosing full-source page. Following still performs independent row
replacement. Initial-unavailable Unfollow passes, but the final checks below found
that available-to-unavailable removal does not preserve its confirmation. No
arbitrary control prop can reopen a withdrawal exemption.

The previous StrictMode sibling-withdrawal failure was rerun during review (62/63
focused cases passed, that case failed). The updated source passes it. Eight new
mute cases cover lookup/mutation/status/retry, source refusals and unavailable
success results through repeated restoration/withdrawal. Their initial run exposed
remaining sibling/overlap elements in all eight cases; plural absence assertions
now count all matching elements instead of using a singular query. Twelve dismissal
cases cover lookup, group selection, mutation, status, retry and Undo after repeated
restoration, with source refusals and unavailable success. Held sibling lookups and
lists cannot restore previews. Three delayed command cases settle exact custody
across two source fences; two same-turn response orders preserve their own read
generation. Two Following cases exercise independent reauthorization and the nested
negative-lookup boundary. The latter failed before the initial exception was limited
to collection observations, then passed after correction.

The first implementation run passed 125/127 focused cases: discarding an entire
stale mute response stranded two independent private controls. Retaining only its
safe settings corrected those failures. The next run passed 126/127: a higher private
version from a pending response incorrectly vetoed a fresh source preview. Separating
private settings and authorized previews corrected that remaining failure. These
failures informed the final boundary model; no assertion or privacy requirement was
weakened to match it. Before the final self-review regressions, `npm run check` passed all 207 application/contract/UI
tests, 64 bootstrap cases, 5 hook cases, typechecking, documentation checks and the
production build on Node24.19.0/macOS arm64.

Initial sandboxed PostgreSQL/browser fixture startup failed because local Docker
access was denied; no product assertion ran in those fixtures. The six-case browser
[failed-start diagnostics](evidence/attention/visibility-sandbox-start/run.json) are
retained. The isolated reruns used the required local Docker/Chromium permissions.
All affected PostgreSQL suites passed: attention26/26, Updates23/23, Following18/18,
Mentions/replies16/16 (83 total). Their server/native source is unchanged by this
increment. No existing development data or credentials were reset.

The [focused Chromium run](evidence/attention/visibility-focused-browser/run.json)
passed 6/6, including four full-source hosts and Following. The settings scenario
cycles actual parent suppression/restoration through lookup, mutation, status and
retry in one mounted view, holds real sibling/list responses across each withdrawal,
and finishes with successful safe Unmute. Status/retry use an actual committed
decision whose response is deliberately lost. No retry, worker, timeout or diagnostics
bound was increased; the complete browser population remains 128 tests.

The complete normal browser run finished **127/128 passing**, with no omitted tests
or retries. All attention cases passed, including the repeated real-parent scenario.
The existing `following.spec.ts:20` failed its unavailable Unfollow confirmation at
line49. Its approved capture shows the temporary recovery mute lookup returning
unavailable, Follow state returning200, and the whole view replaced by an alert.
[Approved complete-run metadata and failure evidence](evidence/attention/visibility-full-browser/run.json)
are retained; this is an unresolved regression, not a green browser result.

Self-review then reproduced two failures with real components in StrictMode:

- **P1:** after available Following rows and mute previews are rendered, a fresh
  Follow lookup returns unavailable. `AuthorizationBoundary.observeRead` only
  remembers available Follow results; the row removes its own title but two mute
  previews and a sibling title remain. Held old mute/list responses leave the same
  exposure. The new test asserts zero exposure and observes two previews/one sibling
  both before and after releasing pending responses.
- **P2:** after the same available-to-unavailable transition, Unfollow creates a
  temporary recovery control. Its new mute lookup returns404; because the boundary
  still remembers available, it withdraws the whole host. The exact Follow command
  settles successfully, but its success confirmation disappears. The separate
  StrictMode test confirms an empty journal and missing success feedback, matching
  the failed browser assertion.

The focused new cases fail2/2 for those expected reasons. No product code was changed
after identifying the P1, following the user's instruction to stop and reflect.
The root cause is incomplete ownership of source visibility: the boundary processes
attention responses centrally but still delegates negative Follow lookup effects to
the row. Safe private state and protected Following metadata also share one render
lifetime. Treating a negative Follow as an exemption would mask protected metadata;
unconditionally withdrawing that lifetime would discard safe removal and feedback.
The proposed follow-up is to separate Following private state/confirmation from
metadata leases and route every source-bearing Follow result through the boundary.
This proposal has not been implemented.

The test gap was integration coverage: prior negative Follow tests checked row
replacement without attention enabled, or started with an unavailable collection.
The host/response matrix drove attention endpoints, not the other producer of the
same metadata. The new regressions combine available Follow and mute state, a Follow
withdrawal, sibling/pending responses and recovery mounting. Self-review stopped at
this P1; it is not a claim that no additional issues remain.

`npm run test:browser-diagnostics` passed the outer verifier: eight intentional child
failures, upload-candidate canary/bounds and lifecycle assertions, and four fail-closed
validation cases. The [approved controlled run](evidence/attention/visibility-diagnostics/run.json)
records those expected child failures. Runtime/source and diagnostic bounds were not
weakened. Root/attention/Following/tests memory, ADR-027 and the public guide retain
the unresolved gaps rather than weakening the privacy or safe-removal requirement.

The final `npm run check` with both self-review regressions retained fails at
application tests: **207/209 pass**, and exactly these two cases fail. Documentation,
64 bootstrap cases, 5 hook cases and all typechecking pass before that stage. The
command does not reach its build step. The prior full check built the identical
product source successfully; only tests and explanatory records changed afterward.
The focused new-case command was
`node --import tsx --test --test-name-pattern='unavailable Following lookup revokes|available-to-unavailable Following removal' tests/web/following.test.tsx`.
The complete browser check was the unfiltered `npm run test:e2e`; the focused6/6
run used `--grep 'settings reauthorization|Following withdraws enclosing|authorization boundary withdraws'`.
All runs used the pinned Node24.19.0 environment. This is local synthetic evidence,
not hosted CI, production or cross-machine acceptance. Broader unrelated database
and development-volume persistence suites were not rerun. No backend behavior,
schema, quota, private command shape or source/delivery clock changed in this increment.
The original stale-prop case is fixed, but the task's complete privacy/safe-removal
acceptance remains unmet because of the stopped Following integration. The index
remains empty and HEAD is unchanged at `8cf9048d25e9ac45905ff0333f47bc6e799c8979`.

## Following visibility and private recovery — 19 October 2026

The follow-up brief is to move every Following visibility transition into the
authorization boundary, fix the two retained privacy/removal regressions, and keep
safe private removal/confirmation independent of metadata. Preserve full-source
withdrawal, identity fencing, immutable commands, versions and recovery custody;
exercise repeated transitions, siblings and pending responses through collection,
lookup, mutation, status and exact retry. No staging or committing is authorized.

The root cause was split ownership: the boundary observed attention metadata while
Following rows handled negative Follow results locally. The same private-page render
lifetime also held safe removal and protected source text. `AuthorizationBoundary`
now validates and observes all Following response paths. Its typed interface returns
private settings separately from collection/lookup metadata and their response
generation; command results return no source metadata. Following renders titles,
paths and source links only under a current lease. Source withdrawal leaves private
rows and removal usable, while full-source pages still withdraw their entire content.
Owner failures withdraw private views as well. This preserves the established
owner-held unavailable-removal contract (LC-20261016-82ZK), including no retained mute.

Private version merging is independent of metadata freshness. Old decisions can
settle exact custody without restoring metadata or replacing newer choices. The
boundary processes source evidence before a journal lock can block completion.
Confirmation is copied to the private page before retiring a temporary recovery
control. Same-owner completion can notify a replacement view; another identity cannot.
The initial unavailable-collection exception applies only to private settings hosts.
No backend contract, schema, quota, source/delivery clock or journal format changed
in this follow-up. Reconsider these interfaces when adding another source producer
or response path; both metadata withdrawal and safe private settlement remain the
acceptance criteria.

The retained privacy and removal tests were rerun before implementation and failed
2/2 for the documented reasons. A new 15-case response matrix also ran before the
fix: 13 failures and 2 passes. Its failures showed missing shared withdrawal or loss
of private controls. The previous gap was cross-producer integration: tests drove
attention endpoints or began with an already unavailable Following collection,
without combining available Follow/mute previews, a negative Follow response and
temporary recovery mounting.

The expanded `tests/web/following.test.tsx` now passes **65/65**, with 40 new cases
in this follow-up. It covers all five response paths against source refusal, owner
refusal and unavailable success; four Follow paths on protected source hosts;
ten restoration/withdrawal cycles in one mounted private view; both same-turn
collection/lookup completion orders; delayed mutation/status/retry receipts across
two fences; off-page removal confirmation and not-recorded custody; conflict/new
version removal; late owner failure after navigation; and blocked completion while
newer metadata/private state arrives. Existing tests retain attention sibling and
known-unavailable removal coverage. These are rendered StrictMode assertions, not
just calls to the boundary class.

During implementation, exact-optional TypeScript errors and a parent/control
feedback loop were corrected. The looping test process was interrupted; it was not
a successful check. Identity-preserving merges stopped that loop. A repeated-cycle
fixture initially clicked a button disabled by its own held lookup; it now completes
only that control's lookup before dispatch while keeping sibling reads held.
The first complete check stopped at a nullable browser button-label expression;
that expression was corrected. The subsequent complete `npm run check` passed
64 bootstrap, 5 hook and **249 application** cases, all typechecks, documentation
validation and production build on pinned Node24.19.0/macOS arm64.

Affected PostgreSQL checks passed: `test:attention:postgres` **26/26**,
`test:updates:postgres` **23/23**, `test:following:postgres` **18/18** and
`test:notifications:postgres` **16/16** (83 total), using isolated synthetic databases.

The focused normal browser command was `npm run test:e2e -- --grep
'Following withdraws enclosing|Follow/edit/unfollow|authorization boundary withdraws'`.
The [first run](evidence/attention/following-boundary-focused-first/run.json) passed
5/6: a discussion credential-refusal case lost its button before dispatch as an
independent read observed revocation. The test now captures the intended request
before revoking the synthetic credential and asserts its actual refusal response.
The [second run](evidence/attention/following-boundary-focused-second/run.json) passed
5/6: approved diagnostics show a route-handler failure during held Follow-lookup
release, followed by assertion interruption during teardown. The auxiliary lookup
gate now delays dispatch rather than copying its response; actual old list/mute
responses remain held across withdrawal. That timing change is not evidence of a
product fix or an established transport cause. The
[third focused run](evidence/attention/following-boundary-focused/run.json) passed
**6/6** with the normal worker, retry, timeout and diagnostic bounds unchanged.
The original real Unfollow confirmation passed in all three runs. Expanded browser
cases cover Following response paths on all four source hosts and actual parent
suppression/restoration with siblings, held responses and safe final removal.

The first complete normal browser run finished **127/128**. Its single failure is
the Undo/viewport case at `attention.spec.ts:306`, but the
[approved fixture trace](evidence/attention/following-boundary-full-first/run.json)
records only `server_starting`, then failed server setup and cleanup: no test-body
assertion or browser request ran. This corrects the initial progress inference from
the test name that a focus assertion had failed. The startup cause is unconfirmed;
the evidence does not establish a product defect or a pre-existing harness defect.
All five expanded attention/Following cases and all existing Following cases passed.
An unchanged, unfiltered normal-suite rerun is used to check the remaining case;
an isolated pass would not replace this failed complete run's evidence.

The [unchanged complete rerun](evidence/attention/following-boundary-full/run.json)
passed **128/128**, with zero omissions and zero retries. The previously unexecuted
Undo case passed its keyboard, focus, viewport and narrow-layout assertions. This
establishes a successful normal run, not a diagnosed fix for the earlier startup
failure. Both approved full-run records remain available.

Self-review traced every Following request producer and source render, boundary
observation ordering, shared generations, repeated restoration, identity replacement,
private-version merging, blocked completion and exact journal settlement. It found
no additional P1 or other actionable correctness/privacy/recovery issue in this
follow-up. The original two regressions now pass in StrictMode and real Chromium;
the widened matrix addresses the cross-producer gap that earlier attention-only
coverage missed. Full-source withdrawal and safe private removal/confirmation are
separate tested behaviors. Future source-bearing endpoints still need to use the
boundary and extend that response-path matrix; this is not a claim of universal
absence of defects.

Current documentation and root/Following/attention/tests memory were reconciled with
the final interfaces, render guards and test assertions. Earlier failure records in
this report remain historical evidence. The scope is local synthetic verification;
no hosted CI, production, provider-agent or cross-machine acceptance is claimed.
Broader unrelated database and development-volume persistence suites were not rerun.

The final `npm run test:browser-diagnostics` outer verifier passed: eight controlled
child failures, complete upload-candidate canaries/bounds and lifecycle checks, plus
four fail-closed validation cases. The
[approved controlled run](evidence/attention/following-boundary-diagnostics/run.json)
retains those intentional failures. Final documentation and whitespace checks pass.
No staging or commit was performed; the index is empty and HEAD remains
`8cf9048d25e9ac45905ff0333f47bc6e799c8979`.

## Revocation independent of lookup freshness — 19 October 2026

The follow-up brief is to separate authorization revocation from request freshness,
test overlapping Follow/mute lookups and pending responses across their hosts, run
the relevant checks and self-review, and stop on any further P1. Safe private
removal/confirmation, exact recovery custody, identity isolation and fresh
reauthorization remain required. No staging or committing is authorized.

The preceding review found that the per-target latest-request token also guarded
negative authorization evidence. A second lookup starting or completing therefore
caused the first lookup's unavailable result or404 refusal to be ignored, leaving
metadata visible. Dispatch order cannot order server authorization snapshots. Moving
responses into one boundary had corrected ownership but retained this ordering error.
The response-path/sibling matrix missed supersession between reads of the same key.

`AuthorizationBoundary.readAuthorized` now determines the live authorization
generation independently of the request eligible to publish. Every current-generation
negative response is observed, subject to the established known-unavailable removal
exception. Superseded positive responses contribute no availability evidence. The
resulting fence invalidates existing and pending leases before publication decisions.
Already revoked generations cannot revoke fresh metadata; owner refusals preserve
their identity scope. This changes no backend contract, journal, private version or
command-settlement rule. ADR-027 and the scoped Following/attention/tests memories
record the distinction; root memory's ownership summary remains accurate.

Before the product fix, all 16 new rendered StrictMode cases failed on retained source
metadata. They cover Follow/mute, unavailable results/404 refusals, both completion
orders, and private/full-source hosts. Afterward they pass, including delayed siblings
and lists, safe Unfollow, fresh reauthorization and another withdrawal in the same
mounted view. Six additional cases preserve old-generation isolation and prevent
discarded positive evidence from closing a safe-removal exception. The three focused
web suites passed 175/175. An initial helper change selected temporary recovery controls
instead of existing rows and caused three unrelated assertions in that run to fail;
the helper now preserves the row selector for private hosts. This was a test-fixture
correction, not a product recovery fix.

The first `npm run check` stopped at an unsupported Testing Library `exact` option
in a new test. After removing it, the complete command passed 64 bootstrap, 5 hook and
271 application cases, typechecks, documentation and production build on pinned
Node 24.19.0/macOS arm64. The affected PostgreSQL commands passed 83/83 against
disposable fixtures: attention 26, Following 18, Updates 23 and notifications 16.

The [focused normal browser run](evidence/attention/revocation-focused/run.json)
passed 7/7. Its real HTTPS barriers hold the first dispatch, capture the newer
available response, suppress the source, then deliver the older refusal before the
pending success. Follow and mute are exercised on area/discussion/artifact/overview
and Following hosts; mute is exercised on Updates and settings. Settings also checks
sibling withdrawal and safe Unmute. Mentions/replies contains dismissal controls,
whose existing boundary/pending-page checks remain in the complete suite. Existing
browser cases were extended without changing workers, retries, deadlines or
diagnostic bounds.

The [complete normal browser suite](evidence/attention/revocation-full/run.json)
passed **128/128**, with no skipped or omitted cases. The diagnostic outer verifier
passed its eight controlled child failures, upload-candidate canaries/bounds,
lifecycle checks and four fail-closed validations; the
[approved controlled run](evidence/attention/revocation-diagnostics/run.json) retains
the intentional failures. Final documentation and whitespace checks passed.

Self-review found no further P1. It traced successful and failed reads through
authorization-generation checks, negative observation, publication freshness and
caller awaits; checked latest-token cleanup in both completion orders; and checked
safe-removal exceptions, identity boundaries and independent command settlement.
The red/green overlap cases and real reversed server-read order directly address
the prior gap. This is local synthetic verification, not production, hosted CI or
cross-machine acceptance. Unrelated database and development-volume persistence
suites were not rerun. No staging or committing occurred; the index is empty and
HEAD remains `8cf9048d25e9ac45905ff0333f47bc6e799c8979`.

## Endpoint response classification — P1 stop, 20 October

The requested pass binds successful response classification to HTTP method and
endpoint, observes Saved/Reading source denials before settling private receipts,
and checks the catalogue against every registered JSON operation and negative
success field. Optional caller schemas cannot select revision-miss semantics.
The user approved preserving only a fresh successful response's own authorized
projection after consuming its embedded denial. Saved uses lease-gated metadata
while retaining private membership and Unsave. Opaque hosts retain whole-view
withdrawal; they cannot adopt the exception without isolating response-owned fields.
ADR-027 and the developer guide record that scope and limitation.

The original added Saved matrix failed49/49 before the fix and passed49/49 after
it. It covers eight hosts and lookup/list/state/status/replay/conflict paths, plus
withdrawal before a blocked journal settlement. Additional tests cover Reading
lookup/receipts and fresh mixed projections with older settled/pending siblings.
The catalogue's first run exposed a missing nested Search operational-state field
and an unescaped route-matcher dot; its corrected run passed2/2. Test fixtures using
nonexistent protected endpoints were moved to real routes. The optional-summary
test now checks the documented conservative fallback for an ambiguous source miss.

`npm run check` passed documentation,64 bootstrap,5 hook and671 application tests,
typechecks and the production build. This pass preceded the new failing self-review
regression. Ten Docker PostgreSQL suites completed with182/182 passing tests: app9,
publication16, identity22, participation12, Saved10, organization15, search46,
references26, summaries14 and changes12.

The extended real Saved browser case pre-saves both mounted targets so a lookup404
cannot mask a successful unavailable-source receipt. Its first run stopped at a
fixture SQL-column error before the denial assertion; that run is not red evidence
for the Saved bug. The fixture was corrected. The rebuilt Saved browser suite then
passed0/11: all cases failed during sign-in setup, before the acceptance scenarios.
Normal one-worker, zero-retry settings and existing deadlines/bounds were retained.
Approved captures each contain62–63 identity/self401 responses, with further events
dropped at the existing diagnostic cap. No raw screenshots are claimed.

**New P1:** `independentRequest` sends an ordinary unauthenticated identity probe
to `observeRequestFailure`, which unconditionally announces another identity
change. The shell responds by probing again. This prevents stable anonymous
discovery and disrupts registration/sign-in. The added
`anonymous identity probes settle without announcing another identity change`
regression fails with3 announcements instead of0.

The root cause is a remaining protocol conflation: successful-payload meanings are
endpoint-specific, while errors still share one global code-based revocation rule.
Session discovery must settle anonymous state separately from revoking established
authority. The new catalogue test proves route/negative-field coverage, not session
lifecycle correctness. The next correction needs explicit endpoint error disposition
and idempotent session transitions, preserving late credential/source denials and
private receipts. Ignoring all401 responses would not meet that requirement.

Implementation stopped after this P1 was confirmed; the regression remains failing.
The native runner finished its active suite and stopped before the remaining six.
The full browser suite, browser-diagnostics verifier, remaining PostgreSQL suites,
SQL/S3 integration and persistence were not run after the stop. Whitespace checks
passed; HEAD is unchanged and the index remains empty. This implementation is not
ready for approval. Exact logs, approved captures and a source/build manifest are
retained with the standalone `classification-review-stop.md` evidence artifact.


## Session discovery and authority revocation — 20 October

The task separates anonymous discovery from revocation while preserving source
withdrawal, exact command bytes, safe removal, private receipt settlement and the
approved bounded-response exception. No API, schema or persistence change is needed.
The server protocols already distinguish discovery of the cookie session from
registration/sign-in proof validation and identity-record lookup. The closed endpoint
catalogue now assigns an explicit error policy as well as successful-field meanings.
Transport consumes each error once; the duplicate view error classifier is removed.
A separate discovery fence rejects pending positive probes overtaken by anonymous
observations. Losing established authority still revokes every retained host once;
the next anonymous probe does not announce another identity change.

The existing anonymous regression failed with three announcements rather than zero.
The new production-shell regression failed because two StrictMode probes scheduled
a third probe. All forty host/path cases reached the genuine withdrawal, then failed
because the follow-up anonymous probe advanced identity again. Ceremony failures
also reproduced incorrect revocation. Initial JSDOM runs needed CSS loading and
dialog-method adapters; those harness failures are not behavioral red evidence.
The first post-fix run exposed three catalogue declarations missing their new
required policy argument; these were corrected. The targeted run then passed206/206
(session, client, catalogue, Saved and query-authorization cases). The full normal
`npm run check` passed:64 bootstrap,5 hook and725 application tests, typechecks,
document checks and production build.

All sixteen Docker PostgreSQL suites passed306/306. The expanded Chromium
participation journey passed its bounded anonymous-discovery checks and real
registration/sign-in. The already-running complete browser suite finished119/128 passing,9 failing,
under the normal one-worker, zero-retry runner with unchanged deadlines.

Self-review then confirmed a P1. Closing a discussion for publication returns
403 forbidden from `ParticipationPublications.open` while leaving the participant
and source readable. `classifyError` still maps forbidden to revoke-owner;
`observeRequestFailure` advances identity before `Composer.send` can settle the
known rejection. `IntentStore.settle` refuses with `AbortError: Identity changed`,
leaving the exact command uncertain. The retained request bytes survive, but the
normal correction/recovery transition is blocked. The new focused client regression
reproduces this failure. It was added after the725-test full check; the current suite
therefore contains a known failing regression and has not been rerun as a passing check.

Root cause: endpoint-specific routing still uses an overbroad authority disposition.
Session validity, source readability and permission to perform an action are distinct
facts. Revoking displayed content must not automatically change private journal
ownership. The next correction should reserve identity invalidation for actual
session/actor loss and allow action refusals to settle exact private outcomes while
applying the appropriate content withdrawal. No post-review implementation fix or
assertion weakening was applied. The earlier matrices covered withdrawal on forbidden
but missed the command's subsequent rejection settlement through the real shell.

No further checks were started after the P1. Browser-diagnostics verification and
SQL/S3 integration/persistence were not run; the prepared disposable storage runner
was never started and created no services or volumes. The containing browser runner validated its approved failure bundles. Failures
are three organization cases, three participation cases and three Saved cases. The
P1 case is `participation.spec.ts:525`, failing at the draft-preservation assertion
on line667. Its approved capture records POST replies403 followed by identity/self200
within6ms, confirming the session remains valid. The focused client regression
isolates the failed journal transition. Other failures were retained without further
triage after the P1 stop; none is claimed fixed or dismissed as a flake.

Actual logs, approved captures, pre-stop build/source hashes, final source snapshots
and the review note are retained in the standalone `session-review-stop.md` artifact
and sibling `session-review/` collection. The repository evidence is a concise
summary; no raw Playwright attachments or secrets were promoted. HEAD and the empty
index are unchanged; nothing was staged or committed.


## Action refusal, journal settlement and capability loss — 20 October

The requested outcome was to separate an action refusal from identity revocation,
preserve exact private settlement, repair the nine browser failures, run all local
and Docker checks, and stop on any new P1. Saved command bytes, first-dispatch versus
uncertain-retry meaning, current source denial, safe removal and previous-owner
fences were preservation requirements. No staging or commit was authorized.

The known publication regression first failed again with `AbortError: Identity
changed` in IntentStore settlement. Action endpoint policies now preserve the owner;
refused reads still withdraw content. The focused session/client/catalogue run
passed99 tests. Expanded all-host cases exercise blocked Web Locks, exact first
rejections, uncertain retries, pending content and pending private receipts. The
host matrices now name discussion's actual projections policy.

Two browser causes required supporting changes. Onboarding and proposal-route
responses now certify readable-but-closed posting with optional
`unavailable_reason: publication_closed`; unqualified unavailable remains a source
denial. The native organization test suppresses the same closed destination and
requires the hint to disappear. Discussion traversal uses response-owned leases
for query values, retained collections and imperative reply pages, preserving a
fresh structural marker without reauthorizing older bodies or pending responses.
Unavailable rows do not immediately refetch their body. Saved quota fixtures retain
500 real tombstones in a separate discussion, avoiding unrelated unpublished
structural placeholders in the discussion whose reply/recovery controls are tested.
The quota, cross-tab and exact-command assertions remain intact.

The focused normal Chromium run passed13/13, including all nine previously failing
cases. One worker, zero retries and all normal deadlines/bounds were retained.
`npm run check` passed760 application tests,64 bootstrap tests,5 hook tests,
typechecking and build. After the host-matrix update, test:app again passed760/760.
The first check failed an old mute assertion that expected forbidden to discard the
owner and leave a first rejection uncertain; it now checks retained private
rejection with withdrawn metadata. PostgreSQL participation initially failed an
old exact closure-response assertion; the corrected assertion checks the new hint,
and its complete12-test suite then passed. These are recorded failures, not flakes.

At the review stop, nine PostgreSQL suites had passed170 tests: app9,
publication16, identity22, participation12, Saved10, organization15, search46,
references26 and summaries14. The remaining changes, notifications, Following,
Updates, reading, attention and migrations suites were not started after the stop.
The already-running summaries suite finished normally. SQL/S3 integration and
stop/start/container-recreation persistence passed in a fresh owned Compose project;
cleanup removed only its disposable resources. Existing development data and
credentials were not reset. Standalone browser-diagnostics verification was not
started after the P1. The complete browser command was already running and finished normally; its final
result is recorded below.

### P1: administrative refusal retains role-protected data

The new regression in `tests/web/session-authorization.test.tsx` loads the same
account query used by the production Admission component, receives403 forbidden on
an administrative command, and settles the exact first rejection. The identity
and command body remain unchanged, but the cached administrator-only account is
still displayed. Its withdrawal assertion fails (`true !== false`).

This is supported by current server guards and an executed native identity case:
`requireAdministrator` protects both account listing and administrative operations;
demotion leaves identity/self valid while audit, account listing and reconciliation
are forbidden. The issue is cached protected content after observed capability loss,
not unauthorized new server reads. `response-contracts.ts` currently maps forbidden
on both action policies to local, so transport never tells the content coordinator
about the lost administrator capability.

The root cause is an overbroad inference introduced by this repair: keeping identity
ownership was treated as permission to keep content. Posting closure and loss of an
administrator role have different read implications. The new action matrix used
generic protected text and encoded that mistaken assumption, missing a capability
shared by the action and its cached projection. Exhaustive route coverage does not
prove the semantic meaning of a refusal.

The next boundary design needs independent identity, content/capability and private
settlement effects. Ambiguous role refusals can withdraw content conservatively
while preserving journal ownership and exact settlement. Only evidenced local
posting restrictions should retain independent content. This is a recommendation,
not an implemented correction or approval to bypass current source rules.

Repairs stopped immediately after the failing regression confirmed this P1. No
runtime code was changed afterward; memory/evidence now identify the current
blocker. The earlier settlement P1 is repaired, but this diff is not ready for
approval. No full application check was rerun after adding the retained failing
review regression. No staging, commit, push or history rewrite occurred.


The final full Chromium command exited1:127 passed and1 timed out from128 planned
and completed cases. All nine earlier failures passed again. The remaining case is
`attention.spec.ts:11`, diagnostic ID
`af98a0cb9d17de54eb12790d351341d62324389d143a00e0ad7bfa9a5c343b2a`,
with duration90216ms. The approved capture is complete with no capture issues;
391 earlier events and170 reporter steps were omitted by the existing bounds.
Its cause was not investigated or repaired after the P1 stop, and it is not claimed
to be unrelated or flaky. Normal worker/retry/timeout settings were unchanged.

The administrative regression was tightened to validate its synthetic command
against the actual AccountInput schema and rerun in isolation. It still fails only
at cached-account withdrawal after successful exact rejection settlement. Source
snapshots, raw ordinary test logs, both review failures and approved browser JSON
are retained in `action-refusal-review-stop.md` and its sibling
`action-refusal-review/` artifact collection. These are implementation evidence,
not a separate completed security scan. Whitespace checking passed and the index
remains empty; the new failing regression means the final diff is not all green.

## Independent authority effects and continued self-review — 20 October 2026

The user replaced the earlier P1 stop rule with fixing findings during self-review
and asked for a refactoring assessment. The brief remains to separate action refusal
from identity revocation, preserve exact journal settlement and safe removal, repair
browser failures, run all local checks with Docker, and stop for review without
staging or committing. Existing imported requirements and architecture bytes remain
unchanged; implementation guidance and scoped memory describe the supported change.

A focused structural change was warranted. The old action/identity-action categories
coupled three independent decisions: current session identity, cached content access
and private receipt custody. Endpoint policies now state session, forbidden and
unavailable effects explicitly. Role/editor-dependent refusals withdraw older content
without replacing the journal owner; ordinary posting closure retains independent
reads. Current server guards substantiate that distinction. Reverting every403 to
identity revocation would reintroduce failed journal settlement; retaining every
command refusal locally would preserve the demonstrated administrator-data leak.
A broader store or component rewrite is not needed for these boundaries. Revisit the
catalogue when a server operation changes its read/write permissions or error meaning.

The original schema-valid P1 regression failed again before the correction, then
passed. The generic host matrix now withdraws on administration/organization/read
refusals, preserves the owner behind blocked settlement, fences old reads and permits
private receipt completion. A separate semantic endpoint test covers identity,
organization, worker, editor and revision commands, rather than inferring meaning
from the route's transport category.

The first production-shell tests then failed because conservative withdrawal also
removed the admission form. Administration now keeps private drafts, correction and
status controls mounted while query data, selected-account copies, configuration
inputs and one-time secret display check their own leases. First dispatch, status
and retry are tested behind a blocked Web Lock. Selected-account details, already
displayed secrets, pending secret results and delayed credential reads remain hidden
after withdrawal; exact success still retires its record. The Chromium admission
case uses an actual database role demotion, confirms that identity/self still
succeeds as a participant, and restores the role before exact status recovery.

Self-review found a smaller recovery regression and fixed it without stopping:
a human enrollment command could be relabelled as agent issuance when protected
selection metadata disappeared. The tightened regression failed both before receipt
completion and after clearing the withdrawn display. Pending recovery now derives
its kind from the immutable command; successful completion retains that private
kind. Neither repair changes stored command bytes or restores selected metadata.

The previous approved timeout capture identifies the overview host. The intended
Following status request reached the server with200 while the fixture waited on its
uncaptured barrier. This loop repeatedly expired/reinstalled the last one-use route,
the same fixture pattern already addressed in the settings test. It now keeps one
interception handler, explicitly arms each lookup/state/status/retry, checks entry,
awaits handler completion and asserts four captures. Normal runner limits are
unchanged. The overview case passed10/10 repetitions before and10/10 after this
fixture repair; the original timeout did not recur in those diagnostics. This is
not an independent reproduction of Playwright's lower-level cleanup race. The full
normal run is the separate acceptance check for the expected runner conditions.

Continued self-review reproduced another implicit-hydration gap: late account
creation mounted a credentials query, and late state, revocation and search actions
called refresh after withdrawal. All four production regressions failed before the
shared-query correction. The query hook now owns dispatch permission; old refresh
callbacks and post-withdrawal mounts cannot start metadata reads. Explicit refresh
still works and private success still settles. This is a focused extension of the
same boundary refactor, rather than adding separate guards to each action handler.
The initial implementation shadowed a local variable, caught by typechecking and
application tests and corrected. A tightened existing traversal case then exposed
an overly conservative continuation block after a fresh mixed response. The final
hook advances that query's own dispatch lease, preserving its pagination while
other old callbacks stay fenced. The 158-case query/session check passed afterward.

The added real-browser late-enrollment phase initially timed out during fixture
setup at an exact select label. It did not reach the intended assertion and is not
counted as browser red evidence. Using the existing account-seeding pattern, the
case passed on the fixed build with actual role demotion, held issuance success,
hidden secret, exact receipt retirement and preserved enrollment kind.

The query refactor distinguishes explicit refresh from post-command refresh. The
latter requires the query's existing lease, including when private status recovery
starts after withdrawal. Setup first/status/retry settle without restarting shell
discovery; a visible administration refresh provides explicit recovery. A separate
configuration regression failed because its new leased query retained the old
settings version after save. The second failed because late success restarted
discovery after withdrawal. Configuration completion now refreshes its owning query
only with current authority, preserving both repeated saves and withdrawal.

The browser counterpart for late account creation initially waited for a refresh
button inside a closed disclosure. That fixture failure did not reach its privacy
assertion; the fixture now opens the account panel explicitly. Its next run against
the previous bundle failed at the no-credentials-read assertion, matching the unit
regressions. The new setup unit fixtures initially asked Value.Create to invent
patterned UUIDs; they now supply and validate complete committed receipts. Neither
fixture repair weakens checks. The resulting query/session suite passed164 cases.

### Final verification and review

| Check | Observed result |
| --- | --- |
| `npm run check` on the final implementation | Passed: docs,64 bootstrap tests,5 hook tests, typechecking,778 application/contract/web tests and production build. |
| All16 `test:*:postgres` suites | Passed306/306, including43 attention cases and9 migration cases. Native suites ran before the final UI-only follow-ups; server/database behavior did not change afterward. |
| `npm run test:e2e` on the final build | Passed128/128, with one worker, zero retries and unchanged timeouts/bounds; no omitted cases. Approved metadata was retained before the diagnostic verifier. |
| `npm run test:browser-diagnostics` | Passed:8 intentional controlled failures, lifecycle/privacy/bounds checks and4 fail-closed validation cases. |
| Disposable Compose storage checks | Doctor, startup, integration, persistence and owned-project cleanup passed. Pinned image identification also passed; existing development data was untouched. |
| CI syntax checks | All26 `.mjs` files in the CI scopes and both PostgreSQL shell scripts passed. |
| Worktree integrity | Tracked diff and all257 untracked files passed whitespace checks. HEAD remains `8cf9048d25e9ac45905ff0333f47bc6e799c8979`; the index is empty. |

The final focused browser case passes both late issuance and late account creation:
real role loss withdraws account/secret metadata, saved commands settle exactly,
enrollment kind survives, no credentials read starts automatically, and explicit
refresh works after authority restoration. Two earlier full128 runs also passed,
but the final full run is the acceptance result for the last query/configuration
repairs. The original Chromium timeout did not recur; its lower-level cause remains
unproven, as distinguished from the repaired fixture lifecycle above. No hosted CI,
production deployment or representative human/device acceptance is claimed.

Final self-review checked endpoint/guard semantics, private settlement before and
after content withdrawal, selected/copied metadata, pending response ordering,
explicit refresh, traversal continuation and command-byte preservation. No remaining
actionable P1/P2 was identified in this pass. The focused refactoring addresses the
shared cause: session identity, content leases, query dispatch and receipt custody
have independent effects. A broader IntentStore/domain rewrite is not justified by
the observed failures. Changes to server capability guards or new post-command read
paths require revisiting the semantic catalogue and dispatch ownership.

Root and affected participation/attention/test memory, README and ADR-027 were
reconciled with source and actual assertions; search memory retained its unchanged
server/worker invariants. Imported requirements/architecture snapshots remain
unchanged. Evidence includes original failing regressions, later fixture failures,
final passes, approved browser JSON and source snapshots in the standalone
`authority-effects` implementation artifact collection. This is task verification
and self-review, not a separate completed security scan. Nothing was staged,
committed, pushed or rewritten; the implementation is ready for user review.

## Dismissal identity recovery review — 20 October 2026

The brief for this pass was to review the current unstaged attention-control diff
for correctness, privacy, concurrency and recovery, fix findings with regressions,
run all local checks with Docker, and stop for review without staging or committing.
Exact saved command bytes, safe removal, independent private settlement and the
authorized bounded relaxation for fresh response content remain requirements.

One P2 recovery issue was reproduced. Server dismissal identities canonicalize UUID
case, but browser journal overlap and source/group/restore controls compared raw
input IDs. An uppercase saved command could therefore be hidden from a lowercase
entry, and the journal could admit another uncertain choice for the same input.
Server version checks still protected stale application; this was a client recovery
and overlap defect. Earlier mixed-case cases covered resources, Following and mutes,
but omitted dismissal input identities and their production recovery controls.

`attentionInputKey` now supplies the shared comparison for those paths. It retains
the input kind, so equal UUIDs in shared-event and personal-delivery namespaces stay
independent. The retained command and all transport bytes are unchanged. This focused
refactoring removes duplicated identity rules; the finding does not justify another
authorization/store redesign. Revisit the helper if input identity semantics change.

Sixteen deterministic regressions cover both input kinds and case directions,
journal overlap, source controls, prepared groups and settings restoration. All16
failed before the fix and passed afterward. The UI cases require existing recovery,
block a replacement command, retain uncertainty after not-recorded status, and send
the original key/body on exact retry before retiring the receipt. The complete
canonical-boundary file passes108 cases. A separate shared Changes regression holds
a successor at the journal Web Lock, withdraws its source, then releases persistence
in the same turn: saved displayed-page recovery must not advance. It passed on the
existing implementation and is additional preservation evidence, not a red-green fix.

| Check | Observed result in this pass |
| --- | --- |
| `npm run check` on the final implementation | Passed: docs,64 bootstrap tests,5 hook tests, typechecking,795 application/contract/web tests and production build. |
| All16 `test:*:postgres` suites | Passed306/306, including43 attention and9 migration cases. |
| `npm run test:e2e` | Passed128/128, with one worker, zero retries, unchanged timeouts/bounds and no omitted cases. Approved JSON was copied after completion and before diagnostics. |
| `npm run test:browser-diagnostics` | Passed:8 intentional controlled failures, lifecycle/privacy/bounds checks and4 fail-closed validation cases. The child run's failed status is expected; the verifier exited0. |
| Disposable Compose storage checks | Doctor, startup, SQL/S3 integration, stop/start and container-recreation persistence, image identification and owned-project cleanup passed. Existing development data was untouched. |
| CI syntax checks | All26 `.mjs` files in the CI scopes and both PostgreSQL shell scripts passed. |
| Worktree integrity | Tracked and257 untracked files passed whitespace checks; HEAD remains `8cf9048d25e9ac45905ff0333f47bc6e799c8979` and the index is empty. |

Final self-review rechecked response classification, same-owner denial propagation,
pending reads/receipts, source/version locking, safe removal, UUID comparisons and
recovery persistence. No remaining actionable correctness, privacy, concurrency or
recovery finding was identified. Browser failures did not recur in this run; the
original intermittent timeout's lower-level cause remains unproven. These are local
synthetic macOS arm64 and Docker checks, not hosted CI, deployment or representative
human/device acceptance.

ADR-027, implementation guidance and attention/test memory now describe the shared
dismissal comparison and the missing test boundary. Root memory, README and related
participation memory retain their applicable invariants; imported requirements and
architecture snapshots remain unchanged. Actual failing/passing logs, final checks,
approved browser JSON and source snapshots are retained in the standalone
`dismissal-identities` implementation artifact collection. This is task verification
and self-review, not a separate completed security scan. No staging, commit, push or
history rewrite occurred.
