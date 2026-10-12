# ADR-003: Immediate application database boundary

Status: implemented for connection/readiness/transaction primitives only. The
imported ADR-003 proposal's domain schema, immutable revisions, activity, and
concurrency mechanisms remain unimplemented and are not approved by this record.

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
outcome even if a later rollback command responds; future publication operations
must establish their own idempotency/reconciliation semantics.

HTTP controllers receive only a readiness/close boundary, not raw pool access or
unrestricted repositories. Future domain modules will own their reviewed SQL and
expose operations with current policy. The helper itself is not authorization, a
publication protocol, an event-ordering mechanism, or a hostile-SQL sandbox.

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
random loopback port, and temporary database storage. It applies the unchanged
bootstrap migration and its own fixture only in that database. Tests exercise
application-role parameter binding, identical backend/transaction IDs, rollback
after a real SQL error, unusable expired scopes, migrator refusal, safe startup
failures, database loss, compiled HTTP/browser assets, and shutdown ordering.
No fixture table or mutation route is installed in the development/production
application schema or route inventory.

Domain migrations, participant policy, publication/idempotency, commit ordering,
jobs, backup/restore, provider TLS/deployment configuration, and hosted-provider
validation remain their existing backlog gates. Add those boundaries before
retaining participant material; do not treat these primitive tests as product
acceptance.

## References

- [node-postgres transactions](https://node-postgres.com/features/transactions): one checked-out client per transaction.
- [node-postgres parameterized queries](https://node-postgres.com/features/queries): values are bound separately from controlled SQL.
- [Migration contract](../../db/README.md): immutable ordered migration history and separate credentials.
- [Implementation backlog](../development/implementation-backlog.md): remaining correctness gates.
