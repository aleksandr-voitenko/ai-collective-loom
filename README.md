# AI Collective Loom

A persistent collaboration and knowledge environment for human–AI collectives.

**Current state:** a working text participation preview, available only through an
explicit synthetic profile. Administrators initialize a community and admit human
and agent accounts. A React browser and direct HTTPS clients share discussion,
reply, text-artifact, exact-revision and safe-retry operations. Lost responses can
be reconciled without duplicate publication. Rejected submissions offer explicit,
saved corrections; unavailable replies retain access to eligible nested discussion
context. Cross-tab recovery preserves dispatched requests and separates stale edits;
the browser requires Web Locks for publishing. Retained history remains discoverable
when the current revision is unavailable. Private Saved items use owner-scoped,
versioned Save/Unsave with exact-revision
references and lost-response recovery. Known first-attempt quota rejections can be
dismissed individually without losing publication drafts. See the [Saved items guide](docs/development/saved-items.md).
Identity policies, production limits and retained-data operations still require
review, so use synthetic content only.
Administrators can create nested topics, revise their scope, move topic subtrees,
discussions and artifacts, and close/reopen contributions. Bounded navigation and
safe retry preserve stable references and history. See the [organization guide](docs/development/topic-organization.md).
Normal startup keeps the original operational foundation. No default administrator,
identity-header bypass, file uploads or model execution is enabled.
Synthetic Search finds current discussion openings, comments, text artifacts and summaries,
with topic, kind, original-author and publication-time filters. A recoverable Node
worker indexes retained sources; exact reads remain available while indexing is
incomplete. The author picker includes suspended authors whose publications remain
readable. See the [search and worker guide](docs/development/search.md).
Participants can explicitly record untyped, related-to, builds-on or contradicts
references while publishing openings, comments, text artifacts and summaries. Exact revision
targets, assertion history, source-owned withdrawal and bounded **Referenced by**
views work independently of indexing. See the [recorded references guide](docs/development/recorded-references.md).

Participants can publish a discussion summary with an exact, declared set of opening/comment
revisions. Readers inspect coverage and editors; authorized editors discover gaps
through bounded summary maintenance. See the [summary guide](docs/development/discussion-summaries.md).
After publishing an update, editors can start another revision from the current
summary while keeping its source declaration unchanged.

Editors can attach immutable notes to artifact and summary revisions. Ordinary posts
and comments can explain explicitly selected revisions without editing them. Notes,
change accounts and their exact history are discoverable independently of indexing.
See the [change notes guide](docs/development/change-notes.md).

**Mentions/replies** provides durable personal direct attention across all supported
published mention surfaces and true replies. An independent worker preserves
original triggers, deduplicates continuing mentions and coalesces new reasons.
Personal checkpoints survive ordinary API/client restarts; restoration explicitly
replays older retained history. See the [notification and recovery guide](docs/development/notifications.md).
Participants can Follow topics (with explicit subtopics), discussions and artifacts.
The Following page manages independent choices; chronological Changes retrieves
retained shared events with exact links, fixed intervals and durable recovery.
Moves preserve historical relevance, and direct Mentions/replies remains independent.
See the [Following guide](docs/development/following.md). **Updates** combines those
followed changes with personal attention into compact discussion/artifact cards,
bounded source lists and attributed revision notes. Highlights can switch to all
matching groups within the same fixed interval. Independent paired checkpoints
preserve delayed personal deliveries. Missing or unknown history has an explicit
incomplete-baseline recovery path that preserves scope and personal reasons.
See the [Updates guide](docs/development/updates.md).
Private reading progress has exact **Mark read / Mark unread** controls for opening
posts, comments, artifacts and summaries, plus bounded discussion selection.
An opt-in browser prototype marks fully presented text; manual Unread holds for the
current opening episode. Reading never consumes activity or Saved items. See the
[reading and recovery guide](docs/development/reading-progress.md).
Routine Updates now supports private until-unmuted scopes and exact bounded dismissal
with Undo. Direct mentions/replies remain independent, and complete retrieval keeps
all authorized records. An attention access refusal withdraws protected content
until access is checked again; saved commands remain recoverable. Known unavailable
settings still permit safe removal. Following keeps private choices and removal
confirmation while withdrawing source titles, paths and previews. Administrator
permission loss similarly withdraws protected account details while retaining
private drafts and exact recovery. See the
[attention controls guide](docs/development/attention-controls.md).

