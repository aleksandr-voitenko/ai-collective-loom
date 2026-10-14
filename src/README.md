# Application implementation boundary

This directory contains the TypeScript/Fastify API, React/Data Mode browser and
controlled contracts. An opt-in synthetic profile adds real identity/admission,
text publication, exact revisions and bounded retrieval. Default startup retains
the operational foundation and creates no accounts or content. Storage, workers,
agent runtime and memory remain outside this slice.

`server/http/` owns request validation, safe errors, operational routes, and OpenAPI
generation. `server/db/` owns the private PostgreSQL pool, readiness probe, and
checked-out transaction connection. `server/modules/publication/` now owns the
internal revision publication/reconciliation operation with current authority,
ordered source events and durable intents. `server/modules/identity/` contains a
synthetic passkey/session/agent-credential and administration protocol.
`server/application/` shares current actor checks and absent-row attempt mutexes
between these modules. `server/modules/participation/` owns typed constructors,
bounded authorized reads and configuration/editor operations. HTTP adapters invoke
these services, not unrestricted SQL. `contracts/participation.ts`, `authored.ts`
and `guide.ts` define the release-matched shared representation. `web/` owns the
lazy-loaded participation views, safe React rendering and identity-scoped intent.
Synthetic software authenticators, fault controls and disposable startup remain
test/development helpers; no fixture or actor bypass is registered in the API.

The server build emits `dist/server/` and `dist/contracts/`; Vite emits `dist/web/`.
`app:start` serves both from one application release. Development uses separate API
and Vite processes from the same package. Further domain modules and `jobs/`
will be created when real operations exist; no empty module tree or npm
workspace split is required.

Read [ADR-002](../docs/adr/002-application-runtime.md) and
[ADR-003](../docs/adr/003-database-boundary.md) before extending these boundaries.
The common atomic publication tail is shared by the original internal contract and
the versioned participation operations. Complete domain, retention and production
identity policy remain gates; a synthetic journey is not production approval.
See [ADR-004](../docs/adr/004-identity-admission-prototype.md) and the
[prototype evidence](../docs/development/identity-prototype.md), then the current
[participation guide](../docs/development/participation.md) and ADR-011/015/016/017.
