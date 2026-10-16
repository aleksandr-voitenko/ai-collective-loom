# ADR-020: Administrator-managed topic organization

Status: implemented for the synthetic profile. Product v0.9 remains
authoritative; optional moderator delegation and attention services remain open.
ADR-012 now implements current text search using this canonical ownership and
hierarchy epoch. This record extends ADR-003/006/015/016/017 without changing imports.

## Parentage and bounded work

Use `resources.owner_resource_id` as the single authoritative parent: an area owns
subareas; discussions and artifacts belong to one area. NULL on an area denotes
the one logical implicit community root, which has no publishable resource ID.
The architecture's proposed separate parent column and closure table are not added:
bounded adjacency traversal avoids competing parentage and a derived table that
every existing constructor would have to maintain. Reconsider a transactional
derived closure index when representative descendant-query workloads justify it;
resource ownership must remain authoritative.

Synthetic limits: 12 area levels, 500 typed areas in the community and at most 500
areas inspected for subtree validation. Traverse explicit bounded frontiers, not
an unbounded recursive intermediate with a final LIMIT. Owner reads allow at most
32 resources. Existing populated rows are preserved; over-limit existing structures
fail explicitly where traversal cannot satisfy the bound. Titles retain the existing
160-character limit; descriptions allow 2,048 UTF-8 bytes. Unicode/NUL validation,
closed schemas and the existing 128 KiB request/response ceiling apply.

Root/subarea and destination pages use stable UUID order, default 12 / maximum 25,
with at most 100 candidates scanned. Destinations show the full currently authorized
ancestor path, including stable IDs. Ancestor paths have the depth bound and are
returned in root-to-parent order. No arbitrary sibling reorder is introduced.

## Authority, versions and closure

Every command and reconciliation rechecks current authenticated administrator
authority through the shared cookie/bearer policy. Editors have no structural
authority. No moderator role or assignment is added or repurposed.

Each resource has an `organization_version`, initially 1, advanced by every accepted
metadata edit, move or explicit open/close command, including a deliberate no-op.
Creation starts at 1. Commands require the expected target version and the expected
community `hierarchy_version`; creation requires only the latter. The hierarchy
version advances for every organization command and setup-created areas. A parent
move does not rewrite descendant versions; the hierarchy precondition fences their
changed context. Stale commands fail before effects and retain client input. Content
revisions and editor-list changes keep their existing independent versions.

Area titles/descriptions have separate immutable metadata revisions, publisher and
time; moves/closure do not create authored revisions. Migration records an explicit
unattributed baseline for existing metadata, never inventing historical authorship.
New setup and organization metadata records are attributable.

Closing an area changes only its local `publication_open`. Effective closure is
inherited by all descendants and blocks discussion, reply and artifact creation and
all contribution/artifact revisions, including administrator publications. Existing
resource-local restrictions still apply. Reads, metadata maintenance and structural
moves remain allowed where source visibility permits. Reopening changes only the
named area; independent descendant closures remain. Moving into a closed branch
is allowed and immediately inherits its contribution restriction. No deletion or
source suppression operation is introduced.

## Transaction and event protocol

Attempt mutex → current actor/credential guards → exclusive ADR-006 structure
guard → resource guards → domain writes → common clock tail → event/outbox/outcome
and COMMIT. Setup takes its existing configuration guard before the structure
guard. Organization does not acquire the configuration guard. Publication continues
to take the shared structure guard, so move/close races have one committed order.
Cycle checks run after the exclusive guard; simultaneous opposite moves cannot
both pass against outdated ancestry. No contested domain guard follows the clock.

Structural activity uses the same `shared_activity` table and transactional clock,
with a NULL revision and explicit before/after area scopes. It does not fabricate
a content revision or replay publications. Earlier `area_scope_ids` remain untouched;
only new publications capture current ancestry. The upgrade does not infer missing
historical ancestry. The search consumer recognizes structural intents without
reindexing text: fresh searches use current ownership. Other consumers remain open.

## Retry, disclosure and browsing

`organization-v1` hashes all semantic request fields, including both preconditions,
excluding the key and credential. Immutable decisions are scoped by participant,
kind and key and contain original reference/version state. Exact retries resolve
before new-write preconditions and never reapply. K1→B, K2→C, retry K1 reports the
original B outcome separately from current C. Status is read-only; not_recorded is
uncertainty. Current authority and source/owner availability are checked before
disclosing retained references, including original scopes. Private audit records
contain actor/credential IDs, operation, versions and scopes, never credentials,
authored payloads or private bookmark data, and have administrator-only retrieval.
Retain at most 10,000 organization decisions in this synthetic community; exact
recovery remains available at the cap. No automatic expiry or erasure is approved.

Hierarchy and current-placement collection cursors bind the hierarchy epoch. Any
organization change explicitly invalidates them; refresh starts a new view without
discarding drafts. This is conservative bounded browsing, not stable activity-feed
traversal or completion of AC40. Existing process-local cursor restart behavior
remains. Metadata history is likewise bounded and reauthorized.

The browser saves exact intent in the existing scoped Web-Locked journal before
dispatch, keeps errors/conflicts and uncertain keys, and offers explicit correction
after a definitive refusal. Account/view generations and record sequences prevent
late responses or stale tabs replacing another operation. Organization recovery
never clears publication or Saved records.

Organizational suggestions remain ordinary discussions. Optional proposal context
binds the affected area, configured destination and settings version at composition;
the server checks that binding under the configuration/structure guards. Changing
or closing the destination cannot silently reroute a draft. The affected area uses
a stable reference, and unavailable routing offers the administrator contacts.
The existing community-wide suggestion action binds the same destination/settings
without inventing an affected area; that field is optional for this case and its
draft resumes at the community overview.

## Verification and limits

Use populated pre-0006 upgrades, real isolated PostgreSQL/HTTPS, deterministic
barriers and persisted row inspection for identities, cycles, publication ordering,
versions, replay and suppression. Browser checks use shared diagnostic fixtures and
the containing runner for reload, stale tabs, late account/route results, keyboard
and narrow layouts. Record actual results separately. Same-machine synthetic
clients do not establish cross-machine operation or human usability; production
identity, retention/restore, multi-process cursor custody and capacity remain gates.

## Following increment

[ADR-024](024-following-shared-changes.md) adds independent owner-private Following
and ungrouped complete shared retrieval. It retains this decision’s source identities
and personal-delivery boundaries. New structural events capture bounded descendant
impacts; older missing facts remain explicit unknown coverage. Grouped Updates,
combined checkpoints, mutes/dismissal and reading progress remain separate work.
