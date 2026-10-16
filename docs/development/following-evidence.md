# Following and shared retrieval: observed task evidence

The supplied 16 October 2026 handoff is the task brief. The checkout started clean
on main at `f7449f9b9400896f80c34413a5bd9d38cb48a06c`, including PR #10 /
`LC-20261016-V1H5`. [ADR-024](../adr/024-following-shared-changes.md) records the
contract and decisions; the [feature guide](following.md) covers browser, HTTPS,
native client and supported bounds.

This is the local synthetic W01 increment: owner-private Following plus ungrouped
complete shared retrieval. No accepted living inventory workbook was present in
the checkout, so changed requirement portions are recorded here. Imported product,
architecture and UI snapshots remain unchanged. W02 remains open.

## Delivered behavior and evidence mapping

Test paths below are relative to `tests/`. Integration fixtures use real isolated
PostgreSQL and authenticated HTTPS. Expected event identities come from independently
created publications, not the production matching function.

| Requirement / handoff boundary | Delivered behavior and direct evidence |
|---|---|
| W01; ATT-01, shared ATT-02 | Authentication determines human/agent ownership. Area descendants and seven preferences are explicit; parent/child and same-name targets remain separate. Closed targets are followable; unavailable targets withhold metadata but remain removable. `integration/following.test.ts` and the compiled management journey check states, ownership spoof rejection and no Saved effects. |
| Desired-state recovery | Absent-target serialization, expected versions, no-op/first-Unfollow tombstones and immutable decisions prevent delayed resurrection. Changed-input keys conflict; rollback leaves no decision. Original/current results survive API restart and a newer opposite command. `following.test.ts`, `following-races.test.ts`, compiled loss/reload/two-tab cases and development StrictMode intent tests inspect these outcomes. |
| ATT-03/15; ORG-04; ART-08 | Fixed definitions and committed upper bounds preserve old event-time membership across direct discussion/artifact and ancestor moves. New structural impacts identify affected watched descendants; later publications use new placement. `following.test.ts` and `following-races.test.ts` check independent sets, direct moves, changed settings, added/removed follows, post-upper moves, reversed publisher preparation and rollback. |
| Shared ATT-06; relevant DIS-04 | One event combines overlapping follows/preferences. Direct discussions include opening, replies and summary; cited artifacts/accounts keep their own source identity. Exact note categories, bounded reason expansion and body omission are checked by the independent set and bounds tests. Compiled navigation opens exact revisions. Existing reference/summary/change suites preserve their distinct contracts. |
| ATT-08/11 | Shared owner/purpose/epoch-bound tokens survive ordinary restart independently of personal custody. Expiry renews fixed bounds; missing history reports a gap; explicit resynchronization creates an incomplete baseline with bounded source inventory. `following-bounds.test.ts`, `following-recovery.test.ts` and compiled page/reload/back tests verify replay and changed successor budgets. |
| ATT-13/14 | Responses declare scope, definitions, preferences, ordering, grouping, omitted detail, completion and recovery. Hidden empty scans progress opaquely; unknown public work and missing historical structural facts cannot create a complete checkpoint. Bounds tests inspect complete UTF-8 JSON including tokens, escaping and Unicode. |
| Current policy / ATT-15 | Source, owner, exact/current revision and credential changes obey conflicting guards. Barriers exercise both orders, including moves. Restoration behind a completed checkpoint reaches older retained history even with structural preferences excluded. Hidden current titles never substitute older text. Race, restoration, bounds/detail and compiled recovery cases check these boundaries. |
| §12.3; shared portions of AC46/60 | Shared retrieval works with both workers stopped. Repairing old direct attention after shared completion produces its later personal delivery without republishing history or consuming either position. `following.test.ts` inspects source/delivery IDs and checkpoints; all existing notification correction/recovery tests also run. |
| Additive upgrade | `following-upgrade.test.ts` populates v1/v2/v3 publications, notes, references, accounts, summaries, structural events, pending/completed consumer work, Saved and personal custody. Complete table digests compare across 0013 with only the new NULL impact field added to old expectations. Personal page tokens replay after upgrade and API restart. Old bytes/digests and scope IDs remain compared. |
| Browser / HUM/API | Compiled Chromium checks management, keyboard activation, paths, lost replies/reload/tabs, frozen pages, back/reload, resizing, failed saves, policy focus, late filter/route replies and sign-out with cleanup blocked on a real Web Lock. Ten development StrictMode cases additionally check late account/route/filter results, failed storage, stale records, intent ownership, refreshed editors, policy feedback and renewal budgets. |
| Independent process recovery | `following-recovery.test.ts` runs separate native HTTPS reader processes against the compiled API, restarts both, replaces an owned synthetic agent credential and checks exact page/successor identity. Its separate 0600 journal is atomically renamed/fsynced before output. An occupied journal lock preserves the old file. This is same-machine evidence only. |

