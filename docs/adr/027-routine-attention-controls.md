# ADR-027: Private routine mutes and bounded dismissal

Status: implementation decision for the synthetic profile, 19 October 2026.
Product v0.9 §12.3 and the supplied routine-attention task brief govern behavior.
Related records: LC-20261014-OIAD, LC-20261014-S0JX, LC-20261016-V1H5,
LC-20261016-82ZK, LC-20261017-FUWG, LC-20261017-5QRE, LC-20261017-PAXI.

## Decisions made before implementation

An owner/kind/resource mute lasts until explicitly unmuted. Areas carry an explicit
descendant Boolean; discussions and artifacts follow stable IDs. All supported
shared event categories participate. Any matching mute quiets the shared input,
using Following's retained event-time scopes and structural impacts. Overlapping
settings remain independent. A current location is display context, never evidence
for a historical match. Mutes neither create nor remove Following definitions.

Dismissal names independent shared-event or personal-delivery identities. Coalesced
reasons stay on their existing signal/delivery. An atomic command contains desired
booleans and expected versions for at most 100 inputs. A whole-card preparation
includes every represented input, including unexpanded personal sources; an oversized
card is refused with an explicit smaller-selection path. It never truncates. New
revisions and later personal deliveries are outside the saved command. Dismissing E
before delivery N exists cannot dismiss N. Restore names the same finite identities
with reviewed versions and leaves independent mutes alone. Card Undo uses the
original applied result versions, including after exact recovery reports newer
current state; an intervening choice produces a conflict rather than automatic rebasing.

Every applied command, including no-ops and initial negative choices, increments
each target version. A stale member retains an atomic conflict without partial
changes. Operation keys bind every semantic field. Exact retry/status resolves the
retained original decision before new-source, selection-expiry or quota checks and
reports current private state separately. A missing decision remains uncertainty.

Server-issued selections are bounded authenticated envelopes, containing owner,
instance, exact identities/versions, original view/group/selection meaning, policy
version and a 24-hour expiry. They contain no source titles or bodies and need no
server selection registry. New commands recheck ownership and current eligibility;
the envelope is not an authorization grant. Confirmed decisions copy their bounded
identity membership independently of seven-day Updates custody. Known unavailable
states allow Unmute/Restore using safe private IDs without source metadata.

## Compatible routine projection

Keep `combined-updates-1` and its endpoints/tokens/journals unchanged. Introduce
`combined-updates-2` on separate routine endpoints. Complete, member-record and
standalone shared/personal retrieval ignore attention choices. Routine Highlights
and Direct use independently surviving shared and personal inputs. Counts describe
remaining routine inputs; complete counts describe represented authorized inputs.

Reuse frozen base membership, group IDs and ordering. A separate bounded selection
projection scans at most 100 existing members per step under a bound attention
version, then selects all surviving direct groups and the first three surviving
routine groups. Thus hidden candidates cannot starve later highlights. This is
request-driven retrieval custody, not a worker or notification acknowledgement.
Direct member pagination reaches signals beyond the two card previews.
Member, reason and dismissal-selection reads require that projection to be ready
at the cursor's policy version, under the same custody guard order. Missing, partial
or earlier-policy rows return `updates_attention_preparing` with same-selection
refresh recovery. Base readiness alone would expose partial membership and allow
an oversized card to masquerade as a bounded whole-card selection. Complete paths
continue to use base membership without requiring private projection preparation.

A policy change requires explicit attention refresh for routine pages. Refresh
reselects the same base view, preserving Following definitions, personal reason,
both intervals, unknown-history qualification, group IDs and original order.
If its descriptor expired, explicit attention refresh also renews that descriptor
within the original custody deadline. Separately requiring renewal first created
a recovery loop when the policy had changed: renewal required attention refresh,
which rejected expiry. This review correction changes neither captured intervals
nor selection-envelope expiry; missing custody still requires resynchronization.
Complete paths remain usable. Visibility/epoch/history recovery precedes attention
checks. Unmute/Restore offers selection refresh or explicit retained-history replay;
it does not publish events or rewind a checkpoint implicitly. Old browser views
remain explicitly accessible under their old contract; new routine custody is
separate. No old token is silently reinterpreted.

