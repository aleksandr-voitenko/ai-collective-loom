# Participation browser boundaries

`EditingIntent.tsx` adds explicit optional controls beside exact/current resources
and existing-revision composers, without changing their draft or publication state.
Initial collapsed controls perform no notice read/mutation. Refresh is independent;
focus/background/reconnection/storage changes mark observations stale and never renew. The source
query uses its existing authorization host and lease; transient failure remains local.
The settings-policy `/loom/editing-intent` route retains private status/exact retry
and owner release after source loss, including confirmed commands. Receipts never
rehydrate source metadata. Existing IntentStore/Web Locks preserve immutable requests
and compare pending resource identity before new commands; no new journal prefix.
An uncertain renewal permits a separate release only for the same notice at an
observed version at least as new as its expected version. Unknown announcements
and releases retain overlap protection. Explicit terminal reconciliation stores
`editing_intent_release` beside immutable request bytes, keeping the original state
uncertain while unblocking new intent. It requires a validated released receipt for
the exact notice at a later version; expiry/absence/denial do not qualify. Web Locks,
sequence checks and view ownership fence reconciliation; late settlement preserves
its evidence. Older journal records remain readable without the optional field.
Saved slot labels retain resource/base while renew/release bodies retain prior notice
and expected version. Composer notices use its retained/corrected draft base rather
than newer resource defaults. Responses arriving after route/identity departure are ignored
before settlement. ADR-032
and the reservations memory own semantic/expiry/limit decisions.

`FileText.tsx` renders exact literal text under the ordinary full withdrawal host;
processing-status reads are separate, never optional unavailable-source projections.
All text/status/download requests use current authorization and endpoint catalogues.
Late success cannot restore a withdrawn/left/other-owner view; explicit retry checks
authority again. Text is rendered only as text nodes in a wrapping pre, never through
AuthoredText/Reading, parsers, embeds or executable blob previews. Files.tsx retains
participant-bound folder/page in the existing history entry's state, leaving source URL/reading episode
unchanged. Search's Files mode has independent schemas/cursors; switching preserves
query/filter intent and starts a fresh traversal. Exact links preserve search URLs
on back. File processing administration loads only when deliberately opened.
Exact preview context_url is a structured API read; browser_context_url is separate.
Expired preview cursors retain a First text page action. Independent status reads
sequence their local observations while all same-owner denials still propagate.

`ParticipationApp.tsx` owns session/community discovery, navigation, sign-out and
the ReadingProvider/view keys. Before community initialization it uses a focused
shell without workspace navigation. `CommunitySetup.tsx` reuses the existing setup
journal/authority protocol; administrators enter only the community name, other
participants see an explicit waiting/refresh screen. Fresh requests use the existing
topic/overview defaults. Hidden fields come from the complete current saved body on
name edits and first dispatch; older drafts/corrections and uncertain retries must
retain their authored content and exact recovery identity. An uncertain setup remains focused even when discovery sees
settings_version > 0: that observation cannot settle the original command. Successful
confirmation reveals the current workspace route. Corrected drafts retain the existing
`/loom/admin?intent=...` recovery link; no automatic POST or new key is introduced.
`ParticipationAdministration.tsx` owns post-setup management only. Additive server
installation_mode distinguishes Local pilot from Synthetic preview; the legacy
synthetic protocol profile and finite policies remain unchanged. `ParticipationRoutes.tsx` selects page components
and supplies fallback authorization boundaries; individual topic, discussion and
resource pages retain their existing source boundaries. The Changes route excludes
query edits from its provider key so persistent controls keep their lifetime.

`ParticipationTopics.tsx` owns topics, proposals and overview composition. Overview
embeds `ResourceContent` from `ParticipationResource.tsx` inside its own boundary.
`ParticipationDiscussion.tsx` keeps discussion traversal and reply expansion together;
reading and reference siblings use distinct revision keys (LC-20261018-QWNB).

