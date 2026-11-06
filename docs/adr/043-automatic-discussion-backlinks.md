# ADR-043: Automatic discussion backlinks

Status: implementation contract extending ADR-021/036. The imported product and
architecture baselines remain unchanged.

## Decision and meaning

Newly published/revised discussion openings and comments infer navigation evidence
from ordinary safe Markdown link tokens on the server, including API publications.
This intentionally revises ADR-021's original decision to infer nothing from URLs.
Authored references retain their explicit identity, relation, rationale, attribution,
withdrawal history and exact-target APIs. Inferred links have their own immutable
`revision_discussion_links` table, no reference ID or semantic relationship, and a
separate `inferred_markdown_link` response provenance. Linking never asserts that
an author represents a team, endorses the target or requests action.

The target discussion's compact **Mentioned in** disclosure shows each eligible
source contribution once, with current discussion title when readable, original
author, current revision publisher/time, exact source revision and conversation
navigation. Several contributions from one discussion remain individually navigable.
This read creates no comment, activity, notification, Follow, Save, reading change,
editor membership or target edit. Ordinary source publication keeps its existing
source event/intents and true-reply/explicit-mention semantics.

## Parsing and destinations

The existing bounded CommonMark parser runs with HTML/image fetching/linkification
disabled. Only active `link_open` tokens in main ordinary prose count, including
angle-bracket HTTP(S) autolinks and reference-style Markdown links. Code blocks,
inline code and blockquotes (including nested quotes) are excluded. Quotes can
repeat another person's text; excluding them avoids crediting that quotation as a
new navigational link. Image parsing remains disabled: the existing dialect treats
`!` followed by a link as text plus an active link, never an image fetch.
No linked URL is fetched. Drafts, revision notes, artifacts, summaries as sources,
uploaded bytes, private notes and explicit reference rationales are not scanned.
Publication validation and combined token accounting retain the original dialect.
Local-link presentation/detection falls back to that dialect when expansion would
invalidate an accepted mention placement or exceed 4096 tokens; those local forms
remain literal and do not infer backlinks. Old accepted intent remains replayable.

Absolute HTTP(S) URLs must match the configured instance origin exactly and have
no credentials or fragment. Root-relative and instance-root path-relative forms
(`/loom/...`, `loom/...`, `./loom/...`, `../loom/...`, and the corresponding
`api/v1/...` forms) resolve consistently from the instance root in every rendered
view. Arbitrary context-relative paths, protocol-relative URLs, other origins,
malformed IDs, fragments and unknown query parameters are unsupported.

Supported routes, verified against this checkout:

| Destination | Owning-discussion association |
| --- | --- |
| `/loom/discussion/{id}` or `/api/v1/discussions/{id}` | Exact discussion container |
| `/loom/discussion/{id}?focus={contribution}` | Focused contribution must belong to that discussion |
| `/loom/resource/{id}[/{revision}]` | Contribution or summary; optional exact revision must belong to it |
| `/api/v1/resources/{id}[/revisions/{revision}]` | Same typed resource/revision identity |
| `/loom/file/contribution/{id}/{revision}/{file}` | Exact published contribution attachment, with stored membership path |
| `/api/v1/contributions/{id}/revisions/{revision}/attachments/{file}/{download\|text\|text/status}` | Same exact attachment identity |

Artifact/file artifacts, topic links, history/list/status-management routes,
`?edit`/`?attribution`, and nonexistent or mismatched memberships are unsupported.
A discussion is never converted into its opening contribution identity. Files,
resource targets, exact revisions and focused contributions retain their separate
target fields and exact destination URL, independently of their discussion ID.
Navigation responses include the owner/revision/file identity without duplicating
the file path. The exact stored path still validates contextual membership on every
read and remains available through the separately authorized file interface. This
keeps even 100 heavily escaped 512-byte file paths from exceeding the maximum page
budget; no destination is dropped to fit it.
The current source revision may store several destinations to one discussion but
returns one incoming source entry with independently eligible destinations.
Links to the source contribution itself and its own discussion container are
omitted. Links to other contributions, revisions, summaries or attachments within
the same discussion remain navigational evidence.

