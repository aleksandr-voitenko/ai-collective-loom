# Current text search

ADR-012 and `docs/development/search.md` define this synthetic-only boundary.
Implementation and verification record: `LC-20261015-94TS`.
`search.ts` supplies participant selection/status and administrator recovery;
`worker.ts` owns durable work. `server/search-worker.ts` is the same-release native
Node entry, running as constrained `loom_app`, without participant credentials.
Personal notifications are an independent ordered sibling consumer (ADR-023).
Search keeps latest-revision-wins semantics and never changes notification identity.
Sources and intents are immutable inputs.

Typed artifacts, contributions and canonical summaries in `loom-markdown-v1`, `loom-markdown-v2` and `loom-markdown-v3`
are the population (ADR-010). Before migration 0010 the worker detects the absent
summary companion table and retains the previous typed population for additive
synthetic upgrade. ADR-021 preserves source title/body indexing across worker
restart/rebuild; rationale and dynamically resolved targets are not indexed.
Recorded references are direct relational reads, independent of this worker.
A null-parent opening represents one discussion result, with its discussion ID
and exact opening resource/revision. Original author filters differ from revision
publisher; dates use the matching revision's publication timestamp. PostgreSQL
`simple` lexical AND, title A/body and note D and rank-descending/resource-UUID ordering
are explicit choices, not universal language, substring or code-symbol guarantees.
NFC/whitespace/case normalize the query. Excerpts are bounded Unicode plain text.

Eligibility walks current resource ownership, not reply parentage. Require active
source/owners, available current revision and exact indexed=current identity.
Suspended authors retain publications; area closure does not hide reads. Reuse
participation retrieval/guards for result construction. Topic moves need no reindex.
Index rows and encrypted continuations never grant authority.
`/search/authors` discovers original authors through those readable current sources,
including suspended accounts and without depending on index output. It reuses
source guards and bounded UUID-ordered pages; optional exact author lookup restores
the browser label. The active-participant directory has a different population.

Cursors bind owner, normalized semantics/rank, source event/index/visibility/
hierarchy/rebuild boundary, offset and five-minute expiry. Process-local AES-GCM
keys inherit single-API-instance custody. Changes fail `search_changed`; never
mix views or hold a transaction across requests. End-of-window is not full history.
Status checks missing eligible current documents, not just maximum event progress.
Participant status has no job counts/IDs; administrator failures use closed codes.

Discovery uses advisory class 4, source UUID batches and an independent pair of
event position/intent UUID over immutable intents. Scan plus event discovery covers
concurrent publications behind the scan cursor and split-event batch boundaries.
Only revision jobs deduplicate by generation/revision; intent-backed jobs also
deduplicate by generation/intent ID, preserving unsupported collisions. Migration
0008 maps existing intent jobs without resetting attempts/outcomes/documents, then
replays bounded event discovery; applied 0007 remains immutable.
Organization events are explicitly not applicable; unknown
event/intent/source kinds retain failed work. Rebuild increments only derived state,
resets both discovery cursors and fences old claims. Expected generation makes
concurrent/repeated rebuild converge; older requests require refresh.

Claims use SKIP LOCKED, PostgreSQL time and monotonically increasing generations.
Preparation occurs outside claim/finalization transactions. Finalization order:
source SHARE → revision SHARE → job UPDATE → state UPDATE, then recheck owner,
claim generation, lease and rebuild generation before any effect. Independently
check current source pointer and indexed ordinal. Output, index version and job
success share COMMIT. Claim/renew/fail never take source guards after job guards.
Visibility writers take their existing source guard then derived state. Discovery
inserts jobs before its state update to avoid reversing finalization's job/state order.

Synthetic bounds: 5,000 sources; 50,000 retained jobs with conservative discovery
headroom; batches 25/50 claim/discovery; lease 30s with attempted 10s renewals;
three claims before failure. Renewal/failure lock the job before checking ownership
and database time in a new statement; an unchanged row lock wait can outlast a
lease without forcing UPDATE predicate re-evaluation. Expired claims cannot renew
or fail. Failed jobs retain safe intent references and
categories; explicit admin retry fences old claims and resets attempts. No silent
eviction or general retry framework. Rebuilds consume retained capacity.
Queries: 256 UTF-8 bytes/16 nodes, 2.5s per statement; 200 matches in the selected
window; default 12/max 25 items; 4–128 KiB complete JSON; 320-character excerpts;
32-resource owner walk. Limits are independent and not production approvals.

Native worker SIGTERM finishes an admitted cycle; process loss recovers through
leases. The preview supervisor supports worker stop/start independently of HTTPS.
See `tests/MEMORY.md` for durable-row, native process, HTTP and browser fixtures.
Retained-data upgrade, pruning/erasure, multi-API key custody, production operating
envelope and cross-machine agent trials remain separate gates.

ADR-022 adds note_text/note_document to the existing one-resource document. V3
notes join the same atomic fenced output; pre-0011 worker fixtures detect the absent
schema and preserve previous inserts. Current pointer and all owner/exact checks
still apply. Search exposes matching_fields, excerpt.field and explicit current
change_account status; explanation filters do not infer classification from prose.
Historical notes are direct exact reads, outside current-only indexing. Target
metadata/rationales are not indexed. Ranking/cursor policy is simple-title-body-note-v2.
