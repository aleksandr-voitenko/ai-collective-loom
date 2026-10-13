# Text participation verification — 14 October 2026

This records checks actually executed for the working slice. It is not an AC/AV
completion claim or approval to retain real participant material. The reviewed
scope is an administrator setting up/admitting, a human starting a discussion,
an external HTTP client reading the actual parent and replying, exact revisions,
current authorization and publication recovery through both interfaces. Existing
authentication/shared transaction, imported baselines, data, storage and worker
gates must remain intact. All accounts and authored content below are synthetic.

## Actual topology

One macOS arm64 host ran Node **24.19.0**, Fastify HTTPS, direct Node HTTPS clients,
standalone client subprocesses and Playwright Chromium **156.0.8078.4** (build 1248).
PostgreSQL **18.4** ran as Linux/arm64 in local Docker, on random loopback ports,
with fresh application/migrator roles and tmpfs storage. Each real suite owned
only its disposable resources. No existing development database, `.env.local`,
storage bucket or retained volume was reset or migrated.

The browser used actual native WebAuthn calls with Chromium virtual CTAP2
authenticators, actual HTTPS cookies/CSRF and origin storage. Test contexts explicitly
accepted their own self-signed localhost certificate. Node clients verified that
certificate as their CA. Publication requests were not Fastify injections and
no identity header/role bypass was used. The original identity suite separately
uses its older private injection/software-signature harness.

The standalone client was a separate **process on this same host**. It was not a
cross-machine agent trial, a model-provider invocation, a physical passkey trial
or a human usability study. No approved remotely reachable environment was supplied
or provisioned. The runnable remote test is delivered in
[`scripts/participation-client.mjs`](../../scripts/participation-client.mjs);
cross-machine execution remains **pending**.

## Observed results

| Command | Result and what it establishes |
|---|---|
| `npm run check` | Passed: unchanged baseline digests/101 mappings/61 scenario IDs/42 illustrative JSON blocks; 64 bootstrap, 5 hook and 25 application/unit/router checks; typecheck and built server/browser. These counts do not claim product acceptance. |
| `npm run test:participation:postgres` | **9 passed** including the parent test, over actual HTTPS/PostgreSQL. Setup/overview/editor rules, atomic constructors and rollback, same-discussion FK, parent/ancestor continuation, immutable/base edits, live authority, exact retry, process/server restart, compatible maximum body limits and hidden scan continuation. |
| `npm run test:e2e` | **5 passed** in the final full Chromium run (17.8 seconds). Real setup, admission, ordinary human authorship, direct HTTP agent reply, repeated nested replies, conflicts, lost response after commit, actual browser process restart, stale route/account results, failed next-page recovery, overview editor/history and artifact/proposal drafts through navigation. |
| `npm run test:publication:postgres` | **16 passed**, preserving absent-attempt races, shared clock/commit ordering, current authority locks, all-stage rollback and connection/process-loss recovery. Synthetic tail measurements remain capacity-unapproved. |
| `npm run test:identity:postgres` | **22 passed**, preserving verifier-only/one-time credentials, WebAuthn proof checks, account/credential lifecycle, identity races and disclosure-safe recovery. |
| `npm run test:app:postgres` | **9 passed** after a sequential build, including compiled HTTP/browser startup, role boundaries, safe failures, database loss, shutdown drain and Vite/API proxy separation. |
| `npm run test:migrations:postgres` | **9 passed**, retaining procedural SQL, atomic rollback/history, immutable checksums, ordering and separate roles. New participation migration was also exercised with all current migrations by each participation/identity/publication fixture. |
| Final `app:typecheck`, `test:app`, build and `git diff --check` | Passed after the relevant changes. No staged diff; no commit/push/deployment or existing-data reset was performed. |
| `npm run app:synthetic` | Built and launched the documented disposable preview. CA-verified HTTPS returned synthetic runtime capabilities and the browser document (200); Ctrl-C completed cleanly. This launch smoke supplements the authenticated browser journeys above. |

The complete `npm run check` passed before the last two browser-only edge repairs;
their later build/typecheck and full five-journey browser run passed. The final
documentation check separately reconfirms unchanged imported baselines.
All ten reference hashes, 20 local links in the new participation/ADR/reference
documents and three guide JSON examples were also checked successfully.
During finalization, staged whitespace checking reported one original trailing-space
line in the v0.6 HTML import (line 864). Its verified supplied bytes are preserved;
all other staged files pass. The earlier unstaged check did not include new files.

