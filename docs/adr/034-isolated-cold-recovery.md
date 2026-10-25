# ADR-034: Coordinated local cold backup and isolated recovery

Status: implementation decision for same-release synthetic rehearsals, 25 October
2026. OPS-04/AC18 are exercised locally; production operational acceptance remains
open. Product/architecture snapshots and applied migrations are unchanged.

## Consistency and ownership

Use a deliberately stopped installation, created exclusively by `scripts/recovery.mjs`.
An explicit external private instance directory identifies UUID-named containers,
volumes and a dedicated bridge, with matching per-attempt ownership labels. There
is no default instance, Compose project, environment file, bucket or volume. The
normal development stack cannot be selected. Cleanup checks each resource label
before removal; failed preflight creates no destination resources. The only host
port is HTTPS bound to loopback. PostgreSQL and S3 have no host port; runtime and
provider maintenance clients share that installation's network namespace at
127.0.0.1. Container roots are read-only, with explicit transient tmpfs mounts.

The runtime owns the real compiled API and three compiled derived workers. SIGTERM
stops API admission and drains handlers, including transfers and explicit cleanup,
then terminates and waits for workers. A nonzero exit refuses capture. Reject other
database connections, nondefault tablespaces, extra network members, unexpected
writable provider mounts and other volume consumers. Inventory is taken after
runtime drain. Stop PostgreSQL and the complete SeaweedFS mini process with SIGINT;
require clean exits, no OOM and PostgreSQL `pg_controldata` state `shut down` before
copying either volume. No publication transaction is held across native IO.

Successful capture leaves the source stopped. A failure can leave a partially
stopped attempt, with no completed backup. Restart is an explicit
maintainer command, never an automatic finally action. A stopped installation has
no live-copy consistency claim. This cooperative local ownership boundary assumes
a trusted Docker/host operator; it cannot fence a hostile operator using Docker
exec or mounting volumes concurrently. Reconsider for multiple API supervisors,
external storage metadata services, tablespaces or an online backup requirement.

## Native identity, contents and compatibility

Capture the entire `/var/lib/postgresql` volume, including catalog/schema/data,
roles/verifiers, WAL and migration history, and the entire SeaweedFS `/data` volume.
This is a physical, same-platform copy; it is not S3 download/re-upload. Restored
native version identifiers remain unchanged. No latest-version substitution,
publication replay or immutable-reference rewrite repairs missing bytes.