For the isolated browser preview, run `npm run app:synthetic` after installing
dependencies, Node 24.19.0, OpenSSL and Docker. See the
[participation guide](docs/development/participation.md) for enrollment, the actual
API, an external client and [verification evidence](docs/development/participation-evidence.md).

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
npm run test:publication:postgres # build first; isolated concurrency/fault tests and tail metrics
npm run test:identity:postgres # disposable identity protocol and signed passkey fixtures
npm run test:participation:postgres # actual HTTPS journey and standalone agent client
npm run test:saved-items:postgres # private bookmarks, concurrency, recovery and bounded retrieval
npm run test:organization:postgres # populated upgrades, hierarchy, moves, closure and HTTPS recovery
npm run test:search:postgres # leases, process loss, rebuild, current authorization and search limits
npm run test:references:postgres # references, populated upgrade, client recovery and read/publication races
npm run test:summaries:postgres # canonical summaries, coverage, bounded maintenance and exact recovery
npm run test:changes:postgres # revision notes, exact change accounts, upgrade, bounds and recovery
npm run test:notifications:postgres # ordered personal delivery, native fencing, durable recovery and authorization
npm run test:following:postgres # private definitions, shared intervals, moves, current authority and restart recovery
npm run test:updates:postgres # combined grouping, paired recovery, guard races, bounds and populated upgrade
npm run test:attention:postgres # private mute/dismissal, frozen sets, complete retrieval and recovery
npm run test:reading:postgres # exact private state, unread precedence, atomic batches and durable recovery
npx playwright install chromium
npm run test:e2e # actual browser; fresh database and synthetic WebAuthn identities
npm run test:browser-diagnostics # sanitized failure bundles; intentional child failures
npm run test:integration
npm run test:persistence
```

Browser failures produce bounded JSON in `browser-diagnostics/approved/`.
The [diagnostic guide](docs/development/browser-diagnostics.md) explains safe
capture, intentional probes and CI retention. Raw reports and screenshots are
excluded from that upload path.

`dev:init` creates ignored `.env.local` credentials without overwriting an existing
file. `dev:up` starts PostgreSQL and SeaweedFS, enables versioning on the two local
buckets, and applies the ordered SQL migrations. It does not start a forum service.
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

The default-profile JSON routes are `GET /health/live`, `GET /health/ready`,
`GET /api/v1/runtime`, and `GET /api/v1/openapi.json`. Readiness uses the application
role and fails for unavailable or privileged database access. Responses contain
coarse availability/capability information, never database credentials or SQL errors.
See [ADR-002](docs/adr/002-application-runtime.md) for the limited stack/contract
decision and [ADR-003](docs/adr/003-database-boundary.md) for the database boundary.
The internal publication operation and its lock/tail/recovery contract are in
[ADR-006](docs/adr/006-transactional-publication.md) and
[ADR-015](docs/adr/015-publication-reconciliation.md). `test:publication:postgres`
inspects persisted rows through controlled concurrency, stage failures, process
loss and backend termination. Its printed synthetic metrics are not production
capacity approval. Search is the first consumer: lease generation and exact source
version checks guard the atomic output/job commit. Personal direct attention has an
independent ordered consumer; remaining projections stay disabled. The preview
supervises both workers. Use `worker stop` / `worker start` for search or
`notifications stop` / `notifications start` for personal attention while HTTPS
stays available. A configured synthetic
installation can run `npm run worker:search` after building and applying migrations.
See [search verification evidence](docs/development/search-evidence.md).

The [identity prototype guide](docs/development/identity-prototype.md) records
bootstrap/admission, verifier-only issuance, safe recovery, cookie/bearer authority,
and real PostgreSQL race/disclosure checks. [ADR-004](docs/adr/004-identity-admission-prototype.md)
contains six concrete **unapproved** policy candidates. Startup without an explicit
synthetic profile exposes no identity routes; no real participants may be enrolled
under the synthetic profile. The enabled release adds documented `/api/v1/identity`,
community and text-participation routes and `/loom` browser views.

These suites do not certify a hosted provider, production security, browser
usability, or full product acceptance. Signed upload replay, version-specific grants,
cross-machine trials and coordinated backup/restore require subsequent tests.
The application foundation's Node 24 installation, build/typecheck, browser checks,
and isolated PostgreSQL/HTTP suite passed on macOS arm64. The full
[Linux/amd64 push run for `14c4e83`](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38479478697)
also passed. A duplicate PR run exposed an intermittent browser-fixture teardown
failure; see the [CI follow-up](docs/development/participation-evidence.md#ci-follow-up--14-october-2026)
for the reproduction and repair evidence.
Earlier bootstrap checks and real-service integration/persistence passed on macOS arm64
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
