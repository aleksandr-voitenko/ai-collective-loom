# Combined Updates

Lore `LC-20261017-FUWG`; ADR-025, guide10, `combined-updates-1`.
Contracts in `src/contracts/updates.ts`,
additive migrations0014/0015, HTTP `http/updates.ts`. Only the opt-in synthetic profile.
No new authored resource, format, worker, read state or notification generation.
Guide11's exact private reading is separate (ADR-026); cards/member metadata and
complete fetching never mark sources read, hide read entries or change these tokens.

`CombinedUpdates` composes Following's candidate SQL/classification/matching/item
projection and personal reason/item/projection policy in one REPEATABLE READ
transaction. Authenticate first; capture Following under its owner guard; capture
both distinct committed clocks, visibility generations and epochs coherently.
Never derive personal progress from a shared position/time. Default scope is the
union, not all activity in personally mentioned discussions. Explicit shared target
substitutes for Following; personal-only removes shared input. Reason filter is bound.

Preparation scans100 candidates per stream and persists only identities/order.
Plan all candidate owners, discussion openings, actual parents, status sources and
explanations before per-source guards. Preparation returns a continuation even after
its final scan; the next group request plans the finished view separately rather
than acquiring a new contested resource plan after a partial preparation plan.
Source clocks are read, never locked/advanced by these reads. Errors rollback both
component progress and any newly created custody. Counts appear only ready; unknown shared history qualifies them as known_sources_only.

Shared event ID coalesces stream overlap while retaining delivery/signal identity,
revision and reasons. An old personally delivered source is not a new shared change.
Ownership groups openings/replies/summaries under discussion, artifacts under self,
discussion/artifact moves under the affected stable identity. Area organization
events each have their own event group; ancestor relevance is not descendant copies.
Frozen group order is direct first, latest immutable display timestamp descending,
kind/key tie; members direct first, display timestamp descending then event UUID.
Visibility changes invalidate before ordinary selection; no live authorized MAX/MIN
can move a group across a page. Exact/current-source authorization still happens on
every read. Protected count/title/source references are withheld on failure.

Highlights = all direct groups plus three routine groups, with bounded pages.
Switching selection restarts group pagination but retains scope, definitions,
reason and both lower/upper bounds. Outside explicit incomplete resynchronization,
only exhausted complete grouping with known coverage issues a checkpoint;
member details/bodies remain explicitly omitted.
Full-record metadata has a separate cursor. Member/detail pages never imply reading.
Personal reasons all fit their three-reason bound; shared match reasons page eight
via `/me/updates/reasons` using combined custody, not standalone tokens.

Select one eligible included revision note before an independent ordinary account,
ordered by immutable publication position/ID and capped at16 candidates/group.
Candidate publication cannot exceed the captured shared upper bound. Link only to
authorized owning source with publisher and eligible included exact targets.
Coverage is an author claim; neither current-summary currency nor whole-interval
explanation follows. Independent account prose keeps its own owner/authority.

Independent AES-GCM key/purpose/epoch in updates_state binds underlying epochs too.
Descriptor expiry24h; custody7 days from creation; renewal preserves displayed
position without extending custody. Missing custody, descriptor expiry, per-stream
history gaps, epoch mismatch and unknown historical facts remain distinct.
Replay explicitly restarts both streams before completed lower bounds; a nonzero
history floor prevents complete replay. Resynchronization makes an incomplete
current baseline plus existing authorized inventories, not invented retained facts.
Self-contained checkpoints do not require old grouping rows. Following changes at
a new checkpoint interval require explicit new scope; old switches remain frozen.

Caps:2000 sources/view,500/group,256 groups,1000 steps,16 views/owner,128 global.
Creation writes the migration0015 custody serialization row before cap/cleanup and
source guards. A concurrent committed creation makes an older RR snapshot retry;
an advisory mutex alone leaves stale quota counts. It deletes one expired view
only. No live-view eviction. Source/group cap needs narrower scope; full custody
needs a retained view or expiry. Default12/max25 items,2 direct previews/group,
4–128 KiB JSON,16 KiB tokens, existing3840-resource plan cap and SQL2.5s/lock1.5s/
transaction15s. These are finite synthetic bounds, not production capacity.

