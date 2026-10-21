# Application implementation boundary

This directory contains the TypeScript/Fastify API, React/Data Mode browser and
controlled contracts. An opt-in synthetic profile adds real identity/admission,
text and file-bearing artifact publication, exact revisions and bounded retrieval.
Default startup retains the operational foundation and creates no accounts or content.
Model execution, agent runtime and agent memory remain outside this slice.

`server/http/` owns request validation, safe errors, operational routes, and OpenAPI
generation. `server/db/` owns the private PostgreSQL pool, readiness probe, and
checked-out transaction connection. `server/modules/publication/` now owns the
internal revision publication/reconciliation operation with current authority,
ordered source events and durable intents. `server/modules/identity/` contains a
synthetic passkey/session/agent-credential and administration protocol.
`server/application/` shares current actor checks and absent-row attempt mutexes
between these modules. `server/modules/participation/` owns typed constructors,
bounded authorized reads, configuration/editor operations, private Saved items and
administrator topic organization. `organization.ts` owns versioned structural
commands, metadata history and reference-only retry; `organization-context.ts`
shares the hierarchy guard/epoch with publication and retrieval. HTTP adapters invoke
these services, not unrestricted SQL. `contracts/participation.ts`, `authored.ts`
and `guide.ts` define the release-matched shared representation. `web/` owns the
lazy-loaded participation views, safe React rendering and identity-scoped intent.
`server/modules/search/` owns current lexical search, bounded derived jobs and
atomic lease/source fencing. `server/search-worker.ts` is the same-release native
worker entry; `contracts/search.ts`, `http/search.ts` and `web/Search.tsx` share
the synthetic search contract. See [ADR-012](../docs/adr/012-scoped-text-search.md).

Artifact file support in `server/modules/participation/` separates private upload
custody and native S3 transfers from atomic revision manifests. Storage is optional
in the service configuration; the isolated synthetic preview supplies private,
versioned SeaweedFS buckets. Exact downloads reauthorize context and use the recorded
native version. See [ADR-029](../docs/adr/029-versioned-artifact-files.md).

`server/modules/notifications/` owns the independent personal mentions/replies worker
and traversal; `following/` owns private subscriptions and direct shared-event reads.
`updates/` combines shared and personal intervals under separate bounded custody,
with a distinct routine-attention projection. These feeds retain independent recovery.
See [ADR-023](../docs/adr/023-personal-direct-attention.md),
[ADR-024](../docs/adr/024-following-shared-changes.md) and
[ADR-025](../docs/adr/025-combined-updates.md).

Synthetic software authenticators, fault controls and disposable startup remain
test/development helpers; no fixture or actor bypass is registered in the API.

The server build emits `dist/server/` and `dist/contracts/`; Vite emits `dist/web/`.
`app:start` serves both from one application release. Development uses separate API
and Vite processes from the same package. Search work stays inside its owning module;
further domain modules will be created when real operations exist. No empty tree or npm
workspace split is required.

Read [ADR-002](../docs/adr/002-application-runtime.md) and
[ADR-003](../docs/adr/003-database-boundary.md) before extending these boundaries.
The common atomic publication tail is shared by the original internal contract and
the versioned participation operations. Remaining domain work, production identity
and hosting, and general retention, erasure and restore policies remain gates;
a synthetic journey is not production approval.
See [ADR-004](../docs/adr/004-identity-admission-prototype.md), the release
[API guide](contracts/guide.ts), and ADR-011/015/016/017/020.
