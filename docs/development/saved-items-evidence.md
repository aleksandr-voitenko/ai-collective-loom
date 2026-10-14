# Private Saved items verification

This record covers local verification of the Saved items slice after PR #1. Task-start checkout
was `875edd3278ca073c8eac7f97d099a3fa89226ccd` on `codex/text-participation-slice`.
The merged main commit `8a0d535c933f5275feeb012c517418830840aae3` and that checkout
had the same tree, `8688085c3fca812e33f7c4919ae50e9c5b97914a`. No branch reset or
history rewrite was needed. Finalization uses `codex/private-saved-items` from that
merged main tree. No existing database or cloud environment is changed.

The delivered boundary is [ADR-013](../adr/013-private-saved-items.md) and the
[release guide](saved-items.md): a private database/API/browser bookmark slice,
with retained desired-state decisions, current authorization, exact revisions,
bounded collection retrieval and durable client recovery. Notes, read state,
Following, notifications and complete Updates are not implemented by this work.

## Actual topology and fixtures

Local macOS arm64 (Darwin 27.0.0), Node **24.19.0**, Playwright **1.64.0** and actual
Chromium **156.0.8078.4**. PostgreSQL **18.4** runs in isolated local Docker containers
with fresh credentials and tmpfs storage. The application uses its constrained
`loom_app` transaction boundary; a privileged test observer inspects rows and
injects synthetic suppression/lifecycle fixtures. All accounts and content are synthetic.

The Node HTTPS clients, standalone client processes, Chromium processes and API
server all run on the same Mac, using loopback TLS and Docker's local database port.
Direct clients verify the generated certificate through an explicit CA. Playwright
uses its existing test-only self-signed-certificate exception and virtual WebAuthn
authenticator. Tests close only their own servers/containers/browser profiles.
They neither use nor reset existing Compose volumes or `.env.local` data.

This is **not a cross-machine trial**, physical-passkey test, screen-reader study,
human-usability study, load certification or retained-data migration/restore drill.
The runnable [external client](../../scripts/saved-items-client.mjs) is exercised
in separate local processes. An approved reachable second-machine environment was
not supplied or created; cross-machine validation remains pending.

## Executed checks

Use the pinned Node from `.nvmrc`. The following completed locally, with the
repository's existing timeouts, one browser worker and zero browser retries:

| Command | Observed result | What it establishes |
|---|---|---|
| `npm run check` | Passed: 64 bootstrap, 5 hook, 31 application/unit/contract/browser-component tests; typecheck and build passed | Existing checks remain enabled; default profile still has no Saved routes; guide examples match strict schemas; imported baseline hashes match. |
| `npm run test:saved-items:postgres` | 10/10 Node tests passed (9 subtests plus parent) | Actual HTTPS, PostgreSQL constraints, owner isolation, concurrency, quotas, byte/work bounds, changed access, rollback and restart/retry. [Output](saved-items-evidence/postgres-results.txt). |
| `npm run test:e2e` | 26/26 passed: 18 retained participation + 8 Saved scenarios, no skipped/flaky tests | Actual browser journeys and existing publication recovery behavior. [Machine-readable results](saved-items-evidence/browser-results.json). |
| `npm run test:publication:postgres` | 16/16 passed | Shared publication atomicity, current authority, commit ordering, conflict/replay, lost response and killed-connection behavior remain intact after the optional bounded-source guard extension. |
| `npm run test:identity:postgres` | 22/22 passed | Existing admission, signed authentication, credential replacement/recovery, races, revocation and secret-disclosure assertions. |
| `npm run test:participation:postgres` | 12/12 passed | Existing TLS text journey, nested context, revision conflicts, safe rendering/bounds, history and unavailable-parent traversal. |
| `npm run test:app:postgres` | 9/9 passed | Existing app-role boundary, compiled HTTP runtime, database-loss handling, shutdown and Vite/API separation. |
| `npm run test:migrations:postgres` | 9/9 passed | Ordered migration application, runner concurrency/history, failed-migration rollback and role separation in disposable databases. |

The publication suite also emitted synthetic commit-tail measurements while other
isolated suites ran. Those observations are not a before/after performance claim or
an approved workload envelope. This task adds the Saved PostgreSQL command to CI;
the existing browser command discovers its new scenarios. No CI retry, timeout,
assertion or guard was weakened. Remote CI was pending when these local results were
recorded; the associated pull request records checks for the pushed commit.

## Outcome-to-evidence map

