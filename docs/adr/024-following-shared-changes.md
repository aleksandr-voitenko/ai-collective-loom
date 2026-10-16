# ADR-024: Following and complete retained shared changes

Status: implementation contract for one local synthetic increment. The 16 October
2026 Following handoff is the task brief. Product v0.9 governs; W01 shared retrieval
does not close W02 grouped Updates, personal/shared composition or attention controls.
Relevant history: LC-20261012-6OTQ, LC-20261014-OIAD, LC-20261014-IGI9,
LC-20261014-S0JX and LC-20261016-V1H5. No living requirements inventory was supplied
in this checkout; report W01 and product requirement portions in task evidence.

## Private definitions and decisions

One participant/kind/resource identity addresses an area, discussion or artifact.
Area descendants are explicit; other kinds require false. Preferences distinguish
new discussions, opening edits, replies (including revisions), artifact publications,
summaries, revision-owned change notes and structural changes. A revision with a
note remains one event. Direct discussion coverage includes its opening, comments
and summary; citing an artifact does not include that artifact's publications.

Follow and Unfollow are desired-state commands with expected version and immutable
operation decisions. Version zero is absent. Every accepted command increments the
target and collection version, including no-ops and first Unfollow. Retain tombstones
and original applied/conflict outcomes; replay never reapplies an old operation.
Changed target/settings/precondition under a key conflicts. Authentication supplies
the owner, with no administrator override. Known unavailable targets retain only
owner-safe identity/settings and permit Unfollow. Closed targets remain readable.

Reuse the Saved attempt/owner serialization pattern, independently of Saved state.
Bound retained target states at 500, active definitions at 64 and decisions at 10,000
per participant. Reads and exact recovery work at the cap. No expiry or pruning is
introduced. Browser intent uses the existing Web-Locked, sequenced journal before
dispatch, preserving unrelated records and an uncertain operation's original key.

## Events and historical facts

Query authoritative committed shared_activity directly; no worker or projection
stands between a committed publication and retrieval. Position is unique and orders
events ascending. Capture definitions and community_clocks.shared_position in one
REPEATABLE READ snapshot. Never use sequence maxima, timestamps, SKIP LOCKED or a
transaction spanning requests. New ordinary publications belong to later intervals.

Publication area_scope_ids is nearest canonical area first, then ancestors. Match
area-only against the first ID and descendants against the retained array. Structural
before/after arrays retain their original meaning: an area event includes itself,
then its parent/ancestors. An area-only subscription matches the changed area or its
immediate before/after parent; descendants match either full scope. A direct target,
or a followed area moved by an ancestor operation, also matches retained impact IDs.

Add bounded synchronous structural impacts before treating ancestor effects as
known: collect at most 500 subtree areas and 5,000 directly owned discussions/artifacts
under the existing exclusive structure guard, before the clock tail. Append IDs as
immutable facts with the structural event; they are not grants or new publications.
No newly contested resource guard follows the clock. Pre-migration structural events
retain NULL impacts. Their explicit scopes and source identity still match; possible
unrecorded descendant impacts make coverage unknown. Do not reconstruct them from
current ancestry. This is a retained-fact limitation, not permission to discard old
events. All retained typed v1/v2/v3 publications and summary/note revisions participate.
Internal text/plain fixtures are explicitly outside this population. Unknown potentially
relevant public kinds/formats prevent a complete-interval claim and checkpoint.

## Traversal, custody and recovery

New Following or explicit single-target scope defaults to labelled retained history.
No implicit whole-community subscription and no implicit start-now choice. Freeze
target IDs, versions, descendant settings and preferences in an encrypted descriptor.
Continuations keep that definition and expose whether current Following changed.
Using a completed checkpoint with changed definitions fails explicitly; a deliberate
new retained-history traversal covers newly included older material.

Use separate database-held AES-GCM custody, purpose/version and recovery epoch.
Personal keys/tokens remain unchanged. Shared descriptors are self-contained, at
most 16 KiB, with 24-hour traversal expiry; checkpoints have no automatic expiry.
The normalized definition cap of 64 bounds descriptor size and matching work without
a server cursor registry. Page and successor tokens plus declared definitions must
fit the complete 4–128 KiB JSON budget; small budgets may require an explicit increase.
Renewal keeps fixed bounds/position. Displayed-page replay saves the original limit
and byte budget before exposing the exact successor; successor budgets may change.

Visibility invalidation precedes preferences and forces explicit replay from the
retention floor, including before completed lower bounds. Reauthorize inherited
restrictions and exact revisions; stable event IDs distinguish replay from new work.
An advanced retention floor is a history gap. Explicit resynchronization establishes
a named new baseline and supplies bounded existing source-inventory/history routes;
it never reconstructs expired events/ancestry or reading state. Inventory uses current
placement and may change while paged; restart invalidated inventory pages and use
the baseline for concurrent new events. Unknown historical coverage likewise offers
this explicit incomplete recovery, never a false completed interval. Epoch mismatch
refuses continuity. No key rotation, destructive restore or pruning command is added.

## Current authorization and independent limits

Read linearization is the RR snapshot plus current conflicting actor/resource/revision
guards. A writer committed before the snapshot is observed; a conflicting writer
committed after it causes serialization/retry or waits until the read ends. Take
actor/credential, owner definition guard, structure and complete sorted resource plan
before exact revision guards. Reads do not acquire the shared clock tail lock. Current
titles/paths are resolved separately from exact historical source metadata; a hidden
current revision is not disclosed, and missing exact text never resolves to current.
Suppressing a comment does not suppress its replies; discussion containment does.

Scan at most 100 candidates, return default 12/max 25 items, expand at most 8 reasons
per row (bounded detail paging for the remaining definitions), and guard at most
3,840 resources with 32-level owning chains. SQL 2.5s, lock waits 1.5s and transactions
15s are independent deadlines. Byte counting covers complete uncompressed UTF-8 JSON.
Never skip an oversized first entry; hidden/filtered scans advance opaque positions
without raw scanned IDs/counts. Distinguish page exhaustion, interval completion,
no subscriptions, unknown coverage, expiry and unavailable retrieval.

## Browser, clients and acceptance plan

Following lists explicit parent/child and same-name targets separately, with full
authorized paths, kind, descendants and preferences. Source controls are separate
from Save. Changes is chronological and ungrouped, with exact/context links and
secondary coverage/recovery details. Mentions/replies stays independently linked.
Freeze one displayed page, bound DOM and local recovery records, retain context on
transport/save failure, withdraw it on policy/epoch failure, and fence late route,
filter and identity responses even if abort loses. Preserve immediate sign-out
fencing before cleanup locks. No read, dismissal, task assignment or delivery effects.

Verification covers populated upgrades; equivalent human/agent
operations; absent-target/opposite-command races and lost responses; independently
expected event sets; reversed publication preparation and clock rollback; moves before
and after fixed bounds; definition changes; both authorization guard orders; restoration
behind completed checkpoints; byte/work/token/history/epoch limits; API/client restart;
compiled browser and development StrictMode; stopped workers and delayed independent
personal delivery; all existing PostgreSQL, normal browser and diagnostic suites.
Observed commands, results, synthetic measurements and earlier failures are recorded
in [task evidence](../development/following-evidence.md); these do not establish full
product acceptance.

Reconsider these synthetic bounds and conservative historical-gap handling when
authoritative older facts, larger measured workloads, new event kinds or separately
approved retention/recovery requirements become available. This increment grants no
production, human-usability, provider-agent or cross-machine acceptance.
