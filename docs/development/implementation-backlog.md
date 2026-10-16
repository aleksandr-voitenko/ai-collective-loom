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
| Fenced job-output publication | Implemented for synthetic search: resource/revision → job → index-state guards precede lease/owner/generation and current-source checks; output and success share COMMIT. Native process barriers exercise actual lease expiry/reclaim, late A after B, R2 before R1 and process loss before/after COMMIT. Search owns independent discovery, retained failures and resumable rebuild. Personal direct attention now uses its independent ordered consumer (ADR-023); remaining consumers and production job/retention policies remain open. | Architecture §7.5; ADR-006/012; OPS-03 |
| Committed event ordering | Transactional row-clock tail implemented for shared publications and administrator organization. PostgreSQL tests inspect visible clock/event coverage through reversed preparation order, rollback, killed publication connections and move/close races in both commit orders. Structural events retain before/after scopes without rewriting old event ancestry. Future lifecycle operations must use the same tail. Ungrouped shared traversal/checkpoint/restoration is implemented in W01 (ADR-024); grouping and a representative production operating envelope remain open. | Architecture §7.3; ADR-006, ADR-020; ATT-08, AC08 |
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

## Authored change explanations

KNW-05 has both synthetic text forms: immutable artifact/summary revision notes and
ordinary opening/comment accounts with 1–16 exact described revisions. Migration
0011 preserves old rows/digests and adds field-specific mention/reference provenance.
Bounded authorized history/discovery and current-note search reuse source identity;
summary coverage distinguishes summary notes from ordinary account sources.
See [ADR-022](../adr/022-authored-change-notes.md), the [guide](change-notes.md)
and [evidence](change-notes-evidence.md). This implements related KNW-02–06,
MEN-01/02 provenance, REF-01–03, SRCH-02/04–07 and API/recovery portions; it does not
complete full Updates, file/private-note integration, broad human/
provider-agent acceptance, production capacity or retained-data policy.

## Durable personal direct attention

The synthetic increment implements MEN-01/02 for supported published text and
notes, true immediate-parent replies and the personal direct-attention portions of
ATT/API retrieval and AC60. Main claims retain identity across revisions; new
revision notes remain distinct; new reasons coalesce into one delivery. Independent
ordered jobs and per-recipient committed clocks support delayed availability,
fixed intervals, restarts and restoration before completed lower bounds. The
browser Mentions/replies view and standalone HTTPS reader share the same contract.
See [ADR-023](../adr/023-personal-direct-attention.md), the [guide](notifications.md)
and [performed checks](notifications-evidence.md).

Old unmentioned replies without publication-time eligibility facts remain explicit
historical gaps. This does not claim complete historical recovery, grouped shared
Updates, routine mutes, highlights/grouping, read state,
dismissal, file/private-note integration, moderation administration, production
operations, comfortable human use or provider/cross-machine validation. These
remain unfinished requirements rather than optional policy changes.

## W01 — Following and ungrouped shared retrieval

Implemented as a synthetic persistence/API/browser increment: owner-private area,
discussion and artifact definitions; explicit descendants/preferences; versioned
retry decisions; direct committed shared intervals; immutable event-time scopes;
separate durable checkpoints and visibility replay. Parent/child choices remain
independent, and current authorization applies on every page/detail. See
[ADR-024](../adr/024-following-shared-changes.md), the [guide](following.md) and
[observed verification, failures and limitations](following-evidence.md).

This covers ATT-01–03 and shared-only portions of ATT-06/08/11/13–15 and §12.3.
Pre-migration area events lack some descendant-impact facts and expose unknown
coverage. W02 grouped Updates, highlights, mutes/dismissal, combined personal/shared
checkpoints and read state remain open. Broad AC08/09/12/13/20/24–26/33/39–43/46/55/60
are not closed by the synthetic shared-only journeys. No accepted inventory workbook
was supplied; its statuses were not invented or edited.

## Subsequent correctness gates

Discussion summaries have a synthetic database/API/browser slice for KNW-01–04
and KNW-07: optional canonical summary, initial creator editor, explicit current
editing rights, fixed full/partial source declarations, independent coverage
history, safe unknown comparison and bounded maintenance. Summary references and
current authored-text indexing reuse existing mechanisms. See [ADR-010](../adr/010-discussion-summary-coverage.md),
the [guide](discussion-summaries.md) and [observed evidence](discussion-summaries-evidence.md).
AC51/52 and applicable summary/source portions of AC10/31/37/38/54/55/57/59 are
bounded scripted journeys, not broad scenario closure. Summary-maintenance alerts, files,
reservations, full moderation UI, representative human and
provider-agent trials, retained-data recovery and production capacity remain open.
The 100-source/10-summary scan and preparation retention/custody limits are
synthetic choices requiring review before larger workloads.

Administrator topic organization is implemented in the synthetic persistence/API/
browser slice: implicit root, nested areas, attributed metadata history, subtree
and content moves, inherited closure, bounded browsing, version preconditions and
original/current exact recovery. The proposal action remains an ordinary discussion
with a stable affected-area reference and a frozen configured destination.
See [ADR-020](../adr/020-topic-organization.md), the [guide](topic-organization.md)
and [observed evidence](topic-organization-evidence.md).
This covers administrator portions of ORG-01–06 and ART-08 and the relevant
organization portions of AC02/12/32/39/40/44/53; it does not complete those broad
scenarios. Optional moderator assignments/delegation, grouped Updates, combined attention
and real joint human/agent usability remain open. W01 adds private subscriptions and
shared event traversal with retained structural impacts (ADR-024).
The 12-level/500-area/10,000-decision bounds and single-process cursor custody are
synthetic constraints requiring review before real use.

