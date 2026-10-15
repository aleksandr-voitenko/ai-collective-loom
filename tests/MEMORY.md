# Browser test diagnostics

Summary tests use the same runner and closed diagnostics (`summaries.spec.ts` and
summary route templates; no raw IDs/bodies added). `summaries*.test.ts` covers
pre-0010 populated upgrade, source snapshot boundaries, both authority/suppression
guard orders, immutable coverage, expiry tombstones, quotas, bounded query/byte
measurements, HTTPS/native search and fsynced external-client/server restart.
`web/summaries.test.tsx` separates development StrictMode ownership/page recovery
from the production Chromium bundle. Keep `references.spec.ts` legacy-correction
regressions in the complete normal suite. Source metadata probes cap 101; the
shared owner guard expansion has its independent 3840 bound, not the source cap.
Summary browser regressions revisit a completed edit for another revision, retain
the old record on fetch/save failures, preserve current content and coverage after
reload, publish a Unicode-boundary default title, and refresh creation in place.
The comparison-failure fixture holds the reload request at a barrier and keeps
its fault active until the retry UI appears. Restored draft text alone does not
establish that the asynchronous comparison fetch has failed.

`npm run test:e2e` uses `scripts/browser-tests.mjs`, the closed validator in
`scripts/lib/browser-diagnostics.mjs`, and `helpers/browser-reporter.ts`.
`helpers/browser-fixtures.ts` shares the existing synthetic PostgreSQL/HTTPS server
and preserves context-before-server disposal (Lore `LC-20261014-WZF5`). Test bodies,
normal timeouts, worker count and retry policy are unchanged by diagnostics.

The automatic collector tracks every page in a registered context. Persistent
contexts must use `diagnostics.launchPersistentContext`; explicitly constructed
contexts must use `diagnostics.track(context)`. Snapshot before explicit closes;
do not rely on a reporter running while a page is alive. A completed server-close
callback is stronger than an asynchronously queued socket-close counter event.
Never hold requests, route barriers, Web Locks or sockets for diagnostics.

Only `browser-diagnostics/approved/*.json` may be uploaded. The containing runner
consumes arbitrary console output and removes Playwright's private raw outputs on
normal child exit. On hard kill, intermediates may remain unsafe; never promote
them to artifacts. Use the npm entry point, not a reporter override/direct CLI.
Write synthetic screenshots through Playwright's per-test `outputPath`, keeping
them portable and inside that private cleanup boundary.
Each run replaces this ignored test-output directory; do not run two browser
commands concurrently in one checkout. Existing development data is not involved.

The schema allows fixed categories/counts, route templates, version/commit metadata,
source locations and hashed test IDs. No arbitrary error text, titles, attachments,
headers, cookies, bodies, storage, DOM, input values, screenshots or traces. Bounds:
256 events, 8 contexts, 16 pages, 64 pending descriptors, 16 reporter steps,
128 KiB/document, 128 collected tests and <17 MiB/candidate. Omissions and incomplete
capture are explicit. The entire candidate fails closed on invalid input; a safe
validated refusal record is the sole upload output in that case.

`test:browser-diagnostics` uses separate intentionally failing children and scans
every approved file for its synthetic canaries, schema/byte bounds and lifecycle
evidence. Canary checks supplement allowlisting, not arbitrary-secret detection.
It must fail if child exit/status, original error count, evidence or containment is
wrong. Probe HTTP fixtures are not Loom authentication tests; the complete E2E
suite still uses actual HTTPS, virtual WebAuthn and disposable PostgreSQL.

CI uses an immutable upload action, an always-running validator and an explicit
upload-ready output, with three-day retention and no continue-on-error.
The manual `verify_failure_upload` input runs the probe configuration after the
normal browser suite; expect a failed step/run and a successful approved upload.
It defaults off and never applies to push/PR runs. Contract: `LC-20261014-3D4P`.
Local bundle validation does not verify hosted upload. See the testing guide and
`docs/development/browser-diagnostics-evidence.md` for observed results/limits.

