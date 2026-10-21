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

Setup/configuration, admission/credentials and editor management have separate
Participation components. Private recovery does not authorize selected account
copies or one-time secrets. Shared presentation and leased collection components
live in `participation-ui.tsx`, without page or shell imports. Page modules do not
import the shell; new shared helpers must preserve that direction.

`tests/unit/protected-read-architecture.test.ts` enforces boundary-based transport
throughout this directory. Mounted StrictMode tests cover late ownership/authority
and recovery, while compiled Chromium exercises dialogs, native focus, routing,
cross-tab journals and the delayed-community sibling-key regression. Build before
browser suites; never run a cleaning build during compiled-browser/native tests.
