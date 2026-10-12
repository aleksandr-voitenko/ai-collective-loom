# Local development

## Scope and prerequisites

The bootstrap prepares a local database and S3-compatible storage. The separate
application foundation now builds a TypeScript/Fastify API and a React/Data Mode
browser. Participant sign-in, policy/mutations, storage operations, durable jobs,
an agent participation API, and the full content schema remain in the
[backlog](implementation-backlog.md). No production provider or passkey recovery
policy is selected here.

Use a local Docker engine, the Docker Compose plugin (v2 or later), and Node.js
24.19.0 from `.nvmrc`. The dependency-free checks passed under Node 24.19.0 and
22.22.2 in the adoption environment. Real integration and persistence passed with
Docker Desktop engine 29.8.2, Compose 5.5.1, and linux/arm64 images on macOS arm64.
[CI run 38176825771](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38176825771)
for `4865058` also passed on Ubuntu 24.04 (Linux/amd64) with Node 24.19.0: all 40
checks and the real integration and persistence suites. Other runtime platforms,
managed providers, and product behavior remain unvalidated. Those results describe
the earlier bootstrap. The application foundation has local Node 24/macOS arm64
installation, build/typecheck, browser, and isolated PostgreSQL/HTTP evidence; its
new CI checks have not executed yet.
`npm ci --ignore-scripts` now installs exact application/build/test dependencies
from the actual lockfile. Application commands require the pinned Node version;
use `nvm install` and `nvm use` first. Current application decisions are scoped in
[ADR-002](../adr/002-application-runtime.md) and [ADR-003](../adr/003-database-boundary.md).

The Compose profile pins these tags to immutable image-index digests:

| Service | Image | Status |
|---|---|---|
| PostgreSQL | `postgres:18.4-bookworm` | Official image; major matches the architecture. Real roles, migrations and persistence passed on Linux/arm64 and Linux/amd64. |
| S3-compatible storage | `chrislusf/seaweedfs:4.48` | Single-node `mini` mode, versioning initialized through the S3 API. Local choice only. |
| Local S3 setup/check client | `public.ecr.aws/aws-cli/aws-cli:2.31.0` | One-shot CLI containers, not an AWS account or application dependency. |

All three images were pulled and executed as Linux/arm64 locally and Linux/amd64
in the linked CI run. Exact image-index pins are in [compose.yaml](../../compose.yaml).
Index pins allow native platform selection without following a moving tag.
Repeat the checks when changing image pins or runtimes and on additional platforms.

## Commands

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

`dev:init` creates `.env.local` with randomly generated independent credentials and
mode 0600 on POSIX systems, plus the ignored `.local/` working directory. It refuses
to overwrite either an existing credential file or a symlink at that path. The
file uses a restricted `KEY=value` syntax, not shell code. Do not source it, add
production secrets, or commit it. `.env.example` documents fields but its placeholder
values are deliberately invalid credentials.

`dev:doctor` checks the local Docker endpoint, engine, Compose availability and
configuration parsing without printing the substituted configuration. It is not
a service, storage, or production-readiness check. Remote Docker contexts are
refused by this local workflow. Docker engine access itself is trusted host power.

`dev:up` starts the services, performs authenticated S3 readiness checks, creates
missing local staging/final buckets, enables versioning on both, and runs the SQL
migrations through the migrator role. A failed setup exits nonzero; it does not
fall back to anonymous access. PostgreSQL role initialization only runs for a fresh
volume. A small wrapper copies the unchanged role hook from its read-only bind
mount into the container at mode 0644, then invokes the official entrypoint. This
avoids a demonstrated host-mount executable-mode mismatch without changing host
metadata or fresh-volume semantics. Correct partial initialization only after
inspecting existing roles/schema and data; startup does not automatically repair,
rotate credentials, or reset an existing volume.

`npm run dev` is an alias for this dependency-initialization flow, not the browser
development server. Keep application startup separate:

```bash
npm run app:dev       # API watcher :3000 and Vite :5173 with a proxy
npm run app:dev:api   # API watcher only
npm run app:dev:web   # Vite only; API must run separately
npm run app:typecheck
npm run app:build
npm run app:start     # compiled API and browser together on :3000
```

The full build cleans only generated `dist/` output. Application startup does not
start dependencies, apply migrations, rotate credentials, or initialize users.
Web mode requires built browser assets and application-role readiness before
listening. API-only development does not require a browser build.

Application commands read generated `.env.local` for the application password and
PostgreSQL port. Keep that file in the bootstrap's restricted format. Supply the
following application-only settings through the shell/deployment environment,
not as extra entries in `.env.local`. Shell values take precedence.

