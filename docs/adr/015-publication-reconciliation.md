# ADR-015: Internal publication attempt and safe reconciliation

Status: implemented for internal `revision.publish`, the identity prototype and the
opt-in synthetic `participation-1` HTTP/browser slice. Production retention and
destructive-restore recovery remain unapproved. The original digest stays supported.

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

The participation extension below supplies authentication, minimal authored entities,
durable intent and recovery vocabulary for synthetic routes. Full document/file
contracts and reviewed retention remain gates before real use. See architecture
§§7.4–7.6, product API-05, EDT-03–06 and SEC-01–08; this does not complete the whole
AC14/AC31 or AV01 scenario.

## Identity prototype extension

[ADR-004](004-identity-admission-prototype.md) keeps account creation separate from
credential issuance. Both reuse the existing transaction owner and extracted
absent-row attempt mutex. An administrator's current participant ID, a fixed
operation kind and UUID key define the attempt, independent of the credential used.
The five controlled kinds are account creation, state/role change, rename,
credential issuance and revocation; reconciliation accepts only that known set.
Reauthorization requires current administrator authority before disclosing an outcome.

`identity-prototype-v1` hashes a fixed JSON tuple of every accepted substantive
field. Creation includes exact display nickname, participant kind and role;
issuance includes target participant, credential kind, enrollment purpose, label
and selected replacement ID/null. State/role, rename and revoke include their
target and complete requested change. UUID spelling is canonicalized; display case
remains substantive, while nickname reservation uses ASCII lower case. Credentials,
request IDs, key and generated secrets are excluded. Unknown fields and coercion
are rejected. A changed request with the same key conflicts.

Identity outcomes store safe participant/credential references, digest/version and
operation identity, with their private audit in the same transaction. They have no
authored body, public activity event or recoverable secret. A separate table is
necessary: publication outcomes require a revision/source event, and synthesizing
those for private account administration would expose inappropriate shared activity.
Exact retries resolve saved references before new nickname/quota checks. Safe status
is read from current credential state/expiry; suspended or revoked administrators
cannot recover outcomes through stale sessions or bearer credentials.

Only a **fresh successful COMMIT** may return the generated agent/enrollment secret.
A committed issuance retry/status returns IDs, current state and `revoke_and_replace`,
never the original secret or an automatically issued successor. An unknown/lost
acknowledgement is reconciled with that same key. The administrator can then revoke
and deliberately replace the uncertain credential on the same participant. Lost
account replies likewise reconcile the original account without another participant.

Bootstrap precedes any participant actor and therefore uses an explicit fixed
deployment scope with separate bootstrap/recovery capability proofs and audit
classes. A singleton initialization row closes new bootstrap attempts permanently;
recovery issues a ticket for its existing first-administrator identity. It does not
create another account or promote/demote/reactivate it. This exception is offline
trusted deployment code, absent even from private HTTP fixtures.

Identity outcomes/audits/reservations have no production cleanup or approved
retention in this prototype. Private controlled races, post-COMMIT reply loss,
rollback, credential replacement and revoked authority are observed in the
[identity evidence](../development/identity-prototype.md). Real-user recovery proof,
operator custody/rotation and policy approval remain gates before real exposure.

## Text participation extension

`participation-text-v1` introduces closed operation-specific requests for
`community.setup`, `discussion.create`, `reply.create`, `artifact.create` and
`revision.publish`. Hash the version, fixed operation kind and canonical semantic
object: every accepted field except the key participates, including target IDs,
title, exact text, format, entities and expected base. UUIDs become lower case;
entity arrays sort by token; object key order is irrelevant. Exact text and token
spelling remain substantive. Do not recalculate earlier `text-revision-v1` outcomes
or reinterpret their `text/plain` bodies as participant Markdown.

Constructors, the new revision/title/mention rows, conditional pointer, ordered
event, outbox intent and saved outcome share the existing transaction and final
`commitRevision` tail. No second publication protocol, notification delivery or
browser-only authority is introduced. Setup also creates the two ordinary root
areas, overview/editor and versioned singleton configuration atomically. Its
configuration guard is `(0x4c4f4f4d,3)`, before its own resource insertions and clock.
The common structure guard remains the authority for containment changes.

`POST /operations/status` is authenticated, owner-scoped and read-only. It takes
the same attempt mutex and returns safe original references under live read
eligibility. Exact mutation retries additionally recheck current action rights;
closure/editor removal may deny retry while allowing read-only reconciliation.
Both channels suppress ineligible result references. `not_recorded` is still
uncertain. Success means committed source publication, not completed indexing.
Search is the only enabled derived worker; attention projections remain disabled.

Configuration/editor-list mutations keep expected numeric versions and immutable
private audit outcomes with all semantic fields hashed. They do not append a
content revision or public activity for private administration. A changed request
under the same kind/key conflicts. Only administrators manage artifact editor lists.

The browser stores intent before dispatch; the standalone external client fsyncs
its journal before sending. Both scope it to origin, instance and participant.
Actual tests discard a committed response and restart client processes before
recovering the original IDs. See [ADR-017](017-browser-participation-recovery.md)
and the [slice evidence](../development/participation-evidence.md). Automatic expiry,
erasure and recovery after rollback of committed history remain closed gates.

## Private Saved items extension

[ADR-013](013-private-saved-items.md) uses the same current authentication, scoped
attempt mutex and transaction owner for fixed operation kind `saved.set`, with
`saved-state-v1` semantic hashing. Private target versions and immutable decisions
live in separate tables and never enter the shared publication clock/event/outbox.
Owner/target versions fence delayed first commands after an opposite action; retained
operation identity alone would not do so. Exact retries resolve before new-version
checks, with the original decision explicitly separate from current bookmark state.
Applied and version-conflict decisions are both retained without automatic expiry.

Unlike publication status, bookmark status may show the caller's already retained
private target identity while its source is unavailable. It returns no cached source
metadata; each current source projection still uses the common reading policy. A
known unavailable target can be unsaved without reading it. No shared-publication
disclosure or retry requirement is weakened. Synthetic quotas and restore/erasure
limitations are specified in ADR-013 and the release guide revision 2.

## Organization extension

[ADR-020](020-topic-organization.md) uses `organization-v1`, scoped by participant,
explicit operation kind and key. Every semantic field, including resource and
hierarchy preconditions, participates. Exact committed retry precedes new version
checks; immutable original state and freshly authorized current state are distinct.
K1→B, K2→C, retry K1 leaves C current. Current administrator authority is required
for both mutation and status; suppressed targets or original scopes are withheld.
Audit contains IDs/versions/time, not metadata bodies or credentials. Area metadata
history has its own attributed snapshots, separate from administrative audit.

Optional `proposal_context` on ordinary discussion creation binds an affected area
and expected community-settings version. It is included only when supplied, so
existing participation-text-v1 digests remain identical. Its stable reference is
retained on the discussion and exposed only when the area remains readable. There
is no proposal workflow or special authority. Changing the designated destination
rejects the frozen request; an exact committed retry still resolves its old outcome.

## Recorded references

[ADR-021](021-recorded-references.md) adds `participation-text-v2` only for
`loom-markdown-v2`. Logical ID, target kind/resource/exact revision, relationship
and exact rationale all enter semantic identity. V1/internal digests and retained
requests remain unchanged. Exact retry resolves before new-target validation and
does not reapply references after a later withdrawal. A v1 edit of a v2 base is
explicitly refused before writing; empty v2 lists represent deliberate withdrawal.
Assertion changes and withdrawals derive attribution from authenticated revision
publishers, never client-supplied ownership fields.
