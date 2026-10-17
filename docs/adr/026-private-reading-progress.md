# ADR-026: Exact private reading progress

Status: local synthetic implementation contract, 17 October 2026. The attached
private-reading task brief governs outcome, preservation and verification. Product
v0.9 ATT-09/10 and §12.3 govern meaning; imported snapshots remain unchanged.
Relevant history: LC-20261014-OIAD, LC-20261014-S0JX, LC-20261016-V1H5,
LC-20261016-82ZK, LC-20261017-FUWG and LC-20261017-5QRE.

## Exact units and ordering

An owner/resource/revision pair identifies one opening, comment, text artifact or
summary's main text. Discussion containers, notes, references, coverage, previews,
files and fetch checkpoints are not this unit. Absent state is unread/version zero,
not evidence of never having seen it. Failed lookup is unknown. No backfill from
publication, authorship, Saved, feeds or summaries occurs.

`reading-state-1` accepts a finite list of desired booleans and expected private
versions, a UUID operation key, basis `manual` or `presentation`, and an episode UUID
for presentation (null for manual). Presentation can only request read. Normalize
UUIDs and sort pairs; reject duplicate revisions, including differently cased IDs.
Hash all semantic fields. Exact retained decisions resolve before new-write checks;
changed input under a key conflicts. Applied and refused decisions retain original
result versions separately from freshly authorized current state. Absence of an
outcome never proves an outstanding request cannot commit.

Every applied command increments each target version, including no-ops and a first
Unread. A second fence records the last deliberate version. Ordinary commands need
exact expected-version equality. A manual Unread may also supersede intervening
presentation-only writes when `deliberate_version <= expected_version < version`.
It may never supersede an intervening deliberate choice. This explicit exception
lets Unread win both commit orders against an older automatic Read without client
timestamps, arrival-wins semantics or automatic rebasing. A stale presentation is
terminal for its episode. Batches validate every member and apply all or none;
one invalid target fails the request, one stale member retains a refusal for all.

## Persistence, disclosure and finite work

Add migration 0016; do not modify applied migrations. Use separate state, owner
quota counters and immutable outcomes. Attempt guard → current account/credential
→ owner advisory guard → structure and complete sorted resource plan → sorted exact
revisions → private writes. READ COMMITTED observes preceding owner writes after
the guard; no source or delivery clock is acquired or advanced. No events, outbox,
search, notifications, summary coverage, Saved or Following mutations occur.

Validate typed main-text sources under existing containment guards; historical
revisions need not be current. Reads do not require editing rights. Only retained
owner states/outcomes may expose their already-known exact pairs after suppression;
they carry private status and `availability: unavailable`, no cached source metadata.
An unknown protected/missing pair fails identically. New Read needs source access;
Unread of an owner-held state remains possible. No owner override, listing of other
readers, public receipts, history export or administrator inspection route exists.
All own-state responses use private/no-store caching. Moves/restoration do not
retarget or delete state. Ordinary restart and replacement credentials keep it.

Synthetic bounds: 25 exact targets/request; 16 KiB uncompressed request and 32 KiB
response; 10,000 target states, 50,000 operations and 100,000 outcome members per
participant. Owner counters make quota work constant; no auto expiry/eviction.
Exact retry/status and lookup remain available at quota. SQL 2.5 s, lock 1.5 s,
transaction 15 s; owning depth 32 and complete guard plan at most 3,840 resources.
Target discovery is bounded before guard acquisition. Oversize work fails atomically.
Initial temporary PostgreSQL sizing: 10,000 state-shaped rows took 1,564,672 bytes;
50,000 single-member outcome-shaped rows took 21,897,216 bytes including indexes,
inserted in 238 ms together. These are disclosed schema-shape fixtures, not API
latency or production forecasts. Actual schema/API growth is measured separately.
The separate maximum-batch shape fixture (4,000 outcomes × 25 members) occupied
12,165,120 bytes; cap both operations and members to bound mixed workloads.

No erasure, destructive database rollback recovery, retention pruning or production
rollout is approved. See the retained-data gate. Losing client custody can lose
reconciliation; ordinary restart is not a coordinated backup/restore test.

