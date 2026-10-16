# Combined Updates: implementation and verification

Task baseline: main `0dbb7d5637a4f3e7dfa34f519b0092135628e623`, including PR11's
summary-context repair (`LC-20261016-A66W`). The attached 17 October 2026 brief is
the acceptance source. Implementation and review stopped without staging. The
user subsequently authorized Lore finalization, commit, push and a pull request as
`LC-20261017-FUWG`; merge, deployment and existing development-data changes remain
outside that authorization.

## Brief and decisions

Deliver one synthetic persistence/API/browser increment combining followed shared
events and personal direct attention into ownership groups, with fixed highlights→
complete transition, independent paired progress, bounded member metadata, exact
source navigation and attributed explanation links. Preserve publication v1/v2/v3,
existing standalone streams/custody, Following, Saved, current authority, actual
reply parents and PR11 summary navigation. Exclude read/unread, mute/dismissal,
files/private notes, new moderation operations and model/agent execution.

The material task assumption is finite local retrieval custody: bounded preparation
may refuse oversized synthetic workloads; it does not promise production capacity.
[ADR-025](../adr/025-combined-updates.md) was recorded before dependent UI work.
It chooses frozen identities/order with explicit visibility invalidation, rather
than regrouping live rows. Highlights includes every direct group plus three routine
groups. Separate committed clocks preserve later availability of old personal
sources. Preparation and finished-group guard planning use separate requests to
avoid adding contested guards after an incomplete plan. Retained custody is finite
and no live view is evicted. These choices do not narrow the supplied acceptance scope.

## Direct acceptance evidence

Review map: migration0014 owns finite grouping custody; migration0015 serializes
quota decisions across concurrent snapshots; `src/contracts/updates.ts`
and `server/http/updates.ts` define controlled reads; `server/modules/updates/`
composes existing shared/personal policy. `web/Updates.tsx` and
`web/updates-recovery.ts` implement cards, detail and local ownership. The standalone
`scripts/updates-client.mjs` owns independent HTTPS recovery. Focused integration,
StrictMode and Chromium files plus CI add executable evidence. ADR025, current
guides, backlog, capability discovery and scoped memory describe the same boundary.

`tests/integration/updates*.test.ts` uses independent expected revision/event sets
and persisted source/delivery identities. Its cases cover twenty replies plus a
summary, personal-only input, overlapping reasons/exact revision-note signals,
112-member busy grouping and multiple direct groups, same-bound complete switching,
delayed personal repair inside/outside Following, real structural moves, replay
behind completed lower bounds, independent parent/owner restrictions, expiry,
component history gaps, missing custody and epoch errors. Real SQL barriers exercise
credential/source/owner/exact suppression, current-title publication and independent
explanation-owner races in both orders; injected component/count errors rollback.
Capacity and Unicode cases include empty scans with later eligible work, oversized
first responses, 501 replies, 257 artifacts and the 16-view custody ceiling.

The populated0013 upgrade hashes every old table before/after migration and
combined browsing, replays old shared/personal tokens and retains v1/v2/v3 exact
sources and Saved decisions. A separate older upgrade retains unknown pre0013
structural impacts. Independent HTTPS client and compiled API processes restart
while recovering overview/member positions, resize successors, retain credential
replacement identity and keep independent journals. These are local native
process trials, not provider-agent or cross-machine trials.

`tests/web/updates.test.tsx` exercises eight development StrictMode cases: displayed
budgets before successors, failed saves/focus, separate expansion reload, stale
tabs, malformed owned records, late scope/route/account results, withdrawal on
policy failure, expired overview/expansion renewal, and retry of first/successor
expansions after an authority race withdraws the overview. Actual Chromium scenarios use
the normal one-worker/zero-retry
runner: AC07 card, exact direct source and note coverage, bounded expansion,
summary context vs historical R1 after R2, reload/back, keyboard/narrow layout,
failed local save and sign-out while cleanup is blocked. Assertions inspect actual
API state and no incidental clocks/deliveries/Saved mutations.

## Executed checks and retained failures

All commands use Node24.19.0 on local macOS arm64 with disposable Linux/arm64
PostgreSQL18.4, synthetic HTTPS credentials and Chromium. These are local executions;
no hosted workflow was dispatched. Normal workers/retries/timeouts remain unchanged.

- Early Updates PostgreSQL run: 4/5 passed; the restart assertion compared randomized
  ciphertext. Corrected it to compare semantic group/source/coverage identity.
- Expanded run: 10/11 passed; a fixture used a highlights result's null checkpoint.
  Corrected complete-selection setup, preserving the rule that highlights never
  produces completion.
- Subsequent run: 15/16 passed; unchanged main mention text correctly produced one
  signal. The distinct-revision fixture now publishes a new revision-owned note
  mention instead of expecting another main claim.
- Next run: 18/19 passed; the out-of-bound reason assertion selected the followed
  setup overview, which was legitimately included. It now uses a publication after
  the captured upper bound.
- Initial StrictMode targeted run: 5/5 passed. Targeted normal Chromium: 4/4 passed;
  approved manifest retained at `evidence/updates/browser-targeted/`.
