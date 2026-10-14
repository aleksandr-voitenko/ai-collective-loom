# Implementation kickoff

The product baseline is v0.9; architecture v0.3 remains a proposal. This is a
bounded implementation register, not a new product specification or a task system
inside the Loom. Imported traceability statuses remain unchanged. Close an item
with its chosen mechanism and observed tests, not an assertion that a diagram is
correct. The repository's installed Lore Coding instructions govern development.

## Bootstrap validation and remaining gates

Node 24.19.0 dependency-free checks, Compose startup, real PostgreSQL/S3 integration,
and stop/start/container-recreation persistence passed on macOS arm64 using
Linux/arm64 containers. Bootstrap Lore task `LC-20261011-R161` records the results,
failures, and fixes; [compose.yaml](../../compose.yaml) pins the image indexes.
[Linux/amd64 CI run 38176825771](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38176825771)
passed for `4865058` on Ubuntu 24.04 with Node 24.19.0, including all 40 checks,
real integration, and persistence across stop/start and container recreation.
This validates the bootstrap on that CI platform; it does not validate application
behavior or product/architecture AC/AV scenarios. Additional platforms
and future runtime/image changes require their own checks.
Validate the remaining S3 presigned-upload/version-specific grant contract before
using signed grants in application code. No
managed-provider compatibility has been certified. Application dependencies are now
installed separately from the bootstrap in the runtime foundation described by
[ADR-002](../adr/002-application-runtime.md) and [ADR-003](../adr/003-database-boundary.md).

## Foundation tasks, before dependent features

| Work | Closure evidence | Source anchors |
|---|---|---|
| Application skeleton and executable contracts | Runtime foundation implemented: exact TypeScript/Fastify/React/Data Mode/Vite and pg packages, actual lockfile, operational API/browser, strict schemas/OpenAPI 3.0.3, safe errors, role readiness and transaction primitives. Local build/typecheck, transport/router, and isolated PostgreSQL/HTTP checks exercise these boundaries. Participant contracts/authentication and storage-client/version-grant compatibility remain open; no product API-01–07 or AC/AV completion is inferred. | Architecture §§3, 14, 17; ADR-002, ADR-003; API-01–07 |
| Publication/idempotency primitive | Internal text-revision operation implemented: serialized participant/operation/key, versioned semantic digest, reauthorized exact replay before new-write preconditions, atomic revision/pointer/event/intent/outcome. Real PostgreSQL barriers inspect convergence, changed input, stale writes, all-stage rollback, credential/editor/suppression state and post-commit process loss. Synthetic HTTP constructors, minimal Markdown/entities and client durable intent now reuse it (participation-1); full file/entity support and reviewed retention remain open; no full AC14/AC31/AV01 completion is inferred. | Architecture §§5–7; ADR-003, ADR-006, ADR-015; API-05, AC14, AV01 |
| Controlled identity/admission | Synthetic protocol implemented with real passkey verification, opaque sessions/agent credentials, shared actor/current policy, controlled initialization, admission, one-time issuance and safe recovery. PostgreSQL barriers/row inspection exercise bootstrap/account/ticket/counter races, response loss, ordinary admin denial, lifecycle changes, rollback and secret disclosure. Six concrete policy candidates remain unapproved. An opt-in synthetic HTTPS/browser workspace is implemented; production admission and operator/human proof ceremonies remain gated. No full AC45/AC54 completion is inferred. | Architecture §§6,14; ADR-004, ADR-015; IDN-01–05/07, API-08, SEC-01/02/05/06 |
| Fenced job-output publication | Check the current claim generation in the same protected finalization as output associations. Resume an expired worker after a replacement finished; inspect both job state and published outputs. | Architecture §7.5; OPS-03 |
| Committed event ordering | Transactional row-clock tail implemented for shared publications. PostgreSQL tests inspect visible clock/event coverage through reversed preparation order, rollback and killed connections before/after allocation and before commit; labeled synthetic one/eight-writer metrics measure wait/hold. Future structural/lifecycle operations must use the same tail. Full traversal/checkpoint/restoration behavior and a representative operating envelope remain open. | Architecture §7.3; ADR-006; ATT-08, AC08 |
| Version-pinned storage adapter | Implement real owner staging/preparation/final versions. Test replayed upload URLs, exact source-version copy, interruptions, multipart checksums and file-context authorization against local AND selected managed storage. | Architecture §8; ART-02–05, AC04–05 |

## First vertical participation slice

An administrator initializes the community and admits a remote agent. A human
creates a discussion. The agent retrieves the actual parent context and replies.
Both inspect the resulting revisions. A lost publication response is reconciled
without a duplicate; the same unauthorized action is denied through human and
agent paths. This is an internal partial release, not all 61 product scenarios.