## Browser presentation policy

Off by default, labelled prototype, preference scoped to origin/instance/participant
in this browser. External clients choose their own consumption policy. Disabling
stops new observations; dispatched commands can still commit.

Only successful, expanded main-text representations on current/exact resource views
and loaded discussion contributions qualify. Require the active route/identity,
visible document, focused window, no covering modal, and actual viewport exposure.
Split the rendered text rectangle into vertical bands no taller than 160 CSS pixels.
Every band must be wholly visible for at least 1,000 continuous milliseconds;
sample every 100 ms, resetting an unfinished band's dwell when hidden/offscreen.
Accumulate completed bands only within that presentation episode. Width must fit
the viewport. Horizontally overflowing code requires manual marking in this prototype.
Long text qualifies by scrolling through all bands, never by a short excerpt.
More than 2,048 bands requires manual marking, bounding observer memory/work.
Mounted text alone retains badge data. A route retains at most 4,096 first-version
and 4,096 blocked-target fences; at capacity it pauses all automatic observation
until reopening, preserving every existing Unread fence and manual controls.
This final-review refinement prevents paging from growing a route cache indefinitely.
A 4,096-ID synthetic pair of fence collections serialized to 335,897 bytes; this
sizes identifiers, not actual JavaScript heap or production browser performance.
No comprehension, agreement, review or file-inspection claim follows.

An episode is one route opening. Revision replacement creates another exact target
within it; rerender, StrictMode replay, status response, tab activation or cross-tab
announcements do not create a fresh episode. Manual Unread and any observed later
version stop automatic qualification for the target until explicit navigation away
and reopening (a full reload is reopening). Capture version before presentation,
never fetch/rebase after a stale automatic refusal. Known-read revisions generate
no further automatic outcomes. Preview/note/coverage/feed components are deliberately
outside the instrumented boundary.

Manual controls remain usable independently of observation. A bounded discussion
selection lists the exact displayed revision IDs/count and freezes them before
dispatch; edits/new arrivals do not expand it. It is explicitly manual selection,
not proof that selected material was presented. Status failures preserve readable
content, page position, focus, drafts and branch navigation.

Use an independent, Web-Locked journal: 128 recovery records, 512 KiB total,
16 KiB per record. Persist/read back exact body/key before any dispatch. No network
operation holds the storage lock. Remove only recorded terminal decisions; quota,
storage, transport and absent outcomes remain distinguishable and recoverable.
No unresolved eviction or automatic retry/rebase. Identity fencing precedes sign-out
cleanup; late completions cannot recreate cleared records. Confirmed removal is
idempotent, while retry verifies the exact retained body. Publication journals remain
independent. Export and explicit cleanup concern only this owner's recovery.
Confirmed conflicts retain their exact request in this same bounded journal until
explicit dismissal. Feedback belongs to the affected revisions, so another operation's
success cannot erase it; reload also preserves the notice. This corrects the shared
error-message race found in self-review. Known conflicts cannot dispatch again as
uncertain work, late duplicate responses cannot recreate a dismissed record, and
dismissal does not change private server state. Rejected/conflicted records share the
existing quota with uncertain work; no extra unbounded feedback cache is introduced.

## Verification and reconsideration

Plan real PostgreSQL/HTTPS tests for populated upgrade and every old-table digest,
exact historical states, both race orders, replay/ABA, duplicates, atomic invalid/
stale/fault/limit behavior, suppression/credentials at SQL guards and no coupled
effects. Native restart/response-loss recovery uses exact saved HTTPS requests.
Production Chromium observes rendered revision IDs and actual progress requests;
development StrictMode separately covers replay/ownership. Run normal check,
relevant PostgreSQL suites, complete normal browser and diagnostic safety checks.
Execution evidence belongs in the feature evidence guide, not this plan.

Reconsider numerical bounds and the presentation approximation after representative
human/agent workloads, accessibility studies, new text/file renderers or retained-data
approval. This increment cannot close compound AC07–09/24–26/42–43/54/60 scenarios,
attention controls, private notes, files or human/provider/cross-machine acceptance.
