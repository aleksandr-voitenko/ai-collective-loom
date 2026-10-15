# Topic organization verification

This is the local evidence for [ADR-020](../adr/020-topic-organization.md) and the
[organization guide](topic-organization.md). The task began on
`codex/browser-failure-diagnostics` at `4279c8abe75a0721a043ddd049502041caed12d0` with
a clean worktree. The supplied `c43d2a26acda4ab7130b5f70f8aacee17317ca0c` baseline
was not available locally; the checkout already contained the PR #3 diagnostic
work. The current checkout was preserved. At the implementation review checkpoint,
no reset, stage, commit, push, merge or deployment had been performed. Applied
migrations and imported product/architecture/UI
sources were preserved.

The delivered slice covers administrator-created root/nested areas, metadata
history, subtree/discussion/artifact movement, inherited closure, bounded hierarchy
and destination retrieval, strict API/browser recovery, and ordinary organizational
suggestion discussions. Resource ownership remains authoritative. A community
hierarchy version conservatively fences changed context and invalidates old
current-placement cursors. These choices assume the existing single-process
synthetic profile and bounded community; they are not production capacity approval.

## Executed checks and environment

All clients and servers ran on one macOS arm64 host with Node **24.19.0**,
Playwright **1.64.0**, Chromium **156.0.8078.4**, Docker and isolated PostgreSQL
**18.4** containers. HTTPS clients trust a generated local CA; browser fixtures use
their existing self-signed-certificate exception and virtual WebAuthn authenticator.
Test observers inject synthetic state and inspect SQL; application operations use
the constrained `loom_app` role. No real accounts/content or existing development
volumes were used.

| Actual command | Observed result |
|---|---|
| `npm run check` | Passed: documentation baseline checks, 64 bootstrap tests, 5 hook tests, 31 application/unit/contract/component tests, typechecking and build. |
| `npm run test:organization:postgres` | **15/15 passed**. Includes populated upgrade and 12 organization HTTPS subtests plus their parent, and explicit area/subtree/decision caps. [Output](topic-organization-evidence/postgres-results.txt). |
| `npm run test:e2e` | **37/37 passed** under the normal one-worker, zero-retry configuration: 8 organization, 18 participation and 11 Saved scenarios. [Results](topic-organization-evidence/browser-results.json), [approval](topic-organization-evidence/browser-approval.json). A previous full run also passed 37/37; the final run includes settled-page and narrow move-form captures. |
| `npm run test:browser-diagnostics` | Passed: 8 intentionally failing child probes, full candidate canary/schema/byte checks, lifecycle assertions and 4 fail-closed validation cases. The child failures are required; the verification harness exited successfully. [Approved probe manifest](topic-organization-evidence/diagnostic-probes/run.json). |
| `npm run test:migrations:postgres` | 9/9 passed: ordered migrations, unchanged checksums, rollback, history and role boundaries. |
| `npm run test:app:postgres` | 9/9 passed: constrained SQL/HTTP runtime, compiled startup, database loss, shutdown and Vite/API separation. |
| `npm run test:publication:postgres` | 16/16 passed: retained publication atomicity, authority, replay, commit order, rollback and killed-connection cases. |
| `npm run test:identity:postgres` | 22/22 passed: current identity policy, credential/passkey races, replacement/recovery, role changes and disclosure assertions. |
| `npm run test:participation:postgres` | 12/12 passed: existing actual HTTPS text flows, bounded context, revisions and source suppression. |
| `npm run test:saved-items:postgres` | 10/10 passed after updating the standalone client to accept guide 3 alongside guide 2. Ownership, target identity, late state, quotas, restart and process-journal assertions remain intact. |
| `node scripts/local.mjs up`, `smoke`, `persistence` | Passed in a fresh copy at `/private/tmp/loom-organization-storage-MS0Flk`, with its own random credentials, ports, Compose project and named volumes. These execute the implementations of `dev:up`, `test:integration` and `test:persistence`. SQL/role/checksum/rollback and versioned storage/signature/expiry/multipart probes passed. Committed rows, migration history, credentials, bucket versioning and three exact object versions survived stop/start and container recreation. Only that disposable project's volumes were then removed using its guarded reset command. |
| `npm run app:typecheck` | Passed again after strengthening separate server-process recovery. |

