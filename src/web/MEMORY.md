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
on back. File processing administration loads only on its selected `/loom/admin/file-processing` route.
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
`/loom/admin/community?intent=...` recovery link; legacy root links still resolve
the retained kind. No automatic POST or new key is introduced.
`ParticipationAdministration.tsx` owns section routing and explicit saved setup recovery. Additive server
installation_mode distinguishes Local pilot, Synthetic preview and Staging test
(ADR-042); staging has its own runtime/profile and preserves the same finite policies.
Staging HTML alone includes a public deployment meta marker, so anonymous sign-in
and landing identify staging before protected community discovery. Status uses the
existing public runtime stage.
`installation.ts` reads that presentation signal; it grants no authentication or
authority and adds no discovery requests. Pilot/preview HTML and request flows stay
unchanged. The legacy synthetic protocol profile and finite policies remain unchanged.
`ParticipationRoutes.tsx` selects page components
and supplies fallback authorization boundaries; individual topic, discussion and
resource pages retain their existing source boundaries. The Changes route excludes
query edits from its provider key so persistent controls keep their lifetime.

`ParticipationTopics.tsx` owns topics, proposals and overview composition. Overview
embeds `ResourceContent` from `ParticipationResource.tsx` inside its own boundary.
`ParticipationDiscussion.tsx` keeps discussion traversal and reply expansion together;
reading and reference siblings use distinct revision keys (LC-20261018-QWNB).
Its `DiscussionBacklinks.tsx` Mentioned in disclosure lazily loads a separate
inferred-navigation page (ADR-043), with exact source links, author/publisher/time
and individually navigable contributions. It uses a full withdrawal boundary,
request/lifetime/identity fences, exact failed-cursor retry and result-heading
focus. Accepted page/cursor state distinguishes initial prospective absence from
an empty completed continuation without retaining earlier pages. Source grouping
never becomes a semantic reference or personal action.
`AuthoredText` shares safe instance-root local-link resolution with the parser;
normalized local hrefs must remain single-root-relative, never protocol-relative.
Native disclosures keep secondary message/discussion controls mounted and authorized;
ReadingText's compact mode leaves the prose/presentation observer outside its reading
disclosure and reveals pending/conflict/error controls. Empty summaries use a small
invitation. Reading disclosures retain the user's open choice after settlement;
only a new pending/error/conflict opens them automatically. The
available/unavailable/error summary states retain their existing meaning.
Reply parent labels reuse only current leased parent metadata with a matching ID;
otherwise the link stays generic. They open the actual parent in discussion context
without extra reads. Preview parent separately reads current context only on demand,
shows an excerpt capped at360 UTF-16 units and never registers ReadingText. Explicit
preview opening reveals/focuses its panel; closing restores a surviving trigger. Its host
survives an unavailable-parent response so fresh negative evidence stays visible;
older projections still withdraw. App-scoped discussion navigation stores only up to64
branch control snapshots and a return anchor, scoped to account/instance/path. It
survives query remounts while preserving their authorization and composer isolation;
return waits for the fresh message DOM before restoring offset/focus. Leaving the
path or identity discards it. Children remain on-demand and six-item bounded: counts describe
that page, never an inferred thread total. Opened branches stay mounted while hidden,
preserving nested drafts/cursors; same-page refresh retains surviving branch IDs.
Failed refresh qualifies retained observations. Projection withdrawal still removes
all page-derived labels/counts and older bodies before fresh structural responses.

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