- Existing PostgreSQL CI commands: app, publication, identity, participation,
  organization, search, references, summaries, changes, notifications, following
  and migrations passed. Saved-items failed because its CLI allowlist excluded
  guide10. The explicit supported-version list was extended by that version only;
  its synthetic/identity checks and intent protocol remain intact.
- Review reproduced an expired-reload bug: renewing the overview discarded its
  saved expansion. The new StrictMode test failed because no member reauthorization
  was requested; preserving the expansion request independently of the failed
  request stage produced a 6/6 green run. Close after reload now returns focus to
  the originating group's Inspect changes button. Chromium adds real encrypted
  descriptor expiry/renewal and two-tab recovery coverage.
- Review reproduced an overconfident count label on pre0013 unknown structural
  history. The older-upgrade assertion failed; ready counts now explicitly say
  `known_sources_only` when shared historical facts are unknown. Completion remains
  refused. Empty unknown views no longer assert unqualified absence.
- `npm run check` passed after the review changes: docs checks, 64 bootstrap tests,
  5 hook tests, typechecking, 71 application/contract/web tests and production build.
- The first full normal `npm run test:e2e` passed 87/87 (one worker, zero retries);
  approved manifest at `evidence/updates/browser-full/`. This preceded the final
  renewal/focus/count review changes.
- The rebuilt full normal `npm run test:e2e` also passed 87/87, with zero omitted
  tests and zero retries, including all four Updates scenarios with the added
  descriptor-renewal, restored focus and two-tab assertions. Its approved
  [run manifest](evidence/updates/browser-reviewed/run.json) and
  [validation result](evidence/updates/browser-reviewed/approval.json) are retained.
  `LOOM_UPDATES_REVIEW_SCREENS=1` enabled only deliberate synthetic screenshot
  capture; worker, retry and timeout settings remained normal.
- `npm run test:browser-diagnostics` passed: 8 controlled child failures and 4
  fail-closed validation cases. Approved probe diagnostics are retained at
  `evidence/updates/diagnostics-verification/`.
- `npm run test:integration` and `npm run test:persistence` both passed in an
  isolated temporary copy using unchanged bootstrap/Compose/migration sources,
  a unique project and fresh synthetic configuration/ports. Setup used dev:init,
  dev:doctor and dev:up. dev:down stopped only those new services; both newly created
  fixture volumes were then removed after checking their project ownership labels.
  Existing development configuration/data/volumes were not selected. The temporary
  copy's 26 bootstrap/Compose/migration files matched their repository sources;
  [sanitized command results](evidence/updates/bootstrap-results.json) are retained.
- The final backend review run passed 19/19 Updates tests, including the previously
  failing unknown-history count assertion. The focused descriptor expiry/owner/
  purpose/gap case also passed after adding a 16,385-character rejection probe.

Intermediate typechecks caught literal-union/index typing and fixture discovery
fields during implementation; those were corrected before the passing final check.
No timeout or test guard was weakened. The first successful full browser run was
already in flight during UI review; final review changes are tested against a new
production build, not attributed to that earlier 87-case result.

Per-command PostgreSQL totals are retained in
[sanitized PostgreSQL results](evidence/updates/postgres-results.json) (all existing
CI PostgreSQL commands plus the 19-case Updates suite passed; Saved used its
corrected rerun). Raw temporary
logs are not public evidence: they can contain synthetic IDs, encrypted descriptors
or local paths. This report retains the failure causes and fixes; only approved
closed-schema browser JSON and deliberate synthetic screenshots are copied here.

Agent visual inspection of the final [desktop](evidence/updates/updates-desktop.png)
and [390px mobile](evidence/updates/updates-mobile.png) captures confirmed readable
group titles, visible exact-source and attributed-note links, clear separation of
the expanded source list, wrapped controls and no visible overlap or horizontal
clipping. The scripted browser also checked document width and actual keyboard
focus. These are agent visual and scripted observations, not representative human
usability or assistive-technology trials.

## Repairs after the requested self-review

The follow-up brief was to fix the three reproduced review findings and add
regressions, preserving the W02 scope, fixed intervals, current authority, journal
positions and exclusion between live readers, then stop before staging or committing.

- Quota tests previously covered sequential creation only. An advisory mutex inside
  REPEATABLE READ did not refresh the quota snapshot. Both new owner/global race
  tests first failed because the stale request succeeded. Additive migration0015
  supplies a writable serialization row; a conflicting committed creation now
  forces `updates_view_changed`, and a fresh retry at the cap returns
  `updates_capacity`. Tests retain exactly 16 owner/128 global views and keep the
  successful view recoverable. A populated0014→0015 upgrade compares every prior
  table, preserves grouping custody/key state and checks restricted row privileges.
- UI tests covered special visibility replay and transport failures, but not the
  generic member-race retry after cached rows were withdrawn. Both first-expansion
  and successor cases failed because clicking Retry issued no request. Retry now
  reauthorizes the overview before the attempted expansion; interim saving retains
  the previous displayed detail until the new response succeeds. The new Chromium
  scenario checks actual focus, persisted position and the independent seven-source
  expected set across the failed successor and retry.
