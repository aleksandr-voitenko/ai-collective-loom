# Advisory editing intent

`reservations.ts`, contracts/reservations.ts and http/reservations.ts implement
editing-intent-1 (ADR-032, migration0022). Publication never imports this service,
queries notices or changes its existing request/digest semantics. Existing concrete
contributions (actual openings/comments), summaries and artifacts are eligible.
An exact historical base is accepted with current editing authority; no automatic
rebase, overlap resolution, path interpretation, presence or publication coupling.

Attempt → actor/credential → custody17 → shared structure1 → sorted owner resource
SHARE guards → exact revision SHARE → reservation-only writes. Editor/lifecycle
writers conflict with these existing guards. No shared clock, object IO, outbox,
notification, content revision, coverage, personal state or worker operation occurs.
SQL2.5s/lock1.5s/transaction15s, owner32. Recheck actor/time after relevant waits.
`authorizeEditor` shares existing author/editor/admin rules; notice closure has a
separate local error, leaving publication's old forbidden response unchanged.

Announce creates notice/version1; renew/release name that notice and its version.
No identity is recycled. One unexpired unreleased notice per owner/resource; peers
can overlap. Explicit renew requires current edit authority and exact-base access,
and computes fixed expiry from database time; default30 minutes, explicit1–120.
Renew cannot revive expiry/release. Release requires only an active authenticated
owner and known notice/version, even after expiry or source/editor loss.

Original accepted operation timestamps/version are immutable, returned separately
from current temporal state. Exact replay/status disclose no protected source IDs,
purpose, scope, label or body; they require current actor credentials but no source
hydration. Credential replacement remains participant-scoped. not_recorded and
cancelled/failed status are uncertainty, never permission to re-key.

Retain100 notices/resource,128/owner,4096/community; active25/resource,16/owner.
General decisions10000 plus one reserved terminal release per admitted notice.
Capacity blocks new announce/renew only; expiry needs no decision. Records are not
evicted; production time retention/erasure remains unapproved. Text bounds512/256
UTF8 bytes, request4096, complete JSON response32768, pages default12/max25.
Inspection scans at most100 exact-base candidates before selecting visible items.
Escaping reduces page item count without truncation. Encrypted2048-byte/5-minute
cursors bind caller/resource/eligible IDs, versions and temporal states. Hidden
notices produce no count/cursor positions. Restart invalidates cursors, not custody.

Private receipts never authorize new source reads. Browser metadata uses the
existing authorization coordinator and exact identity journal; see web memory.
Native suites use real PostgreSQL waiters, fixture-injected expiry separately from
a real one-minute wait, populated0021 snapshots and standalone fsynced HTTPS clients.
Coverage discovers test:reservations:postgres through the normal package inventory.