AC08/09/12/13/20/24–26/33/39–43/46/55/60 receive only the shared text,
subscription, recovery and independence evidence above. No compound AC is closed:
grouping/highlights, combined streams, reading progress, mutes/dismissal, files,
full moderation UI, human usability, autonomous providers and cross-machine
operation are not delivered by this task.

## Commands and observed results

Environment: macOS arm64, Node 24.19.0, installed Playwright 1.64.0 / Chromium
156.0.8078.4 and disposable PostgreSQL fixtures. Shell default was Node 22.22.2;
commands explicitly selected Node 24. Docker socket access required escalation.
No existing development data was reset.

The table below records initial implementation verification. The subsequent
self-review correction results are recorded separately below.

| Command | Observed result |
|---|---|
| `npm run check` | Pass: document/import checks, 64 bootstrap tests, 5 hook tests, all TypeScript projects, 62 application/unit/contract/web tests including seven new StrictMode cases, and build. |
| `npm run test:following:postgres` | Pass, 17 tests including both move guard orders, no skips/cancellations, 18.71 seconds. |
| Complete existing PostgreSQL command set below | Pass after additive-schema expectations were corrected: 207 tests across 12 commands. |
| Focused compiled filter regression | Pass after rebuilding the synchronous URL-filter fix; [approved manifest](evidence/following/browser-filter-green/run.json). |
| `npm run test:e2e` | Pass, 80/80, normal one worker and zero retries, including the final delayed lookup regression; [final approved manifest](evidence/following/browser-reviewed-final/run.json). Earlier 79/80 failure remains below. |
| `npm run test:browser-diagnostics` | Pass: eight intentional browser failures retained their nonzero child result; canary/bound/lifecycle checks and four fail-closed validations passed. |
| `git diff --check` | Pass after final code/documentation edits. The native client syntax and all local links in the new guides/evidence/ADR also check successfully. |

Existing PostgreSQL commands and counts: `test:migrations:postgres` 9,
`test:app:postgres` 9, `test:publication:postgres` 16, `test:identity:postgres` 22,
`test:participation:postgres` 12, `test:saved-items:postgres` 10,
`test:organization:postgres` 15, `test:references:postgres` 26,
`test:summaries:postgres` 14, `test:search:postgres` 46,
`test:changes:postgres` 12 and `test:notifications:postgres` 16. Each used its normal
`npm run` script. Safe exit/count summaries: [first run](evidence/following/postgres-first-run.json)
and [corrected upgrade rerun](evidence/following/postgres-rerun.json).

The new suite is in normal CI. Existing migration, storage, persistence and diagnostic
stages remain present. Hosted CI/upload and Compose storage/persistence commands
were not run in this task; they are preserved stages, not claimed evidence.
Service-interrupting tests used only owned disposable resources.

## Failures retained and corrected

* Initial integration run: 2/5 passed. Two fixture sets omitted the real setup
  overview artifact; expected sets now include it. The structural move case also
  found a production defect: default content-only `lockContext` kinds withheld
  structural areas. Explicit structural kinds fixed the unchanged ancestor-event
  assertion; the next run passed 5/5.
* Expanded run: 11/12 passed. Two artifact creates also serialize existing summary
  editor-state invalidation. Independent discussion creates now isolate reversed
  clock preparation without changing production guards or timeouts.