| Setting | Default/meaning |
|---|---|
| `LOOM_API_HOST` | `127.0.0.1`; also accepts `0.0.0.0` or `::1` when explicitly configured. |
| `LOOM_API_PORT` | `3000`; `0` selects an ephemeral API port for direct runtime tests. Vite's development proxy needs a known positive port. |
| `LOOM_DATABASE_HOST` | `127.0.0.1` |
| `LOOM_POSTGRES_PORT` | Generated bootstrap port, or `54320` |
| `LOOM_DATABASE_NAME` | `loom_dev` |
| `LOOM_DATABASE_USER` | `loom_app`; the actual connection must pass the application privilege boundary. |
| `LOOM_PG_APP_PASSWORD` | Required; generated in `.env.local` or supplied by the deployment environment. |

Vite does not load `.env.local` or export server credentials. Its same-origin proxy
targets the API's IPv4/IPv6 loopback bind under `/api/` and `/health/`; other browser modules remain
Vite requests. Hosted database TLS, reverse-proxy/deployment configuration,
participant authentication, and production operation remain later gates.

```bash
npm run db:migrate
npm run dev:status
npm run dev:images
npm run dev:down
```

`down` retains both named volumes and `.env.local`. Dependency containers do not
start the application. Application health/status is implemented by the separate
runtime; participant onboarding and a remote agent participation API are not.

`dev:images` reports each configured image reference, local image ID, repository
digests, and OS/architecture, including the one-shot AWS CLI image. Run it after
successful startup and tests, and retain that output with the execution evidence.
An image being present locally is not proof that its integration checks passed.

## Credentials and privileges

The local PostgreSQL database is `loom_dev`. The initialization account is
`postgres`; it is not the future application account. `loom_migrator` owns the
application and migration schemas. `loom_app` can use the application schema and
future granted tables, but is not a superuser and cannot create schema objects or
read the migration history schema. No domain tables or participant records are
created by the current migration.

The S3 keys in `.env.local` are **local administrative tooling credentials** for
initialization and smoke checks. They are not participant API credentials or a
production IAM design. The eventual storage adapter needs separate, scoped runtime
configuration and hosted-provider validation. SeaweedFS's unused administrative
ports are not published to the host.

Changing `.env.local` passwords after initialization does not rotate stored
PostgreSQL role passwords. Keep the file with its volumes or change credentials
through an explicit, reviewed operation.

## Ports and signed URLs

Host clients use `127.0.0.1:54320` and `http://127.0.0.1:8333` by default. Containers
use Compose service names (`postgres:5432`, `http://s3:8333`). The S3 helper explicitly
uses the local service endpoint; no ambient AWS profile chooses its destination.

The future browser-facing presigner must sign the client-reachable endpoint. Do
not sign a URL for `s3:8333` and rewrite its host afterward. A remote agent cannot
use a development URL containing `localhost`; a cross-machine pilot needs a
properly reachable, authenticated deployment. This bootstrap does not expose the
local database or storage service on all host interfaces.

## Migration contract

Migrations have unique four-digit versions and filenames such as
`0001_schema.sql`. Applied filename and content hashes are retained in
`loom_migrations.history`. Re-running unchanged migrations is a no-op; changing an
applied file or running an older checkout against unknown applied migrations fails.
Add new migrations after existing versions rather than rewriting or inserting behind applied files.

The runner uses one `psql` connection and transaction, a transaction-scoped advisory
lock, and explicit lock/statement deadlines. A failed migration rolls back its
transaction. Files must not contain psql meta-commands or top-level transaction
control. Statement validation skips comments and quoted text, so quoted procedural
bodies are accepted in both single-line and multiline form. See the
[migration guide](../../db/README.md) for quoting assumptions and validation limits.
The source checks are hygiene, not a SQL sandbox. All migrations are trusted reviewed
repository code. Large/nontransactional migrations and production upgrades require
a later migration procedure; an application rollback is not database rollback.

## Tests and their limits

`npm run check` runs source-digest/mapping/JSON checks, native Node tests of local
configuration, migration-plan generation, safe invocation and reset rules, and the
existing hook-installer plan tests. It also typechecks the application/tests, runs
Fastify HTTP-contract and React router tests, and builds the release. These checks
do not connect to a database. Contract-only body/fault routes exist solely in the
test harness, and are absent from the production API and OpenAPI inventory.

