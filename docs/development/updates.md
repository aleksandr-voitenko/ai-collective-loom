# Combined Updates

Available in the local synthetic profile, participation guide 10. Updates combines
followed shared changes and personal mentions/replies. It creates no publication,
notification, subscription, Saved decision, read state or agent action. Existing
Following, chronological Changes, Mentions/replies and their recovery remain
independent. See [ADR-025](../adr/025-combined-updates.md) for the contract and
[verification](updates-evidence.md) for evidence and limits.

## Browser

Open **Updates** from the existing navigation. Default scope is Following plus
eligible personal attention, including sources outside Following. **Direct attention
only** uses the personal input. **Personal reasons** selects all, mentions or replies.
Follow a discussion without following its area to receive that discussion's shared
activity. A mention never adds its entire discussion or saves a follow.

Preparation scans bounded chunks. **Continue preparing Updates** advances the fixed
interval; counts appear only when both scans finish. Highlights includes all direct
groups and three routine groups, paged when necessary. **Show all matching groups in
this interval** keeps the same definitions, event preferences and both boundaries.
**Refresh scope from retained history** deliberately captures a new scope; **Check
newer activity** uses a completed combined checkpoint. Arrival of a publication or
repaired notification does not alter the displayed interval.

Cards show current titles/paths, named counts, two exact direct-source previews and
an eligible attributed note/account link. Inspect direct attention for more signals,
or inspect changes for bounded member metadata. Full content is fetched only by its
exact/current link. A summary's context opens the discussion; a contribution's context
focuses its actual contribution. Historical summary links retain their exact revision.
One expansion is shown at a time. Previous-page requests and the expanded page's
budgets survive reload, with current authorization. A failed save keeps the prior
recoverable position. Clearing saved Updates views affects only this participant's
Updates storage; it does not clear Saved items, publication drafts or other feeds.

Notes identify their owning revision/publisher. An independent account identifies
its own author and contribution. Named coverage may explain only part of a group;
current summary coverage is not computed. There is no inferred digest, relevance
model, unread badge, Mark read, Mute or Dismiss control.

## HTTPS contract

Authenticated community discovery advertises `updates_contract: combined-updates-1`
and `updates_url`. Generated `/api/v1/openapi.json` contains the controlled schemas
from `src/contracts/updates.ts`. All three routes are POST reads and accept no
recipient override. Human sessions supply normal CSRF/origin; agents use bearer HTTPS.

Start `POST /api/v1/me/updates/query` with:

```json
{"scope":{"kind":"following"},"reason":"all","selection":"highlights","limit":12,"max_response_bytes":131072}
```

Explicit shared scope is `{kind:"explicit",definition:{target,include_descendants,
preferences}}`, with the same definition as Following; `scope:{kind:"personal"}`
omits shared input. Explicit scope never saves a subscription. Do not combine
`cursor`, `checkpoint`, `switch` or `recovery`. Frozen selection cannot be overridden
by ordinary query fields. To change only selection, send
`{switch:{token:page_cursor,selection:"complete"}}` (or `direct`).

Save `page_cursor`, `limit` and `max_response_bytes` before exposing the next cursor.
The page cursor reproduces the displayed position, while `next_cursor` names the
first unseen position. Successor budgets can change; displayed replay budgets must
stay saved. Continue on empty preparation pages. The response identifies separate
shared/personal lower and upper opaque boundary labels. They are different clock
domains and must never be compared numerically. Personal availability may occur
long after its original source event, including below the shared lower bound.

| Field | Meaning |
|---|---|
| `stage` / component `scan_complete` | Preparation or ready; each bounded scan has its own coverage. |
| `selection_exhausted` | This selected group window ended; highlights can omit routine groups. |
| `grouped_interval_complete` | All eligible groups represented in complete selection with known coverage. |
| `checkpoint` | Both available component intervals accounted for; no body-reading claim. |
| `member_metadata_complete` | Always false on group overviews; member requests disclose their own `complete`. |
| `full_contents_fetched` | False; bodies remain separate exact routes. |
| `projection.state` | Generation complete/incomplete/unknown, separately from available personal retrieval. |
| component `history` | Retained continuity or explicitly incomplete baseline; never invented history. |

`POST /me/updates/members` accepts a group's `members_cursor`, `direct_cursor`, or
the overview's `records_cursor`, plus independent budgets. It returns one bounded
page and its displayed/next cursor. An overview cursor may instead specify `group_id`
and `direct_only`; omitting group selects the entire bound set. Each member retains
shared event ID, exact revision, personal delivery/signal ID and field reasons.
Personal main/note/reply reasons are at most three and all are returned. Shared
matching reasons page eight at a time: `POST /me/updates/reasons` with
`{cursor,event_id,reason_offset:source.next_reason}`. Its cursor must belong to this
combined contract, not either standalone feed. Each exact source's detail URL points
to the combined reason operation; body and change-note URLs remain existing routes.

