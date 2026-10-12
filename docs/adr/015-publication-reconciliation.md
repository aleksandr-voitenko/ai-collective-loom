# ADR-015: Internal publication attempt and safe reconciliation

Status: implemented for the internal `revision.publish` operation. No public
mutation/status routes or client-persisted attempt UI are enabled.

## Semantic identity

An attempt is `(participant_id, operation_kind, idempotency_key)`. The operation
kind is trusted code's `revision.publish`, not an input field a caller can change.
UUID keys/IDs are canonicalized to lower case. Credential ID is deliberately not
part of the namespace: a verified replacement for the same participant can recover
the original attempt; revoked credentials still fail current-state checks.

`text-revision-v1` hashes a fixed JSON tuple containing the version, operation kind,
resource ID, required expected revision (UUID or explicit null for the first
revision of a prepared resource), content format and exact text. Transport ordering,
credential, correlation metadata and the key itself are excluded. Text is neither
trimmed nor Unicode/newline normalized. NUL and invalid UTF-16 are rejected to
preserve PostgreSQL UTF-8 round trips. Unknown fields/unsupported formats are
rejected, including private-audience, mention, reference and manifest fields this
increment does not yet implement. New semantic fields require a versioned digest
compatibility decision; never silently ignore them or recompute old records.

## Resolution order and disclosure

Acquire the attempt mutex even when there is no outcome row, then read the
authoritative outcome under READ COMMITTED. Two preliminary absence observations
do not grant independent permission to insert. Unique scoped outcome rows reinforce
this protocol. The tests force both transactions to observe initial absence before
the mutex, then inspect convergence across all durable effects.

If an outcome exists, check current actor/credential state, current owning context
and action rights, and the stored exact revision's availability. Compare semantic
digests and resolve those original references before any new-write expected-revision
check. A changed semantic request with the same key conflicts; an exact retry can
return the original revision after the current pointer changes.

Mutation replay still requires current editing/publication rights. Read-only
`reconcile` requires current reading eligibility, so editor removal or closure need
not prevent safe recovery of an eligible result. Both paths withhold protected or
removed/suppressed source references. They neither substitute a newer revision nor
replay a cached body, signed URL, credential secret or projection status.
Denied edits to readable published content may be specific. Prepared drafts and
suppressed current/exact revisions use the same unavailable failure as an absent
protected target, without current-revision details.

The success value states only `publication_state=committed`, the attempt disposition
and safe operation/resource/revision references. It says nothing about indexing,
notifications, reading or external delivery. The connection owner must confirm
COMMIT before acknowledging. A transport loss or unknown COMMIT result requires
reconciliation using the same intent; it is not permission to create a new key.

An absent reconciliation row is `not_recorded`, not definitive rollback or a
promise that another queued/future call cannot commit. There is no operation list
or caller-selected participant namespace.

## Retention and remaining gates

This internal foundation has no automatic expiry or cleanup. Outcomes and source
references are retained, immutable to application SQL, with restrictive FKs;
suppression/removal flags do not erase deduplication identity. This is not approval
of indefinite production retention. A reviewed erasure/expiry procedure must retain
safe attempt tombstones or disclose loss of duplicate-free recovery. The architecture's
seven-day proposal remains unselected. Destructive restore requires its separate
recovery-epoch/client-intent contract; ordinary restart tests do not certify restore.

Real PostgreSQL tests cover conflicting input, unchanged exact retry after edits,
replacement credentials, revoked/suspended actors, lost editing rights, owning
suppression and exact-revision suppression. A private child process is killed after
commit and before sending its logical result; a new connection resolves the same
IDs without another revision/event/intent/outcome.

Public authentication/authorization integration, full document/file/entity contracts,
client durable intent, recovery vocabulary and reviewed retention are still required
before participant mutation routes. See architecture §§7.4–7.6, product API-05,
EDT-03–06 and SEC-01–08; this does not mark the complete AC14/AC31 or AV01 fixtures
as executed through participant interfaces.
