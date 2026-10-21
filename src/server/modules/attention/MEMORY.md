# Routine attention

ADR-027 / guide12, attention-controls-1, migration0017. This owner-private module
contains no worker, authored resource, publication or shared/personal clock write.
Source read eligibility suffices; Follow/edit rights are unrelated. New targets must
be readable. Known unavailable identities allow safe Unmute/Restore without metadata.
The authenticated participant owns all lookup/state/status/list operations; no
administrator owner override exists.

Mutes key owner/kind/resource. Areas carry explicit descendants; discussions and
artifacts use stable IDs. Until-unmuted is a preference, never an editing reservation.
Following's retained event-time before/after/impact matching governs shared inputs.
Any match quiets an input; independent parent/child settings have no implicit override.
Current paths only explain current overlap. Missing old impacts remain unknown.

Dismissals key owner/input kind/ID, with separate shared_event and personal_delivery
spaces. Atomic lists contain1–100 desired Booleans/expected versions. All applied
no-ops/initial negative choices increment versions. Any stale member records one
conflict, without partial application. Immutable decisions include canonical full
semantic digests; old retries return original versus current, never reapply. There
is no source FK on dismissal IDs: deliberate recovery survives source history loss.

Selection envelopes are AES-GCM, purpose/owner/instance/policy/meaning-bound with
exact identities/versions and24h expiry, no titles/bodies or registry. Preparation
requires ready base grouping and, for filtered cursors, a complete attention
projection at that cursor's policy version; over100 whole-card inputs fail without truncation.
Explicit subsets must be represented; unexpanded personal members are included in
whole-card sets. Current eligibility is rechecked for new decisions. Recorded exact
retry/status resolves before token opening, selection expiry, missing grouping or
quotas. Absent status remains uncertainty. Restoration uses current versions and leaves mutes.
Later revisions/deliveries cannot expand a command; continuing claims retain IDs.
`token-payloads.ts` defines the two issued selection/list shapes checked after
decryption to unknown. Malformed authenticated JSON is invalid_input; checking does not
coerce fields, rewrite token bytes/digests or add grouping lookups. List tokens keep
their collection/version/position format without a new instance or expiry binding.

Lock order: attempt → current actor → attention owner → structure/full sorted
resource plan → exact revisions → state/outcome/counters. Routine retrieval adds
Following before attention and grouping custody before source plans. Writes use
READ COMMITTED after the exclusive owner guard; avoid stale RR quota counts. Shared
owner guards protect reads; no network/storage locks span browser requests. Entire
response fit is inside the transaction so oversize output rolls back mutation.

Quotas per owner:64 active/500 retained mutes,10000 input identities,50000 decisions,
100000 outcome members. No eviction/expiry of decisions, states or negative fences.
64KiB requests/128KiB responses,32KiB envelopes,25-entry lists. List cursors bind
collection/policy version. Source/lock/transaction deadlines2.5/1.5/15s and existing
guard bounds remain. At quota exact recovery and lookup work; a new removal can
still require capacity-policy review. These are synthetic limits, not production
approval. Seven-day grouping cleanup never cascades into confirmed private choices.

`CombinedUpdates` v2 uses separate attention_views/members/groups and contract/AAD.
Filter shared/personal inputs independently before choosing limited highlights;
one remaining personal input keeps its source. Complete routes bypass choices.
Same-view attention refresh preserves base definitions/bounds/group IDs/order and
unknown coverage; an expired descriptor is renewed within its original custody
deadline to avoid the policy-refresh/renewal loop. Selection envelopes are not
renewed. Visibility/epoch/history checks
precede selection. Version1 and standalone feeds preserve their original meaning.

