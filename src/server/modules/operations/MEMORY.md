# Operational observations

ADR-040, guide24 and migration0029 own administrator read-only operational inspection.
`inspection.ts` composes existing TextSearch/FileText/NotificationAdministration and
custody15/fileUsage; it never reads personal collections or performs native storage IO.
Shared readiness stays independent. Each component reports attempted time and explicit
observed/unavailable/not_configured state, with null for unavailable values. Independent
transactions are not a cross-component snapshot. Current active account/credential/
parent/admin authority is checked initially and before returning composed observations.

Heartbeat rules reuse45s authored/files and60s notifications. Null is unknown; timestamps
predating this API runtime are prior_runtime even if recent, including restored timestamps.
Recent does not prove coverage. Discovery/missing eligible output, capacity, processing
jobs and request outcomes retain separate meanings. Unsupported/partial file outcomes
are supported contracts. Expiry/quarantine never proves physical reservations released.
Expired-reserved counts exclude uploads with published file contexts: their originals
have no TTL, irrespective of the earlier preparation timestamp.

`collector.ts` accepts only server request UUID, closed operation family/error code,
HTTP status and DB observation time/position. Route templates classify families; URLs,
bodies, targets, recipient/owner IDs, file paths/bytes/digests, credentials and arbitrary
exception text are excluded. Actual classified refusals are observed after domain
handling, not inside domain transactions. Samples describe attempts, never commit proof.
Posting closure and operational-health requests themselves are excluded from capture.

A1024-slot ring bounds global retained rows; last24h is a live evidence window. Expired
rows are deleted only on admitted capture, so bounded idle expired slots can remain.
No existing audit/source/private/custody records expire through this mechanism.
Class18 nonblocking advisory lock and DB singleton100ms admission bound global samples;
one active capture/process and100ms local floor, no queue or retry, bound process work.
SQL100ms, lock25ms, transaction250ms and existing pool acquisition timeout bound failures.
Domain responses never await collection. Close drains one capture before DB disposal.
Local loss saturates at2147483647; failure latches and emits one fixed safe warning.
Responses always disclose incomplete_sample, including empty results and after restart.
Other-process and previous-runtime losses are not measured by process counters.

Outcome queries use numeric descending keysets (qualify the numeric SQL column when
selecting a text alias), at most25 rows and1024–32768 complete serialized UTF-8 bytes.
Live expiry/replacement can remove unseen samples; refresh observes new records.
Job pages reuse existing26-row queries and return at most25 safe ID/code references;
refresh after worker/recovery changes. Oversized response prefixes never skip a row.
All five routes are recovery_control and classified retrievals for error uncertainty.

Both new tables are observational-captured during cold recovery, never broadly ignored.
Initial restore compares everything exactly. The application verifier subsequently
accepts only its actual request-correlated samples, legal expiry and slot replacement;
all unrelated domain/custody/private/worker state remains compared. See scripts memory.

Native acceptance: `tests/integration/operations.test.ts`; restoration/accounting:
`tests/integration/recovery.test.ts`, `tests/bootstrap/recovery-accounting.test.mjs`.
Browser and independent HTTPS client use the same closed contracts. No new repair,
rebuild, cleanup, retry-all, monitoring deployment or production sizing is implied.
