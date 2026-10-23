# ADR-031: Passive file text and contextual Files search

Status: synthetic implementation contract, 23 October 2026. Extends ART-06 and the
supported-file portion of SRCH-02, preserving ADR-006/012/015/016/017/027–030.
Execution evidence is separate. Product/architecture snapshots remain unchanged.

## Representation

Use `literal-utf8-v1`: authenticated JSON for one exact published artifact file or
contribution attachment. The deterministic decoder requires no native converter,
uploaded module, shell, document interpreter, external reference or model. React
renders text nodes in a wrapping `pre`; no authored Markdown/entity parser,
innerHTML, iframe, automatic links/images, executable blob preview or full-main-text
reading registration. Original downloads retain ADR-029's separate passive path.

Candidate extensions are exactly `.txt`, `.md`, `.csv`, `.json`, `.js`, `.ts`, `.py`,
`.go`, `.rs`, `.c`, `.h`, case-insensitive in the final segment after a nonempty
basename. Plain names such as `txt` and dot-only `.txt` are not extensions. All accept declared
`text/plain` or `application/octet-stream`. Additional pairs: md `text/markdown`;
csv `text/csv`; json `application/json`; js `text/javascript|application/javascript`;
ts `text/typescript|application/typescript`; py `text/x-python`; go `text/x-go`;
rs `text/x-rust`; c/h `text/x-c`. Upload syntax already normalizes MIME case and
rejects parameters. Other pairs are unsupported. Names/MIME never prove safe bytes.

Validate the entire exact length/SHA-256-verified native-version input using fatal
UTF-8 decoding, including an unretained suffix. Preserve BOM, CR/LF and tabs. Reject
C0/C1 controls except TAB/LF/CR, including NUL/DEL. Never use replacement decoding.
HTML fragments inside supported text remain literal; `.html`/`.svg` are unsupported.
JSON/CSV/code is never interpreted as structured or executable content. Unsupported
originals still publish/download. Images, PDF/office conversion, archive extraction,
OCR, notebooks as applications, rich Markdown, syntax plugins, embeddings and private
notes remain deferred. This JSON representation does not claim the architecture
proposal's cookie-free rich-preview origin or operating-system parser sandbox.

Retain at most 65,536 UTF-8 bytes at a complete character boundary. Longer valid input
is partial; its suffix is not searchable. Pages contain at most 4,096 Unicode
characters and 32 KiB complete serialized JSON (default/max), reducible to 4 KiB.
Escaping/envelope/cursor count; smaller pages never skip text. Five-minute
instance-local encrypted cursors bind participant, exact owner/revision/context,
contract, native identity, rebuild generation and character offset. API restart
invalidates traversal, not extraction/originals. `retained_text_complete` ends only
the retained prefix; `source_complete` is independent. Empty supported text is `""`;
unsupported/failed/pending text is null.

## Context and authority

Each context has its own job/document, pinning revision/upload/native version,
verified size/digest and decoder contract. No global hash capability, deduplication
API or shared-blob counts. Reprocessing changes derivatives only, never original
times, sets, notes, attribution, attempts/digests, source events or private state.

Exact preview/status and search result projections lock current actor/credential,
current owning chain and exact revision and verify the contextual identity before
returning file metadata or text. Safe hidden/missing
errors remain identical. Reply ancestry is not ownership. Promoted artifacts never
hydrate or authorize through their source. Source suppression immediately withholds
its previews/status/excerpts despite stopped workers; independent artifact/reply
contexts remain separately eligible. Restoration clears only its own restriction.
Output/cursors never grant authority; previously delivered copies cannot be recalled.

The exact file page uses the ordinary conservative withdrawal boundary, without an
optional unavailable-source projection or changes to PR #21's attribution repair.
Status is separate from preview; an explicit status action can check authority while
body refresh is pending. Late success cannot restore text after denial/navigation/
identity change. Tree history state preserves the chosen folder/page without changing
the resource URL or reading episode. Search URLs preserve query/filter/cursor intent.
No preview/excerpt creates mentions or marks source text read. Protected HTTP
no-store/nosniff rules apply; no shared cache/service worker is added.

## Bounded recoverable work

Migration 0021 adds only file_text state/jobs/documents. Earlier migrations, existing
rows and immutable intents stay intact. A separate same-release file-text worker
uses loom_app and ADR-029's native storage boundary; authored search and personal
notifications neither consume nor depend on file jobs. Malformed files cannot block
publication, ordinary text search or unrelated jobs.

