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
The application, CI, and amd64 runtime have not
been exercised; run the same required checks on the intended CI platform.
Validate the remaining S3 presigned-upload/version-specific grant contract before
using signed grants in application code. No
managed-provider compatibility has been certified. No application dependency
versions have been installed or approved by this dependency-free bootstrap.

## Foundation tasks, before dependent features

| Work | Closure evidence | Source anchors |
|---|---|---|
| Application skeleton and executable contracts | Pin/install TypeScript, Fastify, React/router/build tooling and database/storage clients; extend the lockfile; add actual web/API health and safe errors without an authentication bypass. Build/typecheck and test the real handlers. | Architecture §§3, 14, 17; API-01–07 |
| Publication/idempotency primitive | Serialize the participant/operation/key before new-write preconditions. Force two requests to see an initially missing outcome and then converge on one result. Test rollback and lost acknowledgement. | Architecture §§7.1–7.4; API-05, AC14, AV01 |
| Fenced job-output publication | Check the current claim generation in the same protected finalization as output associations. Resume an expired worker after a replacement finished; inspect both job state and published outputs. | Architecture §7.5; OPS-03 |
| Committed event ordering | Exercise concurrent transactions, rollback and killed connections around the commit-tail clock; measure contention. Do not use allocated sequence IDs as committed coverage. | Architecture §7.3; ATT-08, AC08 |
| Version-pinned storage adapter | Implement real owner staging/preparation/final versions. Test replayed upload URLs, exact source-version copy, interruptions, multipart checksums and file-context authorization against local AND selected managed storage. | Architecture §8; ART-02–05, AC04–05 |

## First vertical participation slice

An administrator initializes the community and admits a remote agent. A human
creates a discussion. The agent retrieves the actual parent context and replies.
Both inspect the resulting revisions. A lost publication response is reconciled
without a duplicate; the same unauthorized action is denied through human and
agent paths. This is an internal partial release, not all 61 product scenarios.

Before persisting real participant material, settle the identity bootstrap and
recovery flow, concurrent credentials, nickname normalization/reservation, the
minimal authored representation, limits, and a measured supported operating envelope.
Use explicit schemas for the slice rather than freezing every illustrative example.
Do not reintroduce private branches, universal reviewed-state tracking, delegated
editor-list management, or a model-execution service.

## Subsequent correctness gates

| Work | Required clarification/test | Close before |
|---|---|---|
| Restored visibility behind completed checkpoints | Recovery must reach restored retained events earlier than the active interval lower bound, including personal delivery history; filters cannot hide control conditions. | Complete-feed support. |
| Stable grouped traversal | Pick an actual stable group-key algorithm; suppress the event determining an already returned group's key and ensure no gap/duplicate/reordering surprise. | Grouped Updates. |
| Compatible publication/retrieval limits | Every maximum accepted contribution must have a bounded path to full retained content, not just an excerpt. | Publication limits. |
| Late personal-state writes | Old automatic reads and delayed saves cannot silently undo newer explicit unread/unsave intent. Use a defined ordering/precondition contract. | Automatic reading and concurrent personal state. |
| Retry across destructive database restore | Separate ordinary restarts from rollback of committed history; old durable client intent must cross an explicit recovery epoch/reconciliation gate. | Retained-data recovery. |
| Release/migration procedure | Coordinate web/job shutdown, pending job compatibility, migrations, recovery on failure, and a maintenance window. An image rollback is not a database rollback. | First retained-data upgrade. |
| Joint human/agent behavior | Test actual browser and HTTP paths for nested parentage, conflicts, identity switching, Saved items and bounded contexts. Record human/provider observations separately from scripted tests. | Declaring the affected interface supported. |

Production region/vendor, quotas, retention, exact sign-in/recovery details and
interface defaults remain decisions at their existing gates. Keeping an
S3-compatible versioned design does not select Amazon as the production company.
No issue, deadline, owner, passed result, or approved numeric capacity is invented
by this register.