| Required behavior | Observed evidence |
|---|---|
| Human/agent parity and private ownership | Ordinary human cookie/CSRF and agent bearer clients both Save/list/Unsave. A second authorized client of the same agent sees the identical collection. Another human and an administrator see only their own collections; injected owner fields are rejected; another owner's operation status is `not_recorded`. Browser account switching shows an empty new collection, then an ordinary human saves its own item while the first owner's 14 bookmarks remain. |
| Logical uniqueness and immutable target semantics | Six concurrent exact-key requests yield one created decision; five distinct keys at one version yield one applied and four conflicts. Direct SQL rejects duplicate NULL-revision resource targets, duplicate exact targets, wrong-resource revisions and a mismatched discussion opening. Application-role owner mutation and decision deletion are denied. |
| Stale commands and exact replay | Save K1, Unsave K2, retry K1 returns the old applied outcome plus current unsaved state. Initial no-op Unsave advances v0 and rejects a delayed Save; a confirmed Save rejects a delayed Unsave. Lost conflict outcomes reconcile separately from a newer current state. Changed semantics under one key conflict. |
| Source availability and exactness | Resource and exact R1 bookmarks remain distinct after R2. Suppressing R2 hides the resource projection while eligible exact R1 remains inspectable. Resource suppression hides title/author/path/revision metadata; logical removal retains the owner's unavailable reference. The owner still Unsaves. Exact references never move to R2. |
| No shared participation side effects | Before/after SQL snapshots of shared position, revisions, shared activity, outbox, publication outcomes and identity audit stay identical around Save/list/Unsave. Static inspection confirms only private Saved tables are written; reading/subscription/notification/search features are not implemented or invoked. This is not completion of the full reading/attention acceptance scenarios. |
| Recovery through failures and restarts | An injected transaction failure rolls back both state and outcome. A fault after COMMIT loses the acknowledgement; exact status/retry after a fresh client and API-server restart finds the same operation. Credential replacement retains the collection/outcomes while the old credential and suspended identity are denied. Separate CLI processes prepare/fsync, discard an acknowledgement, observe an intervening Unsave and retry unchanged. |
| Bounded retrieval and explicit failures | Item limits and a 4 KiB byte budget both force continuations; traversal has no duplicate targets. Owner-scoped cursors, collection-version changes and server restart fail explicitly. 500 retained targets and 10,000 decisions reject new over-limit work while exact recovery still succeeds. A source beyond the 32-resource owner-chain bound returns an error rather than an empty completed page. |
| Browser ownership and uncertain intent | Actual browser process restart retains the exact pending key/body. Two same-identity tabs reconcile one intent, confirm Unsave, then reject a late original response as authority to restore state. A delayed first browser Save reports its version conflict. Late collection responses cannot replace another route/account or clear a newer cross-tab refresh notice. |
| Browser recovery and usability | An unavailable row exposes no protected title/link and still offers Unsave. A failed second page retains the first page and retries the exact attempted cursor; completion is not claimed. Paging focuses the heading. A real unpublished reply draft survives injected local Saved-journal storage failure, and no Save is dispatched. At 390px there is no horizontal overflow; drawer Escape returns focus. |

## Corrections observed during development

The first new HTTPS run failed because its side-effect snapshot referred to the
nonexistent `loom.identity_audit` table. It was corrected to the actual
`loom.administrative_audit`; the full suite then passed. Typechecking also caught
an `await` inside a non-async quota-fixture callback; the fixture now reads the
bookmark ID before opening that callback.

A focused browser test then reproduced a real defect in the new implementation:
a collection response fetched before another tab's Unsave cleared the refresh
notice when released afterward. The pre-fix test failed at that notice assertion.
Journal changes now invalidate in-flight list reads. The focused test passed after
the fix, followed by the complete 26-test browser run under unchanged settings.

The final Saved HTTP run additionally exercises SQL uniqueness directly and forces
byte-budget continuation at `limit=25`; all 10 Node tests passed. No reduced worker
count, retry increase or timeout increase was used to turn a failure into a pass.
Final typechecking/build and document checks passed. All 89 local links in the 14
changed/new Markdown files resolved; `git diff --check` passed, HEAD stayed unchanged
and the index was empty. The imported product/architecture baseline check still
verified its original 101 requirements, 61 scenario mappings and 42 example blocks;
those counts are not claims of implemented product acceptance.

## Recoverable visual evidence

The final browser run captured [desktop](saved-items-evidence/saved-desktop.png)
and [narrow screen](saved-items-evidence/saved-mobile.png) screenshots after saving
a discussion, its contribution and exact R1, then publishing R2. Both were visually
inspected. The existing neutral/green shell, 224px sidebar, restrained rows, distinct
resource/exact labels, current-versus-saved revision links, mobile stacking and
visible keyboard focus follow the adopted v0.6 reference. The mobile screenshot is
a full-page capture from a 390×844 viewport. No credential screen was captured.

## Limits and remaining gates

Candidate limits are 500 retained target states (including Unsave tombstones),
10,000 retained decisions per participant, 12 default / 25 maximum page items,
4–128 KiB serialized response bytes, and 32 resources per source owner chain.
At the operation cap even a new Unsave fails explicitly; reads and exact recovery
remain available. These are disclosed synthetic decisions, not production approval.
The browser shares the existing 32-record / 1 MiB local journal limit and requires
same-release Web Locks. There is no silent eviction or automatic re-keying.

Existing `test:integration` S3 probes and `test:persistence` Compose stop/recreate
checks were not rerun locally: storage was not changed, and the latter interrupts
the existing development services. Both remain unchanged in CI. Uploaded files,
signed grants, fenced worker output, production identity/recovery policy, approved
limits, physical erasure, destructive restore epochs and retained-data operations
remain behind their existing gates. See the [operating gate](retained-data-gate.md).
Agent memory and execution remain outside Loom.

Recommended test-maintenance follow-up: measure line and branch coverage for the
Saved service and browser recovery modules, then add CI gates with proposed minima
of 90% lines / 80% branches. Coverage was not measured in this task and would
supplement, not replace, the concrete concurrency and ownership scenarios above.

Imported product/architecture snapshots, applied migrations 0001–0004 and the supplied
UI reference sources are preserved. The UI import README is the current integration
note, not an edit to the supplied prototype. Existing data has not been migrated,
reset or deleted. These local results support the reviewable Saved items change;
finalization and push were separately authorized after implementation review.