Important observable assertions:

- A browser-admitted ordinary human creates a discussion; an issued bearer agent
  fetches the opening's actual text/discussion ID before replying. Top-level and
  nested child/ancestor IDs agree. A database insert with a parent from a **different
  existing discussion** fails with FK violation, independently of HTTP validation.
- A failure after outcome insertion rolls back the new discussion and opening.
  Retained common-tail tests continue to inspect revision/pointer/event/intent/outcome
  identity and rollback at each stage, not just successful status codes.
- Human/agent forbidden edits and changed publication closure are denied under the
  same domain policy. Editor removal prevents mutation replay but permits authorized
  read-only recovery. Suspended credentials and suppressed contexts disclose no
  saved source references. An old eligible revision with a newer suppressed current
  revision remains readable without exposing that newer ID or an edit hint.
- The browser stores intent before an intercepted request is sent. After the upstream
  server returns 201, the test aborts delivery, closes the **browser process**, reopens
  its persistent profile and retries exactly the same JSON/key. SQL shows one scoped
  outcome. The standalone client separately fsyncs its journal, exits 75 after
  discarding a committed acknowledgement, and recovers in new processes with the
  same retained body/parent/revision. Ordinary server restart retains recovery but
  explicitly invalidates old pagination cursors.
- A 16,384-byte control-character body (worst JSON escaping) is accepted and retrieved
  intact below the 131,072-byte cap. A 4,096-byte requested response budget fails
  explicitly with the measured minimum. Multibyte text at/beyond the UTF-8 boundary
  is accepted/rejected accordingly. More than 100 hidden candidates yields bounded
  progress and continuation, including empty pages. GETs leave source activity
  unchanged and no reading-state table/effect exists.
- Actual browser delays hold successful old reads/publications across navigation
  and identity changes. Releasing them cannot replace the new page, show old-owner
  success or repopulate cleared drafts. A failed next-replies fetch retains visible
  content and its retry cursor. A changed base preserves text for comparison and
  only an explicit corrected submission creates a new key.

## Visual and interaction evidence

The final captures below were viewed, including the 390px mobile reading layout,
and compared with the supplied UI v0.6. The desktop sidebar, quiet community link,
palette, rows, avatars, nested replies and compact actions follow that reference.
The implemented subset has working Topics/Artifacts/Administration/guide surfaces;
unimplemented Following/Updates/Saved/search controls are not rendered as promises.
Mobile overflow and drawer Escape/focus behavior were exercised. This is not a
screen-reader or accessibility certification.

- [Discussion desktop](participation-evidence/discussion-desktop.png)
- [Discussion mobile](participation-evidence/discussion-mobile.png)
- [Recovered reply](participation-evidence/recovered-reply.png)
- [Artifact list](participation-evidence/artifacts-desktop.png)
- [Sanitized final browser results](participation-evidence/browser-results.json)

Ten user-supplied reference files were copied byte-for-byte under `docs/design/ui-v0.6/`
and checked against their originals. Their [manifest](../design/ui-v0.6/manifest.json)
records hashes. The supplied QA's 180/96 counts belong to the reference author;
they are not included in our results. `PRODUCT-ALIGNMENT.md` and the reference test
sources were not supplied, so their contents are not inferred.

## Failures found and corrected

