# Text participation boundary

Summaries (ADR-010): migration 0010 adds one typed canonical resource per discussion,
revision-owned coverage and participant-owned preparation headers/members. The
`summaries.ts` read model is separate from `summary-preparation.ts`; fixed coverage
inserts live in `publication/summary-storage.ts`, before the common clock tail.
`summary.create`/`summary.revise` use `discussion-summary-v1` for v1/v2 content and `discussion-summary-v2` for v3; generic revision
publication cannot bypass coverage. Creation serializes on the discussion UPDATE
guard and grants its creator editing atomically. Later writes require explicit
editor/admin authority; only admins change lists, using `summary.editors`.
Full preparation fixes up to 100 current opening/comment candidates in one SQL
statement; explicit selected pairs remain partial. Class 5 custody precedes class 1
and the sorted resource plan. Handles: 24 hours, 8 active / 128 retained per owner,
8192 headers total; cleanup deletes at most 800 member rows and keeps tombstones.
Publication copies immutable members independently. Whole immediate-base carry
preserves hidden history without new authority. Only a committed irreversible
expiry refusal with `operation_outcome=rejected` can release an uncertain summary
intent for correction; ordinary absent status remains uncertain.
Coverage counts are eligible-only, independent of partial/unknown; >100 current
sources gives null counts/work_limited. Generic detail never serializes memberships.
RR source pages and maintenance use current guards, encrypted five-minute / 2 KiB cursors,
4–128 KiB JSON; maintenance scans 10 summaries / returns 5, member pages scan 100 / return 25.
Source/reference-only revisions count; bookkeeping, linked targets and summary
revisions do not. Saved summaries are explicitly unsupported. `web/Summaries.tsx`
uses the existing journal, current-view callbacks and identity guards; correction
requires an explicit declaration and keeps the v1→v2 comparison guard. See the
summary guide and `test:summaries:postgres`/`e2e/summaries.spec.ts`.
After confirmed summary revision, the composer explicitly fetches the current
authorized revision and saves a newly keyed draft before retiring the old record.
It carries that base's entire declaration without selecting later source material.

`publications.ts`, `retrieval.ts`, `administration.ts`, `organization.ts` and `saved-items.ts` implement the synthetic
`participation-1` slice. Controllers are in `server/http/participation.ts` and
`identity.ts` and `organization.ts`; shared schemas/guide/parser are in `src/contracts/`.

Constructors share `commitRevision` with the original internal text/plain operation.
Validate and parse before SQL. The scoped attempt mutex precedes sorted participant
locks (including mentioned IDs), current actor/credential guards, containment and
revision/editor guards. The common clock/event/intent/outcome tail remains last.
Do not add a network call, parser callback or newly contested guard after the clock.
Setup/config use advisory class 3, identity administration class 2 and containment
class 1. Editor changes take the target exclusive guard and expected list version.

The digest includes the operation/version and all accepted semantic fields except
the key; lower-case UUIDs, sort entity tokens and object keys, preserve text exactly.
Old internal digest rows are not rewritten. Exact replay checks current action
authority before returning the original IDs; read-only status checks live read
eligibility and can recover after losing edit rights. `not_recorded` is uncertainty.

Migration 0004 adds resource companion tables without altering prior migration bytes.
A discussion and null-parent opening commit together; replies name their actual
parent. The composite `(discussion_id,parent_id)` FK rejects cross-discussion parents.
Application grants prevent changing contribution identity/parent/creation order.
Overview is a normal artifact, with normal revisions and administrator editor lists.
Config absence/ineligibility is explicit and does not block unrelated participation.

Bodies are exact v1, explicit-reference v2 or change-aware `loom-markdown-v3`,
16 KiB UTF-8 text plus rationale and 4,096 parsed tokens maximum,
with at most 16 validated ordinary-prose mention tokens/IDs. Raw HTML, images and
non-HTTP(S) links do not render as active content. Ordinary links infer nothing.
Files and model execution remain unsupported; persisted entities feed the independent notification consumer (ADR-023).

