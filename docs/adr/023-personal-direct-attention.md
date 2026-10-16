# ADR-023: Durable personal direct attention

Status: implementation contract for the local synthetic increment. Product v0.9
section 12 and KNW-05 govern behavior. The supplied task request is the brief and
acceptance contract; imported product, architecture and UI snapshots stay unchanged.
Relevant history: LC-20261012-6OTQ, LC-20261015-94TS, LC-20261016-T9G8,
LC-20261016-BA7H and LC-20261014-S0JX.

## Identity and historical evidence

Main mentions use recipient/resource/main identity; replies use recipient/reply;
note mentions use recipient/owning revision/change_note. Newly applicable claims
for one recipient and revision form one signal and one immutable delivery. Repeated
tokens, retries, removal/readdition and reindexing do not allocate another delivery.
Self-alerts are omitted, comparing the publication's actor to the recipient. A
skipped self-mention consumes its logical claim with a null signal: a later editor
cannot turn the continuing mention into a new alert. Ordinary
change accounts remain ordinary contributions. Exact triggering revision/event/time
never changes. Current presence is a separate live observation.

Only typed supported v1/v2/v3 publications participate. Validate persisted fields
with the existing parser, without rewriting sources or request digests. No URL,
rationale, quoted/code/raw text, private data or administrative record infers a
recipient. Original parent authorship, not revision editorship, selects replies.
Valid historical mention rows prove publication-time active-recipient validation
under ADR-011 and the existing constructor. Later publisher or recipient suspension
does not cancel those committed effects. Current authentication governs retrieval.

New replies capture the parent's original author and active human/agent eligibility
under sorted participant locks before resource locks. This fact commits with the
reply, before the common clock tail. The unchanged old request still hashes exactly
as before. Earlier unmentioned replies lack a sufficient lifecycle history: the
administrative audit retains action/target references, not state snapshots. A valid
same-publication mention can establish eligibility for that recipient; otherwise
retain an explicit historical eligibility gap. Project independently known claims,
advance the ordered head with an incomplete marker, and expose repair status. Never
invent eligibility from the current account or discard known historical mentions.
Self replies need no eligibility fact. Reconsider only with authoritative recovered
historical evidence or an explicit product policy, not a current-state guess.

## Consumer and atomic boundary

Independent PostgreSQL jobs consume immutable publication intents without changing
search progress. Bounded historical revision backfill and event/intent-pair discovery
converge; several intents at one event position remain distinct. Internal text/plain
fixtures are not a supported population. Unsupported typed sources retain failures.
Every retained revision, including suppressed and mention-free predecessors, is
processed in ordinal order. Missing/unreconstructible predecessors block later work
with repair status. Reconciliation replays discovery/retries, never clears identities.

Complete lock order: sorted recipient participants SHARE; shared structure guard;
all required resources in UUID order, with the source UPDATE (serializes its
projection) and other resources SHARE; exact revisions SHARE; projection head; job UPDATE; sorted recipient
clock rows UPDATE. Publication still takes participant/credential then complete
source guards and its common clock. Notification workers do not authenticate as the
publisher. Claim/renew/fail only lock jobs; discovery only serializes its own cursor
and inserts jobs before updating state. No source lock follows a job/clock lock.
Visibility invalidation follows existing resource/revision guards.

Preparation is outside finalization. After potentially blocking guards, recheck
owner, claim generation and live PostgreSQL lease before any effects. Claims,
signals, deliveries, projection head/gap and successful job outcome share COMMIT.
All recipient clocks are planned and acquired in sorted order before availability
allocation. No newly discovered contested guard follows that tail. Rollback rolls
back allocation. Repair retains original source identity/time but obtains a later
availability position. Finished work is a no-op at logical keys.

## Personal traversal and recovery

One complete personal feed, ascending availability, supports all/mention/reply
selection. It has no shared position, subscriptions, ranking, reading or dismissal.
Authentication supplies ownership; there is no administrator inbox override.
Encrypted authenticated descriptors bind recipient, instance/recovery epoch,
reason, ordering/contract, fixed lower/upper availability and visibility generation.
The encryption key and recovery epoch live durably in PostgreSQL, so ordinary API
restart does not invalidate checkpoints. Self-contained descriptors avoid an
unbounded server cursor registry. Continuations expire after 24 hours; completed
checkpoints do not automatically expire. Expired descriptors can be renewed with
their exact retained bounds and position. Contradictory selectors fail explicitly.

Visibility control runs before ordinary filters. A changed generation requires an
explicit retained-history replay from the retention floor, even when that precedes
a completed checkpoint's lower bound. Stable delivery IDs support deduplication;
replay does not recreate notifications. A history floor beyond the requested lower
bound is a distinct history gap, with explicit incomplete retained-state
resynchronization. No automatic pruning is enabled. Recovery-epoch mismatch refuses
continuity; this is not implementation/approval of destructive-restore operations.

Each response reauthorizes account, exact source, resource and owners. Parent preview
has its own policy; suppressing a parent comment does not suppress its eligible
reply. Current text never replaces an unavailable trigger. Exact note links retain
their field. Compact metadata separates original publication and availability from
current mention presence. Health is a bounded current-policy observation; unknown
is not zero/healthy. Coverage includes readable historical revisions beneath an
unavailable current revision. Participant responses expose no recipient lists, protected
source IDs or queue counts. Administrator operational diagnostics contain closed
failure codes and job references, not another inbox.

## Synthetic bounds and clients

Source population 5,000; retained revision/intent jobs 50,000; discovery batches 50;
claims 25; lease 30 seconds with 10-second renewal; three attempts with bounded
backoff. Each revision has at most 16 mentions plus one reply reason. Retained
deliveries cap at 50,000 per recipient; no silent eviction. Bound source validation,
owner expansion (32 levels/3,840 guards), candidate scans (100), returned items
(default 12/max 25), complete UTF-8 JSON (4–128 KiB), descriptors (2 KiB), SQL
statements (2.5 seconds), lock waits (1.5 seconds) and transaction duration
(15 seconds) independently. Discovery conservatively reserves space for both
50-item scans before admitting a batch. These are local
synthetic limits, not production capacity approval.

The browser stores only bounded participant/instance-specific recovery tokens and
stable IDs, not a cached authorization grant. Save and read back sufficient recovery
state before advancing. The response's page_cursor replays the displayed page,
including an exhausted page, after reauthorization; it is saved before its next
cursor or checkpoint is exposed. Three reason-scoped records each cap at 32 KiB,
with at most 100 retained delivery IDs. Failed storage retains the prior checkpoint/page request;
reload must refetch it rather than skip. Clients retrieve independently without
acknowledgement or exclusivity. Late route/filter/account results cannot replace
the active view. Transport/save failures retain context and focus; explicit
authorization, visibility or epoch failures withdraw cached rows pending
reauthorization. Sign-out fences views before awaiting local cleanup locks.
Exact navigation, loading,
empty available intervals, incomplete/unknown projection, failure, expiry and
visibility recovery have distinct presentation. No inert Follow/read/dismiss control.

The same-release native worker is supervised independently of search/API in the
disposable preview. The standalone HTTPS example fsyncs its recovery state before
advancing. Required evidence is real isolated PostgreSQL, HTTPS, native process
barriers, full normal Chromium and development StrictMode, existing correction
regressions and diagnostics. Record actual results separately from this plan.
Production/retained-data operations, full Updates/Following, files/private notes,
read state, dismissal, moderation UI and human/provider/cross-machine trials remain
open requirements. Reconsider mechanisms for larger measured workloads, new source
types, key rotation/erasure or a separately approved recovery procedure.
