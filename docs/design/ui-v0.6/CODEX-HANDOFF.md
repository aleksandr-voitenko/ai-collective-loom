# Codex handoff — AI Collective Loom human interface v0.6

Read the repository's current AGENTS.md, required Lore modules, relevant memory, product specification, and current architecture before modifying the application. This package is a separate browser-local visual/interaction reference. It authorizes no commit, push, reset, production deployment, or change to protected baseline files.

Use v0.6 and its DESIGN-GUIDE.md together. Do not merge back the old automatic welcome or always-visible summary instructions from earlier guides. Keep the existing quiet community-name link, Updates home, content-aware topic views, explicit descendant scope, artifact library, colors, avatars, and nested replies.

## Following and artifact-location implementation targets

Replace the sidebar's truncated topic shortcuts with one **Following** destination. Implement a bounded, owner-scoped collection covering topic, discussion, and artifact subscriptions. Use stable IDs, not final path labels; show complete parent/canonical paths as ordinary visible text. Retain pagination, name/path search, type filter, stable sorting, route state, return focus, and narrow-screen access. Do not preload all subscribed resources or silently drop records after a UI limit.

For topics, expose an explicit descendant preference. New follows are direct-only in this reference; approve that default explicitly when integrating real settings. Parent and child subscriptions are independent records. A parent's subtree coverage does not erase explicit children. Removing the child is not an exclusion from the parent's subtree. Show a targeted explanation only when another subscription still supplies coverage. Undo must recreate the selected owner's removed subscription with its scope without reverting unrelated changes; the server must enforce ownership, validation, and safe retry.

A normal Follow button reflects direct membership. Broad coverage may exist without a direct child subscription. Keep this distinction clear in mutation outcomes rather than falsely claiming the child will disappear from Updates. Do not introduce automatic parent following, hidden leaf-only storage, implicit pruning, or a new topic-exclusion mechanism.

Following's **This topic only / Including subtopics** is not the same preference as browsing's **Include subtopics**. Update queries, subscription mutations, bookmarks, reading state, notification dismissal, and open drafts remain independent. An already-bound activity traversal retains its definition; subsequent traversals apply new settings. Coalesce overlapping subscription reasons at stable source/group identities without losing direct mentions/replies or creating duplicate deliveries. Implement this against actual event-time paths and the application's two-stream recovery contract, not the finite JavaScript array used here.

The dedicated page exposes simple topic scope only. Fine-grained event preferences remain a separate interface pass; “Discussion updates” and “Artifact updates” are descriptions, not hard-coded replacement event taxonomies. Avoid expanding this handoff into general notification-channel or automation management.

Artifact location columns depend on the selected query scope:

| Scope | Location presentation |
|---|---|
| One direct topic, through any route | No repeated Topic column or repeated mobile topic line. |
| Selected topic plus descendants | Relative path from that topic; “This topic” for direct items. |
| Global multi-topic browsing | Full canonical topic path. |

Keep that layout stable across search-result composition, pagination, and sorting. Retain IDs, authorized location metadata, date/contributor, exact revisions, and independent Save. Responsive changes must not lose update attribution when removing a column.

Suggested focused components: FollowingPage, SubscriptionRow, SubscriptionScope, FollowingFilters, FollowingPagination, and ArtifactLocation. These are UI responsibilities, not a new domain subsystem. Every real list or mutation is owner-bound and reauthorized; prior subscription snapshots or client-supplied owner IDs cannot grant access.

The reference keeps string keys in `state.follows` with `followSettings[key].includeDescendants` for compatibility. This is not the production database schema. Its `updatesBinding` filters finite sample rows and does not implement persistent replay, an event bus, or notification generation. Native browser storage sharing across downloaded filenames is not guaranteed; implement a reviewed, account-bound production migration rather than copying an unqualified localStorage import.

Validation targets: more than five follows; duplicate leaf names; parent followed after child; independent scope changes; inherited coverage after unfollow; Undo; unavailable/ambiguous legacy records; all three resource types; query/page/scroll/focus restoration; matching one event through several follows; direct attention with no subscriptions; scope changes after an interval is bound; artifact-location layout at direct, descendant and global scopes, including mobile/tablet.

