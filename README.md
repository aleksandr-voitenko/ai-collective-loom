# AI Collective Loom

A persistent collaboration and knowledge environment for human–AI collectives.

**Current state:** development-environment bootstrap. The repository contains the
product baseline, architecture proposal, local database/object-storage setup,
migration and document checks, and a kickoff backlog. It does **not** yet implement
participant sign-in, discussions, a human interface, an agent API, or an agent runtime.

## Design documents

Start with the [documentation index](docs/README.md). The
[product specification v0.9](docs/ai-collective-loom-product-specification.md) is
unchanged. The [architecture package](docs/architecture/ai-collective-loom-architecture-v0.3.md)
is a proposal, not evidence of a completed application. Remaining correctness and
interface decisions are tracked in the [implementation backlog](docs/development/implementation-backlog.md).

## Local development

Use Node.js 24.19.0 from `.nvmrc` and a **local Docker engine with the
Docker Compose plugin (v2 or later)**. The dependency-free bootstrap scripts also support Node 22.16+
so existing repository tooling can be checked; this does not change the proposed
application runtime target. No cloud account or model-provider credential is needed.

```bash
npm ci --ignore-scripts
npm run hooks:install
npm run check
npm run dev:init # only when .env.local is absent
npm run dev:doctor
npm run dev:up
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

`npm run check` runs baseline/JSON checks, bootstrap unit tests, and the existing
Lore hook-installer tests. `npm run test:integration` uses actual local services to
check database roles, migration repeatability/checksums, failed-migration rollback,
versioned object operations, and signed GET success/expiry/tampering. The separate
persistence suite checks committed rows, migration history, versioned bytes and
bucket settings across stop/start and container recreation. Both fail when Docker or services are unavailable;
there is no silent fallback to a storage mock.

These suites do not certify a hosted provider, production security, browser
usability, or product acceptance. Signed upload replay, version-specific grants,
publication concurrency, and coordinated backup/restore require subsequent tests.
Node 24 checks and real-service integration/persistence passed on macOS arm64
using Linux/arm64 containers under Docker Desktop. Bootstrap Lore task
`LC-20261011-R161` records the verification results, initial failures, and fixes.
CI and other container platforms have not been exercised.

The local images are pinned to the observed immutable multi-platform image indexes.
The exact references are in [compose.yaml](compose.yaml); amd64 execution remains
an open gate on the intended CI platform.
The managed production storage provider remains open; it must pass the required
S3/versioning operations. Local SeaweedFS does not select production hosting.

## Development workflow

[Agentic Lore Coding v24](AGENTS.md) is already installed. Preserve its existing
instructions and hooks; do not reinstall a moving upstream version. Implementation
stops for review before staging, committing, or pushing unless those operations
are explicitly authorized. The product does not require participating agents to
use this development method.
