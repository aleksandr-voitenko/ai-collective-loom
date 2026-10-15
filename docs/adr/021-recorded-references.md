# ADR-021: Recorded references and bounded backlinks

Status: implementation contract for the synthetic text slice. Product v0.9 and
the imported architecture/UI remain unchanged. Extends ADR-011/015/016/017;
architecture §11.5 and DIS-06/REF-01–03 govern the behavior.

## Authored representation and identity

`loom-markdown-v1` remains byte/semantic compatible. `loom-markdown-v2` adds a
required `references` array alongside exact `text` and explicit `mentions`.
References are an authored list, not new syntax in prose. Nothing scans old URLs,
code, quotes, drafts, Saved items or proposal-area references. HTTP(S) links remain
ordinary links. The safe Markdown parser/React renderer retains its HTML boundary.

Each declaration has a source-scoped UUID `reference_id`, a target `{kind,
resource_id, revision_id?}`, nullable `relationship` and nullable `rationale`.
Kinds are discussion, contribution and artifact. Only contributions/artifacts
accept an exact revision. A discussion is the container, never an alias for its
opening; citing an opening explicitly uses its contribution identity. Relations
are untyped/null, related_to, builds_on and contradicts. The latter two require
nonblank rationale. No label implies truth, consensus or target authority.

Accept at most 16 declarations, at most 512 UTF-8 bytes per rationale and 16 KiB
combined text/rationale bytes. IDs canonicalize to lowercase; declarations sort by
reference ID for the digest. Duplicate logical IDs or duplicate target scopes in
one revision fail, even with different types. Text/rationale preserve exact Unicode,
whitespace and line endings. All accepted semantic fields participate in
`participation-text-v2`; v1 and internal text-revision-v1 requests/outcomes retain
their existing canonicalization, with no injected defaults or rehashing.

The logical ID survives explicit changes. Immutable per-revision membership stores
the target, relation/rationale, first assertion revision and last changed assertion
revision. New/reintroduced/changed assertions attribute the change to the current
authenticated publisher; identical carry-forward preserves original and last-change
attribution, while the new source revision separately identifies its publisher/time.
Omission withdraws from current membership only. Reintroduction under an earlier ID
preserves its original assertion attribution and records the new assertion editor.
An immutable withdrawal row links each omitted immediate-base declaration to the
withdrawing revision. Historical withdrawn entries expose the latest eligible
withdrawal's publisher/time/revision separately; a suppressed withdrawal revision
withholds that attribution. A bounded indexed lookup avoids scanning source history
to infer the editor who removed the declaration.
An exact operation retry resolves its original outcome without inserting membership
or reapplying a reference after a later source edit.

An edit against a v2 base must use v2, including an explicit empty list to withdraw
everything. Old clients receive `reference_format_required` before writing. Local
intent keeps the exact original format/body/key; opening an old draft never upgrades
an uncertain request. After definitive rejection only, explicit correction may create
a new v2 draft from the selected comparison revision's declarations while keeping
the author's text/title/mentions. References are carried for deliberate review,
including empty lists; loading/saving failure preserves the original rejection.
All tabs must use the same release, as in ADR-017.

## Storage, authorization and ordering

An additive migration creates immutable `revision_references` with source/revision
membership, supported target-kind checks, exact target revision membership, logical
and target-scope uniqueness and retained attribution links. No existing revision,
outcome, proposal reference or personal state is changed or backfilled. Membership
inserts share the source revision/pointer/event/outbox/outcome transaction, before
the common clock. No target publication, reciprocal reference, editor change,
placement/status change or notification results.

New or changed declarations validate current target reading policy, never target
editing rights. An exact historical target only requires its selected revision to
be available, not the current one. Identical carry-forward from the immediate base
may retain an unavailable target. It cannot change target/type/rationale under that
exception. The authored IDs remain part of the independently published source;
resolved titles, bodies, location and links are withheld for unavailable targets.
Source editing and source/owner/revision availability remain mandatory.