Scoped current text search and its first recoverable worker are implemented in the
synthetic database/API/browser slice. The supported SRCH-01–07 portions and remaining
file/private-note/history work are stated individually in the
[search guide](search.md), with [ADR-012](../adr/012-scoped-text-search.md) and
[observed evidence](search-evidence.md). Current placement and exact source versions
govern results; a stale index never authorizes old or suppressed text. Explicit
continuation invalidation, independent work/byte bounds, incomplete coverage and
administrator retry/rebuild are part of the implemented contract. No broad
AC06/15/17/20/30/33/37/39 completion is inferred. The 5,000-source/50,000-job caps,
single-process API cursors, retention/pruning and measured production envelope
remain review gates; same-machine clients/workers are not a cross-machine trial.

Recorded references have a synthetic persistence/API/browser slice for openings,
comments, text artifacts and summaries (DIS-06/REF-01–03). Exact scopes, source-owned changes/
withdrawal, assertion/editor attribution and direct bounded backlinks extend
SRCH-07 without another worker. See [ADR-021](../adr/021-recorded-references.md),
the [guide](recorded-references.md) and [evidence](recorded-references-evidence.md).
File/path and private-note integration remain open. Summaries and
coverage use ADR-010; coverage membership itself is not a reference assertion.
Reference portions of AC27–30/33/34/37/39 do not complete those broad scenarios.
Production capacity, multi-API custody and cross-machine trials remain gates.

Private Saved items are implemented as a synthetic database/API/browser slice:
discussion/contribution/artifact references and exact revisions, principal-derived
ownership, expected target versions, retained decisions/tombstones, current source
authorization, bounded pages and browser recovery. A first Unsave fences a delayed
first Save; retrying an earlier Save after Unsave returns its original outcome and
the current unsaved state without reapplying it. See [ADR-013](../adr/013-private-saved-items.md),
the [guide](saved-items.md) and [observed evidence](saved-items-evidence.md).
The candidate 500-target/10,000-decision retention bounds are not production approval.
Private notes, read state and grouped Updates remain open; W01 supplies Following/shared changes. Personal mentions/replies are independent (ADR-023).

Browser failure diagnostics now have a closed structured contract, pre-close
context/tab capture, local canary/failure verification and a gated CI upload path.
The original PR #2 missing-control and `ERR_NETWORK_CHANGED` failures did not recur
in the predeclared 10 repetitions of each scenario; their causes remain unresolved.
Hosted artifacts were downloaded and validated from passing push/PR runs and an
intentionally failed manual browser run; the failed step stayed failed while the
approved upload succeeded with three-day retention. Keep the two unresolved
investigations separate from verified diagnostic delivery; see
[diagnostic evidence](browser-diagnostics-evidence.md).

| Work | Required clarification/test | Close before |
|---|---|---|
| Restored visibility behind completed checkpoints | Personal direct attention implements retained-history replay before completed lower bounds, evaluated before reason filters (ADR-023). W01 shared Changes likewise replays retained history before completed lower bounds (ADR-024); grouped Updates restoration remains open. | Grouped Updates restoration. |
| Stable grouped traversal | Pick an actual stable group-key algorithm; suppress the event determining an already returned group's key and ensure no gap/duplicate/reordering surprise. | Grouped Updates. |
| Compatible publication/retrieval limits | Synthetic text slice implemented: 16 KiB UTF-8 text, 128 KiB request/response budget, full exact-body links, explicit smaller-budget failure and bounded scan continuations. Maximum JSON-escaped/control text and multibyte boundaries exercised over HTTPS. Larger text/files and approved workload limits remain open. | Increasing text/file limits or real use. |
| Late personal-state writes | Saved items use per-target versions, retained no-op Unsave tombstones and original/current reconciliation; actual HTTPS and browser races exercise delayed and replayed commands. Automatic reads still need their own ordering contract so they cannot undo newer explicit unread intent. | Automatic reading and remaining personal state. |
| Retry across destructive database restore | Separate ordinary restarts from rollback of committed history; old durable client intent must cross an explicit recovery epoch/reconciliation gate. | Retained-data recovery. |
| Release/migration procedure | Coordinate web/job shutdown, pending job compatibility, migrations, recovery on failure, and a maintenance window. An image rollback is not a database rollback. | First retained-data upgrade. |
| Joint human/agent behavior | Local Chromium + actual HTTPS journeys exercise publication, Saved items and administrator organization, including nesting, conflicts, response loss, restart, account/navigation races and bounded pages. Human and agent administrators share current authority policy; participants can contribute but cannot reorganize. Physical devices, human usability, cross-machine topology and remaining personal state still require their own evidence. | Declaring those interfaces/topologies supported. |

Production region/vendor, quotas, retention, exact sign-in/recovery details and
interface defaults remain decisions at their existing gates. Keeping an
S3-compatible versioned design does not select Amazon as the production company.
No issue, deadline, owner, passed result, or approved numeric capacity is invented
by this register.