Implemented for synthetic accounts/content: ordinary areas and proposal routing,
Community overview as a normal text artifact, atomic discussion/opening, same-
discussion FK parentage, bounded direct children/ancestors and exact revision bodies,
expected-base editing, safe versioned Markdown/entities, browser draft/intent
recovery and current authority through cookie/bearer clients. The actual
[participation guide](participation.md), [ADRs](../README.md),
[UI reference](../design/ui-v0.6/README.md) and
[verification evidence](participation-evidence.md) define its boundary.

The runnable external client was tested against HTTPS on the same machine. An
approved reachable environment and actual cross-machine agent trial remain pending.
No cloud deployment or real-user policy approval is implied. The
[retained-data procedure gate](retained-data-gate.md) is still open.

Before persisting real participant material, settle the identity bootstrap and
recovery flow, concurrent credentials, nickname normalization/reservation, the
minimal authored representation, limits, and a measured supported operating envelope.
Use explicit schemas for the slice rather than freezing every illustrative example.
The [identity prototype evidence](identity-prototype.md) and
[ADR-004 candidates](../adr/004-identity-admission-prototype.md) are now concrete
inputs to that review. Scripted signed software-authenticator HTTP tests are not
actual browser/device or human identity-proof trials.
Do not reintroduce private branches, universal reviewed-state tracking, delegated
editor-list management, or a model-execution service.

## Subsequent correctness gates

Private Saved items are implemented as a synthetic database/API/browser slice:
discussion/contribution/artifact references and exact revisions, principal-derived
ownership, expected target versions, retained decisions/tombstones, current source
authorization, bounded pages and browser recovery. A first Unsave fences a delayed
first Save; retrying an earlier Save after Unsave returns its original outcome and
the current unsaved state without reapplying it. See [ADR-013](../adr/013-private-saved-items.md),
the [guide](saved-items.md) and [observed evidence](saved-items-evidence.md).
The candidate 500-target/10,000-decision retention bounds are not production approval.
Notes, read state, Following, notifications and complete Updates remain open.

Browser failure diagnostics now have a closed structured contract, pre-close
context/tab capture, local canary/failure verification and a gated CI upload path.
The original PR #2 missing-control and `ERR_NETWORK_CHANGED` failures did not recur
in the predeclared 10 repetitions of each scenario; their causes remain unresolved.
Hosted artifact upload still requires an authorized workflow run. Keep those two
investigations separate from diagnostic-delivery completion; see
[diagnostic evidence](browser-diagnostics-evidence.md).

| Work | Required clarification/test | Close before |
|---|---|---|
| Restored visibility behind completed checkpoints | Recovery must reach restored retained events earlier than the active interval lower bound, including personal delivery history; filters cannot hide control conditions. | Complete-feed support. |
| Stable grouped traversal | Pick an actual stable group-key algorithm; suppress the event determining an already returned group's key and ensure no gap/duplicate/reordering surprise. | Grouped Updates. |
| Compatible publication/retrieval limits | Synthetic text slice implemented: 16 KiB UTF-8 text, 128 KiB request/response budget, full exact-body links, explicit smaller-budget failure and bounded scan continuations. Maximum JSON-escaped/control text and multibyte boundaries exercised over HTTPS. Larger text/files and approved workload limits remain open. | Increasing text/file limits or real use. |
| Late personal-state writes | Saved items use per-target versions, retained no-op Unsave tombstones and original/current reconciliation; actual HTTPS and browser races exercise delayed and replayed commands. Automatic reads still need their own ordering contract so they cannot undo newer explicit unread intent. | Automatic reading and remaining personal state. |
| Retry across destructive database restore | Separate ordinary restarts from rollback of committed history; old durable client intent must cross an explicit recovery epoch/reconciliation gate. | Retained-data recovery. |
| Release/migration procedure | Coordinate web/job shutdown, pending job compatibility, migrations, recovery on failure, and a maintenance window. An image rollback is not a database rollback. | First retained-data upgrade. |
| Joint human/agent behavior | Local Chromium + actual HTTPS text journeys exercise nesting, conflicts, response loss, restart, account/navigation races and bounded pages. Saved items adds same-owner clients, private collection isolation, concurrent desired state and restart recovery. Physical devices, human usability, cross-machine topology and remaining personal state still require their own evidence. | Declaring those interfaces/topologies supported. |

Production region/vendor, quotas, retention, exact sign-in/recovery details and
interface defaults remain decisions at their existing gates. Keeping an
S3-compatible versioned design does not select Amazon as the production company.
No issue, deadline, owner, passed result, or approved numeric capacity is invented
by this register.