Before any source guard, discover the full source/target/owner set under the shared
structure guard; lock resources in UUID order with UPDATE for the edited source
and SHARE for all other existing resources. Never acquire a SHARE source lock then
upgrade it. Include discussion openings, proposal affected areas and reply parents.
Participant/credential and optional configuration guards precede structure/resources;
selected revisions follow resources; the clock remains last. Existing constructors
reuse already-held guards. Owner walks stop at 32 resources; total guards are bounded.

Reference reads use one short REPEATABLE READ transaction, current actor checks and
the same sorted resource guards. Metadata comes from that snapshot. A conflicting
update committed before guard acquisition causes explicit restart, not mixed data;
writers that follow an acquired guard wait until the authorized read commits.
No transaction spans pages. Source suppression hides backlinks; reply parents are
not owners. Discussion/area suppression covers owned sources. Target suppression
withholds target projections, not independently authored referring text.

## Retrieval and browser experience

Outgoing lists select one exact authorized source revision. Incoming lists select
either the resource-only target or one exact target revision; there is no aggregated
scope in this slice. Default membership is current source revisions; explicit history
returns retained revision memberships. Each item retains declared direction, exact
source revision, original assertion and last-change attribution, source publication
time, current source location, and full-content/context routes. Historical rows say
current, carried_forward, changed or withdrawn relative to the eligible current
source; unavailable current membership is explicitly unknown.

Query `revision_references` directly, independently of search/worker health. Order
by immutable source revision UUID then reference UUID. Scan at most 100 candidates,
return default 12/max 25 items, and bound uncompressed serialized JSON at 4–128 KiB.
An empty scan may have a continuation; disclose work/omitted-body limits without
protected counts. Metadata expands only that bounded candidate set. Queries have
a 2.5-second statement deadline. Encrypted stateless cursors are at most 2 KiB and
expire five minutes after traversal creation; bind caller, exact scope, history,
relationship filter, ordering and shared-source/visibility/hierarchy boundary.
Only item/byte budgets may change. Source publication, visibility/restoration or
organization changes, expiry, mismatch or API restart require Refresh references.
No server cursor registry or graph fetch is introduced.

The browser's Add reference accepts a known ID or same-instance Loom link, validates
it through the API, and confirms resource versus exact revision. Selection does not
depend on indexing or fetch arbitrary URLs. Relationship/rationale controls and
source-owned change/removal feed the existing durable composer journal before POST.
Outgoing References and incoming Referenced by preserve exact links and bounded
pages, history/scope labels, unavailable/failed/restart states and response ownership.
No picker/read/navigation action saves, follows, marks read or publishes anything.

Search supports both document formats in selection, status, worker and rebuild.
Only source-authored title/body is indexed; rationale is retained/displayed but
excluded from lexical search. Dynamically resolved target titles/bodies are never
indexed as source-authored text. This avoids changing the existing body/excerpt
budget or making suppressed target metadata searchable through a citation.

## Alternatives, verification and reconsideration

Inline reference tokens would expand parser syntax and couple list editing to text
rewrites; an explicit versioned list fits the existing editor and direct clients.
A graph store or backlink worker adds unnecessary derived-state recovery. Direct
indexed relational queries preserve authoritative membership while search is down.
Explicit invalidation is chosen over retained long-lived snapshots for this bounded
single-API synthetic release. Reconsider these choices for measured larger workloads,
multi-API custody, mixed-release clients, richer inline authoring or new source kinds.

Acceptance uses populated upgrade/exact old retry, real PostgreSQL/HTTPS durable
rows, deterministic cross-reference/publication/suppression/revocation races,
current/history/byte/work pagination and source/target independence. Browser checks
cover journal correction/reload/restart/stale tabs, exact navigation, late account/
route responses, keyboard/narrow layouts and development StrictMode. Normal CI,
full browser and diagnostic checks remain required; record actual results separately.
Summary, coverage/change-note, file/path and private-note integration remain open.
Same-machine tests do not establish provider-agent or cross-machine trials, real
identity/retention/restore policy, production capacity or broad AC completion.
