# ADR-033: Owner-private notes and lexical search

Status: implementation decision for the synthetic profile, 24 October 2026.
Product v0.9 IDN-06, SRCH-02, REF-03, MEN-01 and SEC-01/03/08/09 govern
behavior. Baseline main is 8f018e8. Acceptance execution is recorded separately;
the product and architecture snapshots remain unchanged.

## Identity, content and authority

Use a dedicated module and additive migration0023, with no shared resource,
revision, reference, mention, event, outbox or worker entry. The authenticated
participant is always the owner, including for administrators. A client supplies
one immutable UUID note identity before creating its exact command. Identity is
scoped to its owner; neither credentials nor operation keys define a new owner.
Multiple notes can cite the same source. Plain text is intentional: HTML, Markdown,
URLs and nickname strings are displayed literally and never fetched or interpreted.

An optional title, nonblank body and up to eight explicit links comprise current
content. Links name discussion, contribution (including opening), summary or artifact;
only the latter three accept an exact revision. New/changed links require current
read eligibility and exact membership under the existing complete source guard plan.
An unchanged retained link requires no new source permission for body editing,
link removal or deletion. Source metadata is an explicit, separately authorized
projection; it never enters the note text or search corpus. Owners may deliberately
quote text; source suppression cannot recall those independently authored copies.
Closed but readable sources remain eligible. Saved target kinds remain unchanged.

## Commands, ordering and deletion

`owner-notes-1` defines create/update/delete and read-only status. Canonical SHA-256
digests bind action, note UUID, expected version (zero for create), exact title/body,
and sorted canonical link identities. Duplicate links fail. Matching retained
attempts resolve before new version, source or capacity checks; changed semantics
under one participant/action/key conflict. Receipts contain original decision,
expected/result version and time separately from current active/deleted identity
and version. They contain no old/current title, body, links or preview. Only a
current authorized detail read returns current text.

Lock order: scoped attempt; current participant/credential; owner-specific note
advisory guard (exclusive writes, shared reads); shared structure and sorted full
source guard plan for newly introduced links/projections; exact revisions; private
writes. READ COMMITTED observes preceding owner writes after the guard. Recheck
current credentials after contested waits. No shared clock, network or user wait
occurs in note transactions. SQL/lock/transaction deadlines are2.5s/1.5s/15s.

Every successful write increments the private note and owner collection versions.
Different writes expecting one version have one winner; retained conflict decisions
permit exact reconciliation without overwriting a later choice. Terminal deletion
atomically removes current title/body, links and lexical data. A minimal identity,
version and creation/update/deletion timestamps remain, plus content-free digests/decisions. A database
guard forbids reactivation; note identities are never recycled. Old committed retries
return their original decision and current deleted state; late unrecorded saves
cannot restore content. There is no history, Trash or undelete.

This is application-row deletion, not immediate secure erasure of PostgreSQL pages,
WAL, replicas, exports or future backup archives. Account erasure, production retention
and coordinated restore remain separate gates. Infrastructure/database/backup owners
and authorized credential recovery remain trusted powers; ordinary administrators
have no note-browsing or impersonation interface. No encryption promise is made.

## Finite synthetic work

Per owner:128 active notes,500 retained identities including tombstones,10,000
general decisions including conflicts. One successful deletion per admitted identity
has reserved decision capacity, independent of the general budget. At that budget
a stale delete can require a fresh current read; exact status/replay remains usable.
Title256 UTF-8 bytes, body16KiB, eight links/2KiB canonical link JSON; transport128KiB,
detail128KiB including JSON escaping. No silent truncation of detail or eviction.

Search/list uses POST body state, never prose/query URL parameters. Trim and collapse
query whitespace, cap256 UTF-8 bytes and32 whitespace terms, then use PostgreSQL
`plainto_tsquery('simple')` against transactionally generated `to_tsvector('simple',
title || ' ' || body)`. All lexical terms match (punctuation is parser input, not
query syntax); nonempty queries without lexemes match nothing. Empty query lists
active notes. Owner filtering precedes all selection. Stable note-UUID ascending
order avoids inferred relevance; at most128 active rows are candidates,25 results
per page (default12). Excerpts are explicitly abbreviated prefixes (160 characters),
not complete bodies or highlighted HTML. No total count is returned.

Pages cap complete serialized UTF-8 JSON at32KiB (caller budget1–32KiB), including
escaping, links and continuation. An item that cannot fit an empty page returns
an explicit budget error. Encrypted process-local five-minute cursors bind owner,
normalized query, stable ordering, private collection version and last UUID.
Own successful writes invalidate traversal; other owners and source changes do not.
Restart requires a new traversal, preserving notes and outcomes.

## Browser custody and independent clients

The actual Notes route is a settings authorization host: owner-only detail/search
reads and recovery remain independently authorized while each generated source
projection checks its own lease. Source denial still revokes older projections
globally. Identity loss withdraws the private view. Private receipts never authorize
source metadata. Source actions seed only structured identity, never source text.

Use existing origin/instance/participant IntentStore,32 records/1MiB, with Web Locks,
exact write/readback and no network under storage locks. Drafts and immutable
commands may retain private prose on this device without expiry. This is not
encryption from its owner. Existing export/sign-out behavior applies; exported
journals are deliberately private recovery files, not diagnostics. Server deletion
cannot clear other tabs/devices/exports. Explicit clearing removes only safe local
note copies; it does not affect unrelated publication records.

An uncertain update may coexist with a deliberate delete of the same known note
at a freshly inspected version. Keep the uncertain bytes unchanged; overlap guards never block an exact retry. A current
authorized terminal tombstone for that exact owner/note permits explicit forgetting,
without asserting whether the earlier update committed. Validate the tombstone and
version under the local journal lock; late replies and queued autosaves cannot
recreate removed persisted note records.
No absence, failed retry, or missing status provides this exception. If local
custody fails, do not dispatch deletion; explain the storage/recovery constraint.

The independent HTTPS example uses separate fsynced private command and output
files, with credentials elsewhere and non-secret console receipts. Replacement
credentials retain the same participant/attempt. Local processes do not constitute
human, cross-machine or provider validation.

## Alternatives and reconsideration

Shared resources would risk publication/index/backlink leakage; revision archives
would retain deleted bodies. Dedicated mutable content plus minimal terminal fences
avoids both. Stable ordering and explicit cursor invalidation are simpler than
retaining historical private search snapshots. Reconsider numeric limits, global
storage sizing, multi-API cursor custody and local recovery policy when measured
workload or approved production requirements demand it, preserving exact decisions,
current authorization and terminal identity. No existing quota policy is changed.
