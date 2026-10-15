# ADR-006: Shared publication transaction and commit tail

Status: implemented for internal revisions, synthetic text participation and topic
organization (ADR-020). Typed
discussion/opening/reply/artifact/setup operations reuse this same tail. Complete
domain/lifecycle operations remain incomplete; the first search consumer is now
implemented as described below. The imported architecture is unchanged.

Organization uses the existing exclusive structure guard before validating parentage,
subtree bounds and versions. Ordinary publication retains its shared form. Setup
keeps configuration-before-structure order and advances the hierarchy epoch when
creating areas. Proposal-bound discussion creation takes configuration then shared
structure guards so a designation change cannot race a frozen proposal destination.
Metadata edits, moves and explicit local closure commands use the same short clock
tail with structural events/outbox intents and immutable organization decisions.
They acquire no domain guards after the clock. All owner walks now have a 32-resource
bound; deep legacy structures fail explicitly before unbounded locking.

## Decision

Use `PublicationOperation` on the existing checked-out PostgreSQL transaction
boundary, with explicit READ COMMITTED isolation. One operation inserts an
immutable revision, conditionally advances the resource pointer, appends a source
event, inserts a `publication.project` outbox intent, and retains its idempotency
outcome. Its promise resolves after COMMIT, never merely after the inserts.

Prepare/validate/canonicalize text before opening the transaction. This operation
accepts no parser, upload, worker or network callback. Slow work belongs outside it.
The dependency decorator used for concurrency barriers and failure injection is
private test code, not a production hook or route.

Use a transactional `community_clocks` row with `shared_position`, rather than
sequence allocation or MAX(event ID), as the committed upper bound. Advance it
after domain changes; hold the row lock through source event/intent/outcome inserts
and COMMIT. Rollback or backend termination rolls back that allocation too. An
older preparation can receive a later position; an uncommitted allocation is
never a readable upper bound. Future shared structural/lifecycle events must use
this same tail protocol. This does not implement a participant change-feed API.

## Module lock protocol

| Order | Guard and obligations |
|---|---|
| 1 | Transaction advisory mutex over JSON `[loom.publication.attempt, participant, operation_kind, key]`, hashed by PostgreSQL to the 64-bit namespace. It exists before any outcome row. Hash collisions only serialize unrelated attempts; the persisted scope remains exact. The original internal kind remains `revision.publish`. |
| 2 | Participant `FOR SHARE` (all declared mention IDs and actor sorted for participation), then credential and parent-passkey rows in UUID order with `FOR SHARE`, before checking current state, ownership/channel/expiry and role. State/role/revocation changes require the conflicting exclusive guard. |
| 3 | Shared two-integer structure advisory guard `(0x4c4f4f4d, 1)`, disjoint from the attempt namespace. Ownership/area movement must take its exclusive form before resource guards. |
| 4 | Discover the complete owning chain, then lock UUIDs in sorted order. A new publication takes `FOR UPDATE` on its target and `FOR SHARE` on containers/areas. Resolution uses shared guards. Rewalk and validate the locked dependency set; a changed set aborts for retry with the same identity. |
| 5 | Check editor membership under the resource guard; editor-list writers take that resource's exclusive guard. Lock selected revision availability with `FOR SHARE`. Lifecycle changes require the conflicting resource/revision guards. |
| 6 | Update the clock at the tail. Acquire no new contested domain guards afterward; FK targets are already guarded or are this transaction's own inserts. |

`FOR KEY SHARE` is insufficient for these non-key lifecycle updates. The real tests
observe PostgreSQL blocking, not just a chosen SQL lock name. A 1500 ms local lock
timeout bounds waits; deadlock/serialization/lock-timeout failures return a safe
same-attempt retry category. The operation does not silently retry or mint a key.
These defaults are not approved product latency or load limits.

The attempt mutex and actor check now live in `server/application/` and are reused
by the synthetic identity protocol. Its administrative writers take the separate
two-integer guard `(0x4c4f4f4d, 2)`, then sorted participant `FOR UPDATE` locks,
before checking role/last-administrator state and locking affected credentials.
That serial guard avoids opposite actor/target lock upgrades and protects the
prototype's administrator-count policy. It never acquires the publication clock.
Account/credential/audit outcomes are private identity effects, not shared activity.
No contested identity guard is introduced after a publication takes the clock.
See [ADR-004](004-identity-admission-prototype.md) for the unapproved policy profile.

## Outbox boundary

Intents contain event references and a controlled kind, not authored bodies or
executed effects. They remain unique per event/kind and immutable for ordinary SQL.
Search now owns separate `search_jobs` and discovery progress; it never marks an
intent globally consumed. Notification/extraction and other projections remain
disabled. The standalone Node worker and API share one application release.

The first consumer implements claim generations, expiring PostgreSQL leases,
bounded retries, retained failures and explicit administrator recovery. Finalization
locks the source resource, exact revision, job and search-state row in that order.
After all potentially blocking guards it verifies owner/generation/expiry, rebuild
generation and current-source version; output association and successful job state
commit atomically. A separate revision-ordinal guard prevents older source work
replacing newer output. Slow preparation runs outside these transactions.
Renewal/failure lock the job before a fresh database-time check; waiting on an
unchanged row cannot revive an expired owner. Revision backfill deduplicates only
revision work; separate intent identity preserves unsupported-event failures.

Search backfill/rebuild scans authoritative retained typed sources in bounded batches
and uses its independent `(event position, intent UUID)` discovery to cover
concurrent publications and batches that split one event's intents. The
search discovery/rebuild advisory class 4 never acquires the public clock. Source
visibility triggers advance only a derived invalidation version while their existing
source locks are held; their write to search state precedes any publication tail.
No search finalizer acquires source locks after search state, preventing inversion.
Search/rebuild does not change source activity, outcomes or other consumer progress.
See [ADR-012](012-scoped-text-search.md) for exact bounds and selection semantics.
This is at-least-once execution with deduplicated effects, not exactly-once execution.

## Evidence and reconsideration

`test:publication:postgres` uses actual application-role connections and private
fixtures in tmpfs PostgreSQL. Barriers cover absent outcomes, competing writes,
authority changes, rollback, lost response processes, and terminated backends
before/after allocation and before commit. Single-statement clock/event inspection
checks the no-late-commit-gap property without treating timestamps as order.

Synthetic runs report wait at clock acquisition and hold through COMMIT, at one
and eight concurrent writers on distinct resources with 128-byte text. They include
local Docker/network overhead and print observed percentiles/throughput. They
establish neither a production envelope nor full workload throughput. Reconsider
the single tail if representative workload evidence requires a different design;
any replacement must preserve committed coverage. The retained backlog still
requires full feed, remaining projections, production identity and product validation.

See architecture §§7.1–7.6 and ADR-015 for the inherited semantics and retry scope;
this record selects the executable mechanism rather than restating the architecture.

Recorded references extend the pre-clock preparation (ADR-021): discover the full
source/target/owner set under the shared structure guard, then take sorted resource
locks with the edited source UPDATE and others SHARE. Include discussion openings,
reply parents and proposal affected areas; avoid cross-citation lock upgrades.
Revision memberships and withdrawal rows are fixed relational inserts before the
pointer/clock/event/intent/outcome tail, in the same transaction. No target event
or independent reference mutation is introduced.
