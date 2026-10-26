# Database migrations

Local provisioning creates `loom_migrator` and `loom_app`, with separate ownership
and runtime privileges. Ordered SQL files in `migrations/` are executed by
`npm run db:migrate` through the migrator, on one connection and transaction.
The first migration sets future table/sequence grants only; it does not claim an
implemented product schema.
`0002_publication_foundation.sql` adds the internal text publication envelopes,
immutable revisions, commit-tail clock, events, intents and outcomes. It creates no
participant/credential/admin records. Its original internal contract is preserved.
This migration was verified only on isolated resources;
existing development data is not automatically migrated by application startup.
Additive `0003_identity_prototype.sql` extends those envelopes with credential
verifiers/expiry/parent sessions, nickname reservations, controlled initialization,
WebAuthn public keys/challenges, safe identity outcomes and restricted audits.
It seeds no account or capability and preserves `0001`/`0002`. Identity routes are
opt-in and synthetic pending the [ADR-004 policy review](../docs/adr/004-identity-admission-prototype.md).

Additive `0004_participation.sql` adds typed areas/discussions/contributions/artifacts,
the same-discussion parent FK, unique opening, immutable mention rows and revision
titles, editor-list versions, private configuration audit and an instance/config
singleton. It seeds configuration identity only, not a community or administrator.
An authorized setup operation publishes the overview through the shared tail.
The new migration was exercised on isolated fresh databases; application startup
does not apply it to existing development data. Read the
[retained-data limits](../README.md#retained-data-limits) before an upgrade.

Additive `0005_saved_items.sql` adds owner-private target states, collection versions
and immutable operation decisions. Unsaved tombstones preserve ordering; composite
FKs, a target-membership trigger and NULL-aware uniqueness prevent mismatched exact
revisions or duplicate logical targets. It seeds no bookmark. The application can
change state/version but cannot delete retry identity or change owner/target fields.
See [ADR-013](../docs/adr/013-private-saved-items.md). `npm run test:saved-items:postgres`
uses fresh disposable PostgreSQL and actual HTTPS; it does not migrate existing data.

Additive `0007_search.sql` adds rebuild/discovery state, retained search jobs and
exact-source document associations with a PostgreSQL lexical index. Resource/revision
visibility triggers invalidate search continuations without publishing shared activity.
The worker uses `loom_app`, never the migration role. Its progress is separate from
immutable outbox intents and other consumers. Populated pre-0007 upgrades, process
loss and resumable rebuild are exercised by `npm run test:search:postgres`.
Additive `0008_search_intent_discovery.sql` distinguishes intent work from revision
backfill and adds an intent UUID to event progress. It preserves existing job
attempts/outcomes and documents, then replays bounded event discovery to recover
skipped intents. Populated pre-0008 upgrade and repeatability are tested separately.

Additive `0009_recorded_references.sql` admits v2 authored text and adds immutable
reference memberships, revision ownership FKs, logical/target uniqueness,
assertion provenance and indexed incoming queries. No historical content,
digests, mentions, Saved state or proposal references change; there is no inferred
backfill. `test:references:postgres` exercises populated upgrade and old uncertain
retry. See [ADR-021](../docs/adr/021-recorded-references.md).
See [ADR-012](../docs/adr/012-scoped-text-search.md) for fencing and synthetic caps.

Use unique four-digit versions and do not edit applied migrations. The runner
checks filename and SHA-256 against `loom_migrations.history`, rejects unknown
applied versions, and serializes concurrent local migration runs. Files must not
contain psql meta-commands or top-level transaction control, including aliases,
savepoints, prepared transactions, and transaction settings.

Validation follows semicolon-delimited SQL statements, ignoring line/nested block
comments, quoted strings and identifiers, and dollar-quoted text. Use quoted bodies
for procedural functions and `DO` blocks: their internal `BEGIN`, `END`, and
semicolons are accepted regardless of line layout. Unquoted psql meta-commands are
rejected anywhere in the source, including after SQL on the same line.
Unterminated quoted text and block comments are rejected before runner SQL can be
appended. Ordinary strings assume PostgreSQL's default
`standard_conforming_strings=on`; use `E'…'` for backslash escapes.
These checks follow [PostgreSQL lexical rules](https://www.postgresql.org/docs/18/sql-syntax-lexical.html)
for migration hygiene, not full SQL parsing or a sandbox for hostile SQL. Review
migration source as trusted executable code; indirect effects of functions or
session changes remain part of that review.

The pinned `psql` stream reader can split newline-concatenated `E'…'` strings
incorrectly when a continued segment contains a backslash-escaped quote (`\'`).
PostgreSQL accepts that form when sent as one command, but the migration runner
uses psql stream input. Keep such escape strings within one quoted literal
(newlines inside it are supported), or use doubled quotes/dollar quoting. The
validator does not repair client parsing limitations.

The application cannot create tables or access migration history. Do not test
application policies using the PostgreSQL initialization superuser. A future
production migration/upgrade procedure must be defined independently of this local
Docker wrapper, including pending jobs and compatible web/job versions.

Run `node --test tests/bootstrap/migrations.test.mjs` for validation regressions.
`npm run test:migrations:postgres` executes real procedural migrations and checks
rollback/history, ordering, checksums, ahead/behind history, one connection and
transaction, and role separation. It requires a local Docker engine and the pinned
PostgreSQL image from `compose.yaml` (downloaded if absent). The suite starts a
UUID-named container with memory-backed database storage, no host ports, and fresh
test credentials, then removes only that container. It does not use `.env.local`,
existing development containers, or development volumes, and fails if Docker or
PostgreSQL is unavailable. The CI integration job runs it separately from the
database/S3 smoke and persistence suites.

`npm run test:publication:postgres` applies current migrations in its own disposable
PostgreSQL database and checks the actual application operation's atomic rows,
idempotency/authority ordering, response-loss recovery and clock failure behavior.
It prints labeled synthetic contention measurements. See
[ADR-006](../docs/adr/006-transactional-publication.md) and
[ADR-015](../docs/adr/015-publication-reconciliation.md) before extending this boundary.

`npm run test:identity:postgres` uses a separate UUID-named tmpfs PostgreSQL container,
fresh credentials and the application role for account/credential operations. Its
private software authenticator signs actual WebAuthn assertions; no fixture is
registered by normal startup. It checks committed identity rows, retries, races,
recovery, current authority and sampled secret disclosure. Development credentials,
containers and volumes are not used or reset.

Migration `0011_change_notes.sql` adds immutable revision notes and exact account
sets/members, main/note entity/reference namespaces, typed-owner/carry/cardinality
constraints and empty note search projections. It does not rewrite source bytes,
old retry identities, existing reference provenance or summary coverage. Existing
entities are explicitly main-field; old search documents have empty note fields.
Only isolated synthetic upgrades have been exercised; retained-data/production
rollout remains gated. See [ADR-022](../docs/adr/022-authored-change-notes.md).

Migration `0018_moderation.sql` adds an independent lifecycle version to existing
resources, immutable administrator decisions/audit and a bounded community counter.
The resource state remains the sole local restriction. Populated active and
suppressed resources begin at version 1 without invented historical decisions.
Existing visibility triggers handle suppression/restoration; no shared activity
or content revision is added. The `test:moderation:postgres` upgrade case preserves
populated pre-0018 content, restrictions, private choices and retained decisions.
See [ADR-028](../docs/adr/028-administrator-suppression.md).

Migration `0019_artifact_files.sql` adds owner-bound upload custody, immutable
artifact file sets and revision-owned contexts, plus retained definitive expiry
refusals. Native versions cannot change once selected. The original nonempty-prose
constraint becomes a deferred text-or-files invariant for file-aware v3 artifacts;
other empty publications remain forbidden. Existing rows, identities and migration
bytes are unchanged, and no historical uploaded files are invented. Published
contexts protect upload lifetime from cleanup. `test:files:postgres` checks populated
upgrade and native SeaweedFS versions in disposable fixtures. It does not migrate
or modify existing development data. See [ADR-029](../docs/adr/029-versioned-artifact-files.md).

Migration `0020_contribution_attachments.sql` extends upload target kinds and adds
immutable complete contribution attachment sets. A file context has exactly one
artifact or contribution owner, constrained to the exact revision/set. Independent
artifact promotion records immutable source and actor attribution alongside its
initial artifact set. Existing native-version lifetime guards cover both owners;
no old upload/version, outcome or source row is rewritten. Populated upgrade tests
compare every old column and retained traversal semantics in disposable fixtures.
See [ADR-030](../docs/adr/030-contribution-attachments-and-promotion.md).

Migration `0028_file_admission_policy.sql` adds one versioned prospective policy and
immutable attributable decisions. Defaults equal existing hard maxima; no upload,
context, prior outcome or usage is rewritten. See [ADR-039](../docs/adr/039-configurable-file-admission.md).
