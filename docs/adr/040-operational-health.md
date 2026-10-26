# ADR-040: Administrator operational observations

Status: synthetic implementation contract for OPS-07. Execution evidence is separate;
production operation, sizing, retention of existing product data and external monitoring
remain outside this increment. Product v 0.9 and applied migrations are unchanged.

## Sources and privacy

| Subject | Authoritative source reused | Missing observation added | Allowed response fields |
|---|---|---|---|
| Uploads | file_uploads, fileUsage and custody15 | Community incomplete/quarantine/expired-reserved aggregates | Counts of uploads, staging-plus-final reserved bytes, time |
| Authored indexing | TextSearch health/status/failures | Explicit recorded heartbeat qualification | Existing job counts, generation/discovery/capacity, eligible current supported coverage, time, safe job ID/code |
| File indexing | FileText health/status; contextual jobs/state | Processing counts and missing-discovery qualification | Per-context job-state counts, generation, derived byte reservations, missing-discovery flag, time, safe job ID/code |
| Activity recovery | NotificationAdministration health/failures; actual traversal error envelopes | Safe observed shared/personal/combined recovery refusals | Existing job/gap counts, discovery/capacity, heartbeat, safe job ID/code; sampled outcome category |
| Publication conflicts | Actual publication revision/idempotency refusal | Safe rollback-independent request sample | Server request UUID, observed time, closed operation family/error category, HTTP status, numeric position |
| Permission denials | Actual HTTP authentication/authorization refusal | Same bounded sample | Same fields; never submitted actor/target/credential identity |

No inbox, note, draft, Saved/Following/reading collection or private outcome body is
queried for diagnostics. No title, prose, query, path, bytes, digest, native key,
URL capability, exception text/stack, IP, user agent, token or cookie is collected.
Only the closed response error code is inspected after domain handling. Successful
cleanup quarantine remains visible through authoritative custody; no fabricated
failed-request sample is added. Posting closure is excluded from authority denial.
Job identifiers cannot download or retry anything. Unknown stored job reasons become
the closed `unknown` category, never arbitrary strings. Independent source retrieval
retains ordinary current authorization, including suppression.

## Meanings and bounds

GET /api/v1/admin/operational-health composes independent bounded observations;
it does not claim a transactionally fixed cross-component snapshot. Each component
has its own attempted observation time and explicit observed/unavailable/not_configured
state. Unavailable values are null, never zeros. Public readiness remains unchanged
and establishes only API/database readiness. Native storage reachability is unverified:
inspection performs no native IO, scan, extraction, enqueue, lease renewal or repair.

Heartbeat timestamps are recent within the existing 45-second authored/file or 60-second
notification windows. Null means unknown; a timestamp predating this API runtime is
prior_runtime even if recent. Otherwise it is recent or stale. These are synthetic
observation rules, not liveness guarantees or production latency commitments. A fresh
API runtime cannot certify restored worker health from a retained timestamp. Empty
queues/failure pages do not establish discovery or current eligible output coverage.
Supported partial prefixes and unsupported file formats are separate processing
outcomes, not incidents. Expired-reserved upload counts exclude published file contexts;
their original files have no TTL even after preparation expiry. Unassociated expired
upload reservations remain charged until existing
eligible native cleanup proves removal. No new reservation ledger is introduced.

Notification history gaps/epochs/missing traversal custody differ from normal
expiry and explicit visibility replay. Publication conflicts differ from service
failures. Request samples describe observed attempts; neither absence nor an error
establishes whether a previous command committed. Exact owner reconciliation remains
authoritative for uncertainty.

## Collector failure isolation

Migration 0029 owns only two new observational tables. A reusable 1024-slot ring stores
at most 1024 fixed-schema request samples, across all API processes. Each row is under
512 serialized UTF-8 bytes. The evidence window is the last 24 hours, possibly shorter
because of slot replacement. Old records are excluded from reads and deleted on the
next admitted capture; idle installations can retain bounded expired slots physically.
This is a finite observation window and bounded storage, not a secure-erasure claim.
No historical observations are backfilled and no existing retained record is pruned.

