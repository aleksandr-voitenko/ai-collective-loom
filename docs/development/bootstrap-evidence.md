# Bootstrap evidence and handoff

> Historical record from 10–11 October 2026, preserved for reference. Status and
> results below describe that adoption period. See the [current development guide](README.md)
> for subsequent implementation and CI evidence; these commands were not rerun when
> this record was added to Git.

**Status:** Local bootstrap validated on macOS arm64 using Linux/arm64 containers.
CI, Linux/amd64 execution, and managed-provider validation remain open.
No staging, commit, push, or cloud deployment performed.
**Adoption date:** 10 October 2026 (Pacific/Auckland).
**Fresh-volume validation:** 11 October 2026 (Pacific/Auckland), passed without manual repair.
**Repository base:** `8b2fcca6edac734430817d5e6a036a0183d8409d`.
**Scope:** Adopt and validate development tooling, not implement the forum.

## Checkout and source preservation

The starting checkout already contained all 30 files from the supplied bootstrap
patch. Every file matched the supplied manifest SHA-256, the patch itself matched
`9b79683b1b98aa5cb23e4609463897b889d3882b43cecbb3a82352f1e6c280a8`, and
`git apply --reverse --check` passed. The patch and `APPLY-AND-REVIEW.md` were
reviewed; no forward or reverse patch application was performed.

The tracked product specification was absent even though the supplied patch leaves
it untouched. The first `npm run check` failed with ENOENT. Restored only that
missing file from HEAD using exclusive creation after verifying its SHA-256:
`ef9ba75869278c24aa2213075404c75e609dbd7577b98327b46e053032a1e4ed`.
The check then passed. The product and all three architecture snapshots still
match `docs/baselines.json`; the manifest was not changed. The product, license,
`AGENTS.md`, `.lore-coding/`, and `.githooks/` have no diff from HEAD.

Root memory was checked against source and history: Lore installation
`LC-20260927-E365` and product import `LC-20260929-5WKG`. Current memory and
ADR-019 now distinguish executed local checks from CI/provider/application gates.
No product decision, other ADR, or application/concurrency backlog item was closed.

## Observed adoption environment

| Component | Observed value and limit |
|---|---|
| Host | macOS 27.0.1, build 26A434; Darwin arm64. |
| Intended Node | `.nvmrc` = 24.19.0; the existing bundled Node executable reported v24.19.0 and ran all final live checks. |
| Compatibility Node | v22.22.2; final dependency-free checks also passed. Live bootstrap validation was completed with Node 24. |
| npm | 12.0.1. |
| Docker client/context | Final client 29.8.2, darwin/arm64; `desktop-linux`. Earlier blocked inspection reported client 29.7.2. |
| Docker engine | 29.8.2, Docker Desktop; `docker info` reports linux/aarch64, `docker version` reports linux/arm64. |
| Compose | 5.5.1. Configuration rendering and actual lifecycle commands passed. |
| Executed images | All three report `os: linux`, `architecture: arm64`. No amd64 container execution. |

Node 24 was selected by prepending the existing bundled runtime's `node/bin`
directory to PATH. No system Node installation or global configuration was changed.
An earlier `curl --fail --silent --show-error --connect-timeout 10 --max-time 20
https://nodejs.org/dist/v24.19.0/SHASUMS256.txt` failed with DNS resolution error 6.
The existing exact-version runtime removed the need for a download.

## Adoption commands and results

These are the initial adoption results from 10 October 2026. Later fresh-volume
validation and expiry-probe verification are recorded separately below.

