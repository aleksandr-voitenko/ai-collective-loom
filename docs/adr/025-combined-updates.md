# ADR-025: Bound combined Updates

Status: local synthetic implementation contract. The 17 October 2026 attached
implementation brief governs this task; product v0.9 remains authoritative.
Related decisions: ADR-006/016/017/021/022/023/024; Lore LC-20261016-82ZK,
LC-20261016-A66W, LC-20261016-V1H5 and LC-20261016-T9G8.

## Identity, scope and coverage

`combined-updates-1` represents existing shared events and recipient deliveries.
A source is one exact publication (or one structural event). A personal signal has
its own delivery identity and up to three field-specific reasons. An activity group
is a retrieval representation, never an authored resource. Publication, signal and
delivery identities and both existing contracts remain unchanged.

The default is the union of captured Following definitions and eligible personal
deliveries. An explicit area/discussion/artifact scope substitutes for Following;
personal-only selection uses no shared definitions. Personal reasons are all,
mention or reply. Empty Following still includes personal attention. A signal does
not subscribe the reader or include unrelated changes from its discussion.

Use separate shared and personal `(lower, upper]` positions, captured together with
definitions, both custody epochs and visibility generations in one REPEATABLE READ
transaction under actor/credential and Following guards. Neither position orders
the other. An absent personal clock means the established empty stream at zero,
not the current shared position. Pending/unknown projection is reported separately
from retrieval of already available deliveries. No standalone cursor is adopted.

## Bounded preparation and stable groups

Prepare at most 100 shared and 100 personal candidates per request. Return explicit
`preparing` coverage and a forward continuation until both scans finish. Persist
only source/event/delivery identities, ownership keys and immutable ordering facts;
never source bodies, titles or excerpts. Retry upserts the same identities. A failed
component rolls back the whole request. No success checkpoint substitutes an
observed maximum for an unfinished scan.

Contribution/opening/summary publications belong to their discussion; artifacts
belong to themselves. Discussion/artifact moves join that affected identity. Area
organization events each remain one structural notice, including ancestor impacts.
Citation reachability never changes ownership or creates events. Coalescing a shared
event and its delivery preserves both identities, triggering revision and reasons.
An older source newly delivered in this interval is not counted as a shared change.

After preparation, freeze group order: direct-bearing groups first, then descending
latest publication/availability timestamp, then kind and resource/event UUID. These
timestamps order display only. Members similarly put direct sources first, then
display time and event UUID. Membership/order never recomputes from a live MIN/MAX.
Both visibility generations are checked before ordinary selectors on every request.
Any change requires explicit retained-history replay, including suppression of the
ordering event. This conservative invalidation is chosen over silently moving keys.
Current account, owners, sources and exact revisions are still guarded on retrieval;
frozen references are not grants. Current titles/paths can change independently.

Highlights includes every direct-bearing group and the first three routine groups,
with bounded pagination. A direct-only group/member selection provides a bounded
path to additional signals. Complete selection retains exactly the original scope,
definitions, reason and two intervals, restarting group pagination. It does not adopt
later Following settings or arrivals. Newer activity is a separate checkpoint query.

Counts name unique shared events, source records, reply publications, reply revisions,
summary publications/revisions, artifact publications/revisions, structural events
and personal signals. Two reasons are one signal. Group count is not event count.
Only completely prepared and currently authorized groups have exact counts; failed
counts fail the request. Preparation exposes no partial or hidden totals.
When retained shared facts are unknown, ready groups label their counts
`known_sources_only`, never exact totals for the potentially incomplete history.

Page end, highlights exhaustion, all-groups coverage, complete member metadata,
full bodies and reading are distinct. Only exhausted complete grouped metadata
with known component coverage produces a combined checkpoint; opening each group
is not required. Its coverage explicitly omits member detail and bodies. A separate
complete-record traversal, and independently paged group/all/direct members, retain
the same bounds. Full exact bodies stay on existing routes. Highlights cannot emit
a completion checkpoint even if its selection happens to contain every group.

## Explanations and current authority

