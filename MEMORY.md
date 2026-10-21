# Repository memory

Product baseline: `docs/ai-collective-loom-product-specification.md` v0.9 remains
unchanged. Architecture v0.3 and companions are in `docs/architecture/`; use
`docs/README.md` for source priority and implementation ADRs for open gates.
Do not recreate `docs/development` or a replacement development folder. Temporary
guides, task notes and review evidence belong outside the repository in `/tmp`.
Keep durable setup/coverage commands in root README, decisions in `docs/adr`, and
implementation constraints in scoped memory. Historical evidence remains in Git.
The architecture is a proposal; its acceptance mappings are not executed results.

Current implementation includes an opt-in **synthetic participation** slice on
one TypeScript/Fastify/React/Data Mode/Vite release. Default startup remains the
operational foundation; `LOOM_PARTICIPATION_PROFILE=synthetic` plus exact HTTPS
`LOOM_ORIGIN` registers identity/admin, publication and bounded retrieval routes.
The browser is `/loom`; executable API/guide version is `participation-1`/`14`.
Artifact files (ADR-029, migration0019) extend ordinary artifact revisions with
complete immutable manifests and contextual exact native S3 versions. The isolated
preview uses app-authenticated HTTPS single-part transfer/download with private
SeaweedFS buckets; it never exposes provider credentials or signed capabilities.
Owner custody and expired unassociated cleanup are separate from atomic shared
publication. Text-only protocols, old digests and uncertain requests retain their
meaning. Search covers title/authored text, never file bytes; file-only views do not
manufacture main-text presentation. See participation memory for limits/recovery.
Administrator suppression (ADR-028, migration0018) uses the existing resource state
plus independent lifecycle fences and immutable decisions/audit. Only whole
discussions, non-opening comments, summaries and artifacts are supported. Safe
metadata management remains available without ordinary source reads; restoration
removes only local suppression. Both credentials require current administrator
authority. Existing visibility generations drive replay; no shared lifecycle event,
content revision or private choice is fabricated. See participation memory.
Administrator topic organization adds an implicit root, bounded nested areas,
attributed metadata history, versioned subtree/content moves and inherited closure.
Resource ownership remains authoritative; the existing exclusive structure guard
serializes organization with publication, followed by the common clock/event tail.
Exact recovery returns original and current state without reapplying earlier moves.
Proposal discussions bind their destination/settings; topic-specific suggestions
also retain the stable affected-area ID. Organization decisions: `LC-20261014-IGI9`.
See ADR-020; optional moderator
delegation remains open. Combined Updates uses ADR-025 below.
Current shared-text search is implemented for typed openings/comments/artifacts/summaries,
with exact revisions, live containment, original-author/time/topic filters and
explicit continuation invalidation. Search and personal direct attention have independent recoverable derived workers;
remaining projections stay disabled. See ADR-012 and
`src/server/modules/search/MEMORY.md` for fencing, backfill, bounds and recovery.
Personal direct attention (ADR-023, guide 8): migration 0012 backfills typed retained
revisions in order and consumes intents independently of search. Immutable logical
claims/signals/deliveries use per-recipient committed clocks. Missing predecessor
and historical unmentioned-reply eligibility gaps remain explicit. API/browser
checkpoints survive ordinary restarts; visibility replay reaches all retained
history before completed lower bounds. No shared Updates/read/dismissal/Follow
semantics are implied. See `src/server/modules/notifications/MEMORY.md` for bounds, locks and recovery custody.
Following and ungrouped shared Changes (ADR-024, guide9) use migration0013,
owner-private versioned definitions/decisions and direct committed-event queries.
Area relevance uses immutable event-time scopes; new ancestor impacts are retained,
while missing old structural facts keep coverage unknown. Fixed shared checkpoints
have independent custody, visibility replay and explicit incomplete resynchronization.
No worker is required, and no personal checkpoint/delivery is consumed. Routine attention
is separate (ADR-027), as is exact reading (ADR-026). See
`src/server/modules/following/MEMORY.md`.
Combined Updates (ADR-025, guide10) uses additive migrations0014/0015 and independent
`combined-updates-1` custody. Bounded preparation freezes ownership membership/order
for the union of followed shared and personal availability intervals. Highlights
switches to complete without adopting later definitions/arrivals; both visibility
generations invalidate before filters and explicit replay reaches before completed
lower bounds. Source/explanation authorization stays current. Member metadata,
group coverage, projection, full bodies and reading remain distinct. No new authored
format or worker; existing claims/events/tokens/Saved remain independent. See
`src/server/modules/updates/MEMORY.md` for finite
custody, recovery, native/browser clients and synthetic acceptance limits.
Routine attention (ADR-027, guide12) adds migration0017, private until-unmuted
settings and exact shared-event/personal-delivery dismissal/restore. Stable negative
fences and applied/conflict decisions survive short-lived grouping custody. Separate
combined-updates-2 routine endpoints filter before highlights and require explicit
same-view policy refresh; old combined, standalone and reading contracts stay intact.
Complete retrieval bypasses private filters; current source/history checks still
precede selection. Browser attention hosts require
`web/AuthorizationBoundary.tsx`, backed by the identity-scoped
`web/protected-content.ts` coordinator. Additive private-controls-1 responses
separate settings/decisions from bounded protected previews. Safe removal and exact
recovery do not hydrate sources; old routes/digests/tokens remain compatible.
Every same-owner source denial revokes older protected projections, even after retry,
restoration or remount. Cached ancestry cannot prove current dependencies after a
move or reordered response; client request age cannot order server authorization.
Positive responses retain freshness fences. Private versions, confirmation and
command custody stay independent; private receipts cannot authorize content.
Fresh mixed responses may publish only their own lease-gated fields (previews,
Saved pages and audited discussion traversal); opaque full hosts still withdraw. The method/endpoint catalogue in
`web/response-contracts.ts` explicitly classifies every negative success field;
its contract test checks actual routes/schemas. Saved/Reading receipt denials are
consumed before private settlement. See ADR-027 for the bounded exception.
Endpoint error policies distinguish anonymous discovery and separate ceremony
proofs from authority loss. Anonymous discovery settles quietly; established-owner
loss revokes once and fences old responses. A separate discovery fence blocks stale
positive probes. Transport consumes errors once; identity-record misses stay local,
while ambiguous source failures remain conservative. Session identity and content
authority are independent endpoint effects: role/editor refusals withdraw older
protected projections without replacing the owner of exact command journals.
Ordinary posting closure alone retains independent reads. Administration retains
private draft/correction/status controls while queries, selected account copies and
one-time credential display check separate leases. Source/role withdrawal precedes
journal locks; uncertain bytes stay immutable. See ADR-027 and the tests described in `tests/MEMORY.md`. Posting closure has a certified response hint; absent hints remain conservative.
Protected reads, including generic queries and reply expansion, require that
boundary; session and receipt-only command APIs reject other endpoints before
dispatch. An architecture test forbids direct component transport imports.
Guarded revision-only failures preserve
independently authorized history; unclassified source/history denials revoke.
No source/delivery clock or worker effects. See
`src/server/modules/attention/MEMORY.md`.
Recorded references (ADR-021) use explicit `loom-markdown-v2` declarations from
openings/comments/text artifacts/summaries; old v1 bytes/digests remain unchanged. Immutable
memberships/withdrawals commit with the source, keeping exact targets and separate
assertion/change/withdrawal attribution. Direct bounded backlinks use current
eligibility, explicit resource/exact and current/history scopes, sorted guards and
restartable snapshot pages. Search supports all three formats' source title/body and current revision notes;
rationale is displayed but not searched. See ADR-021
and the participation memory. Exact artifact revisions also cover file-bearing
artifacts; file-path assertions and private-note integration remain open.
Discussion summaries (ADR-010) add optional canonical identity, explicit editors,
immutable exact source declarations, bounded preparation/comparison/maintenance,
and current authority across API/browser recovery. Coverage is an author claim,
not reading progress. See ADR-010.
Authored explanations (ADR-022, guide 7; LC-20261016-T9G8): immutable artifact/summary revision notes
and ordinary opening/comment accounts with bounded exact described revision sets.
Migration 0011 adds field-local entities/assertions, note/account rows and current
note indexing, preserving old digests and source bytes. Generic bodies link separate
authorized note/coverage fields; discovery labels exact/resource and current/history
scopes. New drafts start without copied notes; existing attempts retain theirs.
See ADR-022 and the participation/search scoped memories.
Private Saved items now support discussion/contribution/artifact resource references
and exact contribution/artifact revisions. Owners come from current authentication,
with no administrator override. Migration 0005 retains versioned target tombstones
and immutable applied/conflict decisions, without shared publication side effects.
See ADR-013; private notes remain open.
Synthetic caps are 500 target states/10,000 decisions per
participant; expiry, erasure and destructive restore remain unapproved.
Exact private reading (ADR-026, migration0016) adds owner/resource/revision states
for typed opening/comment/artifact/summary main text. Every accepted command advances
its private version, including Unread no-ops; a deliberate-choice fence gives manual
Unread precedence over intervening presentation-only writes. Retained exact decisions
return original/current state without reapplication. No shared events, worker, clock,
Saved/Following/notification or feed changes. Browser automatic presentation is an
opt-in per-browser/identity prototype, with separate bounded recovery and explicit
reopening after Unread. See ADR-026 and the
participation memory for limits, authority and custody. Real-data gates remain.
No real accounts/content are approved: ADR-004 identity/recovery candidates,
production limits, retained-data operations and cross-machine validation remain
gates. There is no default administrator or identity-header bypass. Agent memory
and model execution stay external; signed grants, attachments/extraction and other derived workers stay gated.
See root README retained-data limits, ADR-011/015/016/017 and
`src/server/modules/participation/MEMORY.md` for the implemented subset.
The supplied UI v0.6 is preserved under `docs/design/ui-v0.6/`; it guides presentation,
not product policy or authority. Its finite fixture state is not imported into Loom.
Runtime foundation history: `LC-20261012-LMP4`; shared publication:
`LC-20261012-6OTQ`; identity protocol: `LC-20261012-9JJH`.
Text participation, authored/retrieval contracts and browser recovery:
`LC-20261014-9EU9`.
Application commands require Node 24.19.0. `dev` initializes dependencies;
`app:synthetic` builds and launches isolated temporary PostgreSQL, native versioned SeaweedFS + HTTPS with a
private ticket file and independent supervised native search/notification workers.
Terminal `worker stop/start` and `notifications stop/start` preserve the API. It never touches existing development data or credentials.

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
Additive `0003_identity_prototype.sql` supplies verifier/expiry/parent-session
metadata, initialization, nickname reservations, passkeys/challenges and private
identity outcomes/audit. It seeds no account or capability. Legacy records remain
`internal` for trusted publication fixtures and cannot authenticate through either
transport. Additive `0004_participation.sql` adds typed text resources, same-discussion FK
parentage, immutable title/mention revisions, editor versions and configuration.
Current task migrations were exercised only in disposable databases, never applied
to existing development data.
Migration 0006 adds organization versions, immutable metadata/outcome/audit records
and structural activity with explicit before/after scopes and no content revision.
Legacy metadata gets an unattributed baseline; prior event ancestry is not invented
or rewritten. Hierarchy/current-placement continuations bind a community epoch and
must restart explicitly after organization changes. Populated upgrade and concurrent
publication/organization checks live in `test:organization:postgres`.
Migration 0007 adds search jobs, exact-source documents and independent progress.
Visibility triggers advance only derived invalidation state. Populated upgrades and
native lease/COMMIT-loss tests live in `test:search:postgres`; sources, immutable
outbox intents, other consumer progress and Saved rows are preserved.
Migration 0008 preserves jobs/documents while separating intent identity from
revision backfill and replaying event discovery with an intent-aware cursor.
Populated 0007 upgrade and unfinished-rebuild process loss are deterministic tests.
Migration 0009 adds v2 reference membership/withdrawal tables and constraints,
without backfilling old content or rewriting outcomes. Populated pre-0009 upgrade,
original v1 uncertain retry and reference races use `test:references:postgres`.
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
Vite browser-module/API proxy separation. Application verification includes local
Node 24/macOS arm64 with Linux/arm64 PostgreSQL and a full passing Ubuntu 24.04
Linux/amd64 push run for `14c4e83` (CI `38479478697`). The duplicate PR run exposed
an intermittent browser-fixture teardown failure; see the context-before-server disposal regression in
`tests/MEMORY.md` and Lore `LC-20261014-WZF5`. This does not establish a cross-machine
agent trial or approve production policy.
The database pool is private; transaction callbacks own one checked-out client,
explicit values, and no automatic retries. Controllers invoke the health boundary or constrained participation services, never
raw SQL.
Requests reject unknown fields/coercion/default insertion; schemas are controlled
code. Errors/owned diagnostics omit credentials, SQL, payloads, and exception details.
The public health routes report coarse availability only. Participation has its
own operation/schema authorization checks; health readiness does not establish
community setup or publication eligibility.
The original `server/modules/publication/` text/plain entry stays internal; its
`commitRevision` tail and authority guards now serve typed participation constructors.
Its opaque actor factory is a trusted verified-identity boundary, not authentication.
The identity verifier calls it after opaque token or WebAuthn proof verification.
The synthetic profile registers actual controllers, never test fixtures.
`server/application/` shares absent-row attempt mutexes and current actor checks.
Account first, then sorted credential/parent `FOR SHARE` guards recheck channel,
ownership, state, expiry and current role; enrollment tickets cannot publish.
It rechecks actor/credential, containment, author/editor/admin rights and base
revision under the ADR-006 guards. Exact retained attempts resolve before stale
new-write checks; read-only reconciliation can disclose only eligible references.
ADR-015 preserves `text-revision-v1` and `participation-text-v1`; ADR-021 adds
`participation-text-v2` only for new v2 content. Retained outcomes are never silently
rehashed. All still need approved erasure/restore policy.
The transactional clock is acquired last and held through events/intents/outcome
and COMMIT; no sequences or new domain guards define its committed upper bound.
`test:publication:postgres` uses tmpfs PostgreSQL and private process fixtures for
atomicity, concurrency, authority, lost acknowledgements and killed connections;
synthetic tail metrics do not approve production capacity. Checked-out connection
errors between queries are transaction-owned and discard the failed client.
Outbox intents remain immutable. Search uses separate discovery/jobs, source-version
guards and generation-fenced atomic output/job finalization (ADR-006/012).
Ordered personal notifications use their own consumer (ADR-023); extraction and other projections remain open.
Publication protocol and recovery decisions: Lore-ID `LC-20261012-6OTQ`.
Identity account creation, separate one-time issuance and restricted audits commit
on the same application-role transaction owner. Retry/status contains safe IDs and
current status, never a saved secret; explicit replacement stays on the same
participant. Administration uses guard `(0x4c4f4f4d, 2)` before sorted participant
updates, separately from the publication clock. Passkey verification is outside
SQL; challenge consumption commits before verification, ticket state/counters are
rechecked before binding/session insertion. Parent revocation invalidates sessions.
Bootstrap/recovery require distinct deployment capability verifiers and have no
HTTP route; initialization closes new bootstrap attempts permanently. Operator
custody/rotation and human recovery proof are still unimplemented procedures.
`test:identity:postgres` uses tmpfs PostgreSQL, private HTTP cookie/bearer requests,
actual ES256 software signatures and barriers for account/ticket/counter races,
reply loss, rollback, lifecycle authority and sampled disclosure checks. See
ADR-004/ADR-015 and `tests/integration/identity.test.ts`. Actual Chromium virtual-authenticator journeys and an administrator UI now exist.
Physical-device and human recovery proof trials, real enrollment, approved limits/
retention and distributed abuse controls remain open; synthetic tests do not complete
AC45/AC54.
Identity prototype decisions and verification: Lore-ID `LC-20261012-9JJH`.
Integration uses real local dependencies; it is separate and never reported passed
when unavailable.
Browser checks use a containing runner and allowlisted failure bundles; raw reporter
output/attachments are not approved artifacts. See `tests/MEMORY.md` for collection, teardown and CI gates.
`npm run coverage` combines Node/JSDOM, all PostgreSQL suites and Chromium client
execution. Application gates enforce 90% changed lines, 85% branches and exact
no-decline line/branch baseline ratios. Tooling is reported separately. See
root README Coverage and `scripts/lib/coverage/` for source-map invariants and approved reports.
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