| Command/check | Observed result | Evidence boundary |
|---|---|---|
| `npm ci --ignore-scripts` | Passed under Node 22.22.2 and 24.19.0; one package audited, zero registry dependencies. | Bootstrap manifest/lock agreement, not application dependencies. |
| `npm run hooks:install` | Passed under both runtimes; `core.hooksPath` remains `.githooks`. | Existing installer used unchanged. |
| Initial `npm run check` | Failed: missing product specification; passed after exact restoration (31 tests). | Baseline repair verified red/green; no check weakened. |
| Final `npm run check` | **32 passed** on each of Node 24.19.0 and 22.22.2, zero failed/skipped: 27 bootstrap + 5 hook tests. | Includes credential/symlink protection and exact document baselines; not live-service evidence. |
| `npm run dev:init` | Passed once, only when configuration/state directory were absent. | Created ignored `.env.local` (0600) and `.local/` (0700). Never rerun; no credentials printed. |
| `npm run dev:doctor` | Passed with approved host execution. | Local endpoint, engine, Compose and configuration verified. Earlier socket failures retained below. |
| `npm run dev:up` | Passed after the initialization fix described below; passed again with pinned images. | Real roles/schema, two versioned buckets and `0001_schema.sql` initialized. No forum service. |
| `npm run test:integration` | Passed with both the original pulled references and final immutable pins. | Real SQL and S3 assertions, including failed migration rollback and signed GET denial/expiry. |
| `npm run test:persistence` | Initial fixture transfer failed; full suite passed after the fix and again with final pins. | Committed row, complete migration history, stored lengths/exact versions, bucket versioning and credentials retained across stop/start and recreation. |
| `npm run db:migrate` | Passed after final lifecycle tests: all checked-in migrations applied with matching checksums. | Repeat application remains a no-op; not a product-schema migration. |
| `npm run dev:images` | Passed for all three final references, including the profiled one-shot CLI. | Exact IDs/digests and linux/arm64 reported without container environment. |
| `docker compose --env-file .env.local --project-name loom-dev --file compose.yaml --profile tools config --quiet` | Passed. | Compose parsing. Earlier privately captured JSON assertions also checked services, loopback ports and named mounts. |
| `node --check` for all 8 bootstrap script/test modules; `bash -n infra/postgres/10-roles.sh` and `bash -n infra/postgres/start.sh` | Passed. | Syntax; behavioral evidence comes from the live commands above. |
| CI YAML parsing and required-step/permission assertions | Ruby/Psych `YAML.safe_load` passed; both live commands required and permissions `contents: read`. Earlier Python attempt failed because PyYAML is absent. | No GitHub workflow executed. |
| Baseline checks, protected-path diff, ignore/mode checks, `git diff --check` | Passed. | Exact snapshots/Lore/license preserved; local private state ignored; index empty. |
| Changed-document link checks | Passed: 21 relative links resolve. | File/link consistency, not browser rendering. |
| Exact generated-credential scan of tracked/non-ignored files | Passed: no matches in 46 files. | Secret values were compared privately and never printed. |

The final consecutive live run used Node 24.19.0 and the checked-in pinned profile:

```bash
npm run dev:doctor
npm run dev:up
npm run test:integration
npm run test:persistence
npm run db:migrate
npm run dev:images
```

All six exited successfully. The persistence command reported successful checks
before lifecycle changes, after stop/start, and after container recreation. It
verified that stop/start reused both containers and recreation replaced both IDs.
It did not rerun storage setup between phases, which could mask lost bucket settings.
Cleanup succeeded and removed only its own scratch table/row and exact object versions.

Final `docker ps --filter label=com.docker.compose.project=loom-dev` showed PostgreSQL
healthy on `127.0.0.1:54320` and S3 running on `127.0.0.1:8333`. Project volume
inspection showed `loom-dev_postgres-data` and `loom-dev_s3-data` still present.
There were no project containers/volumes at the first successful inventory; startup
created these volumes and all subsequent checks retained them. No reset or deletion
of these development volumes, credential regeneration, cloud service, or storage
substitute was used.

## Fresh disposable-volume validation — 11 October 2026

The full current Compose configuration passed from fresh PostgreSQL and S3 volumes,
without manual repair or changes to implementation. This closes the fresh-profile
coverage gap left by the earlier standalone PostgreSQL probe and repaired
development volume; the earlier failures remain recorded below.

The isolated project was `loom-fresh-e34e88740f10`. A temporary directory held
byte-identical copies of the current Compose file, Node tooling, migrations,
package manifests and Node-version file. Its infrastructure symlink resolved to
the original repository's `infra/postgres` directory, preserving the actual source
mount. The Compose SHA-256 was
`133bb397207172754812d41ae8b1cf814168a28830ab73e753190c756243c84f`.
Only the project name and loopback ports (PostgreSQL 63653, S3 63654) differed in
the private configuration. Existing local credential values were reused privately;
the original `.env.local` was never changed and `dev:init` was not rerun.