- Native recovery tests restarted normally and rejected live lock contention;
  they did not interrupt a lock owner. A SIGKILL regression first failed because
  the next process still reported an active reader. The client now uses Node24's
  built-in SQLite OS locking in a private persistent `.lock.sqlite` sidecar, with
  no new dependency or JSON-journal format change. The native regression verifies
  live exclusion, unchanged saved bytes on interruption, restored overview/member
  identity and budgets, and subsequent member completion. Legacy ownerless `.lock`
  files remain an explicit refusal with recovery instructions; guessing that an
  older client is dead would weaken live-reader exclusion.

Observed follow-up checks:

- The two targeted StrictMode regressions failed before the fix; the complete
  Updates StrictMode file then passed 8/8.
- The two PostgreSQL quota regressions and native crash regression failed before
  the fixes, then passed 3/3 under the same fixture conditions.
- `npm run check` passed: documentation, 64 bootstrap tests, 5 hook tests,
  typechecking, 73 application/contract/web tests and the production build.
- `npm run test:migrations:postgres` passed 9/9.
- `npm run test:updates:postgres` passed 23/23, including all four new native/SQL
  regression and upgrade cases alongside the existing grouping/authority tests.
- The first normal Chromium run ended 88/88 with one failure in the new test:
  its unqualified complementary-region selector also counted the desktop sidebar.
  Naming the `Expanded changes` region preserves the withdrawal assertion. The
  corrected scenario passed through the supported runner with only test selection
  changed. Approved failure and targeted-rerun diagnostics are retained in
  `evidence/updates/browser-review-fixes-failed/` and
  `evidence/updates/browser-review-fixes-targeted/`.
- The subsequent full `npm run test:e2e` passed 88/88 under the normal one-worker,
  zero-retry and unchanged timeout settings. All five Updates scenarios passed.
  Approved evidence is in `evidence/updates/browser-review-fixes/`.
- `npm run test:browser-diagnostics` passed: eight intentionally failing browser
  cases and four fail-closed validation cases, including canary/bounds and lifecycle
  assertions. Approved controlled-failure evidence is retained in
  `evidence/updates/diagnostics-review-fixes/`; these expected child failures are
  separate from the successful application suite.

Earlier results above remain attributed to their original executions. The other
PostgreSQL suites and SQL/S3 lifecycle commands were not repeated for these focused
repairs. Hosted CI and representative human/provider/cross-machine trials remain
unperformed.

Memory review for these repairs updates root migration pointers and the Updates
and tests scoped memories against the serialization SQL, retry branches, native
lock protocol and regression assertions. ADR025 and the current guide now explain
the repaired behavior and legacy-lock limitation.

## Measurements and limits

Observed synthetic empty-scan case: 106 candidates, one eligible group, 483ms for the
retrieval/budget exercise and 8,641 serialized bytes for the successful group page.
The 501-reply/257-artifact capacity exercise refused explicitly with no checkpoint;
its timed section was 4,366ms (fixture setup and 501 reply publications excluded).
These are individual local samples under concurrent verification, not throughput,
p95, production limits or a supported scale claim.

Bounded costs and custody caps are in the ADR/guide. A group can require checking
up to 500 sources; one view contains at most 2,000. Requests plan only selected group
members plus bounded explanations/projection sources. No full source bodies are
downloaded for cards. Full custody slots require a retained view or expiry; local
record deletion does not delete server custody. No retention administration is added.

## Coverage boundary and handoff

W02 implements supported-text ATT-04–08/11–15 grouping, detail, coverage and paired
retrieval; MEN-02 combined direct presentation/repair; KNW-02/04/05 attribution and
limited authored coverage; HUM-01–05 navigation, progressive disclosure, bounded
inspection, focus/recovery and narrow layouts; API-01–04/07/08 routes, schemas,
discovery and equivalent policy. Existing API-05 publication retry is preserved.
Reading, muting/dismissal, file/private-note/moderation integration, retained-data
operations, production capacity and representative human/provider/cross-machine
acceptance remain open. AC07–10/24–26/33/39–41/46/55–60 remain composite scenarios,
with only their exercised grouped-retrieval portions claimed here. No inventory
workbook exists in this checkout to update.

All requested local validation commands completed. Hosted CI, representative
human/provider/cross-machine acceptance and production retained-data operation
trials were not performed; the local synthetic evidence does not establish them.
At the completed review handoff, Git HEAD was the supplied baseline and the index
was empty. The user then authorized committing and publishing this bounded W02
task as `LC-20261017-FUWG`. Hosted CI is pending at commit preparation; the local
results above do not claim a hosted pass. Merge and deployment are not included.

Memory review: root, participation, following, notifications and tests summaries
were reconciled against ADR025, migrations0014/0015, contracts, retrieval and actual
assertions. `updates/MEMORY.md` owns detailed limits/guard/recovery decisions.
Current guide/backlog/README now distinguish this W02 slice from open reading,
moderation, retention and representative acceptance. Imported product, architecture,
UI snapshots and historical execution reports remain unchanged.