After building, `npm run test:app:postgres` creates a disposable PostgreSQL
container with temporary storage, fresh credentials, and a random loopback port.
It uses actual application-role connections and compiled HTTP startup. Checks
cover parameterized transactions on one connection, rollback, expired scopes,
privileged/unavailable startup refusal, liveness versus readiness during database
loss, built browser assets, safe errors, request drain before database closure, and
actual Vite module loading beside the API proxy. It closes only its own HTTP/Vite
processes and removes only its own database container.
It does not use development credentials/volumes or register fixture routes in the
production application. Unavailable Docker/PostgreSQL fails the check.

`npm run test:migrations:postgres` requires a local Docker engine and uses the pinned
PostgreSQL image in a disposable UUID-named container with memory-backed storage,
fresh test credentials, and no host ports. It checks procedural SQL, atomic rollback
and history, migration ordering and immutability, ahead/behind-history refusal, and
role separation. It cleans up only its test container and never uses existing
development volumes or `.env.local`. This suite also runs in the CI integration job;
it fails rather than substituting a database mock when Docker/PostgreSQL is unavailable.

`npm run test:integration` requires previously started local services and fails
when they are absent. It checks real authenticated application-role access,
wrong-password denial, denied schema creation, hidden migration metadata,
repeatable/checksummed migrations,
explicit transaction rollback and rollback of a deliberately failing migration,
ahead-of-checkout refusal, distinct object versions, old-version reads, exact-version
copy, anonymous object denial, signed GET success/expiry/signature tampering,
version listing, and a one-part multipart upload.
It creates unique scratch keys and deletes only the exact versions it created.
Cleanup failures are failures, not a successful test exit. It never deletes a bucket.

`npm run test:persistence` is a separate, disruptive local check. It commits a
uniquely named scratch table/row using the migrator and application roles, stores
two staging versions and one final version, then verifies their stored lengths
and exact contents
before and after `docker compose stop`/`up -d --no-recreate --wait` and
`up --force-recreate --wait`. It also compares migration history and credentials,
checks that both buckets retain versioning, and confirms that container IDs really
change on recreation. The restart phase uses `up --no-recreate --wait` because
some Compose versions lack `start --wait`; unchanged IDs prove container reuse.
It does not rerun storage initialization between phases,
which could hide lost bucket settings. Named volumes are never removed. Only
scratch resources created by the test are cleaned up; cleanup errors fail the
command. Services remain running after a successful run. Do not run this while
another local task needs uninterrupted database or storage access.

The signed GET probes use the AWS CLI to sign the host-reachable loopback address;
they do not log usable URLs. The expiry probe uses a five-second lifetime and waits
a full seven seconds after signing returns, including a two-second margin. It
records UTC signing/expiry/request timestamps and HTTP statuses. Only a still-valid
HTTP 200 allows another request: at most three attempts, one second apart, each
with a ten-second request timeout. Unexpected statuses and transport failures fail
immediately; remaining usable after the third attempt also fails. The deliberate
wait totals seven seconds normally, at most nine with retries, excluding request
time and scheduling delays. Every attempt starts a new request; this does not test
termination of in-flight downloads, version-specific signed grants, signed PUT
replay, browser CORS, or revocation.

These checks do not test all multipart edge cases, application authorization,
publication transactions, backup/restore, or hosted-provider compatibility.
Those are explicit backlog gates. The bootstrap Docker-backed assertions passed on macOS
arm64 using Linux/arm64 containers and in the Ubuntu 24.04 (Linux/amd64) CI run linked
above. Bootstrap Lore task `LC-20261011-R161` records the original adoption;
`LC-20261012-AYAB` records the Compose restart compatibility fix. Find the original
record with `git log --all --fixed-strings --grep='Lore-ID: LC-20261011-R161'`.
Local smoke success is not product acceptance, a cloud-agent pilot, or a guarantee
that another S3-compatible provider behaves identically.

## Destructive local reset

Only after deciding that the local data is disposable:

```bash
node scripts/local.mjs reset --confirm-delete-local-data
```

This removes the selected local Compose project's named PostgreSQL and object
volumes. It retains `.env.local`; the next `dev:up` initializes fresh stores with
those credentials. There is no automatic reset after failures and no cloud-delete
mode. Do not run reset as a remedy for unexplained data or compatibility problems
without first preserving useful evidence.

## Technical references

- [PostgreSQL official image](https://hub.docker.com/_/postgres): PostgreSQL 18 volume layout and fresh-volume initialization.
- [SeaweedFS mini](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini): single-node mode and explicit credential setup.
- [SeaweedFS 4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48): selected source release, not proof of image/runtime testing.
- [Official AWS CLI container](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-docker.html): CLI container use.
- [Compose networking](https://docs.docker.com/compose/how-tos/networking/): service names and published host ports.

Architecture mechanics and product guarantees remain in their original documents;
these references do not establish that any Loom acceptance test has passed.
