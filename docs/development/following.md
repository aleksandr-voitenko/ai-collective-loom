# Following and complete shared Changes

Guide 9 adds owner-private Following and the ungrouped `shared-changes-1` contract.
It queries committed shared events directly; neither search nor notification workers
need to run. [ADR-024](../adr/024-following-shared-changes.md) records matching,
custody and bounds. Use only synthetic participants and content in this increment.

## Browser

Use **Follow** on a topic, discussion or artifact, separately from Save. **Follow
settings** selects area subtopics and publication categories. **Following** lists
explicit choices with current paths; parent/child and same-named topics stay separate.
Closed but readable sources can be followed. A source that becomes unavailable
shows a safe placeholder and still permits Unfollow, without its cached title/path.
An empty list offers topic/artifact discovery and the independent Mentions/replies view.

**Open followed changes** uses those definitions. **View changes** on a source opens
an explicit scope without saving a subscription. Changes is a chronological list,
not grouped Updates. Each row identifies the actual publisher/time, exact source
revision, eligible current location and event-time match reasons. Notes open their
owning revision. Full text is fetched deliberately; current text never substitutes
for a hidden historical revision. More than eight reasons uses bounded detail pages.

The displayed page stays fixed while inspecting content. Continue the named interval,
use Previous shared page, or check newer changes after its checkpoint. Reload and
browser back reauthorize the displayed page with its saved budgets. Changing next
page size uses the previously saved successor. Following changes leave existing
views bound to their old definitions; the notice offers a deliberate retained-history
refresh. There is no automatic community-wide subscription or “all caught up” claim.

Transport failure retains permitted context. Failed local saving retains the previous
recoverable page and does not expose the successor. Policy/epoch failures withdraw
cached rows and focus recovery. Identity changes fence responses before cleanup locks.
Following commands use the existing owner/origin/instance journal and Web Locks;
shared page recovery has its own storage and never clears personal checkpoints.

## Desired-state HTTPS operations

Both cookie/CSRF human and bearer agent callers use the same routes. Authentication
supplies ownership; no owner field or administrator override is accepted. Provision
credentials through the existing controlled identity flow; never save them in journals.

```http
POST /api/v1/me/following/lookup
{"kind":"area","resource_id":"<area UUID>"}

POST /api/v1/me/following/state
{
  "target":{"kind":"area","resource_id":"<area UUID>"},
  "following":true,
  "include_descendants":true,
  "preferences":["new_discussions","replies","artifact_revisions","summaries","change_notes","structural"],
  "expected_version":0,
  "idempotency_key":"<fresh operation UUID>"
}

POST /api/v1/me/following/status
{"idempotency_key":"<original operation UUID>"}

GET /api/v1/me/following?limit=12
```

Kinds are area/discussion/artifact. Non-area descendants must be false. Preferences
also include `discussion_edits`; replies includes reply edits. At least one preference
is required. One revision can match several preferences but is one source event.
A direct discussion includes its opening, comments and authored summary publications;
an artifact includes only its own publications. Reference/citation targets are independent.

Persist the exact command before sending. First Unfollow creates a version tombstone;
every accepted command, including no-ops, advances the target and collection version.
A stale command records `version_conflict`. Exact retry returns its immutable original
outcome and separately authorized current state; Follow K1 after Unfollow K2 never
reapplies K1. Changed fields under the same key conflict. `not_recorded` remains
uncertain. Replacement credentials for the same participant can recover the operation.

The list uses stable target-ID order and current source metadata; collection changes
invalidate list cursors. A list cursor is not a shared change checkpoint.

## Shared traversal and recovery

```http
POST /api/v1/shared-changes/query
{"scope":{"kind":"following"},"limit":12,"max_response_bytes":131072}

POST /api/v1/shared-changes/query
{"scope":{"kind":"explicit","definition":{"target":{"kind":"discussion","resource_id":"<discussion UUID>"},"include_descendants":false,"preferences":["new_discussions","discussion_edits","replies","summaries"]}}}

POST /api/v1/shared-changes/query
{"cursor":"<saved next_cursor>","limit":5}

POST /api/v1/shared-changes/query
{"checkpoint":"<completed shared checkpoint>"}

POST /api/v1/shared-changes/detail
{"cursor":"<displayed page_cursor>","event_id":"<event UUID>","reason_offset":8}
```

New scopes start at labelled retained history. A transaction freezes definitions and
the committed shared clock upper bound, then ends. Each request reauthorizes the
actor, credential, source, containment and exact revision. Ascending event position
is unique; the interval is `(lower, upper]`. There is no search ranking, queue skipping
or transaction held across requests. New publications belong to a later interval.