`web/Attention.tsx` progressively exposes mute/dismiss/restore and bounded settings.
Cards remain until deliberate refresh; successful keyboard Undo focuses a fresh
Dismiss action without scrolling. A new dismissal prepares current versions.
`attention-recovery.ts` uses separate origin/instance/owner Web-Locked immutable
commands,128 records/64KiB each/1MiB total. Save/read-back before send, per-target
conflicts, monotonic mute versions, sequenced lookups and identity/route fences.
Late duplicates cannot recreate cleared feedback. Exact pending commands may be
reconciled or retried; no automatic rebase/re-key. Card Undo uses original applied
result versions even when recovery reports newer current versions. Conflicts remain
in the journal and gate a fresh choice until acknowledged, rather than retaining
an unusable card result. Cursor/group or explicit input-set changes release pending preparation and clear
unconfirmed selections, preserving saved commands. Protected source reads and private recovery have separate contracts.
Additive `private-controls-1` endpoints return only IDs/settings/versions/outcomes;
source metadata/availability/overlap/counts are absent. Known Unmute/Restore and
recorded retry/status do not hydrate sources. Unknown/positive choices still check
eligibility under existing guards; old routes and canonical digests remain intact.
`/me/attention/previews` batches at most25 current source reads. Private version0
lookup defaults do not reveal source existence. Dismissal preparation/legacy input
lookup remains protected, independent of private results.
The mandatory host boundary uses the identity-scoped `protected-content.ts`
coordinator on all eight hosts. It owns previews, current fences and pending evidence,
including after withdrawal/retry/remount. Every same-owner source denial revokes
older protected projections, regardless of dispatch generation, cached paths or whether
other reads have settled. Moves and reordered previews make ancestry unsuitable
for selective preservation without server-ordered authorization proof. Positive
reads need current fences. A fresh mixed response may publish only its own leased fields;
other regions and older responses stay fenced. Private recovery cannot refill
withdrawn metadata. Older identities stay isolated.
Endpoint effects separate session identity from content authority. Role/editor
refusals withdraw protected content while private receipts/rejections can settle;
ordinary posting closure preserves independent reads. Administrator drafts/recovery
are separate from lease-gated account, credential and configuration metadata.
Generic and imperative protected reads require the same boundary capability;
there is no optional hook fallback. Session/receipt APIs have closed route sets,
private reads validate their route/schema, and the architecture check prevents
component transport imports. Reading lookups use the text host's authority while
private recovery remains independent. Only the guarded revision GET error's
explicit revision-only classification preserves independent history. Ordinary
source/history denials cannot opt out through a hook-local exception.
The method/endpoint catalogue classifies every negative success field, including
Saved/Reading receipts before private settlement. Its contract test compares real
routes/schemas. `readProjection` requires lease-gated rendering: Saved preserves
private membership and safe removal but gates metadata; opaque full hosts retain
whole-view withdrawal. An available receipt never grants content authority.
Boundary UUID keys are case-insensitive for bounded source bookkeeping, pending reads,
preview caches/attempts and resource host scopes. Opaque scope names keep their case;
canonical comparisons never rewrite transport targets or saved command bytes.
Mute controls and the journal's overlap guard use the same resource keys, so case
aliases expose the existing uncertain command and block a replacement choice.
Dismissal journal overlap and source/group/restore controls share `attentionInputKey`;
it canonicalizes UUID comparisons within each distinct shared/personal input kind.
Recovery status and retry preserve the original saved key and body spelling.
Limits:32 regions,256 tracked requests,1000 source keys/previews per region;
refuse excess, release unmounted regions only when requests settle, never evict fences.
Private settings and confirmation remain usable on Following/settings withdrawal.
Opaque full-source hosts unmount protected content; audited discussion traversal
gates individual response leases. Owner failure fences the shell before
journal locks. Exact commands settle independently and private versions remain
monotonic. Tests separate dispatch, real server evaluation and response arrival;
client request age never proves authorization age. See ADR-027 and feature evidence.
Successful decisions broadcast policy changes after same-identity navigation;
component liveness only gates its own state, while identity generation fences both.
The latest adjacent Undo receipt belongs to its originating selection; after an
explicit refresh, remaining inputs can receive a fresh reviewed dismissal without
rebasing that receipt. Other dismissed inputs remain discoverable through settings.
Sign-out fences before cleanup
and offers export; unrelated journals stay independent. Reading mutations never
originate here. `scripts/attention-client.mjs` uses fsynced exclusive0600 immutable
per-command journals, exact retry/status, and same-owner replacement credentials.

Tests are `integration/attention*.test.ts`, `web/attention.test.tsx`,
`web/authorization.test.tsx`, the host UI tests and
`e2e/attention.spec.ts`; see `tests/MEMORY.md` and the feature evidence for actual
execution/failure limits. No destructive restore, erasure, multi-API-process key
custody, provider/cross-machine or representative human acceptance follows.
