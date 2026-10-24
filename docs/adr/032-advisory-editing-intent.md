# ADR-032: Advisory editing intent

Status: implemented for synthetic participation; pending user review. Based on merged
PR22 at bf99c52656e68ff109bb8c5974eb22a20ad3a06c. Product v0.9 EDT-01–06
governs behavior; architecture v0.3 is supporting design context.

## Decision

Use a separate reservation module with no dependency from publication. Existing
contributions (including openings), summaries and artifacts accept literal purpose
and whole-resource or described scope, anchored to an eligible exact revision.
The description is participant text, never a path capability or stable range.
One unexpired, unreleased notice per owner/resource is effective; peers may overlap.
Historical bases remain historical. No notice grants authority or prevents publishing.

Announce creates a unique notice at version1. Renew and release name that identity
and expected version. Renew requires unexpired intent and current edit authority;
expired intent requires deliberate new announcement. Release is owner-only and may
retire expired intent. It does not read the source and remains available after edit
or source access loss. Status and exact mutation replay similarly return only the
owner's minimal original timestamps/version and current temporal state, never
purpose, scope, source labels or a cached protected body. Current active credentials
are always required; legitimate credential replacement keeps the participant scope.

All accepted fields enter a canonical versioned digest. Exact replay precedes new
eligibility, capacity and version checks and never reapplies the command. An original
accepted outcome is separate from observed current state. Unknown status/cancellation
does not prove rollback. Clients retain exact private request bytes before dispatch.
Release is explicit and independent of publication success.

Expiry is a fixed PostgreSQL timestamp, checked using clock_timestamp after waits.
Default30 minutes, explicit1–120; renewal starts from accepted database time, not
the prior future deadline. No heartbeat, worker, GET, retry or publication renews it.
Temporal validity is not a claim of current authority or online presence.

## Bounds and ordering

Synthetic limits: purpose512 UTF8 bytes, described scope256 bytes, request4096 bytes,
serialized response32768 bytes; page default12/max25, at most100 retained notices
per resource,128 per participant,4096 community; active25/resource,16/participant.
General accepted decisions cap at10000. Each notice additionally reserves one
terminal release decision (up to4096), so admission exhaustion cannot prevent
cleanup. No-op releases under new keys conflict rather than consume that reserve.
Retained records are never silently evicted. These finite volume bounds are not an
approved production time-retention or erasure policy.

Inspection scans at most100 notices for one resource, checks exact bases before
selection, and exposes no hidden counts or positions. Encrypted cursors cap2048
bytes/5 minutes, bind caller/resource and eligible snapshot, and require restart
after relevant change or API restart. Owner chains retain the existing32 bound;
SQL/lock/transaction deadlines remain2.5s/1.5s/15s.

Lock order: scoped attempt mutex; current participant/credential guards; exclusive
reservation custody advisory class17; existing shared structure class1; sorted
resource chain SHARE guards; sorted exact revisions SHARE; reservation rows/writes.
Editor/lifecycle writers already take conflicting resource guards. No publication
acquires custody17 and no reservation acquires the publication clock, worker guards
or native object store. All locks are transaction-length, with no user/network wait.

The browser uses the existing32-record/1MiB identity journal and Web Locks. Optional
notice errors/capacity do not disable Publish. Protected metadata uses existing
authorization leases; private recovery remains separately reachable. Focus/background
changes mark observations stale, never renew. Explicit refresh leaves drafts intact.

Recovery permits a separate exact-notice release past an uncertain renewal, since
terminal release fences future renewal effects even if the earlier outcome is
unknown. It does not bypass an unknown announcement or release. After a matching
terminal receipt, explicit reconciliation retains the immutable request and unknown
outcome with separate release evidence, allowing a new deliberate intent. Absence,
expiry and authorization refusals do not prove rollback and cannot do this. Late
settlement retains terminal evidence. This relies on irreversible release and unique
notice identity; revisit the client rule if either server guarantee changes.

## Alternatives and reconsideration

Exclusive edit locks, presence heartbeats and coupling release to publication would
contradict advisory behavior or make content outcomes ambiguous. Reusing publication
outcomes would manufacture revisions/events, so reservation state is independent.
Reconsider global custody and finite retained caps if measured workload or approved
retention/multi-API requirements demand it; preserve exact decisions and fixed expiry.

## Acceptance

Native PostgreSQL/HTTPS, mounted StrictMode and compiled Chromium checks must cover
all kinds, overlap, expiry/crash/restart, exact replay, real competing lock orders,
authority withdrawal, durable failures, hidden bases, bounded inspection/admission,
populated upgrades and absence of source/private side effects. The complete normal
coverage, diagnostic, storage smoke and persistence pipeline remains required.
Human/provider/cross-machine and production readiness remain separate gates.
