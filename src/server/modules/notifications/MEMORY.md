# Personal direct attention

ADR-023 and `docs/development/notifications.md` define the synthetic scope.
Implementation decision record: Lore-ID `LC-20261016-V1H5`.
Migration 0012 is additive; persisted v1/v2/v3 authored fields, publication digests,
events, immutable intents and search progress are inputs, never rewritten.

`worker.ts` discovers typed human/agent contribution/artifact/summary revisions in
resource/ordinal order, plus its independent event-position/intent-ID cursor.
Class 6 serializes discovery/reconciliation. Unique revision and intent jobs
converge without losing unsupported intents at the same event position. Never
reuse search's latest-revision-wins rule. Suppressed/empty predecessors participate;
missing predecessors retain failed repair status. No-mention revisions advance
the head. Completed logical keys are never deleted for reindex or reconciliation.

Main identity: recipient/resource; reply: recipient/reply; note: recipient/owning
revision/change_note. New reasons coalesce per recipient/revision. Skipped self
mentions retain null-signal claims, preventing a later editor waking the same main
claim. Source event/revision/time stay original. A repaired older publication
receives a later availability position; fixed upper bounds do not grow.

Historical persisted mentions prove the old constructor's active-recipient
validation. New replies capture parent-original-author eligibility under the
publication's sorted participant guards. Old unmentioned replies lack historical
state evidence: retain `historical_reply_eligibility_unknown`, project known
reasons, advance an incomplete head. Current lifecycle is never guessed backward.
Publisher disconnect, revocation or later suspension cannot cancel committed work.

Preparation holds no finalization transaction. Final guards: sorted recipient
participants SHARE → structure SHARE → full resource UUID plan (source UPDATE,
owners SHARE) → exact revision SHARE → head → job UPDATE → sorted recipient clock
UPDATE. Recheck live lease, owner and claim generation after all blocking guards.
Lost lease throws through the transaction owner so even absent head/clock inserts
roll back. Claims/signals/deliveries/head/gap/success share COMMIT. Allocation rolls
back, and clocks stay locked through COMMIT. No new contested domain guard after
the clocks. Renew/fail take the job lock before fresh PostgreSQL time checks.

`retrieval.ts` uses RR, current actor and complete source/parent/discussion guards,
exact trigger checks, independent parent previews and current mention presence.
No current body substitutes for hidden trigger text. Source metadata is rebuilt
on every page/detail/replay. A suppressed parent comment is not an owning container.
Participant health includes eligible historical revisions beneath a suppressed
current revision, comparing the ordered head with the latest readable ordinal.
It is bounded currently eligible source coverage; >25 candidates
yields unknown unless a checked eligible source is incomplete. No queue counts.

`personal-attention-1` descriptors bind participant/instance/epoch/reason/visibility,
fixed personal bounds and position. Database-held AES key survives ordinary API
restart. Checkpoints have no automatic expiry; traversals have 24-hour expiry and
same-bounds renewal. Visibility control precedes reason filters; explicit replay
starts at the retention floor, including before a completed lower bound. Stable
delivery IDs remain. A retention gap is distinct from descriptor expiry; explicit
resynchronization reports incomplete history. Epoch mismatch refuses continuity.
Pruning, erasure/key rotation and destructive restore are unapproved procedures.

Bounds: sources5000/jobs50000/deliveries50000 per owner; discovery50/claims25;
lease30s/renew10s/attempts3; candidate100/item12 default/max25; complete JSON4–128KiB;
descriptors2KiB; owner32/guards3840; SQL2.5s/lock1.5s/transaction15s. Discovery reserves
room for both 50-row scans. Capacity failures retain work, never evict identity.
`administration.ts` exposes closed health/failure references and fenced retry or
expected-generation reconciliation, not another inbox or a destructive rebuild.

`web/Notifications.tsx` saves page_cursor under current view/identity ownership
before exposing successors; reload reauthorizes the displayed page. Three
reason-scoped Web-Locked records cap at32KiB each/100 recent IDs, with optimistic
sequence checks and a closed displayed-page request schema (never mixed token
modes). Transport/save failures retain position/context/focus; policy/authentication
or epoch failures withdraw cached metadata and focus the recovery notice until
reauthorization. Explicit local
resynchronization clears only that reason record. Sign-out clears scoped recovery.
Confirmed sign-out fences pending views before waiting for cleanup locks. Cleanup
stops if a later identity change takes ownership. The standalone HTTPS reader
fsyncs its private record including displayed page size and exact successor tokens;
next uses that saved boundary with any requested new size, without reconstructing
the previous page's membership. Independent journals do
not consume each other's deliveries. Native supervisor supports notifications
stop/start separately from search. Build before tests that launch compiled files.

See `tests/MEMORY.md` and notification evidence for real PostgreSQL/HTTPS/native
barriers, upgrade, recovery, StrictMode and browser coverage. File/private-note integration, moderation
administration, production and human/provider/cross-machine validation remain open.
Exact private reading lives in `../participation/reading.ts` (ADR-026); fetching
personal deliveries never marks a source read or consumes its independent state.

Following/shared Changes use independent direct event reads and token custody in
`../following/` (ADR-024). Advancing shared checkpoints cannot consume personal
positions or hide a later repaired delivery. Migration0013 leaves this module’s
persisted key, epoch, claims, deliveries and worker behavior unchanged.
Sibling `updates/` (ADR-025) reuses internal reason/item and projection policy under
its own complete actor/owner/source guard plan. Its personal availability interval
stays independent of shared boundaries, including repaired older publications.
Migration0014 and combined reads do not mutate worker/claim/delivery/standalone state.

Guide12 attention controls never mutate this module's claims, signals or deliveries.
Standalone notifications remain all-retained, including dismissed IDs. Only the
explicit combined-updates-2 routine projection filters named personal deliveries;
a mute alone never removes personal input. See `../attention/MEMORY.md`.
Browser dismissal controls share the mandatory authorization boundary with the
whole Mentions/replies page. Source refusal withdraws cached delivery metadata and
fences pending pages/saves without advancing the saved personal request. Owner
refusal enters the shell identity fence; exact attention commands stay recoverable.
Fresh retry retains the existing visibility replay and all-retained semantics.