Eligible retrieval rows contain metadata + exact full-content paths. Default 12, max 25,
scan max 100, serialized response budget 4–128 KiB. Maximum escaped accepted text
fits the 128 KiB full-body path. Empty pages may have a continuation. Child order is
created_at/ID; other collections use UUID order, not a claimed recency/name sort.
Ancestors are nearest-parent first. Child/ancestor pages retain unavailable IDs as
structural markers; `/contributions/:id/context` returns the current body or only
the marker and discussion/parent IDs. `contributionOwner` uses the shared guard's
`reply-traversal` mode: only the target contribution may be unavailable; every owner
must remain active. Body/publication guards remain strict. History checks resource
ownership and each exact revision independently of current-revision availability;
withhold a suppressed current revision ID and editing hint. No ordinary read changes
receipts, delivery or source activity. ADR-016 records the structural-disclosure scope.

AES-GCM cursors bind participant/query/scope with a process-local key. Hierarchy and
area/discussion/artifact collections also bind the community hierarchy epoch; any
organization change makes old continuation requests fail `invalid_cursor`. Restart makes
old cursors invalid, not old publication intents. This currently assumes one API
process. Personal direct attention and ungrouped shared Changes use durable custody
and independent recovery epochs in their sibling notifications/following modules;
combined Updates adds independent paired custody in `../updates/` (ADR-025), while
ordinary browsing cursors keep these rules. Destructive restore remains a separate gate.

Browser `IntentStore` records origin/instance/participant/kind/key/body before POST,
caps 32 records/1 MiB, fails closed without evicting uncertain work, and exports JSON.
Mutations take a short Web Lock over that bounded journal and compare record
sequences; view-local queues order input before dispatch. Unsupported browsers fail
closed on writes. Stale edits become separate `blocked_by` drafts requiring explicit
review, never automatic POSTs. Dispatch/removal reject stale versions; late outcomes
cannot recreate removed intent or downgrade terminal state. Legacy v1 records adopt
sequence 1 with unchanged key/body; all tabs must reload onto the same release.
15-second transport deadlines and cancellation do not prove rollback. Known conflicts
preserve drafts and the exact comparison revision ID across reload. Rejected fields
stay locked until explicit correction saves a new draft before removing the old one.
Resumed-draft URLs move to the new operation ID at that explicit correction boundary.
Write-another replacements use the same saved-draft route as Local drafts, including
area/composer or discussion/parent selection. Canonical unavailable-current pages
offer independently authorized history without substituting an older current body.
Setup/admission use the same first-dispatch rejection rule; a later refusal never
reclassifies an uncertain attempt. One-time credential UI binds participant, kind,
nickname and credential ID to the result and locks target selection until dismissal;
secrets never enter intent storage. Administration uses a private-settings boundary:
queries, selected-account copies and one-time secret displays retain separate leases.
Role/editor refusals withdraw content without revoking the private journal owner;
first rejection can settle and uncertain retries retain their exact bytes. A late
receipt cannot refresh account metadata or restore a withdrawn secret display.
The query hook fences refresh callbacks by their creation generation and blocks
automatic reads mounted after withdrawal. Explicit refresh restores dispatch;
a fresh mixed response carries its own lease into subsequent traversal pages.
Post-command refresh uses `refreshIfCurrent`, preserving the existing query lease
even when recovery was initiated after withdrawal. Setup/configuration cannot
restart shell discovery after withdrawal; explicit administration refresh can.
Configuration success refreshes its own leased query so repeated saves use the
current settings version.
Human credential recovery retains its kind from the immutable enrollment command,
both while pending and after the withdrawn one-time display is dismissed.
Configuration inputs are seeded by a current leased community query. Ordinary
posting closure remains distinct from role loss. Focused branches validate discussion membership.
Recovery/structural-traversal review repairs: `LC-20261014-6LGH` (ADR-016/017).
Journal serialization, replacement routes and canonical history discovery:
`LC-20261014-S0JX` (ADR-017).
Identity generation plus view ownership guards all late results. Sign-out explicitly
clears this identity after export opportunity; cleanup failure still invalidates the
session and reports retained local records. Unresolved records do not auto-expire.
`scripts/participation-client.mjs` uses a private fsynced journal and actual HTTPS;
it is runnable elsewhere but only same-machine execution has been observed.

