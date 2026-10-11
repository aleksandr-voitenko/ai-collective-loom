# ADR-019: Local database and object-storage development profile

Status: bootstrap implementation choice; Node 24 and local linux/arm64 integration/persistence validated. CI and managed-provider validation remain open.
Scope: developer environment and CI only; not a product-policy or production-provider decision.

## Decision and rationale

Use Docker Compose with PostgreSQL 18.4 and single-node SeaweedFS 4.48. Create two
versioned local buckets. Use an official AWS CLI image only as a one-shot local
setup/check client. Start with dependency-free Node tooling following the existing
repository's `.mjs` conventions. The proposed application remains TypeScript/Node
24 with Fastify and React; its packages are not selected by this tooling manifest.

Pin the observed multi-platform image indexes after successful local validation.
Record their selected platform manifests separately: an index pin fixes the set of
images while allowing native architecture selection. Only linux/arm64 has run;
published amd64 manifests are not evidence of an amd64 pass. Review pins when
updating a dependency, and rerun the same checks on each supported runtime platform.

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

Application/dependency bootstrapping follows separately so unavailable registry
access cannot produce a fabricated package lock or claims about builds that did
not run. The current lockfile covers the zero-dependency development-tool package.

## Validation gates

Adoption on macOS arm64 validated Node 24.19.0 tooling and the pinned profile using
Docker Desktop 29.8.2, Compose 5.5.1, and linux/arm64 containers. The real suites
passed role/password enforcement, migration repeatability/checksum/refusal and
rollback, versioned object operations, signed GET success/expiry/tampering, and
persistence through stop/start and recreation. Bootstrap Lore task
`LC-20261011-R161` records the verification results, earlier access failures, and
initialization/transfer regressions.

Require first pull, engine/platform identification, initialization, the real local
smoke suite, signed GET checks, and persistent-volume stop/start and recreation
checks. The persistence command must inspect retained versioning without running
setup again, so initialization cannot mask a loss of stored configuration. It
removes only its own scratch resources and keeps volumes. Separate this service
interruption from the ordinary smoke command. CI includes both commands, but has
not run in this task. Repeat against the same pinned indexes on intended CI
platforms before declaring those platforms supported. Signed upload/version-specific
grant validation and managed-provider tests remain independent gates before dependent features.

No Git staging, commit, push, or workflow run is authorized merely by this document.
Follow the installed repository instructions and the user's explicit permissions.