Discover at most 25 missing/stale jobs per transaction using an indexed anti-join
over committed file_contexts. Committed jobs are resumable progress: no one-way UUID
cursor or concurrent-publication gap. Historical contexts are processed for eligible
exact previews after replacement/omission. Private uploads/preparation are excluded.
Jobs cap at 65,536, matching the existing finite contextual publication population;
older over-cap data stays intact and missing work reports capacity explicitly.
When job admission is full, bounded discovery still resets stale retained jobs;
a missing low-ID context cannot block their rebuild. Capacity reporting checks
missing contexts independently of the selected recovery batch.

Two process admissions precede native reads and their DB waits. Claims use SKIP
LOCKED, database time, monotonic claim generations, 30-second leases and attempted
10-second renewal. Three attempts with 1/2-second retry delays end in retained safe
failure. Expired claims cannot resurrect after lock waits. Suppressed contexts may
be processed nonpublicly; completion never grants participant authority.

Keep at most 32 MiB raw retained text plus reserved in-flight output. Each claim
reserves additional space for a complete 64 KiB output, accounting for an old body
and abandoned reservations. Job/state locks serialize admission. Fixed metadata and
lexical index overhead are separately bounded by job population/text cap; this is
not a physical disk reservation. Inputs retain ADR-029's 4 MiB/file, four storage
admissions and 15-second IO deadline. Capacity is explicit derived failure, never
eviction, source deletion, empty extraction or an uncommitted publication.

Discovery/rebuild use advisory class16. Discovery and claim batches lock jobs in
file-ID order before state. Finalization takes source SHARE, exact revision SHARE,
re-reads immutable context/native input, then job UPDATE and state UPDATE.
file_contexts keeps no-UPDATE/no-DELETE grants: no row-lock privilege is added.
Check exact input, owner/claim generation, rebuild generation and DB lease time
after all waits and before effects. Output, lexical document, accounting, index
version and terminal job state share COMMIT. No IO/decoding holds publication locks,
and no source mutation/public clock tail is added.

Admin retry compares file/claim generation and resets only failed work. Older
accepted generations converge without reapplication. Rebuild compares the expected
generation; exact repetition returns the next generation, older mismatches require
refresh. Bounded discovery resets stale jobs and replaces documents. Original
contexts/versions, other consumers and authored cursors remain unchanged. Persisted
state resolves old claims/process death/lost COMMIT acknowledgement. Failure tokens
never contain text, source bodies or storage credentials.

## Additive Files search and status

GET /search/files has independent schemas/rank/cursors and browser Files mode.
Existing /search kinds, fields, ranking, health and cursors retain their meaning.
Match only retained contents with normalized PostgreSQL simple lexical AND; rank
descending/context UUID ascending. Names/titles have no matching/ranking weight.
No semantic, substring or universal code-symbol claim. Exact indexed/current owner
revision equality is mandatory: R1 cannot substitute for an unprocessed/suppressed
R2. Independent contexts can both match; retries never multiply a context.

Topic filters use current canonical placement. Author means owning publication's
original author, time means matching revision publication, publisher is separate;
promotion does not assert byte authorship. Results identify owner/revision/context/
path, authorized location/attribution, partial excerpt, extraction qualification,
exact preview/download and surrounding context. No source-attribution lookup is
needed for independent promoted results.

Bounds: 256 query UTF-8 bytes/16 parsed nodes, 5,000 typed sources, 200 selected
matches, 12 default/25 max entries, 4–128 KiB JSON, 320-character excerpts, 32 owners
and 2.5-second SQL statements, 1.5-second lock waits and 15-second transactions.
Cursors bind caller, normalized semantics/rank,
source/shared, visibility, organization, file index/rebuild generations and five-minute
expiry. Changes require explicit restart. Mode switching preserves filters and
removes the old cursor. Summary file scope is empty in this release.
Preview responses separate structured exact-source context_url from browser context
navigation. Cursor expiry retains an explicit first-page action for the same file.

Lifecycle distinguishes not discovered, queued, running, complete, partial,
unsupported and failed. Worker unknown/online/offline reflects a heartbeat within
45 seconds, not guaranteed liveness. Extraction/index availability remain explicit.
Coverage has no participant job counts. Ready retained prefixes require recorded
eligible outcomes and recent worker health; unsupported formats/partial suffixes
remain outside matching. Empty selected pages do not certify all-format coverage.
GETs never enqueue, publish, mark read or repair work.

Guide16/OpenAPI, browser and independent HTTPS example ship together. The native
example writes exact JSON to new private files and prints safe receipt/cursor
metadata, preserving query input and unrelated command journals through restart and
legitimate same-participant credential replacement. The isolated launcher independently
supervises file processing with files stop/start.

Reconsider support for a concrete new passive format and its isolation/resource
tests; reconsider limits with measured workloads and approved capacity/retention.
Broader parser/origin support, production storage/backup/erasure and cross-machine
human/provider acceptance require separate decisions and evidence.
