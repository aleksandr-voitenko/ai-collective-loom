# Scoped text search and the indexing worker

This synthetic-only slice provides current lexical search in the browser and the
same `participation-1`, guide 7 API. Its implemented choices and limits are in
[ADR-012](../adr/012-scoped-text-search.md). Product and imported architecture
snapshots remain unchanged. Use synthetic accounts and text only.

## Find and open text

Choose **Search** in the shell or **Search this topic** in a topic. Enter plain
words, select a content kind or original author, and optionally set topic scope
and **Include descendants**. Date bounds use the current matching revision's
publication time: From includes midnight UTC; Before excludes midnight UTC.
Revision publisher is displayed separately from original author.
The author picker lists authors with readable current publications, including
suspended accounts. It excludes authors whose only publications are unavailable.

The current population is discussion titles/openings, comments and authored text
artifacts. One discussion result represents its title and opening together. Results
show current location, attribution, a labelled excerpt and the exact matching
revision. The title opens that exact revision; **Open context** opens the current
discussion branch or artifact. Browser back retains query/filter/cursor URL state;
reload repeats the authorized request. An expired/invalidated selection needs an
explicit refresh. Reading/searching never saves, follows, notifies or marks read.

Search uses NFC normalization, whitespace collapsing, lowercase and PostgreSQL
`simple` lexical AND. Titles have weight A, bodies D; `ts_rank` descending and
source UUID ascending break ties deterministically. There is no corpus popularity
weight. Words such as OR and AND are literal terms. Phrases and query operators
are rejected, as are empty, punctuation-only, malformed or oversized inputs.

The isolated PostgreSQL fixture found `running`, Alice, café, Привет, 東京,
`foo_bar`, `foo.bar` and `C++`; `run`, `runn`, `caf` and 京 did not match that fixture.
This demonstrates case/lexical matching with the tested tokenization, not stemming,
substring matching, code-symbol precision or universal multilingual segmentation.
In particular, punctuation can disappear or produce additional lexemes; a match
for C++ does not establish that C++ is distinguished from C or C#.

## API examples and continuation

Authenticated GET requests use the existing cookie/CSRF or bearer transport. A
search itself is read-only. Use URL encoding, not shell interpolation of authored
text. For example, construct a request in an already authenticated client:

```js
const query = new URLSearchParams({
  q: "retained design", kind: "artifact", limit: "12",
  from: "2026-01-01T00:00:00Z", before: "2027-01-01T00:00:00Z"
});
const page = await client.get("/api/v1/search?" + query);
// Follow full_content_url deliberately for the exact revision.
// Keep the same semantic query/filter fields when adding next_cursor.
```

Optional `topic` and `author` are stable UUIDs from bounded topic and search-author
discovery. `GET /api/v1/search/authors` returns author metadata in UUID order with
`limit` (default 12, maximum 25), `max_response_bytes` (4–128 KiB) and `cursor`.
Optional `author=<UUID>` resolves the selected filter after reload. Discovery uses
readable publications even when indexing is stopped; it does not depend on the
active-participant directory. Its five-minute cursors bind caller, exact filter and
current selection boundary; changes require restart. An unavailable selection stays
selected until explicitly removed. Supplying `descendants` requires a topic. Kinds are `discussion`, `comment`
and `artifact`. Unsupported filters fail explicitly. The controlled schema is
available from `/api/v1/openapi.json`; `/api/v1/guide` gives the same release meaning.

The result supplies `result_id` (discussion, comment or artifact identity),
`source_resource_id`, `revision_id`, `author`, `publisher`, `published_at`, current
`location`, an `excerpt` and `full_content_url`. `context_url` is an API route;
`browser_url` and `browser_context_url` are browser routes. Existing contribution
ancestor/child endpoints provide further bounded context. Exact historical reads
remain available independently; search never falls back to an older revision.

`selection=bounded_current_relevance`, `selection_limited`, `window_exhausted`,
`corpus_exhaustive=false` and `next_cursor` distinguish this selected relevance
window from exhaustive corpus/change history. No total is returned. Cursors bind
owner, normalized query, filters, ranking, source/index/visibility/hierarchy/rebuild
boundaries and position. Only item/byte budgets may change. Edits, moves,
suppression/restoration, index output, rebuild, process restart and five-minute
expiry require a fresh traversal. Every page reauthorizes sources.

`GET /api/v1/search/status` reports `indexing=ready|incomplete|unavailable`,
`coverage=current_supported_text|not_established` and independent direct retrieval.
Coverage examines currently eligible authoritative sources, not a maximum processed
event. A missing R2 stays missing even if R1 is indexed. Original author suspension
does not remove their published text. Suppressed comment parents do not hide replies;
discussion suppression does. Independently authored quotations remain independent.
An area's contribution closure does not hide readable text. Moves affect fresh
scoped queries immediately. No personal or administrative population is indexed.

## Run and stop the worker

Use Node 24.19.0, the built application and configured application-role database
access. Migrations are a separate authorized operation; the worker never applies
them or initializes accounts. Docker provisions dependencies and is not the worker
command protocol.

```bash
npm run app:build
LOOM_PARTICIPATION_PROFILE=synthetic npm run worker:search
# Equivalent native entry point with configured environment:
node --env-file-if-exists=.env.local dist/server/search-worker.js
# One bounded discovery/claim cycle:
LOOM_PARTICIPATION_PROFILE=synthetic npm run worker:search -- --once
```