Discussion headers distinguish local closure from inherited topic closure; only
administrators receive the contextual close/reopen organization links. The existing
Organization journal keeps the same scope and bytes, with original decision versus
current local/effective state displayed on recovery. No reopening resends drafts.
Routine `area.create` confirmation opens the authorized current topic only after
durable local settlement, with matching original/current ID, parent, version and
open state. A changed result keeps the receipt; late view/identity/authority loss
cannot navigate. Completed creation records stay in Local drafts, but are excluded
from the next creation's implicit slot lookup and the Topics recovery list.
The destination's short success notice binds the participant and topic, follows
an authorized source read, focuses the heading and expires without another write.
`response-contracts.ts` accepts certified `forbidden_reason: publication_closed`
only for publication/preparation/upload endpoints. This retains independent readable
history after closure; generic forbidden/identity/source loss still withdraws it.
Mounted `discussion-closure` tests use the actual ActiveView/resource/organization
hosts, including contribution/summary intents and storage refusal before dispatch.

`ParticipationComposer.tsx` coordinates authored drafts, correction and exact retry.
`composer-draft.ts` derives routes/targets/capabilities from its six-kind caller
operation union and owns draft construction/comparison/correction transitions.
Named draft patches preserve undefined-as-unchanged and explicit null/empty values;
loaded journal bodies remain opaque; uncertain dispatch sends the retained body unchanged.
Keep its journal sequencing in `participation-state.tsx`/`participation-client.ts`;
delayed coverage/account selections use latest-draft callbacks. Explicit correction
of a rejected v1 draft may adopt the exact comparison revision's references;
v2-to-v3 correction preserves attempted references (LC-20261016-BA7H).
V4 file-aware correction copies exact comparison file declarations while preserving
supported attempted edits; a conflicting attempted logical ID receives a fresh copy ID.
The file assertion keeps its ID for carry-forward. A rejected format requirement is
retained as journal metadata; unrelated v3 refusals do not force a new comparison.
Missing-manifest refusal can precede the v4 refusal: correction adopts both missing
manifest and unsupported file declarations. V4 drafts retain deliberate withdrawals.
Corrected v4 drafts may retain32 main references locally, but publication is disabled
above16 and server combined limits stay unchanged. Uncertain request bytes remain immutable.
`ReferenceFilePicker` extends existing controls with bounded exact manifests; no byte
preview/download or private action occurs during selection. `FileTextPage` resolves
file reference context independently of text processing, and Files exposes file-scope
incoming controls. Whole-view authorization withdraws late target metadata/results;
failed pages retain prior context and exact cursor, explicit retry focuses the heading.

Contribution composers use `attachment_set` independently of authored format;
FileEditor keeps explicit opening/reply/edit targets and recoverable partial paths.
Legacy correction adopts a reviewed comparison set only when the attempted draft
has no set, preserving its text/references/change-account fields. Exact history
renders attachment controls beside that contribution. `AttachmentPromotion.tsx`
uses the same IntentStore under a settings authorization boundary: private command
recovery survives source withdrawal, while selection/dialog metadata is leased.
Retained promotion labels identify source/revision/file and destination/title.
Late receipts after unmount or identity change cannot settle a journal. Attribution
is progressive: its button opens the exact resource's `?attribution=1` view. Only
that view leases the revision and provenance queries separately; unavailable-source
evidence revokes old content, then the current provenance projection requests a new
artifact read. `ResourcePresentation` unmounts with its revision lease, including
opaque controls under their own withdrawal boundary. Ordinary resource and overview
hosts keep withdrawal; neither private receipts nor cached body values reauthorize
content. Source absence never changes the independent artifact's file context.
See ADR-030 and `tests/web/attachment-promotion.test.tsx`.

Setup/configuration, admission/credentials and editor management have separate
Participation components. Private recovery does not authorize selected account
copies or one-time secrets. Shared presentation and leased collection components
live in `participation-ui.tsx`, without page or shell imports. Page modules do not
import the shell; new shared helpers must preserve that direction.

