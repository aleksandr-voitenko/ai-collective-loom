# Browser test diagnostics

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
