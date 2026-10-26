# ADR-039: Prospective file admission and reserved-byte policy

Status: synthetic implementation contract, 26 October 2026. This delivers the
configurable file-admission mechanism in SEC-05; it does not complete SEC-05,
production sizing or operational acceptance. Product v0.9 is unchanged.

## Decision

Store one versioned community policy in PostgreSQL (migration0028, guide23), shared
uniformly by human and agent participants. Administrators can tighten and restore
four positive integer controls:

| API field | Default and initial hard maximum | Meaning |
|---|---:|---|
| `max_file_bytes` | 4,194,304 bytes | Declared size of a newly admitted upload identity |
| `max_unfinished_uploads` | 4 | Reserved waiting/uploading/staged/finalizing/quarantined states per owner |
| `participant_reserved_bytes` | 67,108,864 bytes | Staging-plus-final reservations per original uploader |
| `community_reserved_bytes` | 268,435,456 bytes | The same reservations across retained upload owners |

1 MiB = 1,048,576 bytes. These controls are independent; there is no cross-field
ordering constraint. A file permitted by its individual size still must fit both
byte allowances and the unfinished count. A zero-byte upload reserves zero bytes
but consumes identity and unfinished capacity. If already over a byte allowance,
even a zero-byte new admission cannot satisfy the post-admission bound.

Defaults equal maxima deliberately: this increment does not expand the verified
buffering/storage envelope. Wire schemas and byte verification retain the fixed
4 MiB ceiling, so tightening admission cannot invalidate accepted retries/status.
Manifest entry/byte/path/depth bounds, transfer slots/deadlines, lifetimes, native
version reconciliation, retained identities, logical publication contexts and
processing budgets remain fixed. Higher ceilings require separate compatibility
and workload evidence. Production sizing and retained-decision capacity should be
reviewed before real workloads are approved.

## Accounting and ordering

`file_uploads` remains the sole physical reservation ledger. Charge twice declared
length for staging plus final to its stable original participant, across credentials,
API processes and restart. This is reserved file bytes, not actual provider disk,
billing, database size or complete installation capacity. Infrastructure overhead
and backups are outside the measure. No new ledger, bucket scan or global hash
lookup is introduced.

Policy editing and admission take current actor/credential guards, then existing
custody15. Attempt locks precede actor locks where applicable. Admission takes
source/structure guards afterward. Policy inspection uses custody15 to observe
policy and usage consistently, without source hydration. Policy edits acquire no
publication clock or native storage operation. Existing request-rate admission is
separate and commits first; this policy neither reinterprets its windows nor refunds
charged requests after a domain refusal.

Exact existing upload identities and immutable digests resolve before dynamic
admission checks. Genuinely new identities atomically check every bound and create
the reservation. Admission-first keeps its reservation when a decrease follows;
policy-first applies the decreased limits. Admitted bytes can transfer/finalize
under original declaration/expiry and current source, credential and lifecycle
rules. Grandfathered size is never grandfathered authority or renewed expiry.

Prepared publication and exact reuse do not allocate physical bytes again.
Promotion retains the original uploader's charge and creates independently governed
logical contexts. Existing context limits and PR29 publication-rate rules still
apply. Suppression, manifest omission, account suspension, restart and elapsed
expiry cannot clear reservations. Only existing eligible unassociated cleanup after
proven native removal releases capacity. Failed or uncertain removal remains
reserved/quarantined; published/promoted contexts prevent deletion.

## Controls, discovery and recovery

`GET /api/v1/file-limits` provides committed policy/version, database `observed_at`
and the caller's aggregate reserved bytes/unfinished count with over-limit flags.
`GET /api/v1/admin/file-limits` additionally provides community aggregate reserved
bytes/over-limit. No other owner's inventory, paths, hashes, private targets,
storage keys, personal collections or credentials are disclosed. Snapshot reads
reserve nothing and create no audit/publication/notification/reading effects.

Administrator `/state` requires expected version and a participant-scoped immutable
key. Policy, digest, actor/credential and decision commit atomically. `/status`
reconciles only the current administrator's own key. Original decision and current
policy are separate: K1 replay after K2 never reapplies K1. Changed K1 input conflicts.
`/audit` is a bounded descending immutable-version keyset, default12/max25. At10,000
retained decisions/version10001, new edits stop; inspection and exact recovery
continue. No pruning or expiry regains edit capacity. Routes, including own discovery,
are explicitly recovery/control classified and remain authenticated and rate-bounded.
Ordinary source reads are unnecessary for these controls and existing cleanup.

Lowering below usage is valid and displays the actual over-limit state. Nothing is
clamped, evicted, expired early or removed. Quota denial uses HTTP409
`file_size_limit`, `file_unfinished_capacity` or `file_reserved_capacity` and
`retain_draft_and_inspect_file_limits`. These are a compatible additive extension
to prior errors. Fixed `file_capacity`, native storage errors and temporary rate
throttling remain separate. No refill time or Retry-After is promised for storage;
waiting alone cannot guarantee capacity.

The Administration form uses the existing bounded durable IntentStore/Web Locks.
Save intent before dispatch; preserve uncertain commands through reload/lost replies.
Only explicit correction after a definitive first conflict creates a new attempt.
Policy/usage/audit reads use authorization leases and identity/route/late-response
fences. Composer discovery is informative only; it does not locally block an
admitted retry against newer limits. Refusal preserves text, manifests, metadata and
exact intent. Reload still requires deliberate byte reselection and exact digest/
length verification. No bytes or credentials enter journals. The independent HTTPS
file client provides the same inspect/update/status and staged admission recovery.

## Compatibility and acceptance

The additive migration initializes only the policy row and empty decision table;
no accounts, historical actors or prior decisions are invented. Applied migrations
and prior records/digests are unchanged. Only historical pre0028 upgrade fixtures
use their prior fixed limits; a missing/invalid row in the policy table fails
closed. Apply all migrations for the current release.

Cold backup/restore inventories the new policy and decisions as authoritative along
with exact custody. No new state is exempted from equality. The existing narrow
PR29 allowance for verifier request charges remains unchanged; exhausted file policy
continues to reject new admissions during recovery verification.

Acceptance uses deterministic small capacities, real PostgreSQL/HTTPS contention,
independent usage arithmetic, native cleanup, populated upgrade and compiled browser
journeys, plus normal repository verification. Execution results are reported
separately. No production deployment, retention/deletion policy, automatic eviction,
per-account overrides, quota transfer, higher ceilings or provider change is implied.