Before startup, both expected volume names were absent from Docker's complete
volume inventory, and the project had no containers or volumes. Normal `dev:up`
created `loom-fresh-e34e88740f10_postgres-data` and
`loom-fresh-e34e88740f10_s3-data`; both reported creation at
`2026-10-11T07:55:12Z` with the matching Compose project label. PostgreSQL startup
logs confirmed that its official entrypoint sourced `10-roles.sh` and completed
fresh initialization. No repair command or pre-seeded database/object data was used.

The following normal commands all exited 0, using Node 24.19.0, Docker 29.8.2,
Compose 5.5.1 and the same pinned linux/arm64 images recorded below:

```bash
npm run dev:doctor
npm run dev:up
npm run test:integration
npm run test:persistence
npm run db:migrate
npm run dev:images
```

Integration verified real role/password enforcement, migration repeatability and
rollback, native object versions/copy, anonymous denial, signed GET expiry and
tampering, and multipart completion. Persistence passed all three phases, retaining
the committed row, migration history, bucket versioning, three exact object versions
and credentials across stop/start and container recreation. The post-lifecycle
migration command found every checked-in migration applied with matching checksums.

Cleanup used `docker compose` with the temporary configuration and explicit
`--project-name loom-fresh-e34e88740f10`, followed by `down --volumes`. Verified that
only this disposable project's containers, two volumes and network were removed.
The temporary directory, including its credential copy, was also removed. The
original development container IDs, volume identities/creation times, credential
bytes and source hashes remained unchanged. No implementation fix or Git operation
was needed. This adds local fresh-start evidence, not CI/amd64 or managed-provider
validation.

## Failures investigated and fixes

### Host access

Before the successful retry, doctor/up/integration/persistence/images failed at
Unix-socket access. Four host-approval attempts timed out in the automatic reviewer,
including attempts after user approval. These were approval-service timeouts, not
findings that Docker was unsafe or incompatible. The user first deferred Docker,
then asked to retry. Approved host execution now reaches the daemon and all live
checks pass. Ordinary sandbox execution still cannot open the socket; no socket
permissions or remote-context safeguards were changed.

### PostgreSQL initialization

The first real `dev:up` pulled the images but PostgreSQL exited 126 after creating
its database: executing the bind-mounted role hook failed with
`/usr/bin/env: bad interpreter: Permission denied`. Host and container mode inspection
showed 0644 for the hook, yet the container's executable test returned true.
`/usr/bin/env true` itself worked. Host quarantine metadata was present, but the
specific underlying filesystem cause was not established; no host metadata was removed.

The narrow fix mounts the source under `/opt/loom/postgres` and runs
`infra/postgres/start.sh` through Bash. The wrapper copies the unchanged hook to the
official init directory at mode 0644 on the container filesystem, then delegates
to the official entrypoint. No role policy or database startup guard was weakened.

A separate real PostgreSQL probe used `docker run --rm --network none` with
`--tmpfs /var/lib/postgresql` and the same read-only source mount and wrapper.
Fresh initialization logged that it was **sourcing** the hook; TCP login verified
`loom_app|true|false` for identity, schema USAGE and CREATE. The installed hook was
non-executable. The isolated probe stopped normally and used no persistent volume.
This exercised the boundary missing from the original static-only checks.

The partially initialized development volume was preserved. Inspection found
zero Loom roles and zero Loom schemas (`0|0`). Only after that check, the unchanged
role hook was run once inside that container using its existing credentials;
reinspection showed two roles and two schemas (`2|2`). This was a deliberate repair
of the observed partial state, not an automatic startup/reset/credential-rotation
path. Subsequent startup, password enforcement, migrations and recreation passed.

### Persistence fixture transfer — harness limitation