For the direct Node form also set `LOOM_PARTICIPATION_PROFILE=synthetic` in the
environment. `LOOM_DATABASE_HOST`, `LOOM_POSTGRES_PORT`, `LOOM_DATABASE_NAME`,
`LOOM_DATABASE_USER` and `LOOM_PG_APP_PASSWORD` use the existing application
configuration. The default role is `loom_app`. Readiness rejects privileged roles
and migration-schema access. No participant credential or original publisher
session is required. The code reads retained sources and changes only its derived
records; it does not execute an agent or model.

`npm run app:synthetic` starts a native worker alongside its isolated PostgreSQL
and HTTPS API. Its terminal accepts `worker stop` and `worker start` while the API
stays available. Ctrl-C drains/stops the worker before removing that preview's
temporary database. Unexpected process loss leaves claims for lease recovery.
SIGTERM/SIGINT finish the admitted bounded cycle; SIGKILL relies on leases. Multiple
worker processes may use the same database. The API still has the inherited
single-process cursor-key limitation; multiple workers do not approve multiple API
processes. Heartbeat availability is an observation with a 45-second stale threshold.

## Backfill, failure and rebuild

The first worker scans authoritative typed current sources in 50-source UUID
batches, retaining its cursor. Independently, it discovers immutable event/intents
in bounded batches from its own `(event position, intent UUID)` cursor. A batch may
end between intents without skipping the rest. Publications created or revised
behind the scan cursor are therefore recovered. Discovery position means enqueued,
not completed. A crash resumes both scans; repeated discovery deduplicates work.
Nothing marks other publication projections as completed.
Revision jobs deduplicate by generation/revision; separate generation/intent identity
retains unsupported pairs even when backfill already owns the revision. Migration
0008 preserves existing jobs, attempts and document associations, maps their intent
references, and replays bounded event discovery to recover previously skipped work.
It does not change applied 0007 or reset source scan progress.

Claims use PostgreSQL time, 30-second leases, monotonically increasing generations
and batches of at most 25. Long preparation is outside claim/finalization
transactions, with attempted renewal every ten seconds. Expired claims cannot renew.
Renewal and failure transitions acquire the job lock before a fresh lease-time
check, including when a competing lock holder makes no row change.
After all source/job/state guards, finalization rechecks claim ownership and expiry,
rebuild generation, current source pointer and indexed revision ordinal. Document
association and job success share COMMIT. Failures retry after one and two seconds,
at most three claims; abandoned third attempts become inspectable failures.

Administrators can expand **Search indexing administration**, refresh health and
failed-job pages, retry a selected failed job, or start a derived-index rebuild.
Equivalent routes:

- `GET /api/v1/admin/search/health`: current generation, bounded progress and counts.
- `GET /api/v1/admin/search/failures?after=<id>`: at most 25 safe job references and
  closed failure categories, including source intent IDs and retained earlier-generation failures.
- `POST /api/v1/admin/search/retry`: `{id, claim_generation}`. Only a current failed
  generation resets attempts; repetition never resets a newer running claim.
- `POST /api/v1/admin/search/rebuild`: `{expected_generation}`. Concurrent/repeated
  requests for that generation converge on one next generation; older requests fail.

Rebuild makes the new generation explicit and initially incomplete, then replaces
derived documents as scanning proceeds. It does not delete or recreate publications,
change activity scopes, edit revision bytes, alter Saved items or reset another
consumer. An older worker cannot publish into the rebuild. No manual SQL is needed.
An old-generation failed job cannot be retried into a new generation; its retained
record remains inspectable and the new source scan owns recovery.

Synthetic bounds: 5,000 current typed sources, 50,000 retained jobs, 256 UTF-8 query
bytes/16 parsed nodes (at most eight simple terms), a 200-match selection window,
12 default/25 maximum results, 320-character excerpts and 4–128 KiB uncompressed
serialized JSON. A 2.5-second statement deadline, bounded ownership walks and
strict query syntax constrain work independently of response bytes. Capacity
exhaustion fails explicitly; jobs are not silently evicted. Repeated rebuilds
consume retained job capacity. Retention/pruning and larger production bounds need
separate approval. Query or database timeout is an error, never an empty success.

## Supported requirement portions

SRCH-01 continues ordinary discovery without notifications. SRCH-02 covers the
implemented current shared text population; file extraction, private-note
and historical search remain open. SRCH-03 supports topic/descendant, kind, original
author and current-revision time filters. SRCH-04 supplies exact contextual excerpts
and attribution. SRCH-05 provides independently bounded selected results and explicit
continuation. SRCH-06 applies live source/owner/revision eligibility. SRCH-07 supplies
exact bodies and existing branch/ancestor routes. [Recorded references](recorded-references.md)
adds independent bounded outgoing/incoming expansion for supported text sources,
including exact target revisions; file/private-note expansion remains open.

All three authored formats' source title/body, plus current v3 note text, participate
in selection, worker output, coverage and rebuild. Authored rationale is not lexical
search content. Resolved target titles/bodies never enter the source index. A
stopped worker does not prevent known-target validation or backlink retrieval.

No broad AC06/15/17/20/30/33/37/39 completion is claimed. Saved searches, attention,
notifications, reading state, files, semantic search and agent execution
remain outside this release. See [verification evidence](search-evidence.md) for
executed checks, failure history and remaining limits. Same-machine workers and
clients do not establish cross-machine agent trials or hosted CI results.

## Authored change explanations

Guide 7 adds current revision note text to each owning resource’s existing search
document and explicit change-account filtering. Results identify matching fields;
note-only excerpts link to the exact note. Ranking is simple-title-body-note-v2.
Historical notes remain exact reads, outside current-only indexing. Target metadata
and rationales remain excluded. V3 is eligible throughout worker/status/rebuild.
See the [change notes guide](change-notes.md) for complete requests and bounds.
