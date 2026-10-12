# Database migrations

Local provisioning creates `loom_migrator` and `loom_app`, with separate ownership
and runtime privileges. Ordered SQL files in `migrations/` are executed by
`npm run db:migrate` through the migrator, on one connection and transaction.
The first migration sets future table/sequence grants only; it does not claim an
implemented product schema.
`0002_publication_foundation.sql` adds the internal text publication envelopes,
immutable revisions, commit-tail clock, events, intents and outcomes. It creates no
participant/credential/admin records. Authentication and public mutation routes
are still unavailable. This migration was verified only on isolated resources;
existing development data is not automatically migrated by application startup.

Use unique four-digit versions and do not edit applied migrations. The runner
checks filename and SHA-256 against `loom_migrations.history`, rejects unknown
applied versions, and serializes concurrent local migration runs. Files must not
contain psql meta-commands or top-level transaction control, including aliases,
savepoints, prepared transactions, and transaction settings.

Validation follows semicolon-delimited SQL statements, ignoring line/nested block
comments, quoted strings and identifiers, and dollar-quoted text. Use quoted bodies
for procedural functions and `DO` blocks: their internal `BEGIN`, `END`, and
semicolons are accepted regardless of line layout. Unquoted psql meta-commands are
rejected anywhere in the source, including after SQL on the same line.
Unterminated quoted text and block comments are rejected before runner SQL can be
appended. Ordinary strings assume PostgreSQL's default
`standard_conforming_strings=on`; use `E'…'` for backslash escapes.
These checks follow [PostgreSQL lexical rules](https://www.postgresql.org/docs/18/sql-syntax-lexical.html)
for migration hygiene, not full SQL parsing or a sandbox for hostile SQL. Review
migration source as trusted executable code; indirect effects of functions or
session changes remain part of that review.

The pinned `psql` stream reader can split newline-concatenated `E'…'` strings
incorrectly when a continued segment contains a backslash-escaped quote (`\'`).
PostgreSQL accepts that form when sent as one command, but the migration runner
uses psql stream input. Keep such escape strings within one quoted literal
(newlines inside it are supported), or use doubled quotes/dollar quoting. The
validator does not repair client parsing limitations.

The application cannot create tables or access migration history. Do not test
application policies using the PostgreSQL initialization superuser. A future
production migration/upgrade procedure must be defined independently of this local
Docker wrapper, including pending jobs and compatible web/job versions.

Run `node --test tests/bootstrap/migrations.test.mjs` for validation regressions.
`npm run test:migrations:postgres` executes real procedural migrations and checks
rollback/history, ordering, checksums, ahead/behind history, one connection and
transaction, and role separation. It requires a local Docker engine and the pinned
PostgreSQL image from `compose.yaml` (downloaded if absent). The suite starts a
UUID-named container with memory-backed database storage, no host ports, and fresh
test credentials, then removes only that container. It does not use `.env.local`,
existing development containers, or development volumes, and fails if Docker or
PostgreSQL is unavailable. The CI integration job runs it separately from the
database/S3 smoke and persistence suites.

`npm run test:publication:postgres` applies current migrations in its own disposable
PostgreSQL database and checks the actual application operation's atomic rows,
idempotency/authority ordering, response-loss recovery and clock failure behavior.
It prints labeled synthetic contention measurements. See
[ADR-006](../docs/adr/006-transactional-publication.md) and
[ADR-015](../docs/adr/015-publication-reconciliation.md) before extending this boundary.