The first live persistence run failed before lifecycle changes: its 18-byte
replacement object read back as 15 bytes (`replacement byt`). Cleanup succeeded.
A controlled real-S3 probe using one rewritten input filename reproduced stored
HEAD/GET lengths of 15, 15 and 12 for expected lengths 15, 18 and 12. A different
output filename did not repair the already-truncated stored object. With a unique
immutable input filename per write, HEAD and GET returned 15, 18 and 12 and all
exact-byte comparisons passed. Each probe cleaned up only its own object versions.

The persistence fixtures now use unique immutable input files and unique download
paths, and assert native HEAD content length as well as exact GET bytes in every
phase. Expected bytes were not changed. The evidence identifies the host-file fixture
path as the affected test boundary; the underlying filesystem or transfer mechanism
remains unidentified. The complete required persistence command subsequently
passed, including both lifecycle phases,
and passed again on the final pinned references.

An additional control on 11 October 2026 created the upload bodies **inside the
AWS CLI container**, using its own `/tmp` filesystem. Each run deliberately reused
one input filename for the same 15-, 18-, and 12-byte bodies and overwrote one
unique S3 key. After all three uploads, native HEAD and version-specific GET
operations checked every version, including the two older versions. Python
compared the full downloaded bytes with the expected bytes, including newlines.
The fixture input, expected output and download files never used the host bind mount.

The control ran in three separate disposable CLI containers against the existing
local S3 service, using the same pinned images and credentials. All three runs
passed: **nine distinct versions**, matching HEAD lengths (15, 18, 12 per run),
and exact GET bytes after overwrites. Each run deleted only its three exact object
versions and verified that none remained under its unique probe key. Development
container IDs, volumes and credential bytes remained unchanged.

The invocation used the current Compose configuration with
`run --rm --no-deps -T --workdir /tmp --entrypoint /bin/bash aws -s --`, passing the
local staging bucket and a unique `bootstrap-container-transfer/` key as arguments.
The diagnostic script arrived on standard input; `printf` generated the reused
fixture inside the container. This was a separate local diagnostic, not a CI run.
Its initial attempt stopped before creating fixtures or writing S3 objects because
the image lacks `cmp`; the successful runs used its existing Python for direct
byte comparison, with unchanged expected content and no installed dependencies.

The repeated container-local results support this scoped harness classification:

> A Docker Desktop host-file fixture caching/transfer limitation, avoided through immutable fixture files; not evidence of stored-version corruption.

This describes the observed test limitation, not an identified cache implementation
or filesystem defect. The precise cause remains unresolved; these controls do not
certify other host filesystems or managed storage providers.

## Added and exercised bootstrap verification coverage

Source review found that the supplied rollback smoke used explicit ROLLBACK without
exercising a failed migration. The suite now injects division by zero after scratch
DDL/DML through the actual migration runner and verifies that neither its table nor
history record committed. It also verifies wrong-password denial, a denied direct
history read and ahead-of-checkout refusal. Complete history records, including
checksums and application times, are compared rather than only row counts.

Storage checks retain distinct native versions, exact old-version reads/copy,
anonymous denial, version listing and one-part multipart completion. Added AWS CLI
signed GET success, signature-tampering denial and expiry denial passed using the
loopback endpoint; usable bearer URLs were never logged. The original one-second
expiry probe passed, but its narrow timing window was subsequently replaced with
the policy below. Both versions start a new request after expiry; neither tests
termination of an in-flight download.

`test:persistence` adds committed runtime DML, retained bucket settings, native
version lengths/bytes and lifecycle evidence. Both live suites are required in CI,
but CI has not run. These additions address source-reviewed gaps; no claim is made
that every added assertion first failed against the original suite. The observed
initialization and transfer failures/fixes provide the regression evidence above.

### Signed-GET expiry timing — 11 October 2026

The expiry probe now signs for five seconds, then waits a full seven seconds after
the presigner returns. This supplies a two-second margin without relying on host
clock subtraction or running close to a second boundary. Signing and calculated
expiry timestamps come from the URL's validated SigV4 metadata; each request's
actual UTC timestamp and HTTP status are recorded without the bearer URL.