`ParticipationComposer.tsx` renders the authored form using `usePublicationComposer.ts`.
The hook owns draft fields, journal actions, comparison reads, mentions/caret state
and focus effects as one coordinator; its view API exposes observations, focus refs
and named authoring actions rather than journal setters or sequencing internals.
`ComposerFeedback.tsx` renders confirmation, uncertain recovery and correction
panels without owning state or adding DOM wrappers. The composer coordinator retains
panel visibility, journal actions, comparison loading and recovery focus ref/effects;
confirmation is shown only after durable settlement. Keep editors and disclosures
mounted through busy/uncertain feedback changes.
`composer-draft.ts` derives routes/targets/capabilities from its six-kind caller
operation union and owns draft construction/comparison/correction transitions.
Named draft patches preserve undefined-as-unchanged and explicit null/empty values;
loaded journal bodies remain opaque; uncertain dispatch sends the retained body unchanged.
Keep its journal sequencing in `participation-state.tsx`/`intent-store.ts`;
after an explicit busy action ends uncertain, focus its existing recovery group only
while authorization is active and focus remains on the body or within that group.
Do not retarget restored drafts or deliberate focus elsewhere; focus also reveals
the controls without relocating the retained form or changing request custody.
Automatic reconnect status reads do not request focus.
Explicit topic/reply opening opts into first-field focus and scroll; closing keeps
the journal and restores the trigger only after a successful local save. A failed
save keeps the editor open with focused feedback. Native composer disclosures retain mounted
file/recovery state and show configured fields. `composer-mentions.ts` validates
caret insertion with the shared parser, then tries a separate prose paragraph
without rewriting the original Markdown. Failed placement leaves the draft intact.
MentionEditor presents readable labels while composer-mentions maps display/wire
offsets, including native CRLF/CR-to-LF display normalization; retained wire bytes
stay unchanged until editing. A private wrapper-free snapshot lifecycle captures
native selection before React mutates the controlled textarea for a label-only
name update, then maps/restores its range and direction through canonical offsets.
Queued selection notifications cannot collapse a pending replacement; labels do
not author content or create undo entries. Edits through a binding remove it, and
plain text paste never adds consent. Collapsed word/line deletions use the resulting caret
and removed length so identical unresolved labels cannot swap recipient identity.
A bounded100-step mounted undo history retains canonical bindings, groups composition
and handles keyboard/native history input. Chips remove all occurrences of a token.
Editable restored mentions resolve names from one authorized12-item directory page;
unknown recipients stay generic. Names remain in memory, never notification identity.
Uncertain requests stay opaque. Local-save feedback is sequence/owner/lifetime gated:
only the latest queued write reports saved. Confirmed results use a compact row;
uncertainty remains prominent. Drafts reuses Help's local journal controls under a
settings boundary, without guide/source hydration; legacy Help entry remains.
Delayed coverage/account selections use latest-draft callbacks. Explicit correction
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
Admission distinguishes a newly created account from protected existing-account
selection. Nickname headings focus only on account changes; failed lookup feedback
stays with lookup. Dispatched issuance hides the not-yet-issued notice; committed
secretless recovery keeps only the credential ID and requires revoke/issue on the
same participant. Select-to-copy selects the one-time field without clipboard or
journal writes. See `ParticipationAdmission.md` for the bounded journey and capture.
Recovered account names come from an independent authorized exact-ID lookup, not
the loaded account page. Its local loading/error/retry and lifetime/sequence/owner
fences never edit the saved command. Automatic lookup stops at withdrawn authority;
an explicit metadata retry can check access. In-flight command presentation hides
check/retry guidance while the durable journal remains uncertain.
`CommunitySettings.tsx` owns `/loom/admin/community`; the shared Administration navigation links to it.
Its instance/participant-bound in-memory draft outlives query reads. Dirty reads
retain both IDs, community name and expected version. Cancel restores the accepted
baseline locally; conflict reload confirms and replaces it only after success.
A successful reload supersedes read errors, independently of save/conflict errors.
Successful Check saved settings shows a separately leased Saved choices comparison,
without rebasing or replacing the draft; withdrawal removes that comparison too.
`CommunityResourcePicker.tsx` uses existing bounded artifact/destination pages and
organization lookups for leased titles/full paths, never whole-community preload.
A permanent First choices action bypasses the capped 16-cursor back history;
completed page navigation focuses the heading, including returning to page one.
A failed lookup retains the internal ID. Unknown unavailable designations cannot
be submitted as null; whole-view source withdrawal still applies.
Settings dispatch uses IntentStore exact custody, validated next-version receipts
and deliberate same-key retry after uncertainty (there is no settings-status API).
Settings-specific revision_conflict can settle an exact uncertain retry: server
`participation/administration.ts` serializes the attempt and returns any committed
audit result before checking the settings version. Generic authority/unavailable
or unknown-outcome errors do not qualify; the shared rejection helper is unchanged.
Restored request bytes keep the form dirty but cannot reconstruct an accepted
baseline for local Cancel; explicit saved reload or confirmed save establishes one.
Unsent edits warn on route/unload loss; uncertain bytes persist across reloads.
Withdrawal hides metadata and fences dispatch/late settlement. Explicit access
checks verify the current administrator role before fresh protected reads; private
input and receipts never reauthorize content. Page/API limits are documented in
`CommunitySettings.md`; no global query, authorization or server contract changes.

`Updates.tsx` keeps route/scope selection, the existing keyed view and rendered
groups/member controls. `useUpdatesView.ts` owns overview/member reads, displayed
recovery saves, retry/renewal actions, attention-change observations and focus refs.
Keep its request/owner/authority fences and save-before-display order together;
reason paging remains local to the stable `MatchingReasons` component. The pending
expansion position stays above withdrawal in `UpdatesPage`, without source metadata.