The first 100 unique supported destination URLs in parsed order are considered
per revision. Destinations exceeding 1024 UTF-8 bytes are unsupported and skipped
before SQL, preserving ordinary prose publication even for heavily padded queries.
Missing identities do not create rows or shift this deterministic
parsing bound. This finite policy bounds publication work without refusing ordinary
prose. Equivalent absolute/local links normalize to the same destination; separate
route aliases can retain separate destinations within the same source entry.

## Publication, lifecycle and migration

Migration 0030 is additive and prospective: no backfill, revision rewrite, authored
format/digest change, outcome change or inferred historical claim. Old publications
can acquire links through an ordinary new revision. An exact pre-upgrade retry
returns its saved outcome without inference. Unknown targets are omitted until a
future source revision; there is no later resolver worker.

Parsing precedes SQL. The existing complete sorted resource plan includes candidate
target identities/owners before source UPDATE or target SHARE guards. Existing
participant/credential, structure, resource, revision and final clock order remains.
Fixed membership inserts share the source revision/pointer/event/intent/outcome
transaction before the clock. Target identity/membership checks do not require
target edit or current read eligibility and return no target metadata to the
publisher. Missing and suppressed destinations cannot block ordinary prose or
disclose target existence through a different publication response.

Current incoming membership requires equality with the source's current revision.
Removal leaves immutable historical rows; re-addition creates new revision rows.
Saved replay resolves before detection/storage, so concurrent retries, lost
acknowledgements and replay after a later edit never duplicate or resurrect links.
Rollback removes the entire source publication and inferred membership together.
The runtime cannot update/delete inferred rows; FKs and typed membership/cardinality
checks preserve source, revision, discussion and contextual file identity.

Reads reauthorize the target discussion, exact linked destinations, each current
source revision and their current ownership chains. Suppressed/deleted resources,
revisions or topics hide affected evidence; restoration reveals still-current
eligible membership without rewriting history. Reply parents are not owners:
an independently eligible nested reply survives parent suppression. If its opening
revision is unavailable, omit that title rather than the independently visible
reply. Whole discussion/topic suppression still covers its owned contributions.
No inaccessible source title, excerpt, URL, ID or count is serialized.

## Bounded retrieval and browser ownership

`GET /api/v1/discussions/{id}/mentioned-in` is ordinary authenticated retrieval.
It queries the immutable membership index directly; no search or new worker is
required. Each REPEATABLE READ page groups/scans at most 20 source revisions in
UUID order, with at most 100 destinations each. It returns default 12/max 25 entries
within the full 4–128 KiB serialized budget. The smaller candidate bound keeps
the complete resource plan within existing 2200-seed/32-owner/3840-resource limits. SQL uses
the existing 2.5-second statement deadline. Empty pages may continue, never disclose
hidden population counts, and do not claim that an empty scan is complete.

Five-minute encrypted process-local cursors, max 2 KiB, bind caller, discussion,
ordering and the existing shared publication/visibility/organization boundary.
Edits, suppression/restoration, movement, expiry, mismatch or API restart require
explicit refresh with `references_changed`. Source/target races either return the
one guarded authorized snapshot or explicit restart. No transaction spans pages.
Oversized first items return `response_budget_too_small` without advancing.

The lazy disclosure uses its own full authorization-withdrawal boundary. Existing
lifetime, request sequence, participant generation and protected-read safeguards
fence late responses. A transient failure keeps the earlier page and exact attempted
cursor for explicit retry; successful retry/paging focuses the result heading.
Native disclosure, links, buttons, time elements and wrapping rows support keyboard
and narrow layouts. It stays separate from authored References/Referenced by.

Direct relational membership was chosen over scanning all content on reads or an
asynchronous backlink worker: it provides bounded authorized discovery while
preserving the source's atomic lifecycle and retry contract. Separate storage was
chosen over adding a relationship flag to authored references to prevent accidental
semantic aggregation. Reconsider these limits or cursor custody for measured larger
workloads, mixed-release/multiple API processes, newly supported route/owner kinds
or an explicitly requested bounded historical backfill. Those are not introduced
by this change. Executed verification belongs in task evidence, not this contract.
