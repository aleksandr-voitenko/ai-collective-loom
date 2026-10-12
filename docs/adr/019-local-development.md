# ADR-019: Local database and object-storage development profile

Status: bootstrap implementation choice; Node 24 tooling, integration, and
persistence validated on macOS arm64 using Linux/arm64 containers and Ubuntu 24.04
(Linux/amd64) CI. Managed-provider and product validation remain open.

Scope: developer environment and CI only; not a product-policy or production-provider decision.

## Decision and rationale

Use Docker Compose with PostgreSQL 18.4 and single-node SeaweedFS 4.48. Create two
versioned local buckets. Use an official AWS CLI image only as a one-shot local
setup/check client. Keep bootstrap scripts dependency-free following the existing
repository's `.mjs` conventions. Application packages and the TypeScript/Node 24,
Fastify, and React runtime are selected separately by [ADR-002](002-application-runtime.md).

Pin the observed multi-platform image indexes after successful local validation.
Record their selected platform manifests separately: an index pin fixes the set of
images while allowing native architecture selection. The pinned images have run
as Linux/arm64 locally and Linux/amd64 in CI; other platforms remain unvalidated.
Review pins when updating a dependency, and rerun the same checks on each supported
runtime platform.

Copy the unchanged PostgreSQL role hook from its read-only host mount to a
container-local mode-0644 file before invoking the official entrypoint. A local
bind mount reported that hook executable despite mode 0644, then denied shebang
execution. Container-local sourcing passed a fresh-database initialization probe
without modifying host metadata or existing-volume semantics. Retain this small
wrapper unless supported mount behavior provides equivalent reliable initialization.

Use unique immutable files for each CLI transfer. Rewriting one host input between
CLI containers reproducibly stored a later 18-byte fixture as 15 bytes; unique
inputs stored and retrieved all expected lengths. Keep exact-byte assertions and
check server-reported lengths. Three additional controls reused a container-local
filename and returned exact bytes for all nine native versions after overwrites.
This supports classifying the original observation as a Docker Desktop host-file
fixture caching/transfer limitation, not evidence of stored-version corruption.
The precise filesystem or transfer mechanism remains unidentified; the workaround
is confined to the test harness without selecting a different storage provider.

The objective is to develop without cloud credentials or a model runtime while
preserving a path to testing actual PostgreSQL and S3 version operations. Keep the
existing product file path and import the three v0.3 architecture documents unchanged.

## Boundaries and alternatives

Do not substitute a host filesystem or in-memory database for native integration
checks. Local storage does not certify a hosted provider, production IAM, retention,
or recovery. Do not implement several local storage engines or a multi-cloud
framework now. An actual operation incompatibility or unacceptable local resource
cost is a reason to reconsider the development provider, not to weaken exact-byte
references or silently disable tests.

Application/dependency bootstrapping remains a separate decision from this local
provider choice. The actual lockfile now includes the runtime selected in ADR-002;
registry access, installation, build, and execution require their own evidence.
The earlier zero-dependency bootstrap checks do not validate application packages.

## Validation gates

Adoption on macOS arm64 validated Node 24.19.0 tooling and the pinned profile using
Docker Desktop 29.8.2, Compose 5.5.1, and linux/arm64 containers. The real suites
passed role/password enforcement, migration repeatability/checksum/refusal and
rollback, versioned object operations, signed GET success/expiry/tampering, and
persistence through stop/start and recreation. Bootstrap Lore task
`LC-20261011-R161` records the verification results, earlier access failures, and
initialization/transfer regressions.

[CI run 38176825771](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38176825771)
on Ubuntu 24.04 (Linux/amd64)
passed for `4865058` with Node 24.19.0: all 40 checks and both real integration and
persistence suites. All three images reported `linux/amd64`. The first CI attempt
rejected `start --wait`; Lore task `LC-20261012-AYAB` changed the restart to
`up --no-recreate --wait`, retaining the health wait and unchanged-container-ID
assertion. The successful run verified retained data, versioning, and credentials
through restart and forced recreation.

Require first pull, engine/platform identification, initialization, the real local
smoke suite, signed GET checks, and persistent-volume stop/start and recreation
checks. The persistence command must inspect retained versioning without running
setup again, so initialization cannot mask a loss of stored configuration. It
removes only its own scratch resources and keeps volumes. Separate this service
interruption from the ordinary smoke command. CI runs both commands. Repeat these
checks when changing image pins or runtimes and on additional platforms before
declaring those configurations validated. Signed upload/version-specific grant
validation, managed-provider tests, and product/architecture AC/AV scenarios remain
independent gates before dependent features or claims of product validation.

No Git staging, commit, push, or workflow run is authorized merely by this document.
Follow the installed repository instructions and the user's explicit permissions.
