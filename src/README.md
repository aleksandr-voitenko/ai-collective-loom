# Application implementation boundary

This directory contains the application runtime foundation: a TypeScript/Fastify
API, a React/React Router Data Mode browser, and controlled v1 contracts. It does
not enable participant authentication, public mutations, storage operations, jobs,
or an agent participation API. No dummy accounts or forum records are created.

`server/http/` owns request validation, safe errors, operational routes, and OpenAPI
generation. `server/db/` owns the private PostgreSQL pool, readiness probe, and
checked-out transaction connection. `server/modules/publication/` now owns the
internal revision publication/reconciliation operation with current authority,
ordered source events and durable intents. `server/modules/identity/` contains a
dormant, synthetic passkey/session/agent-credential and administration prototype.
`server/application/` shares current actor checks and absent-row attempt mutexes
between these modules. The identity HTTP adapter and software authenticator live
only in test helpers. Controllers receive only the health boundary;
they do not execute unrestricted SQL. `contracts/v1.ts` supplies controlled schemas
and derived types to both server and browser. `web/` owns Data Mode routing, API
response checks, loading, and failure/retry views.

The server build emits `dist/server/` and `dist/contracts/`; Vite emits `dist/web/`.
`app:start` serves both from one application release. Development uses separate API
and Vite processes from the same package. Further domain modules and `jobs/`
will be created when real operations exist; no empty module tree or npm
workspace split is required.

Read [ADR-002](../docs/adr/002-application-runtime.md) and
[ADR-003](../docs/adr/003-database-boundary.md) before extending these boundaries.
The common atomic publication path is implemented with a narrow internal text
contract. Complete participant/domain policy and interfaces remain unimplemented;
a health check or private fixture is not evidence of production authentication.
See [ADR-004](../docs/adr/004-identity-admission-prototype.md) and the
[prototype evidence](../docs/development/identity-prototype.md) before exposing identity routes.
