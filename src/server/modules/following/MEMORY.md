# Following and shared retrieval

ADR-024, `docs/development/following.md` and `contracts/following.ts` define the
synthetic W01 increment. Migration 0013 is additive; no old source/event/scope,
publication digest or personal custody data is rewritten. `http/following.ts`
registers strict owner-derived operations only in the synthetic profile.

`subscriptions.ts` serializes operation identity then current actor, per-owner
Following advisory guard, structure and sorted source plan. The owner guard covers
absent targets. Applied no-ops and first Unfollow increment versions; tombstones
and immutable applied/conflict decisions prevent delayed resurrection. Exact retry
reports original outcome separately from current settings, with no reapplication.
Parent/child and same-name targets remain distinct. Only areas accept descendants;
discussions include opening/comments/summary, artifacts their own publications.
Closed readable targets are eligible. Known unavailable targets retain identity/
settings and allow Unfollow, with no title/path disclosure or administrator override.

Caps: 64 active definitions, 500 retained target states, 10,000 decisions per owner;
no automatic eviction. Collection pagination is stable target ID, default12/max25,
4–128 KiB complete JSON, and invalidates on collection change or process restart.
It is independent of shared traversal custody. Existing decisions remain readable
at the cap; new decisions can be refused.

`retrieval.ts` directly queries authoritative shared_activity. RR captures definitions
and committed shared clock, never a sequence maximum or a worker watermark. Fixed
ascending `(lower,upper]` intervals freeze definitions/versions. Existing continuation
keeps its definition; a changed definition cannot reuse a completed checkpoint.
New scope starts labelled retained history. No follows means empty, never implicit
community-wide scope. Explicit scope never saves a subscription.

Public typed v1/v2/v3 events are classified from exact source/revision fields. Note
presence adds a preference match, not another event. One event coalesces overlap;
eight reasons per row, bounded detail expansion for the remainder. Citing another
resource does not republish it. Internal actors are excluded; unclassified eligible
public work yields unknown coverage rather than a false checkpoint. Untyped
contributions/summaries retain their canonical owning discussion for this decision;
a missing companion row must not make a direct discussion traversal complete.
Current-context links focus opening/comment contributions only. Summary events open
their containing discussion and its current summary; exact links retain the event's
summary revision. A summary owner does not make its resource a contribution branch.

Area scopes are immutable nearest-first event-time facts. Structural matching uses
before/after scopes and new affected_target_ids. `structural-facts.ts` collects at
most500 subtree areas/5000 directly owned discussions/artifacts while organization
holds its exclusive structure guard, before the shared clock tail. Pre-0013 area
events retain NULL impacts; possible unknown descendant effects prevent completion.
Never reconstruct old impacts from current ancestry. Structural rows have no revision.

Each page/detail/replay locks current actor/credential, complete sorted resource plan
and exact revisions. Include all five resource kinds when guarding structural events;
lockContext's default is content-only. Current metadata is resolved separately by
`context.ts`; a hidden current title is null, not an older title. Discussion ownership
suppresses replies, while a suppressed parent comment alone does not. RR serialization
conflicts require explicit retry; 2.5s SQL/1.5s lock/15s transaction deadlines bound work.

Shared AES-GCM purpose/AAD, key and epoch belong only to shared_retrieval_state.
Descriptors are self-contained, <=16 KiB, <=64 compact definitions; traversals expire
at24h, checkpoints have no automatic expiry. Ordinary restart preserves them.
Personal tokens/key/positions remain independent. Renewal preserves the fixed view.
Visibility invalidation precedes preference filters and replay reaches behind completed
lower bounds. A nonzero retained floor prevents replay claiming full retained history:
explicit resynchronization creates an incomplete new baseline and current inventory
routes. Epoch mismatch refuses continuity. No pruning/restore/rotation operation exists.

Scan 100 candidates; return 12 by default, at most 25; serialize entire 4–128 KiB UTF-8 JSON;
no raw scanned positions/population counts. An oversized first item errors without
skipping. Separate page exhaustion, eligible interval completion, unknown coverage,
no subscriptions and baseline establishment. Inventory is bounded source browsing,
not search; it may change during paging and cannot reconstruct expired history.

Browser `Following.tsx` uses existing sequenced intent storage plus short per-target
Web Locks, never across network work. Unfollow uses retained settings independently
of incomplete preference edits. `SharedChanges.tsx` keeps controls stable while keying
results by owner/scope to fence late requests and StrictMode remounts. `shared-recovery.ts`
saves displayed token/budgets before exposing successor; renewal preserves those
item/byte budgets. Previous_request remains
recoverable on failed writes. One page/eight back requests,16 views/32 KiB each/512 KiB
total/100 recent IDs, with no silent eviction. Sign-out fences identity before cleanup.
Following row metadata follows its control's newer lookup/decision: an unavailable
source must withdraw the cached row title/path even before membership is refreshed.
An explicit collection refresh also adopts editor settings/version and fences older
lookups without remounting controls. A control's own reported policy placeholder is
feedback, not a successful refresh that can clear its authentication error.
The native shared-changes-client fsyncs a separate0600 journal; next uses its exact
saved successor even when resized. Build before native API/browser tests.

`tests/integration/following*.test.ts`, `tests/web/following.test.tsx` and
`tests/e2e/following.spec.ts` cover these boundaries with owned synthetic resources.
See task evidence for observed commands/failures. Grouping, combined checkpoints,
mutes/dismissal and read state are W02/future work; no production, human usability,
provider-agent or cross-machine acceptance is implied.