Tests: `test:participation:postgres` (real TLS/SQL/standalone processes), `test:e2e`
(actual Chromium, virtual WebAuthn, persistent browser process restart), authored
rendering/recovery units plus retained identity/publication/runtime/migration suites.
Build before real browser/runtime suites; do not run a cleaning build concurrently
with tests that spawn compiled files. Fixtures own fresh tmpfs containers only.
The E2E context fixture depends on the server and explicitly closes the browser
context first. A TLS preconnection without an HTTP request can otherwise block
graceful server teardown; the deterministic socket regression covers that order
(`LC-20261014-WZF5`).
The shared fixture and persistent-context wrapper also capture bounded diagnostics
before close; see `tests/MEMORY.md`. Use the npm browser command so raw reporter
output/attachments stay out of the approved artifact directory.
No logged/screenshot credential secret, reset, deployment or physical-device trial
is implied. See `docs/development/participation-evidence.md` for actual results.

Saved items (ADR-013): HTTP `/api/v1/me/saved-items` derives every owner from the
principal. `saved-state-v1` hashes target, desired boolean and expected target version;
retain applied and version-conflict outcomes separately from current state. Version 0
means absent; every applied command advances it, including an initial Unsave. Never
delete an unsaved tombstone or reapply an old accepted Save on exact retry. Attempt
guard → current actor → owner bookmark guard → bounded shared source guards. These
transactions never acquire the shared publication clock or emit its side effects.
Migration 0005 enforces target kinds, discussion-opening membership, revision ownership
and owner/target uniqueness; immutable identities/outcomes have restricted grants.
Known owner references may show a safe unavailable entry and permit Unsave after
suppression; no cached source metadata is stored or replayed. Exact revisions never
retarget. Saved lookups/decisions fit the hard response cap. Listing selects at most
26 candidates/resolves 25, with 32-resource owner-chain limit, stable target-ID order
and an owner collection version. Changed membership invalidates the cursor explicitly;
source changes reauthorize each projection. Caps include 500 tombstones and 10,000
decisions, with no auto expiry. Restart invalidates process-local cursors only.
`web/SavedItems.tsx` reuses the journal and adds a short per-target lock before initial
intent creation; do not hold either Web Lock across network work. It keeps Saved
recovery separate from publication drafts, guards late view/identity/version responses,
invalidates in-flight collection reads on journal changes, and preserves failed-page
retry positions. Sign-out removes local intent, not server
bookmarks. First-dispatch `saved_limit_reached` is a dismissible rejected record;
later uncertain retries and stale first refusals remain uncertain under journal
sequence/owner guards (`LC-20261014-8GYV`). Tests: `test:saved-items:postgres`,
`e2e/saved-items.spec.ts`; the external
`scripts/saved-items-client.mjs` persists immutable fsynced intent and accepts the
unchanged Saved contract in guide revisions 2–11. Production and cross-machine gates remain.
Saved-state rationale, retention choices and evidence: `LC-20261014-OIAD`.

