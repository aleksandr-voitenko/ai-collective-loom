# Participation browser boundaries

`ParticipationApp.tsx` owns session/community discovery, navigation, sign-out and
the ReadingProvider/view keys. `ParticipationRoutes.tsx` selects page components
and supplies fallback authorization boundaries; individual topic, discussion and
resource pages retain their existing source boundaries. The Changes route excludes
query edits from its provider key so persistent controls keep their lifetime.

`ParticipationTopics.tsx` owns topics, proposals and overview composition. Overview
embeds `ResourceContent` from `ParticipationResource.tsx` inside its own boundary.
`ParticipationDiscussion.tsx` keeps discussion traversal and reply expansion together;
reading and reference siblings use distinct revision keys (LC-20261018-QWNB).

`ParticipationComposer.tsx` coordinates authored drafts, correction and exact retry.
`composer-draft.ts` derives routes/targets/capabilities from its six-kind caller
operation union and owns pure draft construction/comparison/correction transitions.
Named draft patches preserve undefined-as-unchanged and explicit null/empty values;
loaded journal bodies remain opaque; uncertain dispatch sends the retained body unchanged.
Keep its journal sequencing in `participation-state.tsx`/`participation-client.ts`;
delayed coverage/account selections use latest-draft callbacks. Explicit correction
of a rejected v1 draft may adopt the exact comparison revision's references;
v2-to-v3 correction preserves attempted references (LC-20261016-BA7H).
Uncertain request bytes remain immutable.

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