## Transaction and capacity boundaries

Attempt → current actor/credentials → Following owner (retrieval only) → attention
owner → grouping/selection custody → structure → complete sorted resource plan →
exact revisions → private state/outcome/counters. Attention writes use READ COMMITTED
after the owner guard; routine reads use the existing REPEATABLE READ authority
boundary. Selection/custody writes precede source guards. No attention operation
allocates a source or recipient position. Saved, reading, Following, notification
claims/deliveries, summary coverage and old publication digests remain independent.

Initial synthetic limits: 64 active/500 retained mutes, 10,000 dismissal identities,
50,000 decisions/100,000 outcome members per participant; 100 inputs per atomic
command; 64 KiB request/128 KiB response including complete UTF-8 JSON; selection
envelopes at most 32 KiB. Lists return at most 25 identities. Existing Updates
2,000-member/256-group/16-owner-view/128-global-view limits also bound selection
storage; no existing quota is enlarged. Browser recovery has 128 records, 64 KiB
each and 1 MiB total. These are finite design choices to measure in synthetic tests,
not production capacity. No unresolved intent, version fence, outcome or live view
is automatically evicted. At mutation quota, lookup and exact recovery still work;
even a new removal may require capacity-policy review.

## Interaction and verification plan

Use progressive card controls and a private attention settings page. Explain mute
scope and continued mentions/replies. Show the exact shared/personal dismissal
counts before dispatch. Save/read back the immutable command under origin/instance/
participant Web Locks before sending; no network work holds a storage lock. Keep
per-command conflicts, uncertainty and explicit restoration. Leave the card in place
with adjacent feedback until deliberate refresh, preserving focus and viewport.
Cursor or explicit source-input changes invalidate pending/unconfirmed preparation while saved commands
retain their custody. Successful Undo focuses a fresh Dismiss action; preparing
that action reviews current versions. Private versions order choices, not source visibility. Recovery matches are recomputed
when preparation reveals overlapping inputs from another traversal, blocking
replacement while exposing the original command. Recovery remains independent of
presentation.

The selected structural design separates owner-private responses from protected
content. Additive `private-controls-1` projections use `/me/following/private` and
`/me/attention/private`. Lookups, lists and decision receipts contain stable IDs,
settings, versions and original/current outcomes. They contain no source metadata,
availability, overlap or protected counts, and their builders do not hydrate sources.
Known Unfollow/Unmute/Restore and exact replay/status therefore do not need source
reads. New positive choices and unknown negative choices retain current source
guards. Existing endpoints, closed schemas, decision digests, commands and tokens
keep their meanings. Explicit browser adapters select the new projection without
rewriting saved journal paths or command bodies. The compiled browser ships with
these additive routes; no capability is inferred from a private response.

Protected `/me/attention/previews` reads batch at most25 targets under current
actor, structure and source guards. Current scope overlap belongs to this read.
Dismissal preparation/lookup remains a protected operation; its counts and input
availability are separate from the private receipt. A mixed preview batch can
publish available B alongside unavailable A atomically. Private recovery never
implicitly refills metadata withdrawn by a denial; an explicit protected refresh
or full-host Retry is required.
The shared query hook owns dispatch permission as well as the returned lease.
Refresh callbacks capture the generation that created them; delayed private
success cannot start replacement reads, and a query mounted by recovery after
withdrawal starts without dispatch permission. An explicit refresh obtains a new
lease. A fresh mixed response advances only its own query's traversal permission.
Automatic post-command refresh also requires that query's existing lease; recovery
started after withdrawal cannot grant it. Setup/configuration completion follows
the same rule for shell discovery, with explicit administrator refresh available.

