# Repository memory

Product baseline: `docs/ai-collective-loom-product-specification.md` v0.9 remains
unchanged. Architecture v0.3 and companions are in `docs/architecture/`; use
`docs/README.md` for source priority and the implementation backlog for open gates.
The architecture is a proposal; its acceptance mappings are not executed results.

Current implementation is an application runtime/contract foundation: one
TypeScript/Fastify package with React 19/Data Mode/Vite, controlled v1 schemas,
OpenAPI 3.0.3, and an operational status browser, plus an internal atomic text
publication/reconciliation module. Participant authentication, public mutations,
complete domain schema/policy, storage operations, workers, and an agent participation
API remain unimplemented. There is no default administrator or identity-header
bypass. See `src/README.md`, ADR-002, ADR-003, and the implementation backlog.
Runtime foundation decisions and verification: Lore-ID `LC-20261012-LMP4`.
Application commands require Node 24.19.0. `dev` still initializes dependencies;
`app:dev`, `app:build`, `app:start`, and `app:typecheck` serve/check the release.

`scripts/local.mjs` manages an explicitly local Compose project. PostgreSQL 18.4
and SeaweedFS 4.48 use immutable image-index pins; hosted storage remains undecided.
Earlier dependency-free bootstrap checks passed on Node 24.19.0. Bootstrap real
integration and persistence checks passed on macOS arm64 using Linux/arm64
containers under Docker Desktop. The same bootstrap checks and real suites passed
on Ubuntu 24.04 (Linux/amd64) for `4865058` in
[CI run 38176825771](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38176825771).
Other runtime platforms, managed-provider operations, and product validation remain
open. See bootstrap Lore task `LC-20261011-R161` for the original adoption scope.
Do not weaken product revision, privacy, retry, or recovery requirements because
bootstrap tests pass.

`.env.local` and `.local/` are ignored generated state. Initialization never replaces
passwords silently; persistent volumes retain their own credentials. Runtime and
migration database roles are separate. New `0002_publication_foundation.sql` creates
minimal authority/resource envelopes, immutable text revisions, clock/events,
outbox intents and reference-only outcomes; it seeds no participants/credentials.
This is not the complete product schema. Applied migrations remain immutable.
Migration checksums and application history are
different concepts. Ordinary stop retains volumes; reset requires explicit consent.
Migration hygiene checks SQL statement heads outside comments/quoted text, allowing
quoted procedural bodies while rejecting psql and top-level transaction control.
It assumes default PostgreSQL string settings and trusted reviewed files, not a
hostile-SQL sandbox; see `db/README.md`. `test:migrations:postgres` uses a disposable
local PostgreSQL container with memory-backed storage and fresh credentials to
check procedural execution, rollback/history, and runner/role invariants in CI.

The actual package manifest/lockfile now pin application and test dependencies.
`npm run check` retains docs, bootstrap units and hook tests, and adds application
typechecking, HTTP/router tests, and build. `test:app:postgres` uses temporary
PostgreSQL storage and compiled HTTP processes to verify app-role readiness,
parameter binding, rollback, safe failures, database loss, graceful shutdown, and
Vite browser-module/API proxy separation. Application verification is local
Node 24/macOS arm64 with Linux/arm64 PostgreSQL; its updated CI remains unperformed.
The database pool is private; transaction callbacks own one checked-out client,
explicit values, and no automatic retries. Controllers use only the health boundary.
Requests reject unknown fields/coercion/default insertion; schemas are controlled
code. Errors/owned diagnostics omit credentials, SQL, payloads, and exception details.
The public health routes report coarse availability only. Future domain readiness
and participant authorization require their own operation/schema checks.
`server/modules/publication/` is internal and absent from production HTTP routes.
Its opaque actor factory is a trusted verified-identity boundary, not authentication.
It rechecks actor/credential, containment, author/editor/admin rights and base
revision under the ADR-006 guards. Exact retained attempts resolve before stale
new-write checks; read-only reconciliation can disclose only eligible references.
ADR-015 defines the narrow canonical text input and retention/erasure limits.
The transactional clock is acquired last and held through events/intents/outcome
and COMMIT; no sequences or new domain guards define its committed upper bound.
`test:publication:postgres` uses tmpfs PostgreSQL and private process fixtures for
atomicity, concurrency, authority, lost acknowledgements and killed connections;
synthetic tail metrics do not approve production capacity. Checked-out connection
errors between queries are transaction-owned and discard the failed client.
Outbox intents are durable but no worker effects run. Generation-fenced output
publication remains mandatory before the first consumer is enabled.
Publication protocol and recovery decisions: Lore-ID `LC-20261012-6OTQ`.
Integration uses real local dependencies; it is separate and never reported passed
when unavailable.
`test:integration` includes failed-migration rollback and signed GET probes;
expiry checks record UTC timing and use a bounded retry window only for a
still-successful GET. They do not retry unrelated failures or log bearer URLs.
`test:persistence` separately interrupts local services to check committed rows,
history, bucket settings, and exact object versions through stop/start/recreation.
Its restart uses `up --no-recreate --wait`; Linux CI rejected `start --wait`
(Lore-ID: LC-20261012-AYAB).
Unchanged container IDs prove that this phase reuses the stopped containers.
Persistence checks do not rerun storage setup between phases or remove volumes;
they clean up only their own scratch data. CLI transfer files are uniquely named
and immutable to avoid an observed Docker Desktop host-file fixture limitation.
Controls using reused container-local files returned exact object versions; the
underlying filesystem/transfer cause remains unidentified (Lore-ID: LC-20261011-R161).
PostgreSQL's wrapper copies the unchanged initialization hook into the container
at mode 0644 before its official entrypoint; it does not reset or reinitialize
existing volumes.

Lore Coding v24 is installed (`AGENTS.md`; Lore-ID: LC-20260927-E365).
Product import Lore-ID: LC-20260929-5WKG. The reserved product DEC-002 does not
replace installed repository instructions. Editor-list management in the current
product is administrator-only; do not revive earlier delegated-manager proposals.
