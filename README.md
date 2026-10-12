# AI Collective Loom

A persistent collaboration and knowledge environment for human–AI collectives.

**Current state:** application runtime and executable contract foundation. A real
TypeScript/Fastify API and React/React Router Data Mode browser build and run as one
release. The browser shows service status, loading, and failure/retry states.
Participant admission/sign-in, discussions, publishing, an agent participation API,
storage operations, and jobs remain unimplemented. No default administrator or
development authentication bypass is provided.

## Design documents

Start with the [documentation index](docs/README.md). The
[product specification v0.9](docs/ai-collective-loom-product-specification.md) is
unchanged. The [architecture package](docs/architecture/ai-collective-loom-architecture-v0.3.md)
is a proposal, not evidence of a completed application. Remaining correctness and
interface decisions are tracked in the [implementation backlog](docs/development/implementation-backlog.md).

## Local development

Use Node.js 24.19.0 from `.nvmrc` and a **local Docker engine with the
Docker Compose plugin (v2 or later)**. Application commands check the pinned Node
version. Concrete dependencies and their resolved graph are in `package.json` and
the actual lockfile. No cloud account or model-provider credential is needed.

```bash
nvm install
nvm use
npm ci --ignore-scripts
npm run hooks:install
npm run check
npm run dev:init # only when .env.local is absent
npm run dev:doctor
npm run dev
npm run app:dev
```

`dev` (also `dev:up`) initializes dependencies, buckets, and migrations. It does
not start the application. `app:dev` starts the API watcher on
`http://127.0.0.1:3000` and Vite on `http://127.0.0.1:5173`, with an API proxy.
`app:dev:api` and `app:dev:web` run either development process separately.

For the compiled application and real-service checks:

```bash
npm run app:typecheck
npm run app:build
npm run app:start # serves the API and compiled browser at http://127.0.0.1:3000
npm run test:app:postgres # build first; isolated PostgreSQL and HTTP tests
npm run test:integration
npm run test:persistence
```

`dev:init` creates ignored `.env.local` credentials without overwriting an existing
file. `dev:up` starts PostgreSQL and SeaweedFS, enables versioning on the two local
buckets, and applies the bootstrap migration. It does not start a forum service.
Initial image downloads require internet access.

PostgreSQL is exposed at `127.0.0.1:54320`; the local S3 endpoint is
`http://127.0.0.1:8333`. Change unused local ports in `.env.local` before startup.
Passwords are in that private file, not in this README. The application database
role is `loom_app`; migrations use `loom_migrator`. The database is `loom_dev`.

`test:persistence` deliberately stops/starts and recreates this local project's
two service containers while retaining their named volumes. Run it when a brief
local service interruption is acceptable; it leaves services running and removes
only its own scratch table and exact object versions.

```bash
npm run dev:status
npm run db:migrate
npm run dev:down
```

Stopping services preserves named data volumes. Deleting `.env.local` does not
reset passwords stored in an existing volume. Read the
[development guide](docs/development/README.md) before a destructive reset,
changing credentials, or running storage tests.

## Checks and scope

`npm run check` retains baseline/JSON, bootstrap, and Lore hook checks, and adds
application typechecking, HTTP contract/router tests, and the production build.
`npm run test:app:postgres` uses disposable PostgreSQL resources to check actual
application-role readiness, parameterized transactions, rollback, startup failures,
database loss, graceful shutdown, and Vite module/API proxy separation.
`npm run test:integration` uses actual local services to
check database roles, migration repeatability/checksums, failed-migration rollback,
versioned object operations, and signed GET success/expiry/tampering. The separate
persistence suite checks committed rows, migration history, versioned bytes and
bucket settings across stop/start and container recreation. Both fail when Docker or services are unavailable;
there is no silent fallback to a storage mock.

`npm run test:migrations:postgres` checks migration validation and execution against
an isolated PostgreSQL container with temporary storage. It leaves development
services and data intact; see the [migration guide](db/README.md).

The implemented JSON routes are `GET /health/live`, `GET /health/ready`,
`GET /api/v1/runtime`, and `GET /api/v1/openapi.json`. Readiness uses the application
role and fails for unavailable or privileged database access. Responses contain
coarse availability/capability information, never database credentials or SQL errors.
See [ADR-002](docs/adr/002-application-runtime.md) for the limited stack/contract
decision and [ADR-003](docs/adr/003-database-boundary.md) for the database boundary.

These suites do not certify a hosted provider, production security, browser
usability, or product acceptance. Signed upload replay, version-specific grants,
publication concurrency, and coordinated backup/restore require subsequent tests.
The application foundation's Node 24 installation, build/typecheck, browser checks,
and isolated PostgreSQL/HTTP suite passed on macOS arm64. Its updated CI has not
executed yet. Earlier bootstrap checks and real-service integration/persistence passed on macOS arm64
using Linux/arm64 containers under Docker Desktop. Bootstrap Lore task
`LC-20261011-R161` records the verification results, initial failures, and fixes.
[Linux/amd64 CI run 38176825771](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38176825771)
passed for `4865058` on Ubuntu 24.04 with Node 24.19.0: all 40 checks, real
PostgreSQL/S3 integration, and persistence through stop/start and container recreation.

The local images are pinned to the observed immutable multi-platform image indexes.
The exact references are in [compose.yaml](compose.yaml). All three images have
executed as Linux/arm64 locally and Linux/amd64 in CI; other platforms remain unvalidated.
The managed production storage provider remains open; it must pass the required
S3/versioning operations. Local SeaweedFS does not select production hosting.

## Development workflow

[Agentic Lore Coding v24](AGENTS.md) is already installed. Preserve its existing
instructions and hooks; do not reinstall a moving upstream version. Implementation
stops for review before staging, committing, or pushing unless those operations
are explicitly authorized. The product does not require participating agents to
use this development method.
