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
timestamps, arrival-wins semantics or automatic rebasing. A stale automatic request
is terminal for its viewport visit. A later measured exit and eligible re-entry may
create a fresh operation at the current confirmed version; it never changes or
retries the stale request. Batches validate every member and apply all or none;
one invalid target fails the request, one stale member retains a refusal for all.
After a validated terminal atomic refusal, the browser may form one new automatic
subset operation. Only members whose returned current state is available, unread
and still at their original expected version qualify. The refused body and conflict
record remain unchanged; the subset has a new key and unchanged expected versions.
A reserved subset dispatch stays separate from fresh observations, so each member's
continuation allowance is independent of queue order. A second conflict cannot
continue. Transport uncertainty, absent status, failed status lookup and old journal
records never create a subset. This is neither
uncertain-key retry nor stale-version rebasing.

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

The browser enables automatic reading when no preference is stored, while preserving
explicit true or false choices at the origin/instance/participant/browser boundary.
Invalid or unavailable storage pauses automatic writes. External clients choose
their own consumption policy. Disabling stops new observations; dispatched commands
can still commit.

Only successful, expanded main-text representations on current/exact resource views
and loaded discussion contributions qualify. A positive intersection of the actual
rendered prose qualifies while its source is authorized, private state is known,
the document is visible and focused, and the text is genuinely displayed and
uncovered. Complete message height, dwell, horizontal traversal, avatars, headers,
action rows and collapsed labels are irrelevant. A long message qualifies when a
portion of its main text appears. Shared intersection, scroll, focus and DOM events
drive checks without a timer per message. Fetched but offscreen text, collapsed
content, parent previews, excerpts, references, activity cards, file previews and
summary links/cards remain excluded. No comprehension, agreement or review claim
follows.

An episode is one route opening. Revision replacement creates another exact target.
Within an episode, each exact revision can have repeated viewport visits. A manual
Unread immediately cancels its unfrozen observation and holds the revision while
any rendered occurrence remains in the viewport. Partial scrolling, rerenders,
StrictMode cleanup, status responses, menu changes, focus changes and repeated
cross-tab notifications do not release the hold. A measured full exit, including
deliberate branch collapse, followed by an eligible re-entry permits a fresh
observation at the current confirmed private version. Removing a duplicate
occurrence alone is not an exit. A terminal automatic refusal suppresses the same
visit; a new visit may create a new key without changing the refused request or
its single continuation allowance. Any overlapping unresolved operation still
blocks automatic writes. Known-read revisions generate no redundant outcomes.
Each visibility event measures all mounted occurrences before reconciling exits
and qualifying entries, so a handoff between copies cannot end a held visit.
Automatic attempt suppression belongs to the visit that produced its candidate;
a delayed freeze after exit cannot suppress a later visit. A cross-tab intent
change gates its affected revisions until a fresh registered-host lookup settles
their private versions, then rechecks any already-visible eligible visit. The gate
starts when a journal change is observed, even if a receipt event reveals the
intent's removal before that removal event arrives.
At most 4,096 exact targets are tracked in one view; capacity pauses automation
without evicting a manual hold. Mounted text alone shows reading feedback.

Human full-text views show a subtle unread indication in a stable author-line
slot, quiet synchronization and visible error/conflict recovery. Ordinary
settlement therefore does not change message height or the reading anchor.
Discussion messages put Mark unread in their
existing More disclosure; full resource text uses the same small action disclosure.
The former routine status row, Mark read, status refresh and browser bulk selector
are removed. Explicit selective and atomic list operations remain available to
agents through the unchanged API. Status failures preserve readable content, page
position, focus, drafts and branch navigation.

Qualified browser observations enter an in-memory buffer of at most 128 exact
targets. Duplicate, already-read and unresolved automatic targets do not enter it.
The oldest candidate starts a 250 ms maximum transport buffer; a full 25-target
batch flushes promptly, and arrivals cannot reset the oldest deadline. One
automatic batch is in flight per provider; later bounded candidates drain after
capacity returns. One refused batch can reserve at most 25 continuation candidates
outside the 128 fresh slots and dispatch them next, so a full fresh buffer cannot
discard unaffected members. Combined unfrozen storage is at most 153 candidates.
Manual commands dispatch independently. At fresh-buffer capacity, further
observations are refused from the buffer and may be observed again as space opens.
This buffering is not presentation dwell and is not durable: route departure, disabling,
identity loss, source withdrawal or a later deliberate choice (including a manual
intent observed from another tab) cancels unfrozen work, and page/process exit can
lose it. Immediately before freezing, the browser
rechecks participant, instance, provider episode, preference, source generation,
original private version and local intent. The saved operation keeps the original
expected versions and the episode ID of that viewing session.

Use an independent, Web-Locked journal: 128 recovery records, 512 KiB total,
16 KiB per record. Persist/read back exact body/key before any dispatch. No network
operation holds the storage lock. Remove only recorded terminal decisions; quota,
storage, transport and absent outcomes remain distinguishable and recoverable.
No unresolved eviction or uncertain-operation retry/rebase. Identity fencing precedes sign-out
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
An acknowledged operation replaces its own journal slot with compact, versioned
success evidence while overlapping unresolved operations remain. This avoids
expanding every sibling record near the journal's byte cap. The evidence uses the
same 128-record/512-KiB custody limit, is exported with recovery, and is pruned
by the highest acknowledged version for each exact pair still referenced by an
unresolved operation; versions for dismissed pairs do not affect retention. Older
receipt-filled journals also prune proven obsolete evidence before admitting a
new operation, after checking that its key has never been used locally. Older
per-intent success metadata remains readable. Once equal-or-newer compact evidence
has been durably read back, covered legacy entries can be removed without changing
their request bodies or keys; uncovered entries remain. If a later storage write
fails, subsequent admission or conflict recording can repeat the covered compaction
without replaying the acknowledged request. A refusal delivered after a newer
success reconciles in either response order and after reload. A later success may
stop showing a warning beside a revision only when its version is newer than the
refusal; the original conflict record remains reviewable. Private receipt state may
advance monotonically but its positive availability never renews a protected content
lease. Initial, explicit,
cross-tab and recovery lookups use registered source hosts; local journal
save/begin/finish events do not rescan every registered target.

## Verification and reconsideration

Plan real PostgreSQL/HTTPS tests for populated upgrade and every old-table digest,
exact historical states, both race orders, replay/ABA, duplicates, atomic invalid/
stale/fault/limit behavior, suppression/credentials at SQL guards and no coupled
effects. Native restart/response-loss recovery uses exact saved HTTPS requests.
Production Chromium observes rendered revision IDs and actual progress requests;
development StrictMode separately covers replay/ownership. Run normal check,
relevant PostgreSQL suites, complete normal browser and diagnostic safety checks.
Execution evidence belongs in Lore task records and CI runs, not this plan.

Reconsider numerical bounds and the presentation approximation after representative
human/agent workloads, accessibility studies, new text/file renderers or retained-data
approval. This increment cannot close compound AC07–09/24–26/42–43/54/60 scenarios,
attention controls, private notes, files or human/provider/cross-machine acceptance.
