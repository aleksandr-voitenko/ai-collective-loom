# ADR-028: Administrator suppression and selective restoration

Status: implementation decision for the synthetic profile, 20 October 2026.
Product v0.9 §§16.4–16.5 and the administrator suppression task brief govern
behavior. This extends ADR-006/015/016/017/020/023–027 without changing baselines.

## State and operation

Support whole discussions, individual non-opening comments, whole summaries and
whole artifacts. `resources.state` remains authoritative. Add a lifecycle version
starting at 1, independent of revision, editor and organization versions. Existing
states and content remain unchanged; pre-feature suppression has no invented actor.
Restoration only changes the named resource from suppressed to active. Deleted
state, owner/child restrictions, exact revision restrictions and closure remain.

`POST /api/v1/admin/moderation/state` accepts one desired `suppressed` Boolean,
target kind/UUID, expected lifecycle version and UUID idempotency key.
`moderation-state-1` hashes every semantic field with canonical UUIDs. Attempt
identity is participant/kind/key, independent of credential. Every applied choice,
including an initial restoration/no-op, advances the lifecycle fence. A stale
version fails before effects. Changed semantics under a retained key conflict.
The recorded outcome is immutable; status and exact retry return it separately
from current control metadata and never reapply it. Resolve retained decisions
before new preconditions or capacity. Missing status and lost replies remain
uncertain. Legitimately replaced credentials can recover for the same participant.

All commands, inspection, discovery, status and audit require current active
administrator authority under the common actor/credential locks. Authors/editors
have no moderation authority. Metadata-only control inspection does not use or
weaken ordinary source access: IDs/kinds/local states/versions/owner facts and
current ordinary-read eligibility are control facts, never a body authorization.
No title, body, snippet, reference set or private collection enters these records.
Unsupported areas/openings/untyped targets fail explicitly for administrators.

## Ordering and invalidation

Attempt mutex (commands/status) → current actor and sorted credential/parent guards
→ existing structure guard → complete sorted resource plan → selected current
revision guards → writes and retained operation/audit → COMMIT.
New commands use the exclusive structure guard, reusing organization's bounded
serialization. Control reads use its shared form. The common reference plan
discovers owners and discussion openings before resource locks; the changed target
uses UPDATE, all other resources SHARE. No lock upgrade or new domain guard follows
a shared clock. Moderation does not acquire a source or delivery clock.

Publication/revision/editor changes and source reads conflict on the existing
resource guards; moves conflict on structure. Actor changes conflict before
structure. A publication either commits before suppression or subsequently fails
ordinary availability. State/version, decision, audit, and existing search,
notification and shared-retrieval visibility triggers commit or roll back together.
No new shared lifecycle event is needed. Existing filter-independent replay
reaches historical material behind completed checkpoints; source times, immutable
events, notification identities and private choices remain unchanged.

## Bounds and clients

Synthetic bounds: 4 KiB command, 32 KiB response, default 12/max 25 list entries,
100 candidates/scan, existing 32-owner/3840-resource guard plan, statement 2.5s,
lock 1.5s and transaction 15s. Lists use encrypted five-minute, 2 KiB cursors
bound to administrator, collection and lifecycle/visibility/hierarchy generation;
changes require explicit refresh. Retain at most 10,000 decisions/community
without automatic expiry or eviction. A serialized counter bounds capacity work.
Reads/status/exact retry remain usable at capacity; new restoration also requires
capacity. Review capacity before real use; these limits do not approve retention,
erasure, destructive restore or production workloads.

The browser reuses the 32-record/1 MiB origin/instance/participant journal and
short Web Locks, including canonical per-target overlap checks. Save/read back
exact bytes before dispatch; no network under storage locks. Recovery is reachable
independently of a source page, including a suppressed Community overview. Explain
containment before confirmation and separate recorded choice, current local
restriction and ordinary-read eligibility. No optimistic success or automatic
re-key/rebase. Successful receipts withdraw obsolete content before journal
settlement; neither restoration nor a late receipt grants content access.
Administrative projections retain authorization leases independently of immutable
local command custody. Reuse the mandatory boundary and endpoint catalogue.
The shared journal restores its prior bytes when a write/readback fails, preserving
an uncertain command across failed settlement; if storage itself remains unavailable,
the caller receives an explicit failure and retains its in-memory exact command.

An executable HTTPS example uses exclusive private fsynced immutable journals,
identity-bound recovery and exact saved transport fields. Ordinary process restart
does not certify cross-machine, human usability, provider-agent or disaster
recovery acceptance. Reconsider these choices when measured synthetic limits,
new target kinds or an approved retention/deployment policy require it.