Browser `Updates.tsx` keeps filters outside keyed owner/scope result state. One
overview/expansion, eight back requests; `updates-recovery.ts` stores only requests
and successors with separate expansion budgets. Origin/instance/owner Web Locks,
sequence and identity fencing reject late/stale saves. Save before exposing a page;
transport errors retain permitted context, policy failures withdraw it. Sign-out
invalidates before cleanup. Explicit clearing owns only Updates records. Storage
16 records/128 KiB each/512 KiB total, with no silent eviction of other journals.
Tokenless gap recovery sends the selected scope/reason; descriptor-bound recovery
uses the frozen token. Ready unknown-history pages offer explicit resynchronization.
Browser history warnings follow component history flags across reload/newer intervals,
with retained-content links, rather than disappearing after the baseline page.
Recovery boundary rationale and regressions: `LC-20261017-5QRE`.
`scripts/updates-client.mjs` provides mode0600 atomic/fsynced HTTPS recovery,
separate overview/member positions, resizing successors and credential continuity.
Member retry reauthorizes a withdrawn overview before the attempted expansion;
interim saves retain the previous displayed detail until its successor succeeds.
Native journal ownership uses built-in Node24 SQLite BEGIN EXCLUSIVE on a private
`.lock.sqlite` sidecar. OS locks release on process death; never unlink the sidecar
and split its inode ownership. Share journals only between clients using that
protocol. Legacy `.lock` files have unknown ownership and are explicitly refused.

Tests: `integration/updates*.test.ts`, `web/updates.test.tsx`, `e2e/updates.spec.ts`.
Build before compiled API/browser checks. Use the normal browser runner; retain
approved failed diagnostics before reruns. Evidence/limits live in
`docs/development/updates-evidence.md`; synthetic trials do not close composite
product scenarios or human/provider/cross-machine and retained-data gates.

Guide12 / ADR-027 adds an explicitly separate combined-updates-2 mode and HTTP
`routine-updates` endpoints. It reuses frozen base groups but retains private
selection in migration0017 attention_views/members/groups under the attention owner
guard after Following and before custody/source guards. Selection scans100 existing
members/request, retaining independent shared/personal flags. It ranks surviving
routine groups before the three-highlight limit; direct members remain paged.
Filtered member/reason/selection reads require ready attention custody at the bound
policy version, under the base-view then selection guards. Missing, partial or old
projections return updates_attention_preparing; continue overview preparation or
explicitly attention_refresh the same interval. Complete reads remain available.
Policy mismatch requires attention_refresh over the same view/scope/definitions/
reason/intervals/order. Explicit attention refresh renews an expired descriptor
within the original custody deadline; requiring separate renewal deadlocks when
policy changed too. Selection-envelope expiry remains independent. Complete
selection and record/member paths bypass private filters; source/epoch/history
checks still precede them. Unknown coverage is inherited, never inferred away.
Version1 performs no attention-table queries, including pre0017 fixtures. Separate
AAD/contract literals prevent token reinterpretation. Browser default v2 has its own
routine-updates-pages prefix; explicit legacy mode keeps old saved views usable.
The mandatory host authorization boundary withdraws the whole visible overview/
expansion on source refusal or unavailable attention results and fences pending
reads/recovery saves. Owner refusals enter the shell identity fence. The separate
attention journal remains recoverable. A bounded attempted expansion request and
its budgets remain outside the withdrawn subtree, scoped to the same owner/filter,
so explicit retry reauthorizes the saved overview before that expansion. Page loads
capture the attention-event
generation: a response cannot clear a newer local/cross-tab policy-change notice.
Selection preparation forwards changed-policy, preparing and descriptor-expiry
errors to explicit refresh/renew recovery, retaining displayed overview/expansion
budgets and fencing an unseen successor. Expanded source controls invalidate their
pending/unconfirmed choice when the shared/personal input set changes, even with
the same event ID and no group cursor. Same-identity late attention completion still
notifies newly mounted views; sign-out/identity changes suppress that notification.
See sibling attention memory for command retention and selection envelopes.