Organization scenarios use the same fixtures/runner; the closed vocabulary includes
organization routes, `organization.spec.ts` and four organization control categories.
Diagnostic files use compact JSON so the expanded vocabulary fits the unchanged
128 KiB document envelope. Maximum capture and full-bundle serialization are checked
alongside the original canary/lifecycle/refusal probes. Explicit synthetic screenshots
are curated separately, never included in the approved diagnostic upload candidate.
`integration/organization.test.ts` verifies populated pre-0006 upgrade, current
cookie/bearer authority, immutable identities/scopes, exclusive/shared structure-lock
barriers in both commit orders, quotas, replay, rollback and restart. Its quota data
is synthetic fixture state, not a supported product mutation or data-reset procedure.

`web/organization.test.tsx` mounts actual development React in StrictMode with
JSDOM and HTTP stubs. It checks successful/rejected command completion and delayed
unmount/identity ownership; effect setup must restore liveness after StrictMode's
extra cleanup. The PostgreSQL/Chromium fixture serves the production bundle and
does not exercise that development lifecycle. Community-wide proposal recovery
checks cover both drafts and lost committed responses after the destination is
closed or unconfigured, retaining the original request and administrator fallback.

Search scenarios extend the same closed diagnostics with `search.spec.ts`, search/
authors/status/admin route templates and search/refresh controls. Queries and cursors are
discarded by route classification; no authored text or raw diagnostics are approved.
Preserve approved failure evidence before another browser/diagnostic run replaces
the output directory. Search tests exercise actual HTTPS/SQL and native built workers;
build first and never clean `dist` while native children are running.
`integration/search-worker.test.ts` inspects populated pre-0007 upgrades, leases,
source ordering, retries, rebuild and atomic output/job rows. Native phase barriers
in `fixtures/search-worker.ts` pause preparation and COMMIT boundaries. Lease theft
waits for the stored PostgreSQL deadline; no arbitrary race sleep. Private observer
mutations elsewhere explicitly inject expiry/failure, never expose HTTP fault hooks.
`integration/search.test.ts` covers human/agent search, current eligibility/scopes,
Unicode byte limits, resumable rebuild and disclosed synthetic query measurements.
`integration/search-limits.test.ts` separately exercises cursor expiry/API restart,
real statement timeout, retained unsupported work, job cap and corpus cap.
`integration/search-recovery.test.ts` covers expiry during unchanged job-lock waits,
simultaneous claim batches, populated 0007 migration, intent collisions and split
event pages. Its native `fixtures/search-discovery.ts` barriers kill unfinished
rebuilds before/after discovery COMMIT and restart the built worker over retained
progress plus new publications. `helpers/search-races.ts` observes actual
`pg_blocking_pids` dependencies and stored lease deadlines rather than race sleeps.
`integration/search-authorization.test.ts` gates real HTTPS/SQL transactions before
and after source guards to test resource/revision/discussion suppression and actual
administrator credential revocation in both commit orders. It also tests author
discovery eligibility, paging, byte bounds and caller/cursor binding.
`web/search.test.tsx` mounts development StrictMode; `e2e/search.spec.ts` exercises
production navigation, stale query/page/identity responses, reload/back, keyboard,
narrow layout, incomplete indexing, administrator recovery and suspended-author
selection/reload. A fresh-search fixture
must observe navigation completion before entering a new query; an old status
notice can already exist and is not a navigation barrier.

Reference tests use `helpers/references.ts` with ordinary cookie/bearer accounts
and real HTTPS/SQL. `integration/references*.test.ts` covers populated 0008 upgrade,
unchanged old digests, declaration/withdrawal attribution, rollback, exact retries,
known-target selection without search, native worker restart/rebuild, bounded
hidden-candidate paging and source/target/credential races. SQL barriers and
`pg_blocking_pids` establish both commit orders. `references-client.test.ts` also
restarts the standalone fsynced client and checks UTF-8/JSON/statement limits.
`web/references.test.tsx` exercises development StrictMode; Chromium scenarios
cover exact navigation, correction, failed autosave, stale tabs, persistent restart,
page recovery and late route/account results. Observe the failed dispatch leaving
busy state before restoring faulted storage; click completion alone is not a
journal-write barrier. Legacy correction cases distinguish uncommitted v1→v2
conflicts (empty/populated lists), an existing format refusal, explicit withdrawal,
comparison-load/save failures and reload. These differ from the already-committed
v1 replay scenario. The comparison failure and rejection notices need exact text selectors when both show.
Closed diagnostics add `references.spec.ts`, three route
templates and Add/Check/Refresh controls, without changing bounds or raw containment.