The new PostgreSQL suite is on the normal CI path, and the normal browser runner
discovers its spec. No worker count, retry, timeout or assertion was weakened.
Remote CI and hosted artifact delivery had not run at that review checkpoint.
Synthetic tail timings from the retained publication tests are not a performance
comparison or approved workload envelope.

## Outcome-to-evidence map

| Required behavior | Direct evidence |
|---|---|
| Populated upgrade | Seeded migration-0005 database includes areas, settings, discussion/opening/reply, exact R1/R2, artifact, editor list and exact Saved reference. Before/after SQL snapshots match through 0006 and a repeated migration. New metadata baselines are unattributed; no historical activity is invented. |
| Authority parity | Human cookie/CSRF and agent bearer administrators create/edit organizational state under the shared policy. Both ordinary participant channels contribute successfully and are denied structural changes, reconciliation and audit. Demotion denies an earlier administrator's exact retry/status. Strict unknown fields fail and generated OpenAPI validates. |
| Metadata and placement | Attributed metadata history preserves creation/edit publishers. Subtree movement changes current paths without adding text revisions or metadata revisions. Discussion/artifact moves preserve every revision, actual reply parent, editor list, Saved row and earlier publication event in SQL snapshots. |
| Cycle safety | Self/descendant, nonexistent and wrong-kind parents are rejected. Two opposite moves are held at deterministic exclusive structure-lock barriers: one commits and the stale contender refuses, leaving no cycle. |
| Publication races and event order | Move/reply and close/reply exercise both shared/exclusive lock acquisition and commit orders using barriers, not sleeps. Current placement and new event scopes agree, old opening scopes stay unchanged, closed-first writes refuse, and the shared clock covers committed events. |
| Idempotency and rollback | Lost post-COMMIT response, changed input, stale versions and injected pre-COMMIT failure are checked against rows and the clock. Two concurrent exact requests share one operation/event/outbox/audit set. K1→B, K2→C, exact K1 returns original B and current C without applying again. |
| Process recovery | Exact intent is written and fsynced before the lost-response dispatch. Two separately launched compiled API server processes and two fresh HTTPS client processes recover the same earlier move from PostgreSQL. Ordinary restart invalidates prior cursor custody, not operation identity. Browser persistent-profile process restart independently preserves the exact journal body/key. |
| Closure and visibility | Inherited closure blocks discussion/artifact creation, replies and artifact revisions, including administrator revision attempts, while content reads succeed. Reopening an ancestor preserves the child's independent closure. Suppression removes organization projections, history, proposal routing and Saved source metadata, and prevents outcome disclosure. Existing publication tests retain broader contribution/revision suppression coverage. |
| Bounds and continuation | Depth 12 succeeds and 13 refuses; subtree depth overflow, byte/Unicode description limits and oversized page limits refuse. 4 KiB destination/audit budgets produce continuations. At 500 areas new creation refuses; exactly 500 subtree rows fit and an injected 501-row imported subtree refuses. At 10,000 retained decisions new commands refuse with unchanged clock while exact recovery remains available. Relevant moves/edits and restart invalidate cursors with explicit replay recovery. |
| Proposal route | Opening a browser composer leaves publication counts unchanged. Destination rename/move keeps its configured stable ID/settings version. Closure and changed settings preserve the ordinary draft and offer contacts. The affected-area reference survives reorganization and is withheld when inaccessible. |
| Browser recovery and layout | Real Chromium exercises create/edit/move/close/reopen, contextual duplicate-name destinations, lost response, reload, stale version correction, stale tabs, late route/account responses and proposal fallback. An unrelated publication draft survives organization recovery. Existing Saved tests cover its journal isolation. Keyboard selection/confirmation, pagination focus, drawer Escape/focus and 390px overflow assertions run. |

## Development failures and repairs

The first PostgreSQL run failed in a snapshot fixture that ordered a single-column
table by two columns. The fixture was corrected to `ORDER BY 1`; the suite passed,
then later expanded to 15 passing tests. No product assertion was relaxed.

