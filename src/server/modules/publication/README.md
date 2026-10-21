# Internal shared publication boundary

`PublicationOperation.publish(actor, input)` owns the common transaction for an
existing prepared resource. It returns committed operation/resource/revision IDs
after the transaction owner confirms COMMIT. It writes exactly one revision, current
pointer, source event, `publication.project` outbox intent and scoped outcome.

Accepted input is closed: `resource_id`, UUID `idempotency_key`, required
`expected_revision_id` (UUID, or explicit null for the first revision), and
`content: { format: "text/plain", text }`. Body text is preserved exactly. This
original internal schema rejects privacy/file/mention/reference fields. Richer
participant feature contracts use separate typed constructors; they do not extend
this internal schema or change its digest.

`actorFromVerifiedIdentity` is a trusted authentication-integration boundary and
does not authenticate IDs itself. Only verified internal callers/private fixtures
may invoke it. Contexts are opaque and runtime-registered; input JSON and headers
are never converted to actors. The operation always reads current stored authority.
The synthetic identity protocol verifies passkeys/sessions or agent credentials
before constructing that same actor. Shared checks now include channel kind,
expiry and parent-passkey state; enrollment tickets grant no publication authority.
Participation HTTP uses typed constructors sharing `guards.ts` and `commitRevision`;
it imports no fixture. The original `text/plain` contract/digest stays internal.
Read operations use the same guards and safe error conversion without loading
publication orchestration. Fixed reference, coverage, change and file inserts live
in this module, while participation owns validation and preparation.

`reconcile(actor, key)` is read-only and owner-bound. It can recover an eligible
historical result after loss of editing rights, without mutation or new side effects.
`not_recorded` is unresolved absence, not proof of failure. Replays/status do not
cache authored bodies, disclose unavailable revisions or advance the event clock.

Use [ADR-003](../../../../docs/adr/003-database-boundary.md),
[ADR-006](../../../../docs/adr/006-transactional-publication.md) and
[ADR-015](../../../../docs/adr/015-publication-reconciliation.md) before extending
the schema, semantic digest, lock classes or lifecycle writers. Source/entity
preparation precedes the clock lock; native file IO stays outside SQL transactions.
Prepared manifest inserts remain inside the guarded atomic revision transaction,
before its clock/event/outcome tail.

After `npm run app:build`, `npm run test:publication:postgres` uses real PostgreSQL with tmpfs storage and
fresh private identities. It tests absence races, stale conflicts, all write-stage
rollbacks, lost processes, current authority, killed connections and committed
coverage. It prints labeled synthetic wait/hold metrics rather than asserting an
approved production capacity. Synthetic participant routes and constructors are
implemented separately. Search and personal notifications have independent discovery,
jobs and fenced finalization without consuming immutable intents globally; see
[ADR-012](../../../../docs/adr/012-scoped-text-search.md) and
[ADR-023](../../../../docs/adr/023-personal-direct-attention.md).
Following/shared Changes traverse authoritative events directly, while Combined
Updates composes shared and personal intervals under separate custody, including a
distinct routine-attention projection. Bounded traversal and recovery are implemented;
see [ADR-024](../../../../docs/adr/024-following-shared-changes.md) and
[ADR-025](../../../../docs/adr/025-combined-updates.md). Production identity and hosting,
general retention, erasure and restore policies, and further projections remain gates.