One in-flight capture per API process, no queue, and a 100 ms process admission floor
bound in-memory work. A nonblocking transaction advisory lock (class 18), singleton
PostgreSQL-time admission and slot replacement cap admitted global samples at 10/sec.
The existing connection acquisition timeout bounds pool waiting; SQL 100 ms, lock 25 ms,
transaction 250 ms bound capture work. Capture begins only after domain handling, outside
all publication/recipient locks; the response does not await it. No domain operation
can be failed, rolled back, retried or re-keyed by collector failure. Closing drains
that one owned capture before database disposal.

Coverage always says incomplete_sample. Local drop count saturates at 2147483647;
collection failure latches for the process and emits one fixed warning with no error
object. There is no recursive capture of operational-health requests or the warning,
no memory fallback log and no automatic retry. Restart resets local loss evidence;
other-process losses are not measurable from that counter. Ring samples survive
restart. This deliberately rejects a comprehensive audit/event log, private-body
mining or a new infrastructure dependency. Reconsider sampling/window limits only
with explicit operational needs and measured costs; these defaults are synthetic.

## Queries and browser

Every overview/page checks current active participant, credential/parent and admin
role, including continuations. Composed sources recheck administrator authority
before return. All new routes are explicitly recovery_control, authenticated and
bounded, even after ordinary exhaustion. POST outcomes/failures are retrievals for
5xx uncertainty policy, never domain mutations.

POST /admin/operational-health/outcomes accepts cursor (numeric position), limit 1–25
(default 12), max_bytes 1024–32768. Numeric descending keyset order returns a prefix
that fits the complete serialized UTF-8 JSON; it never skips an oversized item.
The 24h cutoff and oldest retained sample disclose the actual finite window. This is
a live retained window: expiry/replacement between pages can remove samples, and
newer observations require Refresh. `complete` ends only that page's current retained
selection, never the incident population. Cursor possession conveys no authority.

POST /admin/operational-health/{authored|files|activity}/failures reuses existing
bounded job discovery, returns at most 25 safe references and a UUID continuation.
Job traversal is live; refresh after processing/recovery changes. Complete 32 KiB
JSON and existing finite source/job populations plus SQL deadlines bound retrieval.
Neither maximum progress nor an empty partial scan is advertised as full coverage.

Administration mounts this compact section only when opened. Explicit Refresh and
on-demand failure/outcome pages use existing authorization leases and request/identity/
route ownership. It retains one page and at most 16 previous cursor positions.
Transient failed pages retain prior authorized rows labelled stale, exact retry
position and native focus through aria-disabled controls. Authority denial withdraws
protected rows and fences late successes. No polling, mutation controls, new recovery
journal, notification acknowledgement or personal state change is introduced.
Existing separate recovery controls retain their contracts.

The independent operational-health-client.mjs uses HTTPS only, private credential
and result files and one bounded page per invocation. It imports no server code.
Guide 24 and generated OpenAPI share the browser's fields and classifications.

## Recovery and acceptance

Physical cold restore compares every new row exactly before application verification.
These tables are observational, but do not receive a blanket inventory exemption.
Application verification may create only identified samples from its own actual
HTTP responses; prior samples, slot replacement/expiry and capture position must
be validated against that finite set and database-time interval. Existing domain,
private, policy, native version and request-accounting rules remain unchanged.
Retained heartbeat timestamps never prove current workers after restoration.

Acceptance requires real cookie/bearer HTTPS collection, native failure injection,
actual independent worker stop/resume, privacy canaries, bounded loss/queries,
current authority races, compiled UI ownership/focus/narrow layout, whole meaningful
state preservation, populated upgrade and cold recovery. Standard check, native,
compiled-browser, diagnostics, coverage and isolated storage/persistence paths remain
required. Automated results do not establish human/device/provider trials, production
capacity, external alerting or complete operational acceptance.

The full acceptance run exposed incompatible tsx/Playwright generated maps for
the same server module during coverage normalization. Browser entry points now
preload tsx and leave application, script and compiled imports outside Playwright's
test transformation. A real dual-host import regression checks the shared source
through the existing strict normalizer. No map is dropped or rewritten; original
counter merging, source identity, inventory, concurrency, deadlines and all four
coverage gates remain unchanged. This is supporting verification work, not a
change to the production compiler or operational-health meaning.
