# ADR-013: Private Saved items with versioned desired state

Status: implemented for the opt-in synthetic profile. This expands only the bookmark
part of architecture ADR-013. Notes, read receipts, subscriptions, personal activity,
notification state and production retention remain open.

## Targets and ownership

ATT-16, IDN-01/04, API-02/05/07 and SEC-01/03/09 require one durable private collection
per participant, equivalent through cookie and bearer clients. The owner is always
the authenticated principal; there is no owner parameter or administrator override.
Infrastructure and authorized credential recovery remain trusted powers, not a
promise of cryptographic secrecy from the deployment owner.

`discussion`, `contribution` (including opening contributions), and `artifact` targets
follow stable resources. A `revision` target pins a retained contribution/artifact
revision. Discussions have no independent revision: pin their opening contribution's
revision instead. Areas, files, summaries and private notes are unsupported targets.
Target kind is part of identity. An opening contribution and its discussion are
distinct saves; a resource save and exact R1 save remain distinct after R2.

Resource metadata opens the currently eligible revision. On an unsaved-to-saved
transition the server records its selected revision as `observed_revision_id`;
for a discussion this is its opening contribution's revision. The UI says **Revision
current when saved**, not that the participant read it. Repeating Save on an already
saved target keeps that reference. Exact bookmarks never move to a newer revision.

Migration `0005_saved_items.sql` adds private collections, versioned target rows and
immutable operation decisions. `UNIQUE NULLS NOT DISTINCT` enforces owner/kind/
resource/exact-revision uniqueness. Composite revision FKs and the target-membership
trigger enforce logical type, owning resource, and discussion-opening membership.
Column grants prevent the application from changing target/owner identity or deleting
tombstones/outcomes. Applied migrations and imported snapshots remain unchanged.

## Concurrency and recovery

Commands explicitly request `saved=true|false`, with `expected_version` and a UUID
`idempotency_key`. An initially absent target reads as unsaved version **0**, without
writing a row. Every accepted command advances its target version, even an explicit
Unsave at version 0 or Save on an already saved target. Thus an Unsave creates a
tombstone, and a delayed Save expecting 0 cannot silently reverse it. No browser
timestamp, server wall clock, UUID sort order or uniqueness constraint orders intent.

Each command takes the existing scoped attempt mutex, rechecks participant/credential
authority, then takes an exclusive owner-specific bookmark guard. It resolves any
retained exact attempt before checking a new version precondition. New commands
validate source eligibility (except Unsave of a known owner target), enforce quotas,
compare versions, and atomically retain an `applied` or `version_conflict` decision.
Two simultaneous different keys at the same version yield one applied decision and
one conflict; duplicate requests with the same key converge on the same decision.
Both success and conflict are retained so lost conflict acknowledgements are also
reconcilable. A conflict does not change membership or target version.

`saved-state-v1` hashes the fixed operation kind, canonical target, desired boolean
and expected version. UUIDs are lowercase; credentials, JSON key ordering and the
operation key are excluded. Reusing a key with changed semantic input is HTTP 409
`idempotency_conflict`. A new deliberate decision needs a fresh key and current
version, after resolving earlier uncertainty. No implicit rebase or toggle exists.

The closed decision response separates `outcome` (original desired state, expected
version and result version) from `current` (the current bookmark state and freshly
authorized metadata). HTTP 200 confirms a recorded protocol decision; clients must
inspect `operation_state=applied|version_conflict`, not treat every 200 as an applied
Save. Save K1 at v0, Unsave K2 at v1, retry K1 returns applied/true/v1 in `outcome` and
unsaved/v2 in `current`. It never reexecutes K1. Read-only status has the same result
or `not_recorded`, which remains uncertainty rather than proof of rollback.

Actor/credential state is checked on every operation. Known private outcomes can
still disclose their owner's original target IDs after source suppression; current
source metadata cannot. This differs deliberately from shared publication status,
whose references require source reading eligibility. No shared publication rule is
relaxed. Bookmark transactions do not use the shared clock, publication outcome
table, event tail, outbox, notifications, search indexing or reading state.

## Retrieval and availability

The owner collection guard is shared for lookup/list/status, exclusive for updates.
Lists order by the stable private target-row UUID, not time or importance. Index-backed
selection fetches at most requested size + 1 rows (maximum 26), resolving at most 25
sources, each supporting at most 32 resources in its owning chain. A bounded
33-row discovery detects and rejects a deeper chain before locking its resource
rows. The existing structure/row guards retain current authorization
through response construction; a request beginning after committed suppression cannot
read previously cached source metadata. Already delivered copies cannot be recalled.

Pages default to 12, maximum 25, with serialized UTF-8 JSON budget 4,096–131,072 bytes.
The service reserves continuation space and checks final serialized size; a too-small
budget is an error, never a skipped target. Lookups and decisions obey the hard byte
cap too. Metadata contains no text bodies; source exact-body links retain their normal
bounded retrieval contracts.

Every applied command increments an owner collection version. Encrypted process-local
cursors bind owner, collection version and position. A changed collection returns
HTTP 409 `saved_collection_changed`, requiring a fresh traversal. Rejected commands
do not change that version. Source edits/suppression do not change private membership:
later pages reauthorize metadata. Limit/budget may change between pages. Restart
invalidates cursors (`invalid_cursor`), but not bookmark state or retry identities.
This chooses explicit restart over silently missing saves inserted before the cursor;
it is a bounded collection traversal, not an activity checkpoint or historical snapshot.

Known saved references survive unavailable current revisions, suppressed resources and
logical removal as `{source:{state:"unavailable"}}`, with only the owner's target and
private saved/version fields. No cached title, author, body, path or newer revision is
replayed. Unsave needs ownership, not source access. A fresh unknown inaccessible target
uses the same unavailable response as a nonexistent target. Saving never grants access,
extends source retention, or retargets an exact revision.

## Synthetic retention and reconsideration

The candidate limit is **500 retained targets** (including unsaved tombstones) and
**10,000 retained decisions per participant**, independent of credential or role.
Counts and quota checks serialize with updates. At a limit, a new bounded mutation
fails with `saved_limit_reached`; exact retry/status and reads still work. Target-limit
exhaustion still permits changes to existing targets; operation-limit exhaustion
requires reviewing the synthetic retention gate before more mutations, including Unsave.
No automatic eviction, key expiry, target-version reset or cleanup endpoint exists.

Sign-out, credential replacement and ordinary client/server restart do not delete
PostgreSQL bookmarks. Browser recovery is separately bounded and cleared as described
in [ADR-017](017-browser-participation-recovery.md). Logical suppression/removal is
tested. Physical erasure, FK/tombstone handling, destructive restore, recovery epochs,
multi-process cursor-key custody and retained-data migration remain subject to the
[operating gate](../development/retained-data-gate.md). Existing restrictive source
retention must be reconciled with an approved erasure procedure before real data.

Reconsider owner serialization, quotas, cursor invalidation and storage retention when
measured workload or approved multi-process/real-participant requirements demand it;
any replacement must retain owner isolation, stale-command rejection and distinct
original/current outcomes. Production limits are not approved by synthetic tests.
See [the executable guide and trial](../development/saved-items.md) and
[verification evidence](../development/saved-items-evidence.md).