The first eight-scenario browser run passed six and failed the stale-tab and
account-switch scenarios. The stale-tab fixture navigated away before its unrelated
publication draft had persisted; it now explicitly waits for that record. The
account-switch fixture now uses the existing UI sign-out/clear journey instead of
direct cookie manipulation and replaces its previous virtual authenticator. The
sanitized initial evidence does not establish a single cause for that account
failure. Both targeted reruns passed, then both complete normal runs passed.
[Initial failure manifest](topic-organization-evidence/initial-browser-failures/run.json)
and [targeted rerun](topic-organization-evidence/targeted-browser-repair/run.json)
are retained; these runs are not evidence that intermittent failures are impossible.

The first diagnostic invocation used the restricted execution sandbox: all probes
failed before capturing a page/Chromium version and the harness correctly refused
to count this as success. [Evidence](topic-organization-evidence/sandbox-diagnostic-failure/run.json)
was preserved before retrying with local browser permissions. That run reached the
maximum-capture serialization assertion: adding four closed control categories
exceeded the previous pretty-printed reserve. Diagnostic output now uses compact
JSON, keeping the original 128 KiB document, 17 MiB candidate, page/event count
and lifecycle guards. The test measures actual writer serialization and a
full maximum-size bundle. [Size-failure probes](topic-organization-evidence/diagnostic-size-failure/run.json)
are retained, and complete verification subsequently passed. No raw error text,
DOM, credentials, headers, storage or unrestricted traces were added.

The retained Saved integration suite caught the standalone client's guide-2-only
check. Guide 3 adds organization without changing Saved semantics; the client now
accepts versions 2 and 3, with the full 10-test suite passing. Review also corrected
a breadcrumb/sidebar style interaction and added explicit collection restart after
hierarchy invalidation while retaining stale page context. The final browser suite
exercises those changes.

Final preservation review identified an uncovered community-wide suggestion path:
requiring an affected area would falsely identify the proposal destination as its
subject. A new API assertion first failed with 400 instead of 201; dependent
subtests then lacked the setup that assertion interrupted. The optional affected
area now distinguishes community-wide suggestions while retaining their frozen
settings/destination binding. Browser coverage checks the initially empty composer,
durable draft return to the overview and absence of a fabricated area reference.
The full organization and retained participation suites then passed 15/15 and
12/12 respectively; the final complete browser run passed 37/37. This correction preserves the existing community-wide action;
topic-specific suggestions still retain their affected-area ID.

## Visual evidence and remaining gates

The [desktop topic](topic-organization-evidence/desktop.png), [390px topic](topic-organization-evidence/mobile.png)
and [390px move confirmation](topic-organization-evidence/move-mobile.png) captures
were visually inspected. They show actual synthetic data, ancestor navigation,
inherited closure, descriptions, bounded contextual destinations, wrapping IDs and
visible keyboard focus in the existing neutral/green shell. These are explicitly
curated screenshots outside the diagnostic upload candidate; no credential screen
was captured. Automated keyboard/layout checks are not a human or screen-reader study.

Optional moderator assignment/delegation, search workers, grouped Updates,
subscriptions, notifications, automatic reading, notes, uploads and agent execution
remain unimplemented. Only the supported administrator/organization portions of
ORG-01–06, ART-08 and AC02/12/32/39/40/44/53 are claimed here. Broad attention/search
acceptance cases remain open. Physical passkeys, cross-machine clients, real-user
policy, hosted operations, multi-process cursor custody, production quotas and
retained-data erasure/destructive restore procedures remain gates. Ordinary local
process/storage restarts and a synthetic populated migration do not satisfy them.

Root and scoped memory were reconciled against organization services, lock guards,
schemas, browser journal code and the assertions above: guide version, metadata/
event semantics, cursor invalidation, admin-only policy, caps and diagnostic encoding
were updated. Existing publication/Saved/identity privacy constraints and Lore links
remain in place. Implementation stopped at an uncommitted reviewable diff;
subsequent authorized finalization is recorded by Lore-ID `LC-20261014-IGI9`.
All 112 local links across the 18 changed/new Markdown files resolved, document
baseline checks and `git diff --check` passed. At that checkpoint HEAD remained
unchanged and the index was empty. Existing migrations and imported product/architecture/UI snapshots had
no diff. These checks do not claim broader product acceptance.

