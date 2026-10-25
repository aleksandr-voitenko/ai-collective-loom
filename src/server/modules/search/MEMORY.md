# Authored search and independent file text

ADR-012 and `src/contracts/guide.ts` define this synthetic-only boundary.
Implementation and verification record: `LC-20261015-94TS`.
`search.ts` supplies participant selection/status and administrator recovery;
`worker.ts` owns durable work. `server/search-worker.ts` is the same-release native
Node entry, running as constrained `loom_app`, without participant credentials.
Personal notifications are an independent ordered sibling consumer (ADR-023).
Search keeps latest-revision-wins semantics and never changes notification identity.
Shared Changes (ADR-024) queries committed events independently; relevance-ranked
search is neither shared-history completion nor its resynchronization inventory.
Sources and intents are immutable inputs.

Typed artifacts, contributions and canonical summaries in `loom-markdown-v1`, `loom-markdown-v2`, `loom-markdown-v3` and `loom-markdown-v4`
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

ADR-031/guide16 add separate `file-worker.ts`/`file-text.ts`/`file-decoder.ts` and
native `server/file-text-worker.ts`. They never alter authored jobs/documents,
notification consumption, immutable sources/intents or private state. Jobs/documents
are per exact file_context, including retained history and independent promotions.
Current Files search additionally requires indexed owner revision=current pointer;
no R1 fallback when R2 is unprocessed/omitted/suppressed. Match/rank only retained
contents using simple lexical AND, rank descending/context UUID ascending.
Placement/original-author/revision-publication filters use the existing guarded
source projection. File cursors have separate keys, mode/rank and file index/rebuild
boundaries plus existing source/visibility/organization fences. Authored cursors and
health meanings remain unchanged. Eligible status reveals no participant job counts.

Class16 serializes missing/stale-context discovery and rebuild. An indexed anti-join
in25-context batches resumes from committed jobs without a UUID high-water gap.
Jobs<=65536; process admissions2; leases30s/renew10s/attempts3 with1/2s retry delay.
At job capacity, discovery excludes new admission but still advances stale retained
jobs; missing low-ID contexts cannot starve rebuild, and capacity stays explicit.
Reserve additional output before IO: retained raw text+in-flight reservations<=32MiB,
output<=64KiB/context. Fixed metadata/lexical overhead is bounded separately, not a
physical disk reservation. Discovery and claims lock jobs in file-ID order before
state. Finalize source SHARE→revision SHARE→exact immutable context/native re-read
→job UPDATE→state UPDATE, then check claim/rebuild/time after waits. Contexts keep
no-UPDATE/no-DELETE grants. Native IO/strict decoding occurs outside SQL; suppressed
contexts may complete nonpublicly and never authorize participant access.
Rebuild increments derived generation; bounded discovery replaces stale jobs/docs,
preserving originals and other workers. Exact retry/rebuild converge without
reapplication. Leases, output/accounting/job COMMIT and safe failure tokens recover
process loss/acknowledgement uncertainty. GETs never enqueue or change read state.
Decoder policy, MIME pairs, controls/BOM/newlines and precise budgets are in ADR-031
and contracts/file-text.ts. Unsupported formats and partial suffixes stay excluded;
unknown heartbeat/missing output never establish ready coverage. Exact preview pages
are<=32KiB JSON; Files search retains4–128KiB pages/200-match windows/5000-source cap.
