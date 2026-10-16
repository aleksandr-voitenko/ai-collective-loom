# ADR-012: Current shared text search and recoverable indexing

Status: implemented for the synthetic release. This expands ADR-012
in the unchanged architecture proposal; numerical limits are not production policy.

## Population and query

Index only typed discussion openings, comments, text artifacts and summaries in
`loom-markdown-v1`, `loom-markdown-v2` or `loom-markdown-v3` (ADR-021/022). Source-authored title/body and optional current note
is searched; reference rationale and resolved target metadata are excluded.
A discussion title belongs to its opening revision: the one
discussion result identifies the discussion and that exact opening resource/revision.
Comments, artifacts and summaries retain their own resource identity. ADR-010
adds summary population/placement; only independent summary title/body is indexed. Files,
private notes, Saved state, administrative records and historical search are excluded.
Author filtering means original resource author; revision publisher is separately
attributed. The time interval is inclusive `from`, exclusive `before`, against the
matching current revision's publication timestamp, in UTC.

Normalize queries to NFC, trimmed/collapsed whitespace and lowercase. PostgreSQL
`simple` lexical processing uses AND between terms, title weight A and body weight D,
`ts_rank` descending and resource UUID ascending for ties. No stemming, substring,
semantic or universal multilingual claim follows from `simple`. Phrase/operator
syntax is unsupported; punctuation-only/empty, invalid Unicode, NUL and oversized
queries fail explicitly. Punctuation within ordinary identifiers follows PostgreSQL's
parser. Evaluate actual prose, names, languages and identifiers in the SQL suite.
Excerpts are labelled partial plain text from the exact indexed revision, rendered
as React text; neither raw HTML nor database headline markup is trusted.

## Selection and eligibility

Current canonical ownership and availability authorize results. Require the indexed
revision to equal the current pointer; never substitute R1 when R2 is unindexed or
unavailable. Original author suspension does not erase retained publications. Area
closure does not affect reading. Reply ancestry is not containment. Reuse current
source guards for result construction and reauthorize every page.

Author discovery uses readable current publications, independently of indexing and
account suspension. The active-participant directory serves a different population
and cannot supply this filter. `/search/authors` reuses source/authority guards,
returns only author metadata in UUID order, and binds bounded continuations to the
caller, optional exact author filter and current selection boundary. An unavailable
author filter remains selected by ID; the browser never silently broadens it.

Use explicit invalidation, not a transaction spanning requests: encrypted cursors
bind participant, normalized query/filters, rank version, source event boundary,
hierarchy, visibility, index and rebuild generations, position and expiry. Any bound
change, process restart, mismatch or five-minute expiry requires a new search.
Source visibility changes advance a derived visibility generation in their own
transaction, including restoration; no source event is rewritten or fabricated.
Moves affect fresh searches immediately without indexing. Index completion may
invalidate a view; Refresh deliberately starts a new selection. Search has no totals
and never claims change-history coverage. Selected-window exhaustion is separate
from source coverage; a timeout is an error. Direct exact retrieval stays independent.

## Durable work and lock order

Search owns its own jobs and event-discovery position over immutable outbox/event
references. Nothing globally consumes `publication.project`. Explicitly recognized
organization events require no text output; unknown intent/event/source formats fail
for administrator inspection, not successful unrelated consumption. Backfill scans
authoritative typed sources independently of activity history in resumable UUID
batches. Event discovery runs from retained position zero and continues during and
after scanning, covering new publications inserted behind the source cursor.

Revision jobs deduplicate by rebuild generation/revision. Intent-backed work also
deduplicates by generation/intent ID; unsupported intents cannot collide with
revision backfill. Event progress is the pair `(event position, intent UUID)`, so a
batch ending between one event's intents resumes without skipping the remainder.
Additive migration 0008 maps existing intent jobs without resetting attempts or
outcomes, preserves documents, and resets only event discovery for bounded replay.
Applied 0007 stays unchanged; existing revision/intent jobs absorb replay duplicates.

Claim bounded batches with `FOR UPDATE SKIP LOCKED`; each claim increments its
generation and attempt. Lease expiry uses PostgreSQL time. Preparation is outside
claim/finalization transactions; renew only an unexpired owned claim. Renewal and
failure first lock the job, then check ownership and database time in a fresh SQL
statement: an UPDATE predicate alone can have been evaluated before an unchanged
row's lock wait. Expiry never permits resurrection by renewal or failure transition.
Three attempts with bounded exponential backoff end in retained failure;
explicit administrator retry fences the old generation and resets the attempt budget.

Finalization locks source resource, exact revision, job, then search state. Verify
claim generation, owner, unexpired lease and rebuild generation before any output.
Compare the current source pointer and revision ordinal independently of the claim
fence. Commit document/output association, index generation and successful job state
atomically. An older revision becomes explicitly superseded. A lost COMMIT reply
is resolved by the persisted job/document, never by publishing first then checking
ownership. Claim/renew/fail never acquire source locks after the job lock.
Visibility writers hold their existing source guard before the search-state tail.
Discovery/rebuild serialize with a separate advisory guard; discovery takes no
search-state write lock until after inserting its bounded jobs. Public clock/order,
actor credentials and immutable intents remain untouched.

Rebuild increments a derived generation and resets bounded scan/discovery progress.
Old documents are unavailable to the new generation until replaced; no source rows
or other consumer progress are cleared. Concurrent requests compare the expected
generation; repeating the same request converges without starting another rebuild.
Older workers cannot publish into the new generation. Retained failures remain
inspectable. Worker access uses the constrained application role, never migrator,
superuser or publisher credentials. This is an internal same-release process.

## Synthetic bounds and verification

Query: 256 UTF-8 bytes, 16 parsed nodes. Supported corpus scan: 5,000 typed current
sources; over-limit work fails explicitly. Selected relevance window: 200 matches;
pages: default 12, maximum 25. Responses: 4–128 KiB serialized uncompressed UTF-8
JSON including envelope/cursor; excerpts: 320 Unicode characters. Context uses the
existing 32-resource owner bound and 500-area/12-level organization bounds.
Continuations are stateless, at most 2 KiB, expire after five minutes and permit
only page-size/response-budget changes. Query statements have a 2.5-second deadline.
Work batches: 25; source/event discovery batches: 50; lease: 30 seconds, renew at
10 seconds; attempts: 3; retry delays: 1 and 2 seconds; retained jobs: 50,000. Capacity
failure is explicit, with no silent eviction. These values require measurement and
review before real content. Participant status has no queue counts or failed IDs;
administrator inspection is bounded and contains safe categories/references only.

Verify populated upgrades, interruption, concurrent scanning/publication, native
process loss, lease theft and stale-source races with deterministic barriers and
durable row assertions. Exercise real HTTPS human/agent parity, suppression,
restoration/moves, limits, exact navigation, StrictMode, normal browser regression
and closed diagnostics. Record measurements and actual outcomes in the search guide;
do not infer production approval or broad AC completion from synthetic checks.
Executed results and failure evidence are retained in
[search verification](../development/search-evidence.md).

## Guide 7 extension — ADR-022

Loom-markdown-v3 and optional current revision notes join the same owning search document, with matching_fields, excerpt.field and explicit account classification/filtering. Ranking is simple-title-body-note-v2 (title A, main/note D). Resolved target titles/bodies and rationales stay excluded. Discovery, processing, status and rebuild include v3 together; historical notes are exact reads, not indexed history. See [ADR-022](022-authored-change-notes.md) for the complete contract and reconsideration conditions.