Counts use distinct source records, shared changes, personal signals, reply
publications/revisions, summary/artifact/opening changes and structural events.
Overlapping follows do not multiply a shared change; two direct reasons are one
signal. An old personal source is represented but not a new shared change. Group
counts carry `known_sources_only` when shared historical facts are unknown, rather
than claiming exact interval totals. Otherwise counts are `exact` for eligible bound inputs.
Ownership groups contributions/summaries under discussion and artifacts independently. An
area move is one structural source, not copies for each impacted descendant.

## Recovery and finite limits

Every overview, member/reason page, switch and recovery reauthorizes the current
account, owners and exact sources. Any visibility-generation change invalidates
the old grouping before ordinary filters. Explicit replay reaches both retained
streams before completed lower bounds, retaining original event/delivery IDs.

| Error | Action |
|---|---|
| `updates_descriptor_expired` | Query `recovery:{action:"renew",token}`; members use `renew:true`. Preserve displayed position/budgets. |
| `updates_visibility_replay_required` | Query `recovery:{action:"replay",token}`; both lower bounds restart at retained history. |
| `updates_shared_history_gap` / `updates_personal_history_gap` | Named component continuity is missing; explicit resynchronization establishes an incomplete baseline and inventory links. |
| `updates_state_unavailable` | Grouping custody expired/missing; exact page recovery is unavailable. Explicitly resynchronize. |
| `updates_epoch_changed` | Deployment recovery required; renewal cannot make a different epoch continuous. |
| `updates_definition_changed` | Begin a new retained-history scope to adopt changed Following. |
| `updates_view_changed` / `updates_work_limit` | Retry the same authorized position after a concurrent change/deadline. No failed component advanced. |
| `updates_capacity` | Group/source/work cap: narrow scope; retained-view cap: reuse a saved view or wait for expiry. No live view is evicted. |
| `response_budget_too_small` | Increase bytes for the same page; an oversized first group is never skipped. |

Unknown historical structural coverage is explicit and prevents a completion
checkpoint. Resynchronization never reconstructs absent facts using current ancestry.
It returns current topic/artifact and retained personal inventory routes, whose own
continuations/authorization still apply. This is not a destructive restore tool.

The browser offers **Establish an incomplete new baseline** after a component
history-gap error and on a ready interval with unknown historical coverage, including
an exhausted complete selection. Before a descriptor exists, recovery keeps the
selected scope and personal reason. With a descriptor, it retains that interval's
frozen scope, definitions and reason. The action starts at the current paired
boundaries; it does not claim that older activity was retrieved. **Check newer
activity** then works after reload. An incomplete-history notice stays visible in
subsequent intervals, with links to retained topics, artifacts and personal attention.

Synthetic bounds: 100 candidates from each stream per preparation step; 2,000
sources, 500/group, 256 groups and 1,000 steps/view; 16 views/participant, 128 total;
24-hour descriptor, seven-day nonextendable custody; cleanup of one expired view per
creation. This may require waiting for custody expiry after repeated fresh scopes.
Checkpoints have separate self-contained continuity and survive custody cleanup.
Return default 12/max25 groups or members, two direct previews/group and 4–128 KiB
complete JSON; descriptors max16 KiB. SQL 2.5s, lock1.5s, transaction15s. No production
capacity is established. Browser storage: 16 scoped records,128 KiB each,512 KiB total,
eight back requests, one overview/expansion and no silent eviction.

## Standalone client

Use a synthetic agent credential issued through the existing administrator flow.
Keep the secret and journal in private files. No SDK or browser automation is needed:

```bash
node scripts/updates-client.mjs --origin https://localhost:3443 \
  --credential-file /private/path/agent-token --ca /private/path/cert.pem \
  --journal /private/path/updates.json --action read --limit 5
```

Repeat the same arguments with `--action next` while preparation or selected pages
continue. `complete` and `direct` switch selection in the same interval. `members`
opens all source metadata, optionally `--group GROUP_ID --direct-only true`;
`next-members --limit 12` resizes the exact successor. `read` reauthorizes/replays
both saved overview and expansion after client/API restart. `close` removes only
the expansion; `newer` requires a completed checkpoint. `renew`, `replay` and
`resynchronize` are explicit recovery actions. `--scope-file` supplies JSON scope
and `--reason mention` filters personal reasons; a journal rejects changed identity,
origin, instance or scope instead of silently resetting. A second client uses its
own journal. The mode0600 journal is fsynced/atomically renamed before output,
contains only bounded replay metadata and uses an exclusive local lock.
Node 24's built-in SQLite holds that lock in a private `.lock.sqlite` sidecar; an
interrupted process releases ownership automatically. Keep the sidecar in place,
including between runs, and use the same client protocol for every process sharing
a journal. The sidecar contains no content, credential or recovery record. A legacy
`.lock` file is refused because its owner cannot be verified: stop older clients,
verify none is active, then remove only that legacy lock before retrying the saved
journal. Never remove an active `.lock.sqlite` sidecar.

[Exact reading progress](reading-progress.md) has separate operations and recovery.
Cards, expanded metadata, notes and complete-feed exhaustion do not mark sources
read or remove read entries. Existing grouping and checkpoint formats are unchanged.
Mutes/dismissal, files/private notes, moderation administration,
production retention/restore operations and representative human/provider/cross-machine
acceptance remain open. Composite product scenarios are not closed by this subset.