## Topic navigation implementation targets

Use availability metadata for the whole collection, not the current result page or search results. Subtopics counts immediate children. Keep Discussions available at zero. Hide Artifacts only when no authorized artifact exists in either the current topic or its descendants; otherwise users still need access to Include subtopics. Preserve the direct-membership default.

Known-positive counts produce small chips. Known zero produces no chip. Unknown/unavailable counts also produce no numeric chip, but cannot justify hiding the view. The API can provide an explicit nonempty indicator when an exact total is unavailable; do not require an expensive full-table count for every navigation paint. All metadata is currently authorized and has a declared unit/scope; do not leak protected records through count requests.

Counts reflect the destination view's unfiltered topic scope, including an explicit saved descendant setting, not its query, format filter, or page length. Count one artifact rather than every file or revision. Reuse the selected scope and representation in UI and agent metadata rather than silently broadening the topic.

Hide the complete view strip when Discussions is the only option. Parent topics normally open Subtopics; leaves open Discussions. Stale deep links to empty optional collections normalize to a useful default without carrying unrelated filters into it. A valid explicit view/deep link remains authoritative. Never remove an already open view solely because its last item disappeared mid-session; show the empty state in place and simplify on the next navigation. This does not preserve access to newly suppressed content.

Keep creation discoverable independently: topic actions offers the first artifact draft and either New subtopic or Suggest a subtopic under actual current grants. Administrators create roots; administrators and in-scope moderators create children; other participants use the ordinary proposal-discussion route. Server-side checks, not the prototype's `topicRolePreview`, authorize every action. Recheck at submission. Editor-list management remains administrator-only and is unrelated to these actions.

The local form's 120-character name and 800-character scope limits and same-parent duplicate-name validation are prototype choices, not newly settled production limits or naming rules. Preview role controls and all fixture metadata overrides live outside production navigation. The artifact form exports text only; it does not implement uploads/publication. Preserve an honest draft status until actual publication succeeds.

Suggested small components: TopicAvailability, TopicViews, CollectionCount, TopicActions, TopicCreationForm, and the existing scoped Directory/DiscussionList/ArtifactLibrary. Do not introduce a new role or generic permission designer.

## Earlier reviewed interaction targets retained

### Summary presentation and history

Separate **authoring permission**, **retained exact summary revisions**, **current source coverage**, **quiet-period eligibility**, and **current-view presentation**. An editor may publish a snapshot during an active conversation without making it the default featured summary. A 72-hour period is a testable proposal, not proof that conversation ended or a production value silently approved by these files.

The prototype features a latest snapshot only after quiet, with full known current sources and a summary publication after that period. New opening-post/comment content or edits remove eligibility. Summary/self-note/editor/bookmark/read/subscription/reservation/structural changes do not themselves restart source activity. External sources and newer versions of exact cited artifacts do not recursively invalidate it.

Preserve exact summary history, attribution, and exact source revision links. An explicit older-summary route may reveal its authorized historical snapshot with the appropriate qualification, while the ordinary active discussion omits it. Unknown exact revisions must not fall back to another summary. An open reading session can keep its pinned snapshot with a compact changed-source notice; preserve the actual DOM anchor and do not silently replace prose.

The UI reference uses fixed date fixtures and sets held in memory. Replace them with current, authorized server metadata derived from the same source population as KNW-02. Server reads and summary publication must handle concurrent source changes, unknown or suppressed source availability, and partial scope. No current claim may be based on a timestamp alone. A maintenance/candidate query is bounded discovery, not a job assignment or model invocation. Do not add a built-in summarizing worker.

### Reply recovery

A retained uncertain attempt must keep instance, owner, operation identity, exact text, target parent, and any expected revision. Do not implement this with the reference's `state.outcomes` map. Use real authorized reconciliation and the backend's retry contract.

