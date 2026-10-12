# ADR-003: Immediate application database boundary

Status: implemented for the runtime boundary and internal publication foundation.
The imported proposal's complete domain schema, authentication and participant
interfaces remain unimplemented. Its snapshot is unchanged.

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

HTTP controllers receive only a readiness/close boundary, not raw pool access or
unrestricted repositories. The internal publication module now owns its reviewed
SQL and constrained operation; it is not registered with a controller. The helper
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
discussion/artifact model. Typed domain constructors, parent relationships, metadata,
files/entities and full authored-document contracts remain later work. The operation
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
locks. No public route, default identity, token issuance or trusted header is added.
See [ADR-015](015-publication-reconciliation.md) for canonical input and safe recovery.

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
No fixture table or mutation route is installed in the development/production
application schema or route inventory.

The publication suite additionally verifies atomic rows/identities, authority
ordering, connection termination, tail ordering and recovery through real PostgreSQL.
It reproduced an unhandled checked-out connection failure before the owner-listener
repair. Domain constructors/authentication, full lifecycle policy, workers/fenced
outputs, backup/restore, provider TLS/deployment and hosted-provider validation
remain gates before retaining real participant material. No existing development
data or volumes are used for the publication fixtures.

## References

- [node-postgres transactions](https://node-postgres.com/features/transactions): one checked-out client per transaction.
- [node-postgres parameterized queries](https://node-postgres.com/features/queries): values are bound separately from controlled SQL.
- [Migration contract](../../db/README.md): immutable ordered migration history and separate credentials.
- [Implementation backlog](../development/implementation-backlog.md): remaining correctness gates.