Organization (ADR-020): `resources.owner_resource_id` is the only parentage;
NULL for an area is the implicit non-publishable root. Exclusive class-1 structure
guard precedes cycle/depth checks and writes. Publication uses its shared form;
proposal-bound publication takes class 3 before class 1. Every accepted command
advances the hierarchy epoch and existing target's organization version, including
no-ops; title/description edits append separately attributed metadata history.
Migration 0006 records legacy metadata as an unattributed baseline. Structural
events share the last clock tail with explicit before/after scopes and NULL revision;
old event scopes and content identities/revisions/editors/bookmarks stay unchanged.
Closure is local plus inherited, blocks all new text publications/revisions even
for administrators, and preserves reading. Reopen never clears child restrictions.
Only current administrators mutate/reconcile; audit has a separate admin-only route.
`organization-v1` retains original outcome references and freshly authorized current
state. Exact outcomes resolve before stale preconditions; K1→B, K2→C, retry K1 stays C.
Check original and current scope visibility before recovery. `not_recorded` is
uncertainty. No auto expiry: 10,000 decisions/community, 500 areas/subtree work,
12 area levels and 32-resource owner reads. Use bounded frontiers, not an unbounded
recursive intermediate. Future closure indexes must preserve resource parentage.
Optional `proposal_context` keeps ordinary discussion creation/digest compatibility
and binds affected area/settings; community-wide suggestions omit the area and
resume at the overview instead of inventing a subject. It never reroutes a retained draft. References are
withheld when affected sources are unavailable. `web/Organization.tsx` reuses the
extracted `participation-state.tsx` hooks and scoped journal ownership. Guide 7 and
`test:organization:postgres`/`e2e/organization.spec.ts` define the supported slice.

Search (ADR-012) lives in the sibling `search/` module and reuses these exact-body
and source guards. Current pointer equality is mandatory; reply ancestry is not
containment. Topic moves affect scope without indexing; closure does not hide text.
Guide 9 advertises independent search/personal consumers and direct shared Changes;
none certifies global outbox completion.
The bounded topic selector is reused with a search-specific label. Search owns its
query/cursor URL and late-response guards; no search operation enters the intent
journal or writes personal state. Search's separate author directory uses readable
publications, including suspended authors; the active-participant directory keeps
its existing meaning. See `../search/MEMORY.md` and `tests/MEMORY.md`.

References (ADR-021): `reference-context.ts` owns bounded target validation and
the full pre-source resource lock plan. `publication/reference-storage.ts` owns
fixed membership/withdrawal inserts in the common revision transaction before
clock allocation. Immutable source-scoped logical IDs retain original and latest
assertion attribution; identical carry-forward does not claim a new assertion.
Omissions append withdrawal provenance; historical withdrawn entries show the
latest eligible withdrawing revision. Unchanged immediate-base carry-forward may
retain unavailable targets; changed/new targets require read eligibility.
V2 is required when editing a v2 base, even an empty one. Explicit correction of a
definitively rejected v1 edit loads its exact conflict/expected revision and carries
that reference-aware base's declarations into a new draft for review, preserving
authored text.
Comparison failure blocks legacy correction; failed saves retain the rejected body.
Uncertain/replayed requests never upgrade. The v2 digest includes every
declaration field; v1 journal/digest interpretation never changes. Limits: 16 refs,
512 UTF-8 rationale bytes each, 16 KiB combined body/rationale. Duplicate IDs or
target scopes fail. File/private-note sources are excluded. ADR-010 adds typed summaries.
The full plan accepts up to 2,200 seeds for bounded summary maintenance, while
retaining the shared 3,840-guard cap; ordinary reference declarations still cap at 16.

`references.ts` provides direct outgoing/incoming reads under REPEATABLE READ,
current actor and sorted full resource guards. Read races either wait or return
explicit restart; do not mix snapshots. Incoming resource/exact scopes never
aggregate; default current, explicit history. Candidate scan 100, items max25,
JSON 4–128 KiB, owner walk32/total guards3840, statement deadline2.5s. Encrypted
2 KiB/five-minute cursors bind caller, semantics and source/visibility/hierarchy
boundary; edits/moves/restoration/restart invalidate. No counts or graph scan.
`web/References.tsx` feeds declarations into the existing durable composer and
guards picker/page responses by live view, request sequence and identity generation.
Known IDs/links work without indexing. Rationale is not searched; all three formats'
source title/body remain worker/rebuild eligible. Tests: `test:references:postgres`,
`web/references.test.tsx`, `e2e/references.spec.ts` and the reference evidence guide.

