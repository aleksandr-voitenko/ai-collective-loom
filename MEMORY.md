# Repository memory

Product baseline: `docs/ai-collective-loom-product-specification.md` v0.9 remains
unchanged. Architecture v0.3 and companions are in `docs/architecture/`; use
`docs/README.md` for source priority and the implementation backlog for open gates.
The architecture is a proposal; its acceptance mappings are not executed results.

Current implementation is development tooling only, not a forum HTTP/API/UI.
`scripts/local.mjs` manages an explicitly local Compose project. PostgreSQL 18.4
and SeaweedFS 4.48 use immutable image-index pins; hosted storage remains undecided.
Dependency-free checks pass on Node 24.19.0; this is not an application build.
Real integration and persistence checks pass on macOS arm64 using Linux/arm64
containers under Docker Desktop. The same bootstrap checks and real suites passed
on Ubuntu 24.04 (Linux/amd64) for `4865058` in
[CI run 38176825771](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38176825771).
Other runtime platforms, managed-provider operations, and product validation remain
open. See bootstrap Lore task `LC-20261011-R161` for the original adoption scope.
Do not weaken product revision, privacy, retry, or recovery requirements because
bootstrap tests pass.

`.env.local` and `.local/` are ignored generated state. Initialization never replaces
passwords silently; persistent volumes retain their own credentials. Runtime and
migration database roles are separate. Current SQL creates grants/metadata only,
not the proposed product schema. Migration checksums and application history are
different concepts. Ordinary stop retains volumes; reset requires explicit consent.

Root npm scripts have no registry dependencies. `npm run check` covers docs,
bootstrap units, and the existing hook-installer plan tests. Integration uses real
local dependencies; it is separate and never reported passed when unavailable.
Application dependencies and their lockfile entries are a subsequent task.
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
