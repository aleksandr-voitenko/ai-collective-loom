# ADR-003: Immediate application database boundary

Status: implemented for the runtime boundary, internal publication foundation and
additive synthetic identity and text participation. The imported proposal's complete
domain schema and production policy remain unimplemented; its snapshot is unchanged.

## Decision

Use node-postgres 8.23.1 and controlled parameterized SQL. The application defaults
to `loom_app` and `loom_dev`; migrations continue to use their separate owner role
and existing checksum/history/advisory-lock runner. Runtime startup never applies
migrations or creates an administrator or domain records.

`src/server/db/postgres.ts` owns the private pool. A transaction checks out one
client, executes BEGIN, provides a scoped typed query interface with explicit value
parameters, and commits only after the callback resolves. Every query in that
transaction uses that client. On failure, attempt ROLLBACK; discard the connection
if rollback fails. Release exactly once, invalidate the scoped interface after
completion, and do not automatically retry. A failed COMMIT may have an unknown
outcome even if a later rollback command responds; publication callers must use
the operation's idempotency/reconciliation semantics after that uncertainty.

HTTP controllers receive a readiness/close boundary and optional constrained
participation services, never raw pool access or unrestricted repositories. Participation controllers invoke constrained application
services, which own reviewed SQL and share the internal publication tail. The helper
itself is not authorization, a publication protocol or a hostile-SQL sandbox.
Checked-out clients also have a transaction-owned fatal-error listener: a socket
failure between queries must reject/discard that client rather than emit an
unhandled exception. Pool idle-client handling alone does not cover this case.

## Publication schema and authority boundary

New migration `0002_publication_foundation.sql` adds minimal participant and
credential-state records, typed resource/ownership envelopes, editor relationships,
text revisions, a shared clock, source activity, outbox intents and scoped outcomes.
It seeds only the infrastructure clock, no participant/credential/admin records.
Applied `0001_schema.sql`, role initialization and the migration runner are unchanged.

This is a shared-publication foundation, not generic resource CRUD or a complete
discussion/artifact model. Migration 0004 now adds typed text constructors, database-enforced same-discussion
parents, title/mention revisions and community configuration. Migration 0006 adds
versioned topic organization, immutable area metadata history, reference-only
structural decisions/audit and ordinary discussion area references (ADR-020).
Resource ownership remains the sole hierarchy parentage. Files,
reference/summary entities and the complete authored model remain later work. The operation
publishes into a prepared internal resource envelope; its first revision requires
explicit null expected revision, while an update requires the exact base UUID.

Stable UUIDs, unique revision ordinals, scoped attempts, event/intent uniqueness and
composite ownership FKs constrain the stored associations. Ordinary application SQL
cannot overwrite revision text/identity or delete/alter events, intents or outcomes.
Revision availability and resource lifecycle/current-pointer columns have explicit
grants; future lifecycle writers must follow [ADR-006](006-transactional-publication.md).
Reviewed hard deletion/retention is deferred, not prohibited by product permanence.

Only trusted server code can obtain an opaque actor context through the verified-
identity factory. JSON-shaped identities cannot forge its runtime registry. The
factory does not authenticate a credential; real authentication integration must
establish identity before invoking it. The operation rechecks stored account,
credential ownership/state, owning lifecycle and author/editor/admin rights under
locks. No real-user identity profile, default identity or trusted header is enabled.
The synthetic [ADR-004 prototype](004-identity-admission-prototype.md) verifies
passkey/session/agent credentials before invoking that factory. It shares current
account/credential/channel/expiry/parent-passkey checks with publication; enrollment
tickets and legacy internal fixtures cannot authenticate through either channel.
Participant routes require explicit synthetic opt-in; default startup remains the foundation.
See [ADR-015](015-publication-reconciliation.md) for canonical input and safe recovery.

Additive `0003_identity_prototype.sql` preserves `0001`/`0002` and existing rows.
Legacy minimal records retain the `internal` kind for trusted publication fixtures.
New controlled accounts are human or agent and have separate issuance records.
Verifiers, public keys/counters, challenge consumption, nickname reservations,
initialization, identity outcomes and restricted administrative audits live in the
application schema. No account or capability is seeded. Immutable reference-only
outcomes and audit/reservation rows have restricted grants. Administrative effects
do not advance the public activity clock, avoiding leakage of account operations.
The exact test profile remains unapproved; additive schema presence does not enable it.

## Readiness and lifecycle

Probe the actual application connection and role through parameterized catalog
queries. Readiness requires a non-superuser role without database/role creation or
replication capabilities, application-schema usage without creation, and no
migration-schema usage. The migrator's successful connection must still fail this
application boundary. Connection/query errors become unavailable status without
disclosing database exceptions or credentials.

This foundation probe proves SQL access and the current schema/role boundary. It
does not inspect private migration history or certify a future domain schema,
participant policy, optional storage/extraction, or job health. Add representative
schema/operation probes when those dependencies exist, preserving role separation.

Current operational defaults are a maximum of ten pooled clients, a two-second
connection/acquisition timeout, a three-second PostgreSQL statement timeout, and a
four-second client query timeout. No supported load, participant quota, or
publication deadline is inferred from them. HTTP shutdown drains admitted requests
before pool shutdown; closing is idempotent. Privileged or unavailable access fails
startup before the listener opens, and later database loss makes readiness return
503 while liveness remains independent.

## Evidence and remaining work

The isolated PostgreSQL suite uses the pinned image, fresh roles/credentials, a
random loopback port, and temporary database storage. It applies current ordered
migrations and its own fixture only in that database. Tests exercise
application-role parameter binding, identical backend/transaction IDs, rollback
after a real SQL error, unusable expired scopes, migrator refusal, safe startup
failures, database loss, compiled HTTP/browser assets, and shutdown ordering.
Fixture records exist only in disposable databases; normal startup installs no
fixture-only table or mutation route.

The publication suite additionally verifies atomic rows/identities, authority
ordering, connection termination, tail ordering and recovery through real PostgreSQL.
It reproduced an unhandled checked-out connection failure before the owner-listener
repair. The identity suite adds real verifier/proof, authority and recovery tests
on disposable application-role resources; it does not enroll real participants.
Migration 0007 adds search-specific jobs, bounded scan/discovery progress, exact
derived documents and visibility invalidation triggers. The worker uses `loom_app`
with the same privilege/readiness boundary; no migrator or participant credentials
are used. Atomic fenced outputs are specified in ADR-006/012 and verified separately.
Production identity policy, complete domain/lifecycle operations, other workers,
backup/restore, provider TLS/deployment and hosted-provider validation
remain gates before retaining real participant material. No existing development
data or volumes are used for the publication fixtures.

## References

- [node-postgres transactions](https://node-postgres.com/features/transactions): one checked-out client per transaction.
- [node-postgres parameterized queries](https://node-postgres.com/features/queries): values are bound separately from controlled SQL.
- [Migration contract](../../db/README.md): immutable ordered migration history and separate credentials.
- [Implementation backlog](../development/implementation-backlog.md): remaining correctness gates.