`SearchAdministration.tsx` owns `/loom/admin/search`; the shared Administration navigation links to it.
Health and the exact requested failed-job page load on entry and Refresh status.
One leased page replaces prior rows; failed continuations remain exact, First page
stays reachable and explicit pagination focuses its heading. Health counts are
current-generation only; failure rows span generations and older jobs cannot retry.
No queued work observed is not a coverage claim. Failed reads qualify retained data
as earlier observations; role withdrawal hides it and explicit access rechecks role.
`search-maintenance-recovery.ts` retains one 2KiB exact request per origin/instance/
participant using verified storage and Web Locks, including cross-tab dispatch.
Rebuild/retry use the original generation guards, without invented idempotency keys
or IntentStore records. Acknowledgement is separate from processing and actor
attribution. A conflict after response loss remains uncertain: no status lookup can
recover beyond the server replay window. Fresh health never rebases that request.
Sign-out includes explicit uncertain-request warning and owner-scoped cleanup.
Command errors bind to the recovery snapshot; cross-tab supersession retires only
that attempt's error. Unsent attempts keep their own request/context beside the
older custody snapshot; only failure before the send callback proves non-dispatch.
Receipt-storage failure remains uncertain. Retry feedback/recovery stays beside its job, retaining only
a bounded page position if the row disappears; rebuild feedback stays in Maintenance. Retry
feedback updates do not move focus or scroll the reader.
See `SearchAdministration.md` for states, existing API limits and capture commands.

`recovery-storage.ts` shares exact write/readback and best-effort raw rollback
across Reading, Attention, Shared Changes and both Updates journals. Its bounded
per-intent scanner/writer serves only Reading and Attention: scans count stored
UTF-8 bytes; replacement capacity counts reserialized other records. Adapters own
schemas, limits, prefixes, locks, transitions, messages and success events. Reading
automatic preferences and Updates partial clear keep their separate write paths.
Feed map construction, sequence checks and tokens remain in each feed adapter.

`participation-client.ts` is the compatibility facade for existing explicit client APIs.
`browser-transport.ts` owns endpoint requests, single error consumption and definitive
rejection policy; components keep facade imports and protected reads use
AuthorizationBoundary. `intent-store.ts` owns draft schemas and journal custody,
including the unchanged v1 storage prefix, legacy sequence adoption and Web Locks.
`webauthn.ts` owns only ceremony decoding/encoding and uses the session transport.
No journal operation performs a network request.

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
leased account; audit mounts only on its selected section route. User-entered lookup
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

Drafts and the legacy Local drafts section in Participation guide offer explicit
publication status without opening an ordinary source read. A confirmed journal remains retained with its exact
command; throttled, missing or failed status keeps uncertainty. Late responses after
navigation/identity change cannot settle the journal.

`FileLimits.tsx` (ADR-039/guide23) uses existing IntentStore and authorization leases
for administrator policy/status/audit and optional composer own-usage discovery.
Snapshots never authorize admission or locally block retained retries. Quota errors
retain drafts/exact attempts; only definitive first refusals allow explicit correction.
The four fields use exact bytes/counts and separate over-limit usage. No file bytes
or credentials enter journals; ordinary file reselection/digest checks remain.

Operational health (ADR-040) mounts on entry to Administration Overview and performs explicit
protected reads only. `OperationalHealth.tsx` displays independent source observations,
unknown/unavailable states, safe failure references and incomplete request samples.
`useBoundedAdministrationPage` shares existing one-page/16-position history, exact
failed-page retry/focus and authority/request/route fences with account/audit browsing.
No polling, automatic worker recovery or private collection query is introduced.
The response catalogue classifies all five operational routes as protected reads.

`ParticipationAdministration.tsx` selects exactly one of seven routed sections;
`administration-navigation.ts` owns their short ordered link list and exact retained
operation destinations. Community/Search keep their URLs; admission moves to
`/loom/admin/participants`, both independent limit controls to `/limits`, file text
to `/file-processing`, and identity-only audit to `/audit`. Unknown children are
unavailable. Root legacy `?intent` links resolve the actual retained kind, retaining
all query/hash values; unknown/missing intents remain explicit and reviewable.
`intentUrl` also uses that mapping. Selected setup recovery retains CommunitySetup;
uncertain initial setup still owns the focused shell. No mount replays a command.

The shell replaces ordinary navigation for the admin route segment, reusing its
branding/account/sign-out controls and linking Back to Loom to Updates. Only one
navigation tree mounts. Both desktop sidebars scroll within the available height,
including keyboard focus on lower navigation/account controls. At <=960px, a native
modal drawer overlays full-width content, with explicit Tab wrapping, Escape/close,
opener restoration and heading
focus after successful navigation. Resizing releases the modal without remounting
the active page. Community's blocker retains cancelled drafts and current links.
Admission adds one-time handoff route/unload protection without secret persistence;
late issuance after departure retains the exact attempt for deliberate reconciliation.
Credential completion rechecks lifetime/identity inside the serialized journal lock.
A secret also needs its current content lease; its in-memory handoff and existing
departure blocker commit synchronously before request retirement. Departure while
waiting for the lock leaves the original non-secret attempt untouched. A check only
after awaiting completion cannot preserve that custody. No secret enters storage.
Identical session probes retain the same Self snapshot so route discovery cannot
restart a pending/failed selected-account read; actual identity/role/CSRF changes still update it.
`Administration.md` records the bounded route/layout and compatibility contract.
