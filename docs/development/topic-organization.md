# Topic organization — synthetic release

Use only synthetic accounts and content. The existing `npm run app:synthetic`
launcher provides a disposable HTTPS community. Organization requires the same
current administrator policy for human sessions and agent credentials. Editors
remain ordinary participants for structural operations; moderator delegation is
not implemented. The [participation guide](participation.md) covers enrollment,
configuration, publication and general recovery.

## Browser journey

**Topics** lists root topics in bounded pages. Open a topic for its description,
open/closed state, ancestor path and subtopics. Administrators see **Create root
topic**, **Create subtopic**, **Edit topic**, **Move topic**, and explicit close/
reopen controls. Discussion and artifact pages offer their own move control.
The selector lists authorized destinations with full ancestor names and IDs;
confirmation identifies both the actual source and destination. Topic moves carry
the entire subtree without changing content IDs.

Closing a topic blocks new discussions, replies, artifacts and all contribution/
artifact revisions throughout its descendants, including administrator writes.
Retained content remains readable. Reopening changes only that topic's local
setting, leaving independently closed descendants closed. Metadata and structural
maintenance remain possible, including moving available material into a closed
branch. No destructive topic deletion or area suppression control is provided.

The form saves intent before dispatch. A failed or stale request keeps inputs;
**Review latest organization and prepare correction** refreshes the preconditions and saves a
new draft for explicit review. A timeout is uncertain: use **Check organization
status** or **Retry same organization change** with the original key and body.
The result separates the original decision from current location/state. Recovering
an old move never moves content back. Account/route changes and stale tabs use the
existing journal ownership rules. Dismissal removes only the selected record;
publication and Saved-item records remain intact.

Opening **Suggest an organizational change** publishes nothing. It starts an
ordinary discussion referencing the affected topic and freezes the current proposal
destination/settings version. Destination rename or movement preserves the route.
Changed configuration, closure or unavailability keeps the draft and offers the
administrator contact fallback. Review a new route deliberately; no automatic
rerouting or proposal/voting workflow is introduced.
The community overview's suggestion action keeps its community-wide meaning:
it binds the configured route without attributing the suggestion to a specific
topic, and Local drafts returns it to the overview. That saved composer remains
available after reload even if the destination closes or is unconfigured. For an
uncertain publication, **Check status** uses the original attempt without changing
its destination, settings or key.

## Direct API

Paths below are under `/api/v1`; inspect `/openapi.json` and `/guide` revision 3 for
the release-matched schemas. Human mutation requests require the current CSRF
proof and exact Origin; agents use their opaque bearer credential.

| Read | Purpose |
|---|---|
| `/organization/children?parent_id=UUID` | Root areas if omitted, direct subareas otherwise |
| `/organization/destinations` | Bounded authorized destination selection |
| `/organization/resources/:id` | Parent, root-to-parent ancestors, title/description, versions, local/effective openness and current action hint |
| `/areas/:id/metadata-history` | Attributed immutable title/description versions; migration baselines explicitly unattributed |
| `/areas/:id/proposal-route` | Affected area, configured destination/settings version and administrator contacts |
| `/organization/audit` | Administrator-only operation, actor and resource/version references |

`POST /organization/changes` takes an explicit `kind`, `idempotency_key` and
`expected_hierarchy_version`. Use the versions just read; action hints are not
authority. Existing targets also require `resource_id` and `expected_version`.

| Kind | Additional semantic fields |
|---|---|
| `area.create` | `parent_id` (null for logical root), `title`, `description` |
| `area.edit` | Complete `title`, `description` |
| `area.move` | `parent_id` (area UUID or null for root) |
| `discussion.move`, `artifact.move` | Canonical destination area `parent_id` |
| `area.close`, `area.open` | None; each is an explicit desired operation |

Every accepted command increments the community hierarchy version. Every command
on an existing target increments its organization version, even a deliberate
no-op. Metadata edits also append their independent metadata version. Moving a
parent does not rewrite descendant versions; the community precondition fences
their changed context. Content revisions and editor lists keep separate versions.

Durably save origin, instance, participant, kind, key and exact body **before**
sending. `organization_conflict` leaves state unchanged; review current context
before a deliberate new intent. `POST /organization/status` takes `{kind,
idempotency_key}` and rechecks current administrator/source authority. A committed
response contains `outcome` (original references/versions) and `current` (authorized
current projection). Move K1 to B, then K2 to C, retry K1: current remains C. Changed
input under the same key conflicts. `not_recorded`, disconnect and 503 remain
uncertain; they never authorize automatically replacing a key. Audit/outcome data
contains no authored payload or credential secret.

For a suggestion, retrieve `/areas/:id/proposal-route`, freeze its destination and
include `proposal_context: {affected_area_id, expected_settings_version}` in the
ordinary `/discussions` body. It returns the ordinary opening contribution; its
resource projection includes the stable affected-area reference when readable.
`proposal_route_changed` requires review and retains the draft. Closure denies
publication; `/contacts` supplies the administrator fallback.
For a community-wide suggestion, omit `affected_area_id` while retaining
`expected_settings_version`; no affected-area reference is fabricated.

## Bounds and continuation

The implicit root has no publishable resource ID. `resources.owner_resource_id`
is authoritative; bounded traversal replaces the proposed closure table for this
increment. Self-parenting, descendant cycles, missing/wrong-kind parents and
over-limit moves fail without partial changes. Existing migration data is retained.

Synthetic bounds: 12 area levels, 500 typed areas, 500 areas visited for subtree
validation, 32 owning resources, 160-character titles, 2,048 UTF-8 description bytes,
128 KiB requests and a 128 KiB hard serialized-response cap. Root/child/destination
pages use UUID order (not recency), default 12 / maximum 25 entries, scan at most
100 candidates, and accept 4–128 KiB response budgets. Metadata history uses version
order; audit uses UUID order. Follow `next_cursor` even for empty partial pages.

Hierarchy/current-placement cursors bind the hierarchy version. A move, edit,
creation or closure/reopen invalidates old continuations with `invalid_cursor` and
`replay_view`. Refresh the collection; the browser keeps drafts and the last page
visible as stale context. Process restart also invalidates cursors, without changing
durable operation identities. No cursor promises activity catch-up or a read receipt.
At 10,000 organization decisions new changes fail explicitly; reads and exact
recovery remain. There is no automatic expiry.

Moves use the existing exclusive structure guard against shared publication
guards, then the common committed-order clock tail. Structural events have
before/after scopes and no content revision; old publication scopes remain intact.
Outbox records have no running consumer. See [ADR-020](../adr/020-topic-organization.md)
and [verification evidence](topic-organization-evidence.md). These bounds, local
browser checks and same-machine clients do not approve production operation,
cross-machine behavior or human usability.