`recovery-storage.ts` shares exact write/readback and best-effort raw rollback
across Reading, Attention, Shared Changes and both Updates journals. Its bounded
per-intent scanner/writer serves only Reading and Attention: scans count stored
UTF-8 bytes; replacement capacity counts reserialized other records. Adapters own
schemas, limits, prefixes, locks, transitions, messages and success events. Reading
automatic preferences and Updates partial clear keep their separate write paths.
Feed map construction, sequence checks and tokens remain in each feed adapter.

`tests/unit/protected-read-architecture.test.ts` enforces boundary-based transport
throughout this directory. Mounted StrictMode tests cover late ownership/authority
and recovery, while compiled Chromium exercises dialogs, native focus, routing,
cross-tab journals and the delayed-community sibling-key regression. Build before
browser suites; never run a cleaning build during compiled-browser/native tests.

Private notes (`PrivateNotes.tsx`, ADR-033) use the actual `/loom/notes` settings
host. Closed privateRead routes authorize owner detail/search separately from
leased `/sources` previews. Source denial withdraws previews while retaining
owner text/cleanup; identity loss withdraws both. Queries use POST and participant-
bound history state. Note receipts contain no bodies and cannot authorize sources.
`note-recovery.ts` validates drafts/exact commands; IntentStore shares the existing
32-record/1-MiB journal. Unknown updates permit a separate optimistic delete.
Explicit terminal forgetting requires the same identity, valid deletion timestamp
and a version above the attempted base, without deciding the earlier outcome.
Clear/remove readback failures stay visible; late receipts and queued autosaves never
recreate removed persisted note records. Note/storage events invalidate pages and
previews; a relevant cross-tab storage event consults the current journal and makes
one fresh owner read for a saved or attempted note, including a create committed
without leaving its draft route. Unsent drafts are not rebased. See focused mounted
and compiled `notes` tests.

Administration uses `useAdministrationPage` for additive read-only POSTs, passing
current self for cookie CSRF. It retains one leased page and at most16 earlier
cursor positions; failed loads keep the page and exact retry continuation. Controls
use aria-disabled plus busy guards to preserve native focus. Credential components
are keyed by selected account; lifetime/sequence/identity/authority checks fence
late rows and post-command refreshes after departure. Exact lookup adds at most one
leased account; audit is mounted only when deliberately opened. User-entered lookup
intent stays independent of protected result/selection copies. Existing one-time
secret leases and exact private command journals retain their prior semantics.
See ADR-035 and the production-host mounted/compiled administration tests.

## Temporary participation throttling

`temporarily_throttled` retains session, authorized content and exact intent/uncertainty;
never add it to definitive rejection or withdrawal lists. Discovery throttling retains
identity with explicit Retry. `ParticipationRates.tsx` uses the existing journal for
versioned policy commands/status and a leased audit view. No automatic retry/re-key.
Mounted composer, shell and policy tests plus compiled administration cases cover
reload/lost acknowledgement and original/current policy recovery. See ADR-038.

Local drafts on the Participation guide offers explicit publication status without
opening an ordinary source read. A confirmed journal remains retained with its exact
command; throttled, missing or failed status keeps uncertainty. Late responses after
navigation/identity change cannot settle the journal.

`FileLimits.tsx` (ADR-039/guide23) uses existing IntentStore and authorization leases
for administrator policy/status/audit and optional composer own-usage discovery.
Snapshots never authorize admission or locally block retained retries. Quota errors
retain drafts/exact attempts; only definitive first refusals allow explicit correction.
The four fields use exact bytes/counts and separate over-limit usage. No file bytes
or credentials enter journals; ordinary file reselection/digest checks remain.

Operational health (ADR-040) mounts on demand in Administration and performs explicit
protected reads only. `OperationalHealth.tsx` displays independent source observations,
unknown/unavailable states, safe failure references and incomplete request samples.
`useBoundedAdministrationPage` shares existing one-page/16-position history, exact
failed-page retry/focus and authority/request/route fences with account/audit browsing.
No polling, automatic worker recovery or private collection query is introduced.
The response catalogue classifies all five operational routes as protected reads.