Authored changes (ADR-022): `change-context.ts` prepares exact account members;
`publication/change-storage.ts` inserts note/account rows before the common tail;
`changes.ts` owns authorized bounded reads/discovery. V3 explicitly requires nullable
change_note/change_account; only artifact/summary owners accept notes and only
ordinary contributions accept accounts. New members require eligibility; immediate-
base identical/carry members can survive suppression. Generated coverage withholds
hidden IDs/counts and reports unknown. Notes have no independent identity/event.
Main/note tokens and reference IDs are field-local; note assertions never carry as
continuing main assertions. Combined text/rationales 16384 bytes, note4096, combined
mentions/references16 each and parser tokens4096. Exact note bodies stay separate.
`web/Changes.tsx` uses current-draft callbacks and stable accessible names. New
revision drafts omit notes; saved/uncertain attempts preserve their exact fields.
Correction retains attempted references, including v2→v3 upgrades; only v1 drafts
adopt comparison-base references. An obsolete account carry requires an explicit
comparison-declaration carry, replacement or removal; the comparison read checks
source metadata without expanding unavailable members.
Discovery scans100, returns25, binds scope/history/form/owner and live source epochs;
resource aggregation validates each exact member even if current is unavailable.
Summary eligibility includes v3 ordinary accounts; summary note revisions stay out.

Notification integration (ADR-023): new reply constructors discover the immutable
parent author before sorted participant locks and capture active human/agent
eligibility in `notification_reply_facts` before the common publication tail. Older
schema fixtures omit that additive fact; old bytes/digests/retries stay unchanged.
The consumer authenticates no publisher and processes every retained ordinal;
see `../notifications/MEMORY.md`. Retrieval and Saved state never acknowledge,
consume or create notification effects.

Following/shared Changes live in sibling `following/` (ADR-024). Organization captures
bounded affected target IDs under its existing exclusive structure guard before the
clock tail; a pre-0013 fixture uses the original insert shape. New reads use all five
resource kinds for structural events, complete reference guard plans and exact revision
eligibility. Their private definitions and separate shared tokens do not change Saved,
publication, summary coverage or personal recovery. See `../following/MEMORY.md`.

Guide10/community discovery advertises `combined-updates-1` and its query URL.
`http/updates.ts` registers strict overview/member/reason reads, using shared source
projection and personal exact-source policy in one guarded transaction. It preserves
PR11's contribution-only focused-context rule; summaries open their discussion.
Updates errors carry retrieval recovery actions, never publication outcome claims.