Select one deterministic attributed link: an included revision-owned note first,
otherwise an ordinary account explicitly describing an included exact revision.
Account publication must not exceed the shared upper bound. Select by immutable
publication position then UUID, reauthorize its owner and exact revision, and expose
only authorized included coverage. An account remains Bob's contribution; it does
not become Alice's artifact event or editor note. A note explains only its owning
revision. No opening, current summary timestamp, model inference or latest note is
substituted. Current summary coverage is not computed by these cards and is not
claimed current. Independent prose follows its own owner; target previews follow
target access. Absent/unavailable explanations fall back to change counts.

Use existing shared classification, matching and source projection plus personal
reason/source policy internally in one transaction, never HTTP calls to our own
server. Complete sorted resource/owner and exact-revision guards precede reads;
no retrieval mutates publication/delivery clocks or acquires their tail locks.

## Custody, recovery and bounds

New independent AES-GCM purpose/key/epoch; both underlying epochs remain bound.
Tokens are at most 16 KiB, traversal lifetime 24 hours, grouping custody seven days
from creation (renewal cannot extend that ceiling). Checkpoints are self-contained
and have no automatic expiry. Renewal preserves displayed group/member position
and budgets. Missing grouping state, descriptor expiry, component history gaps,
unknown historical facts and epoch mismatch are distinct refusals.

Replay starts both streams at retained history, before completed lower bounds,
under the captured definitions. A nonzero component floor prevents full replay.
Explicit resynchronization establishes an incomplete new baseline, names each
component gap and links existing authorized inventories; it never reconstructs
missing ancestry or personal eligibility from current state. Changed Following
cannot silently reuse a completed checkpoint. Existing v1/v2/v3 documents, digests,
uncertain drafts, standalone tokens and journals remain supported.

Synthetic caps: 2,000 represented sources/view, 500/group, 256 groups/view, 1,000
preparation requests/view, 16 retained views/owner, 128 global views. Cleanup deletes
one expired view and at most 2,000 members/256 groups per creation, then enforces
the caps; no live view is evicted. Storage is at most 256,000 identity rows plus
32,768 group rows and 128 bounded headers. Requests return default 12/max 25 groups
or members, at most two direct previews/card, and complete JSON 4–128 KiB. Complete
guard plans retain the existing 3,840 resources/32 owners limit. SQL 2.5s, lock 1.5s,
transaction 15s; capacity/work errors offer narrower scope or retry without progress.
Measurements belong in task evidence, not a production-capacity claim.

Migration 0015 adds a writable custody serialization row, independent of both source
clocks and token keys. Creation updates it before cleanup/counting and source guards.
Under REPEATABLE READ, a concurrent committed creation forces an older snapshot to
retry; an advisory mutex alone cannot refresh its quota count. No changes to applied
migration 0014 or existing grouping/token state are required.

Browser and native clients save displayed request/budgets and expansion separately
from successors before showing progress. One group expansion and one overview page
bound the DOM. Local recovery stores no source bodies and uses origin/instance/owner,
Web Locks/sequence fencing and at most 16 views/512 KiB. Failed storage keeps the
prior recoverable request. Policy errors withdraw cached metadata; transport errors
retain permitted context and retry. Sign-out fences identity before cleanup and
clears only Updates recovery in addition to existing independently owned cleanup.
After a member authority race withdraws cached metadata, retry reauthorizes the
overview before fetching the attempted expansion. The last displayed expansion
stays recoverable until the replacement detail response is authorized and saved.

The standalone Node 24 client holds an exclusive transaction through built-in
SQLite solely as an OS-backed journal mutex. Its private `.lock.sqlite` sidecar
contains no source or recovery data and stays on disk: removing an open lock file
could split ownership across inodes. Process death releases the lock without stale
PID guessing or an extra native dependency. All clients sharing a journal must use
this protocol. A legacy `.lock` has no verifiable owner and is refused with explicit
instructions; it is never automatically deleted. The JSON journal and its fsynced
atomic replacement protocol remain unchanged.

Alternatives rejected: grouping the first raw page loses busy-group members;
timestamp cursors lose delayed deliveries; live ordering keys skip groups after
suppression; copying standalone tokens cannot capture coherent paired boundaries;
unbounded aggregate/body scans violate bounded work. A finite preparation is a
retrieval mechanism, not a worker, task system or inbox claim. Reconsider when measured
workloads exceed these caps, new source kinds arrive, or retention/restore policy is
approved. Read state, mute/dismissal, files/private notes, agent execution and full
moderation/production/human/provider/cross-machine acceptance remain open.