## Hosted CI follow-up

The authorized task commit `d55e70bb9ab0d781e633fa7da666ab1d72c8eea5`
(`LC-20261014-IGI9`) was pushed on the existing branch.
[Push run 38596456075](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38596456075)
passed the initial checks, runtime/publication/identity/participation/Saved/
organization PostgreSQL suites and diagnostic verification on Ubuntu 24.04 x64.
The normal browser suite finished **35/37 passed**. Subsequent migration, storage
integration and persistence steps were skipped because that browser step failed.
Approved diagnostic upload succeeded, and the downloaded JSON validates against
the closed schemas. [Manifest](topic-organization-evidence/ci-first-failure/run.json)
and both failure bundles are retained without raw browser output.

The organization scenario reached its narrow move-form screenshot at line 61,
with the signed-in shell and enabled confirmation control captured, no failed
network request, and normal teardown. Its three screenshot destinations used the
macOS-specific `/private/tmp` path, outside Playwright's private output directory.
Local macOS runs had not exercised that portability gap. They now use per-test
`outputPath`, matching the existing suites and the runner's raw-output cleanup.
No application behavior, assertion, timeout, worker count or retry changed.

The separate retained participation scenario failed on its first `/loom` request
with the diagnostic category `network_changed`, before the application shell
loaded. This evidence identifies the transport failure, not its underlying cause;
the screenshot path repair does not claim to resolve it.

After the path correction, `npm run app:typecheck` and the full normal
`npm run test:e2e` passed locally: **37/37**, one worker and zero retries, including
both scenarios that failed on the first hosted run.
[Results](topic-organization-evidence/portable-captures-results.json) and
[approval](topic-organization-evidence/portable-captures-approval.json) are retained.
Documentation and diff checks also passed. Hosted verification of this follow-up
remains pending at commit preparation (`LC-20261015-83ZU`).

## PR #5 browser recovery corrections

Review of `ab7d013` identified two gaps:
[StrictMode form liveness](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/5#discussion_r4277276377)
and [community-wide proposal recovery](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/5#discussion_r4277276383).
The form now restores liveness on every effect setup while retaining real-unmount
and identity-generation guards. Existing proposal attempts remain accessible
independently of fresh routing, with their original destination, settings and key.

On Node 24.19.0/macOS arm64,
`node --import tsx --test tests/web/organization.test.tsx` first failed both
success/rejection busy-state assertions on the original source; unmount and
identity cases passed. After the fix, all four pass. These use actual development
React StrictMode, JSDOM, the real intent store and HTTP stubs. The normal Chromium
fixture serves the production bundle, so it does not exercise that effect cycle.

`npm run test:e2e -- tests/e2e/organization.spec.ts --grep 'community-wide proposal'`
first failed all four corrected regressions at the missing composer, then passed
all four after the fix. Actual Chromium, HTTPS and disposable PostgreSQL cover
drafts and committed-but-unacknowledged publications with a closed or unconfigured
destination. Local-draft resume plus reload preserves text and the entire request;
status reconciliation keeps the original key, produces no duplicate discussion
and invents no affected-area reference. Administrator contacts remain available.

Initial fixture runs also exposed a 200-versus-201 expectation in the lost-response
setup and stalled DOM-object assertion formatting. The status expectation now
matches the documented creation response. Three stalled unit runs were stopped;
boolean behavior assertions now report the intended failures without formatting
the DOM object. The corrected regressions were rerun before application changes.

`npm run check` passed 64 bootstrap, five hook and 35 application tests, typechecking,
document checks and build. The complete normal `npm run test:e2e` passed **41/41**,
with one worker, zero retries and validated diagnostics, including existing late
account/navigation, stale-draft, participation and Saved scenarios. No dependency,
migration, authority policy, timeout or normal retry setting changed. This is
synthetic verification, not production readiness or a rendered development-browser
trial. Hosted CI is pending at commit preparation (`LC-20261015-NXOD`).