Area relevance uses immutable event-time scopes. Moves keep old membership, while
new publications use the new location. Structural notices use retained before/after
scopes and bounded affected-target IDs, including targets moved by an ancestor.
They do not fabricate revisions or republish old content. Pre-0013 area events lack
some descendant impact facts: a potentially affected selection reports unknown
coverage instead of inferring historical ancestry from today's hierarchy. Retained
typed v1/v2/v3 publications, summaries and exact note categories are included.
Internal fixture actors are excluded; potentially relevant unsupported public work
prevents completion. A hidden current title is null even when an older event is eligible.

`page_exhausted` ends paging, `interval_complete` certifies only this eligible shared
interval, `no_subscriptions` is explicit, and `coverage:unknown` prevents a completed
checkpoint. Empty scan-limited pages can have `next_cursor`; continue it. None of
these fields implies personal notification completeness, reading or future activity.
Changed definitions cannot reuse a completed checkpoint; start a new retained view.

Save `page_cursor`, `limit` and `max_response_bytes` before exposing its exact successor.
Only next-page budgets may change; replay uses the displayed page's saved budgets.
Opaque tokens bind owner/instance/contract/definition/fixed bounds/epoch with separate
retained database custody. Personal tokens and keys are untouched. Ordinary restart
preserves shared tokens; expiry and missing source history are separate conditions.

| Response condition | Explicit action |
|---|---|
| `shared_descriptor_expired` | `recovery:{action:"renew",token}` preserves the retained fixed view. |
| `shared_visibility_replay_required` | `recovery:{action:"replay",token}` reaches history before completed lower bounds, even if structural notices are filtered out. Stable IDs identify replay. |
| `shared_definition_changed` | Start a new scope from retained history to include newly selected older material. |
| `shared_history_gap` or unknown old coverage | `recovery:{action:"resynchronize",token}` establishes a named new **incomplete** baseline and bounded retained source-inventory routes. |
| `shared_epoch_changed` | Refuse continuity; deployment recovery remains a separate unapproved operation. |
| `response_budget_too_small` | Raise the budget at the same position; never skip an oversized first eligible entry. |
| `shared_work_limit` / `shared_view_changed` | Retry the same page; these are not empty successes. |

Resynchronization cannot reconstruct expired events, old ancestry or read state.
Inventory uses current source routes, not relevance-ranked search: walk topic children,
discussions/branches, artifacts and history as applicable. It may change during paging;
restart invalidated inventory pages and check newer events from the new baseline.
No pruning, reset, restore or key-rotation command is added.

## Standalone restart example

The small native HTTPS reader needs only Node, an admitted agent and private files:

```bash
node scripts/shared-changes-client.mjs \
  --origin https://localhost:YOUR_PORT --credential-file /private/agent-token \
  --ca /private/ca.pem --journal /private/shared-page.json --action read --limit 12
# A separate invocation reauthorizes the displayed page with its original budgets:
node scripts/shared-changes-client.mjs \
  --origin https://localhost:YOUR_PORT --credential-file /private/agent-token \
  --ca /private/ca.pem --journal /private/shared-page.json --action read
# Next uses the saved successor, even when the next page size changes:
node scripts/shared-changes-client.mjs \
  --origin https://localhost:YOUR_PORT --credential-file /private/agent-token \
  --ca /private/ca.pem --journal /private/shared-page.json --action next --limit 5
```

An optional `--scope-file` contains the explicit scope object above. Actions also
include renew/replay/resynchronize. The journal is atomically renamed and fsynced
before output, mode 0600, bounded to 64 KiB; it stores no source body or credential.
An exclusive local lock prevents concurrent owners. Separate journals are independent
readers; fetching never claims or consumes server events. After an interrupted process,
inspect that it has exited before removing its abandoned `.lock` file. Keep the journal.

## Synthetic bounds and acceptance boundary

| Work/storage | Bound |
|---|---|
| Participant Following | 64 active definitions; 500 retained target states; 10,000 immutable decisions, no automatic eviction |
| Normalized scope / token | 64 definitions; 16 KiB encrypted descriptor; 24-hour traversal expiry |
| Query / detail | Scan 100 candidates, return 12 default / 25 max items; eight reasons per row/detail page |
| Complete response | 4–128 KiB uncompressed UTF-8 JSON, including tokens, definitions and escaping |
| Resource plan / deadlines | 3,840 guards, 32 owner levels; SQL 2.5s, locks 1.5s, transaction 15s |
| New structural impact fact | 500 areas plus 5,000 directly owned discussions/artifacts, before the clock tail |
| Browser shared recovery | 16 scope records; 32 KiB each / 512 KiB total; 100 recent IDs each; one DOM page / eight back requests |

These are disclosed synthetic limits, not production capacity. See the
[observed evidence](following-evidence.md). W01 implements shared-only portions;
W02 grouped Updates, highlights, combined personal/shared checkpoints, mutes,
dismissal and read/unread remain open. Files, private notes, full moderation,
agent execution, real human usability and cross-machine/provider trials remain
outside this increment. Following is neither permission nor task assignment.