`protected-content.ts` owns identity-scoped regions, metadata and in-flight evidence.
`AuthorizationBoundary` is the mandatory rendering adapter on all eight hosts:
area, discussion, artifact, overview, Following, Updates, Mentions/replies and settings.
Opaque content hosts withdraw as a whole; private pages retain settings and
confirmation. Audited discussion traversal gates each response separately.
Protected reads require a boundary capability, including imperative reply expansion,
reference/summary/change inspection, search, organization, Saved and shared feed
reads. Remaining authenticated routes provide a default whole-view boundary.
There is no optional query-hook fallback. Closed session and receipt-only command
APIs reject other endpoints before dispatch; private reads additionally check their
route and response schema. The application check forbids component imports of the
internal transport, re-exports and direct network clients. This is a repository
architecture guard, not a replacement for server authorization.
Reading batches inherit their displayed text hosts' authorities while the provider
keeps private journal custody. Organization command receipts settle independently,
but their current-location metadata needs its captured lease after settlement.
Saved command adapters consume source observations before discarding metadata;
only a fresh protected lookup can refill it. Successful Saved and Reading receipts
can report unavailable sources while still confirming a private decision. Revocation
runs before awaiting journal settlement, and does not discard that receipt.

Response classification is closed by HTTP method and endpoint in
`web/response-contracts.ts`, independently of a caller's optional schema. Every
successful response field that can say `unavailable` has an explicit source-denial
or local-absence meaning. Search worker availability is operational; personal
notification current-revision absence is certified after exact-source guards.
Other ambiguous source/representation absence remains conservative. Current/exact
revision error hints are recognized by endpoint, not by a caller supplying a schema.
The contract test compares this catalogue with actual registered server JSON routes
and success schemas; added routes, omitted negative fields and stale entries fail it.
Error policies declare independent session and content effects per endpoint.
Public operations and registration/sign-in ceremonies concern separate proofs;
a missing identity record is not a source denial. Authenticated operations revoke
the owner on unauthenticated or invalid-actor responses. A forbidden read or a
role/editor-dependent command withdraws content without replacing the journal owner.
That includes identity/organization/worker administration and resource revisions:
those capabilities can also guard other cached representations. Ordinary creation
and reply endpoints require readable/open sources; their posting closure alone
does not imply loss of independent reading rights. Unknown proof/input/operational
errors stay local. First-dispatch rejection can settle; uncertain retries retain
their original bytes and uncertainty.

The earlier action/identity-action grouping was too broad: it fixed journal ownership
but left administrator-only account data visible after demotion. The replacement
uses explicit session, forbidden and unavailable effects, rather than inferring all
three from a transport category. Server guards and semantic endpoint tests determine
these effects; adding an endpoint requires reviewing shared read/write capabilities.
Administration keeps private drafts, correction and exact recovery mounted while
queries, selected-account copies, configuration inputs and one-time credential
display retain independent content leases. Late receipts settle without restoring
those fields. No role- or source-dependent content is authorized by a private receipt.
A broader UI/store rewrite is unnecessary for this boundary change; revisit the
classification when server permissions or response semantics change.
Source operations retain conservative withdrawal for ambiguous unavailable errors;
only certified revision misses remain local. Private mutations can check sources,
so their unavailable failures remain conservative even when their receipts are private.

