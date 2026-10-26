# Maintainer recovery tooling

`recovery.mjs` / `lib/recovery*.mjs` implement ADR-034's same-release, same-platform
synthetic cold recovery. They never read `.env.local` or select Compose/dev resources.
Explicit private external directories identify generated attempts; Docker ownership
labels must match before mutation/cleanup. All provider persistence is in known
named volumes with read-only roots, explicit transient tmpfs, one private bridge,
and only a loopback HTTPS port. Runtime/PG use the S3 anchor's network namespace;
local-only FileStorage validation stays intact. Freeze the allocated HTTPS port
before identity initialization because Docker changes ephemeral mappings on start.

Drain the managed API/transfers/cleanup and all three workers, reject other DB
connections/tablespaces/volume consumers, stop both providers cleanly, and require
pg_controldata shut-down state before copying. Inventory every non-system table and
every native version; check required final versions against retained file contexts.
Never re-upload versions or substitute latest. Capture whole PG and SeaweedFS data
including native metadata, mini options/local keys and migration history.

GnuPG AES256 protects components and manifest; its passphrase uses stdin, with a
separate private random key. Backup files/plaintext/expectations never belong in
the repository or approved CI artifacts. Fixed diagnostics cannot include raw
provider/SQL/GPG errors. Completion is last, after integrity checks; source restart
is explicit. `recovery-archive.py` uses stdlib tar validation and re-emits ordinary
USTAR before new-volume extraction, rejecting links and unsafe paths/types/modes.
`recovery-bundle.mjs` shares capture's final admission with inspection/restore.
The unchanged 1 GiB ceiling bounds payload, raw/normalized tar and ciphertext
separately; headers/padding/encryption overhead consume that representation's
allowance. JSON stays capped at 16 MiB. Completion follows the reader's actual
decryption, hash, metadata and archive admission, not only an encryption roundtrip.
Internal test ceilings may tighten the configured bound, never raise it; no CLI
or environment override selects a different runtime policy.

Restore preflight precedes destination creation; directories/resources must be new.
Restoration inventory equality establishes quarantine integrity, not usability.
Separate HTTPS verification compares independent private expectations and every
table/version before VERIFIED. ADR-038 permits bounded ordinary/control charges
from its own authenticated requests: compare participant/category counts and legal
window expiry within observed DB time. ADR-040's observational ring/capture rows are
also captured exactly; after initial exact restore, `recovery-observations.mjs`
permits only samples correlated to the verifier's actual response UUID/family/code/
status, bounded slot replacement and expired samples. Graceful API close drains its
collector before comparison, then the verified API restarts without workers.
VERIFIED.json records the allowlisted verifier observations. Publication counts,
policy/decisions and all other prior state stay exact; no domain table is exempt.
Do not skip admission or reset counters to make verification pass. Notification recovery keys/epochs/visibility are
authoritative inside mixed progress state. All tables are captured; only known
derived state may advance when unchanged compiled workers resume. Do not clear
private fences, clock/notification identities, outcomes or recovery custody.

The native suite is auto-selected by coverage's `test:*:postgres` discovery. The
compiled-browser test has its own explicit diagnostic inventory entry; preserve
deadlines/retries/concurrency and context-before-provider teardown. Provider test
helpers elsewhere use their own distinct disposable ownership conventions.

This is isolated snapshot recovery, never live rollback/cutover or journal adoption.
Later revocations/deletions/outcomes/checkpoints can be absent; absence is uncertain.
Production backup/retention/reconciliation and earlier storage intermittency remain
separate. An interrupted host can leave owner-private scratch/locks; cleanup must
prove attempt ownership and never sweep unrelated resources.

`administration-client.mjs` is an independent HTTPS read example (ADR-035), with
private bounded credential-file admission, exclusive0600 output and one page per
invocation. Canonical UUID scope/owner checks bind --after-page to the prior output; current server
authority remains decisive. It sends no mutations and imports no server internals.

`file-artifacts-client.mjs` guide21 adds list-files/reference-target/referenced-by
using existing contextual IDs/path and bounded cursor outputs. It remains an independent
HTTPS client; no server imports, automatic format upgrades, credentials in journals or
implicit download. Existing prepare/send/status/lost-response actions retain v4 intent.

Parallel verification (ADR-037) is owned by `lib/coverage/MEMORY.md` and
`coverage-ci.mjs`. The original local coverage command stays sequential; hosted
jobs use isolated workspaces and a shared validated numeric evidence protocol.
Never rebuild or replace browser diagnostics in a checkout running collection.

Guide22 participation throttling: `participation-client.mjs` keeps the exact private
journal on `temporarily_throttled`, prints caller-safe wait guidance, and `status`
does not add an ordinary content fetch. Never loop/re-key after this response.
Saved/file examples accept guide22 without changing their prior contracts.

Guide23 extends file-artifacts-client with own/admin limits and bounded audit output,
file.policy prepare/send/status/lost-response, and upload admit/lost-admission-response.
The latter stops before bytes and rejects policy/publication journals before command
dispatch; later send uses the same fsynced metadata and supplied bytes.
Recovery captures policy/decisions and rejects new admissions under exhaustion
without relaxing authoritative inventory equality or the PR29 charge allowance.

`operational-health-client.mjs` (guide24/ADR-040) independently inspects one bounded
health/outcome/job-failure page through HTTPS, with private input/output and current
administrator authority on each invocation. `--after-page` binds origin/owner/collection;
outputs never carry credentials. It imports no server internals and sends no mutations.