* A public retained untyped text/plain event incorrectly returned known coverage.
  A new assertion reproduced it; unsupported eligible public work now goes through
  matching and makes coverage unknown. Internal actors stay excluded. Another
  regression expected `shared_history_gap` when replaying behind a completed
  checkpoint after its history floor advanced; the original success was wrong.
  Replay now requires older history or explicit incomplete resynchronization.
  Both regressions pass.
* Five old upgrade assertions failed on the additive NULL `affected_target_ids`
  field (references, summaries, two search tests, notifications). Expected shapes
  add that one field and retain every original-field comparison. All four complete
  commands passed on rerun. Search totals grew from 41 to 46 because the corrected
  parent then executed its five nested cases.
* Compiled Following runs were 4/7, then 6/7; the first full normal browser run
  was 79/80. Two fixtures used the wrong established overview heading or refreshed
  before Unfollow completed; they now wait for the actual named outcome. Keyed
  remounts in both page and shell collapsed explicit-scope controls; a StrictMode
  regression observed it. Controls now persist while separately keyed results
  retain response fencing. Native checkbox interaction still exposed deferred
  router state restoring the old checked value. Synchronous URL updates pass the
  same compiled assertion. One probe reused the prior compiled bundle; it is not
  evidence against the source fix. A subsequent rebuild and focused run passed.
  Normal workers, timeouts, retries and assertion semantics were retained.
* A development regression observed Unfollow sending empty unsaved preferences.
  Removal now uses retained settings; new Follow still requires preferences.
  The regression passes in the full StrictMode suite.
* Final review added a stale-row regression: a newer unavailable lookup hid the
  control link but left the containing Following row title/path visible. The test
  failed its cached-title assertion before the fix; row metadata now follows the
  authorized lookup/decision. All seven StrictMode cases pass. The compiled
  management case delays a lookup while the source becomes unavailable and also
  passes in the final full 80-case run.
  The first test attempt compared a DOM object directly and produced no output;
  it was interrupted after 25.8 seconds. Boolean presence assertions produced the
  clear red/green result. Two typecheck attempts then exposed the new callback
  fixture's inferred array type and unchecked element; explicit types fixed those
  without changing assertions.

Approved manifests/bundles remain under `evidence/following/browser-first-run`,
`browser-second-run`, `browser-full-first`, `browser-filter-probe`,
`browser-filter-old-build`, `browser-filter-green`, `browser-full-final`,
`browser-reviewed-final` and
`diagnostics-verification`. The last contains deliberate probe failures, not
application regressions. They use closed diagnostic
vocabulary, excluding raw scopes, queries, tokens, bodies and unrestricted traces.
Raw browser output remains excluded by the existing runner.

## Self-review corrections

The read-only self-review found three defects. Authorized fixes retained the
ADR-024 contract; no migration, event, personal token or saved intent was rewritten.

* A public untyped contribution had a known canonical discussion owner but no
  companion row. Direct discussion retrieval incorrectly returned known coverage
  and a completed checkpoint. The new PostgreSQL regression first failed that
  assertion. Candidate discovery now preserves the known owner for unknown-coverage
  decisions without treating the source as typed. Explicit and followed scopes
  cover both contributions and summaries; suppressed sources and unrelated scopes
  retain their normal eligibility behavior. The previous unsupported-work test
  exercised only an area scope.
* An explicit Following refresh updated row descriptions but left mounted editor
  settings and expected versions stale. The new StrictMode regression first failed
  the subtopic checkbox assertion. Refreshed server state now updates the editor
  and fences an older pending lookup without closing its controls. The test also
  checks the subsequent command's complete settings and expected version. Existing
  tests exercised lookup-to-row updates, not collection-to-editor updates.
* Expired-page renewal discarded the saved item and byte budgets. The new StrictMode
  regression first observed a renewal request missing both fields. Renewal now
  retains the displayed page's budgets and persists them again with the renewed
  descriptor. The test uses five items and an 8 KiB budget. Earlier tests covered
  ordinary replay/resizing and server renewal separately, missing this client path.