Show the unresolved reply beside its composer, not as a generic discussion-wide status. Use **“We couldn’t confirm whether your reply was posted.”** and **Check status**. Keep retry of the original intent separate from starting a new publication. Unsent drafts use different wording. Missing/expired/unavailable outcome is not proven failure, and a page cancellation is not rollback.

A reconnect can trigger a bounded status check. The reference models one in-flight check; choose real backoff/deadline/retention behavior in the contract, not by copying the 180ms animation delay. A late result must not open a dialog or replace another route/account. Status lookup is read-only; unchanged retry obeys current authority and retains the original key. Do not automatically re-key an uncertain attempt, even after credential rotation or local process restart.

The sample's migration retains compatible earlier demonstration state and does not rewrite prior storage keys. Real private-state retention, sign-out clearing, session ownership, and server reconstruction require the agreed security design. Never store real credentials in localStorage.

### Sorting and visual flow

Remove the visible **Order** label. Keep the accessible name **Reply order** on the select. Preserve sibling ordering within the true reply tree. Keep a visible gap between Conversation and its count. Do not add permanent warnings, empty-summary panels, or recurring prototype labels to replace removed clutter.

## Product alignment before integration

Count chips and collection-aware navigation refine the human presentation; they do not remove hierarchy, artifact support, or contribution rights. `PRODUCT-ALIGNMENT.md` states their scope and the earlier still-pending product wording changes.

`PRODUCT-ALIGNMENT.md` identifies the proposed narrow amendments. The current baseline literally names Start here, allows optional current-state summaries, and expects visible coverage qualifications; it does not prescribe the quiet-period lifecycle. The owner requested a new reference of that proposed direction, not a blanket approval of every timing/schema choice.

Record the default presentation and candidate-discovery policy explicitly. Keep normal summary creation permissions, administrator-only editor lists, immutable revisions, content-retention/suppression rules, and no model-runtime dependency. Align summary flags across human UI, API, search/Updates previews, and maintenance discovery. Do not impose a human welcome or summary acknowledgment on agent participation.

## Suggested component boundaries

Use the existing AppShell, TopicWorkspace, Directory, ArtifactLibrary, AuthorIdentity, ReplyBranch, and RecoveryComposer where appropriate. Add small equivalents of **SummaryPresentation**, **SummaryHistory**, **ExactSummaryView**, **SourceCoverageDetails**, and **PersonalReplyRecovery**. These are suggested responsibilities, not required package names or a general-purpose workflow engine.

Keep UI state separate from the authoritative operation layer. Same-resource current-query results cannot overwrite an exact pinned snapshot, and late source responses cannot advance unrelated read state. The sample single-script rerender is not the production request/caching policy.

## Verification targets

Test through real browser and direct API paths:

- Active default has no featured incomplete summary; exact history remains retrievable.
- Time alone neither generates a summary nor cures coverage gaps. Test exactly the threshold, unknown time, partial scope, source edits, and self-update exclusion.
- A new source during preparation is not retroactively covered; after another quiet period an explicit new revision can become eligible.
- New source arrival preserves the current reading anchor but removes default eligibility for subsequent visits.
- Original source/snapshot bytes and citations stay exact; unavailable revisions are never silently replaced.
- Unknown reply status retains original intent; competing retries converge; read-only reconciliation creates no publication; current ownership and authorization are enforced.
- Late status results, account/route switches, expired replay windows, manual unread, and independently saved content stay safe.
- Preserve topic pagination, descendant scope, Back restoration, artifact revisions, mentions, and keyboard/mobile navigation.

The current delivered 180 interaction checks and 96 responsive checks are listed in `tests/QA.md`; they test local fixtures only. They are not completed product AC/AV cases. Record server, storage, browser, human, and external-agent evidence separately.

## Scope still missing

Production sign-in/account management, server-authorized topic creation, artifact publication/uploads/promotion, private-note authoring, moderation, durable API pagination, and real network recovery are not implemented here. New-discussion and new-artifact composition export drafts. The topic-creation form changes local fixtures only; none of these controls invokes a backend. The `#/review` controls and synthetic clock belong outside normal production routes.