Guide11 adds `reading-state-1` in `reading.ts`/`http/reading.ts` and migration0016.
Owner comes only from current authentication. Exact typed main-text resource/revision
pairs use absent unread/version0, retained negative states and immutable decisions.
Attempt → actor → owner advisory → full source plan → sorted exact revision guards;
no clock, event, outbox or worker. Every applied command increments version, even
no-ops. Manual Unread may supersede presentation-only changes since its expected
version; last deliberate version prevents overriding another deliberate choice.
Atomic lists of1–25 normalize UUIDs/sort revisions and reject duplicates. Replay
resolves before quotas/staleness and reports original separately from current.
Only known states/outcomes may return safe IDs/status after source suppression;
unknown hidden/missing pairs fail identically. New Read needs eligibility, known
Unread remains possible. Source editing rights are unnecessary; exact eligible
history survives current-revision/parent-comment suppression.
Limits:10000 states/50000 operations/100000 members per owner,16KiB request/32KiB
response,SQL2.5s/lock1.5s/transaction15s,owner32/guards3840. No expiry/eviction;
lookup and exact reconciliation remain usable at quota. See ADR-026.
`web/Reading.tsx` instruments only full main text, not `AuthoredText` globally.
`ParticipationApp.tsx` contribution bodies give reading and reference siblings
distinct revision-based keys. Sharing a revision key can leave duplicate text/controls
after a late community rerender; `e2e/following.spec.ts` gates that order explicitly.
Opt-in presentation requires every<=160px vertical band visible/foreground/focused
for1000ms sampled100ms. It accumulates across scrolling within the route episode;
overflowing horizontal code and>2048 bands remain manual. Manual Unread or observing
a later version blocks the episode; passive rerender/status/StrictMode/tab changes
never rearm. Explicit away/reopen or reload can. Preserve Changes controls' existing
query-independent provider lifetime. Badge cache follows mounted text;4096 episode
fences pause automatic observation without eviction until reopening. Manual controls
remain usable. `reading-recovery.ts` has separate Web-Locked
128-record/16KiB-per-record/512KiB custody, exact bodies and attempt counts, no
network under storage locks and identity fencing before cleanup. First-refusal
classification checks current attempts; retry/terminal late responses cannot
recreate cleared work. Native `reading-client.mjs` uses immutable fsynced0600 files.
Confirmed conflicts stay in the bounded browser journal until explicit dismissal,
with revision-specific feedback independent of other completions, refresh or reload.
`begin` refuses known conflicts; late duplicate results cannot recreate dismissed
records, and a late first refusal cannot downgrade a confirmed conflict.

Guide12 discovery additionally advertises attention-controls-1 and the separate
combined-updates-2 routine URL. `http/attention.ts` remains synthetic-only. Existing
publication formats/digests, reading conflict custody and distinct reading/reference
sibling keys remain unchanged. Shell sign-out adds separate attention/routine
journal cleanup after existing journals, with identity fencing between awaits.
Full area/discussion/artifact page components own the mandatory authorization
boundary around their content and Follow/mute controls. Community overview owns
one around its embedded artifact and proposal form. Source-error refusal withdraws
the whole page; owner refusal clears the shell identity and checks it again.
Discussion traversal uses a projections host: query values, retained collection
pages and reply pages gate their own leases. Fresh structural markers may remain
while older headers/bodies are withdrawn; opaque child state is removed with its
owning query. A retained opening ID is only an internal immutable query seed.
Readable but closed proposal destinations carry optional unavailable_reason:
publication_closed in onboarding/proposal-route responses. The boundary excludes
only that certified posting restriction from source denials; suppression and absent
hints remain conservative. Saved publication bytes and digest rules are unchanged. Shared read
generations reject earlier content replies. Only guarded current/exact revision
GET failures add `unavailable_scope: revision` to the existing404 unavailable
envelope. `RevisionUnavailableError` is raised after resource/ownership guards;
the HTTP adapter withholds its hint on other routes. Missing/suppressed revisions
keep independently authorized history discoverable. The browser boundary owns
classification; generic hooks cannot suppress unavailable errors. Unclassified
source/history denials withdraw conservatively, including after query unmount.
All browser protected reads require a boundary capability, including imperative
reply, reference, summary-source, change, organization, Saved, search and shared
feed reads. Other authenticated routes supply a default whole-view boundary.
Reading lookup batches use their registered text hosts' authorities; the provider
keeps private command custody through withdrawal. Closed session/receipt APIs
cannot fetch protected endpoints. Organization current-location results retain a
lease through journal settlement; Saved command denials are observed before metadata
is stripped. Reading receipt denial uses the same identity coordinator. The closed
method/endpoint catalogue classifies success fields independently of caller schemas.
Saved pages preserve private membership/Unsave while checking each page's metadata
lease; a fresh mixed page may display its own authorized rows, never older cached
content. Controls seeded by that page do not automatically rehydrate each row.
The import
guard and actual component/browser regressions enforce use of the boundary.
See `web/AuthorizationBoundary.tsx` and ADR-027.
See `../attention/MEMORY.md` for private choices and complete-feed preservation.