The first runs exposed test locator mistakes (a status region shared with loading,
the decorative reply arrow, and a prefilled textarea's label). The UI now gives the
textarea a stable accessible name and hides the decorative arrow from that name.
Tests wait for the committed result, not the draft textarea's visible text.

A pending publication incorrectly displayed the uncertain-outcome notice before
its request finished. It now shows pending confirmation separately; uncertainty
appears after loss/failure or recovered intent. A link-label parser lookahead let a
declared mention appear to be ordinary prose; its HTTP regression failed before
the parser correction and passed afterward. Review added a failing exact-history
test that exposed the suppressed-current ID, then verified the repair. Two final
browser regressions reproduced stale already-open child lists and proposal drafts
resumed through a different composer slot; both were repaired and the entire
browser suite passed again.

The existing router suite initially failed because eagerly importing the new route
loaded CSS in Node; lazy route loading fixed it and reduced the initial bundle.
One runtime regression run failed with missing compiled modules because it was
started concurrently with a build cleaning `dist/`. The normal full runtime suite
was rerun after build completion and passed; neither guards nor assertions were
weakened. The original default startup and current-role protocol remain tested.

## Decisions, memory and remaining gates

Material working assumption: integrate v0.6's relevant visual/recovery experience
within this first text slice; its broader fixtures and proposed timing/defaults
do not silently authorize all Following/summary/personal-state features. Product
v0.9 and all imported architecture baseline bytes are preserved. ADR-011/015/016/017
record implemented choices; prior ADRs/docs are reconciled where their old “no
participant routes/UI” status changed.

Root `MEMORY.md` and `src/server/modules/participation/MEMORY.md` were checked
against final routes, profile guards, migration grants, shared-tail call sites,
schemas, cursor/intent code and actual assertions. They now describe opt-in
participation, both retained digest versions, scoped recovery, fixture topology
and the still-open gates. Inherited Lore anchors are `LC-20261012-LMP4` (runtime),
`LC-20261012-6OTQ` (publication), `LC-20261012-9JJH` (identity) and
`LC-20260929-5WKG` (product baseline). The participation task record is
`LC-20261014-9EU9`; finalization adds this pointer without changing the observed checks.

Remaining: remote reachable-environment trial; real identity/bootstrap/recovery
approval and physical devices; representative capacity/abuse controls; retention,
erasure, backup/restore epochs and upgrade operating procedures; hierarchical
topic management, typed references/summaries, personal collections/reading/feeds;
storage version/grant compatibility and worker fenced outputs. Administrative
identity lists retain their documented 100-row prototype bound. At the original local
verification, updated Linux CI had not run. Existing retained-service S3/persistence
suites were not rerun locally because this slice changes neither storage nor that
environment; isolated migration, runtime, publication, identity and participation
suites were used.

The [retained-data gate](retained-data-gate.md) is still unapproved. Synthetic success
does not settle it, and no real-data or deployment authorization is inferred.

## CI follow-up — 14 October 2026

For commit `14c4e8333b2d98c701b1618b0d56a16039469e74`, the
[push workflow](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38479478697)
passed both jobs on Ubuntu 24.04/Linux amd64, including all five browser journeys
(25.9 seconds) and the retained migration/S3/persistence steps. The duplicate
[PR workflow](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38479509322)
failed during E2E server teardown after the late-publication/account-change test;
its body assertions had completed. The error was `Tearing down "server" exceeded
the test timeout of 90000ms`. Four other journeys passed. Subsequent integration
steps in that failed job were skipped; the successful push run supplies their evidence.

The same unchanged late-publication test reproduced the failure locally on repeat
7 of 10: nine passed and one failed with the identical teardown timeout. A separate
bounded probe showed that both pre-handshake TCP and established TLS sockets with
no HTTP request keep `app.close()` and database-close hooks pending until the client
socket closes. The CI log contains no socket trace; this mechanism was reproduced
locally rather than inferred solely from the timeout.

The fixture had no browser-context/server dependency. For the existing argument
order, teardown could wait for the server while the browser context remained alive.
The context fixture now explicitly depends on the server and closes the context in
`finally` before server teardown. A regression holds a real, CA-verified TLS socket
without an HTTP request and ties its lifetime to the browser context. It failed
with the original ordering at the 90-second teardown limit, then passed after the
fix. This models the connection lifetime deterministically; it does not claim to
force Chromium's speculative-connection scheduling.

`npm run test:e2e -- --grep 'browser-owned TLS preconnection|a late committed publication' --repeat-each 10`
passed **20 tests in 47.6 seconds** after the fix. The normal `npm run test:e2e`
then passed **all 6 tests in 19.7 seconds**, including browser-process restart and
the new regression. Typechecking also passed. Production code, request draining,
application shutdown deadlines, existing assertions, retries,
worker count and the normal 90-second test timeout are unchanged. This repair only
orders test-client disposal before server disposal; it does not force-close server
connections or ignore teardown errors.

At commit preparation, the fixture repair had local verification only; its new
GitHub CI run remained pending. The original failed run is retained above.
Fixture task record: `LC-20261014-WZF5`.