Anonymous discovery settles without broadcasting an identity change. Discovery
that loses established authority revokes it once, including retained protected hosts;
the shell's subsequent anonymous probe settles quietly. A separate discovery fence
rejects positive probes overtaken by an anonymous observation without inventing a
revocation event. Late same-owner denials still revoke and old-owner responses cannot
invalidate a replacement identity. Transport consumes error evidence exactly once
before handing failure back to a view or command; callers do not reinterpret codes.
StrictMode shell and all-host tests cover these transitions. These policies follow
the current endpoint protocols and need review when those protocols change.
An optional wrapper or another local error handler would leave the original bypass
possible. The real nested-reply404 reproduction and direct production-reader tests
motivated mandatory entry points; a larger adapter response matrix alone missed it.
Every same-owner source denial invalidates older protected projections, including apparently
unrelated settled previews and opaque bodies/expansions. Returned ancestry describes
a past server read: a move can introduce an unseen dependency, and a reordered
preview can replace a newer path. It cannot prove that another projection is still
authorized. This replaces selective preservation based on cached dependency sets.
The approved bounded relaxation permits a fresh successful response to publish
only its own authorized representation after consuming its embedded source denials.
`readProjection` returns a new content generation; every rendered protected field
must check that generation again, including after asynchronous local persistence.
An older pending response cannot use this exception, and another denial revokes the
fresh projection again. No private version, command receipt or cached path restores
other content. This extends the mixed-preview rule to audited response projections:
Saved keeps private membership/removal while its page metadata is lease-gated.
Full hosts that cannot isolate response-owned fields retain whole-view withdrawal;
the exception is not permission to reactivate an opaque React tree. This fallback
can still require a host retry for an unavailable optional source. Discussion
traversal now uses an explicit projections host: query values, retained collection
pages and imperative reply pages each gate their returned generation. Headers and
bodies are withdrawn independently of a fresh structural page. Known unavailable
rows render only that page's authorized structural marker; they do not immediately
refetch the unavailable body. Only immutable opening identity remains as an internal
query seed. Source-error responses still withdraw the whole host and require Retry.
The exact artifact attribution view isolates its revision and provenance queries
under the same rule; ADR-030 describes its fresh independent reauthorization.
Other hosts must isolate their projections before adopting this policy.

Community proposal designation and proposal-route responses add optional
`unavailable_reason: publication_closed` only after current source/owner guards.
The boundary treats that certified posting restriction as local; missing hints,
source suppression and an independently unavailable overview remain conservative.
This preserves proposal drafts and administrator fallback after closure. It does
not change saved publication paths, bodies, keys or server digest interpretation.

The coordinator retains only bounded source keys for capacity accounting and preview
identity, not a dependency-completeness model. Private receipts remain independent.
Every denial revokes again after an earlier denial, restoration, retry or remount. Request dispatch order is not server authorization order. Positive results
must still carry the current fence through publication. The coordinator survives
React retry and retains detached regions while their requests drain.

The boundary canonicalizes UUID comparison keys for bounded source bookkeeping,
pending reads, preview caching and resource host scopes. The accepted UUID
contract is case-insensitive; raw URL or saved-command spelling cannot distinguish
authorization identities. Opaque names, paths and tokens retain their own meaning.
Canonicalization is confined to indexing and comparison: saved commands, request
bodies and server digests retain their existing bytes and semantics.
Pending Follow/mute recovery and per-resource mutation guards use that same identity;
older Following slots are matched through their frozen target without rewriting the
record. A different UUID spelling must not permit a second uncertain command.
Dismissal input comparisons share one browser key function across journal overlap
checks, source/group controls and restoration entries. Keys include the input kind:
a shared event and personal delivery remain independent even with the same UUID.
Status and retry retain the original command key, input spelling and ordering.

This deliberately accepts unnecessary withdrawal from an ambiguously old denial.
There is no server-ordered authorization proof in this increment. We would revisit
that tradeoff if measured availability costs require it and a complete server-ordered
authorization/structure proof is available; a client generation, private version or
cached path cannot supply that proof. The confirmed real HTTPS failure
was a request held before dispatch across suppression, restoration and a second
suppression. It is tested independently of client dispatch order.

Coordinator bounds are32 retained regions,256 tracked requests and1,000 source
identity/ancestor keys and previews per region. It refuses excess work rather than
evicting a necessary fence. Unmounted regions are released after their requests
settle. Preview batches cap at25 and retain only the current region projection.
Private command journals retain their existing independent bounds and semantics.
Legacy adapters observe denials conservatively and strip receipts before private
settlement. They do not manufacture positive metadata authority from a decision.

