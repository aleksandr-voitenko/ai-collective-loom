# ADR-045: Discover newer routine Updates

Routine Updates can stay open while shared publications and personal deliveries
commit independently. A reader may still be inspecting an expanded group, and
ordinary Highlights never issues a completion checkpoint. Guide 29 adds two
operations to the routine contract at `/api/v1/me/routine-updates`.

## Observe the accepted overview

`POST /observe` accepts `{view: page_cursor, cursor?}`. The first check starts at
the two upper bounds in the accepted overview, including a preparing overview.
Subsequent checks carry the same overview and an opaque observation cursor.
Each check takes one REPEATABLE READ snapshot of the shared committed clock and
the participant's delivery clock. A delivery can cross the latter boundary even
when the triggering publication is already behind the former.

The server rechecks the actor, original view custody, continuity and explicit
scope access. The continuation uses a separate encryption purpose bound to the
instance, participant, originating view, selection, epochs, visibility, scope,
captured definitions, attention version, expiry and both intervals. It carries
two scan positions and cumulative positive and unknown flags. Overview, member,
selection, standalone and checkpoint tokens retain their own purposes.

Each stream processes up to 100 candidates plus one lookahead. The shared stream
can be skipped for Direct or a personal-only scope. Existing event-time Following
matching, up to 64 captured definitions, bounded active mutes, exact input
dismissals, current resource ancestry and exact revision access govern eligibility.
A shared event and a personal delivery have independent dismissal identities.
Personal eligibility survives a muted shared event. Complete bypasses private
selection. Unknown historical matches remain qualified. The server returns
`new_activity`, `scan_complete`, `coverage`, `settings_current`, a cursor of at
most 512 bytes and the contract literal. The whole response fits in 1 KiB. A
positive Highlights observation identifies eligible activity. Ranking takes
place when the reader asks for groups.

An unfinished scan can be continued at the next ordinary check. Observation
uses the existing 2.5-second statement, 1.5-second lock and 15-second transaction
limits. Private policy, Following definitions and retained custody use the same
snapshot. Reading the mutable preparation-progress row without a row lock lets
the foreground reader continue. Actor and source authorization keep their guards.
After a serialization conflict, deadlock or lock timeout, one additional
transaction can recheck the binding and authority with the same deadlines.
This recheck scans zero candidates. If access is confirmed, or contention
prevents the recheck from finishing, the caller receives a retryable work-limit
error for its original position. A concrete access or continuity refusal retains
its authorization or recovery meaning. These failures issue no observation
cursor.

Observation leaves custody expiry, preparation and retained-view quotas intact.
Ordinary participant rate admission applies. The
browser schedules one request at a time on an approximately 15-second cadence
while visible and online. The API leaves scheduling to each caller.

## Apply a notice

A genuine checkpoint starts a newer interval under ADR-025. Without one,
`POST /query` accepts `{refresh_from_view: page_cursor, limit?, max_response_bytes?}`.
It verifies the old binding, preserves both lower bounds and captures both new
upper bounds together. The replacement keeps the original scope, definitions,
reason, selection and history qualifications. An extended resynchronization
baseline prepares the new range even though its earlier history is incomplete.
Creation uses the same custody quotas and bounded preparation as other views.
The earlier view remains independently traversable.

The browser keeps observation progress in memory. Applying a notice goes
through the foreground reader and saves the authorized replacement overview
before displaying it. Failed transport or storage leaves the prior display,
recovery record and notice available. Once accepted, the replacement's own
upper bounds seed observation, including commits made while its response was
in flight. Expanded controls, focus and recovery are independent of timer ticks.

## Changes to policy or access

A Following change is reported through `settings_current`; the original
definitions remain in force. Attention refresh explicitly adopts the changed
private policy over the same interval. Visibility replay, missing custody,
expiry, component history gaps and epoch changes keep the recovery semantics
of ADR-025 and ADR-027. Checking never resynchronizes a reader's history.

See [combined Updates](025-combined-updates.md), [routine attention
controls](027-routine-attention-controls.md) and the [topic discussion
freshness scheduler](044-topic-discussion-freshness.md).
