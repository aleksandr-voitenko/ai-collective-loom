# Database migrations

Local provisioning creates `loom_migrator` and `loom_app`, with separate ownership
and runtime privileges. Ordered SQL files in `migrations/` are executed by
`npm run db:migrate` through the migrator, on one connection and transaction.
The first migration sets future table/sequence grants only; it does not claim an
implemented product schema.

Use unique four-digit versions and do not edit applied migrations. The runner
checks filename and SHA-256 against `loom_migrations.history`, rejects unknown
applied versions, and serializes concurrent local migration runs. Files must not
contain psql commands or manage transactions. These hygiene checks are not a SQL
sandbox; review migration source as trusted executable code.

The application cannot create tables or access migration history. Do not test
application policies using the PostgreSQL initialization superuser. A future
production migration/upgrade procedure must be defined independently of this local
Docker wrapper, including pending jobs and compatible web/job versions.