Credential/access refusal invokes the shell's existing identity fence, including
a refusal arriving after same-identity navigation. Older identities cannot revoke
a replacement identity. Private recovery records survive, but their controls are
not displayed until the shell establishes current identity again. Withdrawal runs
before awaiting journal Web Locks; if identity fencing prevents recording a known
refusal locally, its immutable command remains uncertain and needs exact recovery.
Missing individual revisions retain the existing independently authorized history
path; they do not imply that every retained revision is unreadable.
Current/exact revision GET failures may add `unavailable_scope: revision` to the
existing `404 unavailable` envelope, only after the same transaction's resource
and ownership guards succeed. Nonexistent, suppressed and unsupported revisions
share that classification; it contains no revision identity or content. Source
guard failures never carry it. History resource denials remain ordinary source
denials; empty history and invalid continuations keep their existing contracts.
The boundary recognizes this classification only for revision reads. Generic
query hooks cannot opt out of revocation, and missing/unknown classifications
withdraw conservatively. A later history probe cannot classify an earlier denial:
access could have changed between the two server reads. This annotation classifies
the failed representation; it is not a new authorization lease or ordering proof.

This replaces the earlier mount-owned generation and safe-removal exception model.
Centralizing callbacks had improved coverage, but combined response types still
forced authorization exceptions into private recovery and tests inferred server
ordering from client request age. Keep authorization lifetime separate
from durable operation settlement: a confirmed old decision can settle its journal
without reauthorizing metadata. Reconsider this boundary when another host or
transport is introduced, using the host/response-path matrix as the acceptance rule.
Selection preparation errors for changed policy, unfinished projection or expired
descriptors reach Updates recovery. Recovery uses the displayed overview/expansion
bounds and fences unseen successor responses; it does not substitute a fresh scope.
Updates shares that boundary for controls, overview/member/reason reads and pending
recovery saves. Its bounded pending expansion request survives outside the withdrawn
content; retry reauthorizes the saved overview before recovering that exact expansion.
A fresh authorized view may restore the display; the private command journal survives.
Applied dismissal receipts retain
their originating selection separately from the refreshed card, allowing remaining
inputs to be reviewed without undoing the earlier subset. Keep only the latest
adjacent receipt; the bounded settings list still discovers other dismissed inputs.
Page reads capture an attention-event generation so a delayed response cannot clear
a notice from a later local completion or another tab. These client rules preserve
the server's existing exact sets, original Undo versions and frozen traversal bounds.
Successful decisions notify the current identity even after their originating
control unmounts. Only the old component's state update requires it to remain
mounted; an identity change prevents both notification and stale UI updates.
Attention actions never invoke reading operations. Sign-out fences identity before
its independent journal cleanup; late responses cannot recreate removed records.

Verify real PostgreSQL/HTTPS identity sets, negative fences, overlapping operations,
both guard orders, delayed delivery, old-table/token upgrades, quota/rollback/bytes,
restart and credential replacement. Exercise compiled Chromium, separate StrictMode,
failed storage, stale tabs, both cross-target response orders, keyboard and narrow
layout. Run normal checks, affected PostgreSQL suites, the complete browser suite
and diagnostic verification without weakening CI. Record actual results separately.

Rejected alternatives: resource watermarks lose gaps and future inputs; filtering
after highlight selection starves eligible groups; live group ordering skips pages;
altering v1 silently changes old recovery meaning; expiring decisions with grouping
custody loses deliberate state. Reconsider limits with representative workloads or
approved retention requirements. Until-unmuted is no editing reservation. Physical
erasure, destructive restore, multi-API custody, production, files/attachments,
private notes, reservations, timed snooze, push/email/webhooks, recommendation
inference, automatic acknowledgement and universal reviewed flags remain outside
this increment. No composite acceptance scenario is declared complete by this ADR.