The actual pinned SeaweedFS mini reports 4.48 / `530be3e37`. Its
[pinned implementation](https://github.com/seaweedfs/seaweedfs/blob/530be3e37/weed/command/mini.go)
persists configuration, local key material and multiple component stores beneath
its data directory. Capturing a bucket's current objects alone is insufficient.
Read-only root and explicit mounts constrain persistence, rather than assuming
that an arbitrary existing installation uses the same paths. Master metadata,
filer metadata, native volumes/indexes, bucket/versioning metadata, mini options,
admin/worker state and `.mini_*` keys travel together. Native tests require every
listed version's exact bytes, plus every final version referenced by retained
file contexts, including historical, suppressed and promoted contexts.

The encrypted version-1 manifest includes backup ID, source instance and managed
attempt identity, boundary time, consistency method, Git revision, hashes of actual
compiled release assets/tooling and lockfile, immutable provider/runtime image
pins, Docker platform, complete migration filenames/checksums, table inventories,
native version inventories and component ciphertext/plaintext SHA-256 digests.
Restoration requires the exact release and platform, not merely an equal migration
count. It uses the checkout's release binaries; no source data volume is consulted.
Provider or runtime upgrades require a separately tested compatibility decision.

Every non-system database table is captured and inventoried; unknown new tables
default to authoritative. This includes identities/authority, immutable revisions,
attribution/manifests, original outcomes and conflicts, private positive/negative
versions and terminal note identities, notification claims/signals/delivery clocks,
shared clocks, recovery epochs/checkpoints, custody and persisted token keys.
Search and file-text jobs/documents/state and notification jobs/heads/gaps are
captured derived state. Notification state is mixed: progress/heartbeat may advance,
while its persisted cursor key, recovery epoch and visibility fence are compared
separately. Nothing is discarded or reset. Workers resume their existing fenced
protocols; no general rebuild or new retry policy is introduced.

HTTP admissions, in-flight IO, processes, process-local cursors, ephemeral rate
windows and browser journals are not server backup state. New reference traversals
receive new short-lived traversal expiry; persisted upload, preparation, session
and editing-notice deadlines remain their original database timestamps.

## Encryption, validation and quarantine

Use installed GnuPG symmetric AES256 with its integrity-protected format, separate
random fixture key files, no passphrase argv/environment and no symmetric-key cache.
Do not invent encryption. All instance/backup/temporary directories are private,
outside the repository; keys are outside instance and backup directories. Encrypted
configuration retains database/storage credentials, fixture bootstrap/recovery
proofs and fixture TLS custody. PostgreSQL and SeaweedFS persisted keys are in the
physical captures. Separate client credentials and independently authored HTTPS
expectations remain private fixture custody; never upload any of these materials.

Each component is encrypted, decrypted and hash-checked before publishing the last
`COMPLETED.json` marker. Restore decrypts/authenticates the manifest, validates the
release/schema/platform and every component, then normalizes both archives before
creating the destination. Python's standard tar library rejects traversal/absolute
paths, aliases, links, special files/modes, sparse files, duplicate paths and
oversized archives; it emits only regular USTAR files/directories for extraction
into new empty volumes. No archive is extracted onto the host. Existing destination
directories/resources and overlap with either the backup or original source path
are refused.

Destinations receive new containers, volumes, bridge, origin and process state.
Initial status is quarantined. Full database-row/native-version inventory equality
establishes physical restoration integrity, not application usability. A separate
verify command requires independently captured authenticated HTTPS expectations
for the original instance. It checks exact reads/downloads, original/current private
outcomes, exact retries and unchanged full inventories before publishing VERIFIED.
Only request IDs and a new reference traversal's ephemeral TTL are excluded from
response equality. No persisted expiry is excluded. Failures stop the verifier API
and leave a failed quarantine status, with no success marker. Source processes must
be stopped/absent; the native and browser rehearsals remove source containers,
volumes and network entirely before restoring. The verifier namespace has only
destination provider loopback endpoints and no source volumes or Docker socket.

Normal exceptions remove temporary plaintext. A killed host process may leave
private scratch directories and an instance operation lock; preserve evidence,
check exact owned resources, and perform explicit cleanup. Do not sweep unrelated
temporary paths or remove locks while a controller is running. An interrupted
backup without COMPLETED cannot restore; a partial destination cannot become a
verified installation. Diagnostics contain fixed stages/indexes and safe counts,
never provider errors, SQL, credentials, object capabilities or private prose.

## Disaster rollback is a separate gate

This restores a historical isolated snapshot. It never adopts existing browser
journals, reconnects existing clients, reuses a live origin, switches traffic or
claims continuity with a newer running service. The fixture deliberately deletes
a note, revokes a credential and publishes an artifact after backup; those changes
are absent after restore. The earlier note and credential are present in the
snapshot. Later consumed checkpoints and operation outcomes can likewise be absent.
An absent operation record means uncertainty, not evidence of original failure.

Production cutover, post-backup revocation/deletion reconciliation, same-instance
rollback fencing, retention/erasure, key rotation/custody approval and recovery
objectives remain separate gates. Ordinary restart, a new timestamp or clearing
recovery records would not close them. These commands never clear those records.

## Acceptance evidence

Normal native coverage includes `test:recovery:postgres`; normal Chromium inventory
includes `recovery.spec.ts`. Fixtures use actual authenticated HTTPS, PostgreSQL and
the pinned native SeaweedFS, without fixture-only HTTP routes. Independently captured
expectations cover nested/history/file/promotion/coverage/reference/private and
exact operation behavior. Full table/version equality complements these targeted
application assertions. Faults exercise incomplete capture, interrupted restore,
missing/corrupt components, wrong/missing keys, incompatible manifest/schema,
existing destinations and a missing exact native version with another version
still present. Archive attacks are in the normal bootstrap suite.

Actual commands and results are reported separately. Passing this local rehearsal
does not repair the previously observed storage-recreation intermittency, certify
a managed provider or complete the production operational acceptance gate.
