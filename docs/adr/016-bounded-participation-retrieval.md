# ADR-016: Bounded participation retrieval

Status: implemented for `participation-1` synthetic interfaces. Search, feeds,
complete topic hierarchies and reference discovery remain separate gates.

## Choices

Every request rechecks the current actor and owning resource chain through the
same stored policy used by publication. Cookie and bearer clients receive the
same domain decision. GET never marks content read, creates an attention claim or
advances activity. Exact revision URLs retain their identity when current changes;
suppressed or removed exact/owning context is unavailable, not replaced with newer
prose. Eligible content rows contain metadata and an explicit full-content URL,
not false excerpts labelled as complete text. Revision history authorizes the
resource and its owners, then checks each revision independently. An unavailable
current revision does not hide eligible older revisions; its ID and the edit hint
are withheld. Suppressing the resource or an owner still makes history unavailable.

Pages default to 12 items, accept 1–25, and scan at most 100 candidates. Empty pages
can carry `next_cursor` and `work_budget_reached`; `complete` describes exhaustion
of this bounded query, not a transaction snapshot or product-wide completeness.
Consumers continue even when an intermediate page has no visible rows. At most
131,072 serialized UTF-8 bytes are returned; clients may request 4,096–131,072.
The next candidate is not skipped when it does not fit. A single full exact body
that exceeds a requested smaller budget fails with `response_budget_too_small`
and its measured required bytes. Every accepted body fits the maximum budget.

Children are **direct** children of the specified contribution, ordered by immutable
creation timestamp and ID, oldest first. Ancestors walk nearest parent to opening,
at most 100 links per request, and carry continuation and unavailable-parent markers.
They do not return unrelated siblings or claim to contain all discussion content.
An opening has no parent; top-level comments name the opening; nested replies name
the particular contribution answered. Migration 0004 enforces same-discussion
parentage with a composite FK, one opening and immutable application parent fields.

Reply ancestry is not ownership. An unavailable contribution remains a structural
marker in child/ancestor pages: only `resource_id` and `state: unavailable`. Its
direct-child and ancestor routes remain traversable while the authenticated actor
and every owner (discussion/area) remain eligible. This preserves access to eligible
descendants without reparenting them or disclosing the unavailable contribution's
text, title, author or revision IDs. Suppressing a discussion/area denies traversal.

`GET /contributions/:id/context` returns the eligible current revision or a minimal
marker containing `resource_id`, `state`, `discussion_id` and `parent_id`. It accepts
the same full-response byte budget. It rejects artifacts and cannot grant access to
an unavailable body or enable publication to an unavailable parent. The browser
uses the returned discussion ID to validate focused branches before displaying
reply controls. This additive route avoids changing the current/exact body endpoints'
unavailable semantics. Reconsider structural disclosure if a future privacy model
restricts contribution identity separately from the owning discussion.

Other collections use stable UUID ordering for this slice; no alphabetical,
recent-activity or relevance ordering is advertised. Revision numbers are supplied
as decimal strings, but history pages currently use UUID order. Stable keys and
explicit paging were selected over offset pages; concurrent insertions before a
cursor may require a fresh traversal. These are bounded discovery views, not a
complete catch-up feed or fixed activity interval.

Opaque AES-GCM continuations bind participant, collection and scope, hiding scanned
protected IDs. They use an ephemeral process key. Restart, tampering or a different
participant/scope returns `invalid_cursor` with `replay_view`; clients start the
view again while retaining publication intent. Deploying multiple API processes
requires a reviewed shared cursor-key/rotation design or affinity. No such topology
is claimed supported here. Destructive restore is a different unsatisfied gate.

## Configuration and discoverability

`GET /community` exposes the instance UUID, current contract/guide, candidate limits,
contacts and two explicit designations. Missing designation is `setup_incomplete`;
ineligible/suppressed/closed required target is `unavailable` with no protected ID.
The overview is an ordinary published artifact with immutable revisions and normal
administrator-managed editor lists. Its absence does not block unrelated ordinary
discussion publication. Proposal creation targets the configured ordinary area;
it does not create a topic or privileged workflow.

The small browser uses bounded pages and exact body requests. Direct-topic artifact
rows omit repeated location; the global list includes the authorized topic title.
This slice has two root areas and no area-creation/move API, so descendant browsing
and repeated-leaf hierarchical paths remain feature gates.

These choices implement architecture §§5.3, 12, 14 and the first backlog milestone.
Reconsider indexes, limits and ordering with representative workload measurements;
do not call the synthetic values approved capacity. See the
[verification evidence](../development/participation-evidence.md).