Only HTTP 200 permits a retry while waiting for the transition to HTTP 403. There
are at most three attempts, one second apart, with a ten-second timeout per request.
Other statuses, transport failures and an exhausted retry allowance fail. Every
response body is cancelled; the existing signed-success and tampering checks are
unchanged. Deliberate waiting is seven seconds normally and nine seconds at most,
excluding network time and scheduling delays. The underlying implementation is
`scripts/lib/signed-get-expiry.mjs`, called by the real storage smoke suite.

The original one-second/2.1-second-wait behavior was first extracted without
changing it. The eight new deterministic tests failed against that behavior, then
passed after the timing, diagnostics and bounded-retry changes. They exercise
delayed scheduling, successful transition, retry exhaustion, immediate failure on
HTTP 401/404/500 and transport errors, metadata validation, and bearer-safe output.
These controlled responses verify test orchestration, not S3 behavior.

| Command | Observed result |
|---|---|
| `node --test tests/bootstrap/signed-get-expiry.test.mjs` | Eight tests passed after the change; initial run against extracted old behavior failed all eight. |
| `npm run check` on Node 24.19.0 and 22.22.2 | **40 passed** on each: 35 bootstrap tests and five existing hook tests; no failures or skips. |
| `npm run test:integration` on Node 24.19.0 | Passed against the real local PostgreSQL/S3 profile on macOS arm64 using Linux/arm64 containers; cleanup succeeded. |

The live URL was signed at `2026-10-11T08:50:43.000Z`, with declared expiry at
`2026-10-11T08:50:48.000Z`. The GET was requested at `2026-10-11T08:50:51.040Z`.
It returned HTTP 403 on attempt 1 of 3. No retry was needed in that live run;
retry transitions and exhaustion were exercised by the deterministic tests.
CI itself remains unrun. Persistence was not rerun for this expiry-only change;
the earlier lifecycle results remain separate evidence.

## Validated image references and platforms

`compose.yaml` pins multi-platform index digests observed through registry manifest
inspection and local image inspection. All three were pulled and executed as
linux/arm64. On this Docker image store, the reported local image ID equals the
index digest. `dev:images` returned the matching repository digest for each image.

| Tag | Pinned index / observed image ID | Executed linux/arm64 manifest |
|---|---|---|
| `postgres:18.4-bookworm` | `sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382` | `sha256:83b9631dbb4121d9235ef910018272798b7d3041ef5b716aa481122d4c49353f` |
| `chrislusf/seaweedfs:4.48` | `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` | `sha256:f1f303474940e9e088edbd2c1658f7ac38cb0dd90f91a2b0a51916d74b8575a1` |
| `public.ecr.aws/aws-cli/aws-cli:2.31.0` | `sha256:cd2b1ed9b2181b2b8341f6584ec019b117cc13d3ec142a244d8908e1bb8ea487` | `sha256:b477ea16c6a71d99c355865bdae8bf4539746cdc821728b29a0bc98b9e6d0f79` |

The same indexes advertise these linux/amd64 manifests, identified but **not run**:

| Image | Unexecuted linux/amd64 manifest |
|---|---|
| PostgreSQL | `sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568` |
| SeaweedFS | `sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931` |
| AWS CLI | `sha256:d5f18fde2ba3f9205e75d511ca3e6185c144e55df07e50eee16d940994557b40` |

For each tag, `docker buildx imagetools inspect <tag>` supplied the index and child
platform descriptors. `npm run dev:images` supplied the actual local identity and
architecture. Pinning the index preserves platform selection; it does not certify
any unexecuted platform or future upgraded image.

## Remaining gaps

Repeat the required commands in CI/on intended additional runtime platforms.
Managed-provider compatibility, full multipart recovery, signed upload and
version-specific grant contracts, coordinated backup/restore, application builds
and HTTP/browser paths, publication concurrency, product AC/AV scenarios, and
human/agent trials remain separate gates in the [backlog](implementation-backlog.md).
No unresolved product policy was approved by these bootstrap checks. Local SeaweedFS
compatibility does not select or certify a managed production provider.

Historical preparation evidence is preserved in
[bootstrap-preparation-evidence.md](bootstrap-preparation-evidence.md); it did
not include live container execution.
