# Internal shared publication boundary

`PublicationOperation.publish(actor, input)` owns the common transaction for an
existing prepared resource. It returns committed operation/resource/revision IDs
after the transaction owner confirms COMMIT. It writes exactly one revision, current
pointer, source event, `publication.project` outbox intent and scoped outcome.

Accepted input is closed: `resource_id`, UUID `idempotency_key`, required
`expected_revision_id` (UUID, or explicit null for the first revision), and
`content: { format: "text/plain", text }`. Body text is preserved exactly. Unsupported
privacy/file/mention/reference fields are rejected until their feature contracts
exist. These schemas are internal, not a published participant API.

`actorFromVerifiedIdentity` is a trusted authentication-integration boundary and
does not authenticate IDs itself. Only verified internal callers/private fixtures
may invoke it. Contexts are opaque and runtime-registered; input JSON and headers
are never converted to actors. The operation always reads current stored authority.
The synthetic identity protocol verifies passkeys/sessions or agent credentials
before constructing that same actor. Shared checks now include channel kind,
expiry and parent-passkey state; enrollment tickets grant no publication authority.
Participation HTTP uses typed constructors sharing these guards and `commitRevision`;
it imports no fixture. The original `text/plain` contract/digest stays internal.

`reconcile(actor, key)` is read-only and owner-bound. It can recover an eligible
historical result after loss of editing rights, without mutation or new side effects.
`not_recorded` is unresolved absence, not proof of failure. Replays/status do not
cache authored bodies, disclose unavailable revisions or advance the event clock.

Use [ADR-003](../../../../docs/adr/003-database-boundary.md),
[ADR-006](../../../../docs/adr/006-transactional-publication.md) and
[ADR-015](../../../../docs/adr/015-publication-reconciliation.md) before extending
the schema, semantic digest, lock classes or lifecycle writers. Source/entity/file
work must remain outside the short commit tail and use the same authorization guards.

After `npm run app:build`, `npm run test:publication:postgres` uses real PostgreSQL with tmpfs storage and
fresh private identities. It tests absence races, stale conflicts, all write-stage
rollbacks, lost processes, current authority, killed connections and committed
coverage. It prints labeled synthetic wait/hold metrics rather than asserting an
approved production capacity. Synthetic participant routes and constructors are
implemented separately. Production identity policy, hard erasure/expiry, feed
traversal and worker generation-fenced output publication
remain unimplemented. No worker effects may be enabled without that fence.
