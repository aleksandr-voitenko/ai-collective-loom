# ADR-044: Topic discussion freshness

Status: implementation decision for `participation-1`. Builds on the direct-topic
creation-ordered traversal in ADR-016 and the organization and visibility rules
in ADR-020 and ADR-028.

## Observation and traversal

The selected topic’s Discussions tab uses an authenticated, read-only observation
contract. Its cursor advances independently of the list’s creation boundary and
continuation. An opening publication can commit after a traversal starts even when
its creation timestamp is older than rows already displayed. The observation
position follows committed writes. Direct moves and visibility changes can also
change the collection without a new publication. Reply activity leaves the topic
list and its notices alone.

`POST /api/v1/areas/{id}/discussions/freshness` supports `baseline`, `check`
and `audit`. The encrypted observation token binds contract, participant,
instance, recovery epoch, API process lifetime and topic. The process binding
prevents a restored database from accepting an old cursor after the clock
passes the cursor’s previous position again. Each check takes up to 32 activity and 32
visibility candidates plus one lookahead in each index. Migration 0033 records
openings and direct moves under `(area_id, position)` and availability under
the existing committed visibility generation. The scans seek from the two
independent positions. When either scan finds another candidate beyond its
budget, the response has `complete: false` and a continuation. Checks keep their
ordinary cadence while catching up. Candidate authorization probes exact source,
ancestor and revision keys in one database snapshot.
The authenticated request uses ordinary read admission and the response is
capped at 4 KiB.

Before an initial read, Back reconstruction or deliberate latest-list restart, the
browser takes an observation baseline. The following list request starts a new
creation-ordered traversal. Changes committed through the baseline preceded that
read. Changes after the baseline remain eligible for discovery, including commits
while the list response is in transit. This conservative ordering can surface a
change that a concurrent listing already included. Doing the reads in reverse
would silently skip commits between them.

The browser adopts the replacement observation boundary only when it accepts the
replacement list. Polling advances the observation position and accumulates a
bounded notice. A failed latest read retains the previous traversal and pending
notice. The replacement traversal starts at page one and owns subsequent
continuations. Browser Back records continue to store position and extent controls
and reconstruct them with fresh authorized reads.

## Availability and client behavior

An observation checks the current participant and topic. Historical placement and
event scope provide evidence about what changed. Current authorization determines
which source information can be returned. A visibility restoration is recorded
independently of publication so it remains discoverable even after the client has
passed the original publication or suppression. `order=created_desc&observe=1`
adds opaque withdrawal tags to authorized rows. Checks can match those tags when
an exact opening revision or its source is unavailable, including for a row that
stayed visible after an authorized move. Unmatched visibility slots carry no
source identifiers. Ordinary change notices remain scoped to the selected topic.
A departure can raise a content-free notice even after the moved source becomes
unavailable in its destination. Topic or session loss uses the existing
authorization boundary. Withdrawal evidence from checks that overlap a page read
can fence its response. A page requested after the evidence arrives can admit a
currently authorized restoration.

An invalid observation cursor raises a broad update indication and begins a
current authorization audit of the retained rows, up to 32 exact pairs per
request. Audit outcomes refer to the supplied positions and give fresh tags for
still-authorized rows. Capturing a recovery baseline keeps the update indication
pending for explicit application. The observation returns no discussion bodies
or replies and leaves reading, Saved, Following, notifications, Updates and
publication recovery independent.

The browser schedules one check at a time while the selected list is active,
visible and online. It coalesces resume events and backs off on temporary failure.
A validated server retry interval from a check or a latest-list baseline also
governs an already scheduled check. A reserved status beside **Show
latest discussions** announces meaningful changes and leaves focus and position
in place. The explicit action reuses the newest-first restart and yields positioning
to intervening reader interaction. The composer remains independently mounted.
Agents can request baselines and checks selectively over the shared API.

Revisit request budgets and the observation mechanism if measured catch-up delays
prevent timely discovery, or if the community’s authority model changes to
introduce additional ways for a participant to lose access to individual sources.
Review cursor custody and admission if deployments move to multiple API processes.