A preservation test caught the first editor-synchronization fix treating its own
unavailable placeholder as a successful refresh, clearing an authentication error.
Reported-state feedback is now distinguished from an explicit collection refresh;
the error, withheld metadata and disabled controls remain intact. The test failed
before this correction and passed afterward. One subsequent typecheck rejected
a Playwright-only `exact` option in the Testing Library fixture; removing the
unsupported option preserved the same exact-name assertion.

Observed correction checks:

| Command | Result |
|---|---|
| Focused StrictMode regressions before fixes | Both original UI assertions failed for the reported defects. The added policy-feedback assertion also failed before its correction. |
| Focused PostgreSQL regression before/after fix | Failed with `coverage:known` for unsupported discussion-owned work, then passed both source kinds, scope modes and eligibility cases. |
| `node --import tsx --test tests/web/following.test.tsx` | Pass, 10/10 development StrictMode tests. |
| `npm run check` | Final pass: document/import checks, 64 bootstrap tests, 5 hook tests, typechecking, 65 application tests and production build. |
| `npm run test:following:postgres` | Pass, 18/18, no skips/cancellations, 20.43 seconds; includes upgrade, independent process recovery, authority races and the new coverage regression. |
| `npm run test:e2e` | Pass, 82/82, normal one worker and zero retries. New compiled browser cases verify refreshed editor settings/version and renewal of the same five-item page after reload; [approved manifest](evidence/following/browser-self-review-fixes/run.json). |

Memory review verified the existing root/participation summaries remain accurate.
Following and test memories now document canonical ownership for unknown work,
explicit editor refresh versus policy feedback, and preserved renewal budgets.
The earlier 207-test PostgreSQL set and diagnostic verification remain prior
implementation evidence; those unrelated suites were not rerun for these fixes.

## Synthetic observations and visual review

The completed 17-case run observed a 103-event fixture with 101 suppressed artifacts:
the first empty bounded page was 2,261 bytes, had a successor and did not claim
completion; the full traversal took 258 ms. A 64-follow/66-event fixture returned
25 entries in a 56,571-byte complete JSON page, with a 5,692-byte descriptor and
636 SQL calls. These disclose work and serialization cost, not production capacity,
latency guarantees or a baseline speedup. Independent deadlines and caps remain.

Deliberately captured synthetic screenshots were visually inspected:
[Following desktop](evidence/following/following-desktop.png),
[Following 390px](evidence/following/following-mobile.png),
[Changes desktop](evidence/following/changes-desktop.png) and
[Changes 390px](evidence/following/changes-mobile.png). They show distinct parent/
same-name paths, chronological metadata, exact links, old-settings notice and
secondary coverage. Browser checks assert no 390px horizontal overflow and exercise
keyboard activation/paging focus. This does not establish human usability or
assistive-device acceptance.

## Decisions, memory and remaining boundaries

The implementation adopts the handoff's recommended labelled retained-history start;
there is no optional start-now path. Direct committed-event queries avoid projection
lag. Immutable event-time facts preserve history across moves. Separate shared
custody and journals preserve personal delivery independence. Missing old ancestor
impacts remain unknown, never backfilled from current ancestry. Resynchronization
supplies an incomplete baseline and bounded current inventories, which can change
while paged; it cannot reconstruct expired events, ancestry, read state or coverage.

Memory review checked root `MEMORY.md`, participation/search/notifications scoped
memories, the new following memory and `tests/MEMORY.md` against routes, schemas,
guards/storage and actual assertions. Corrections cover guide9, summary search
population, worker/shared independence, stale deferred shared-catch-up wording,
structural impact ownership, custody and browser lifecycle. Detailed facts live in
following memory; parents link there. Anchors: `contracts/following.ts`,
`http/following.ts`, `modules/following/*`, organization insertion before the clock
tail, `web/Following.tsx`, `web/SharedChanges.tsx`, `web/shared-recovery.ts` and the
tests above. Current guide prose acknowledges the notification worker; the Saved
client actually supports guides 2–9; search population/kinds include summaries.

No pruning, destructive restore, key rotation or production deployment is added.
Larger measured workloads or authoritative recovered facts would prompt review of
the bounded contract, not automatic changes. Merge and deployment remain outside
this increment.
