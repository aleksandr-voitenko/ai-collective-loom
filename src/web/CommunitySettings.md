# Community settings interaction specification

`/loom/admin/community` is the administrator form for the overview artifact and
proposal destination. `/loom/admin` links here; maintenance, admission and audit
sections remain on Administration. Presentation follows the v0.6 Loom palette and
system typography, with one 820px content column, a breadcrumb, two labelled
selections and adjacent Save changes / Cancel actions. Styles are scoped to this
page and its native modal picker.

On entry, read saved settings. Display the selected artifact title and containing
topic path, and the proposal topic name and complete path. Keep resource IDs
internal. Change opens a keyboard-contained dialog; Escape / Close preserves the
selection and restores focus to Change. Choosing a row changes only the local
selection. Duplicate names remain distinguishable by their visible paths.

Use existing authorized reads only: `GET /api/v1/artifacts?limit=12` and
`GET /api/v1/organization/destinations?limit=12`, with opaque continuation cursors.
Resolve selected resources and at most one artifact page through
`GET /api/v1/organization/resources/:id`. Never fetch all pages in advance.
Retain at most 16 previous cursors. First choices remains available after forward
traversal, including beyond that history window; it clears history and requests
page one directly. Completed navigation focuses the picker heading, including
return to page one. Traversal never changes the form's selected resource.
Closed topics are labelled and cannot be selected as new proposal destinations.
Failures show retry controls, never an empty selection or a cleared saved ID.

The in-memory draft retains its accepted baseline and expected settings version
across reads. Cancel restores that baseline locally, without a settings read or
write. Dirty route navigation and browser unload warn before losing unsent edits.
Unchanged and pending submissions disable Save. An explicit reload offered after
a conflict confirms before discarding edits; the draft changes only when the read
succeeds. A successful reload supersedes an earlier read error. Separate save
rejection and conflict messages survive an ordinary read.
Check saved settings displays a leased, read-only Saved choices comparison with
the unsaved choices above. It reports successful checking without changing draft
values or their expected version; a failed or withdrawn check cannot display a
fresh comparison. Cancel and successful save/reload remove the comparison.

Saving uses the existing settings contract and IntentStore. Persist the exact
request before dispatch. Only a validated committed receipt with the expected next
version reports success. Distinguish pending, confirmed, rejected/conflicted and
unresolved outcomes. An unresolved request locks editing, persists across reload
and offers deliberate Retry same save with identical bytes and operation key.
There is no automatic retry or new key for an uncertain save. A first definitive
rejection releases its request for correction while retaining the draft. If local
cleanup fails, the retained rejected request can be deliberately discarded only
after saved settings load successfully.

For settings only, an exact retry's `revision_conflict` (without an unknown-outcome
marker) also confirms noncommit: `ParticipationAdministration.change` holds the
owner/kind/key attempt lock and looks up a committed audit result before checking
the settings version. Such a result would return the committed receipt instead.
Current identity/role checks precede that lookup; permission, unavailable and
generic failures therefore cannot settle a previously uncertain request. The
shared rejection helper remains unchanged. Confirmed conflict releases that
request and exposes conflict resolution, retaining the attempted choices and base.
After remount, retained request bytes do not reconstruct the earlier accepted
choices: the form stays dirty and local Cancel stays disabled until explicit saved
reload or confirmed save establishes a baseline.

Authorization leases govern all titles, paths, reads and writes independently of
the private draft. Withdrawal hides metadata and prevents late receipts from
refreshing the shell or settling the request. Explicit Check access verifies the
current participant and administrator role before requesting new protected data.
Identity or instance changes remount the form under the correct journal owner.

## Existing API limits

There is no read-only Community settings operation-status endpoint. Exact replay
of the existing settings POST is the supported deliberate recovery action; this
page does not invent a status operation or infer an outcome from current values.

Onboarding can withhold a designation when its source is unavailable. The existing
whole-view authorization policy then withdraws settings metadata; this page does
not bypass it to recover hidden IDs or silently write null. Repairing that case
through a settings-only read would need a separately reviewed administrator
settings projection and authorization contract. No server extension is included.

## Review evidence

Mounted tests: `tests/web/community-settings.test.tsx` and
`tests/web/session-authorization.test.tsx`. The existing administration browser
journey exercises the compiled page, real WebAuthn, duplicate-name selection,
keyboard focus, Cancel/navigation, live version conflict, read failure/reload,
confirmed save, exact lost-response recovery and actual role withdrawal.

Opt-in capture (synthetic isolated fixtures only):

```sh
npm run app:build
LOOM_SETTINGS_REVIEW_SCREENS=1 npm run test:e2e -- administration.spec.ts
```

The helper writes PNG viewports and provenance under
`/tmp/loom-review-evidence/ui-02/viewport`, separate from diagnostic uploads.
Injected read errors and aborted save responses are labelled in the manifest.
No authentication state or raw traces belong in the review package.

The follow-up journey `community settings conflict recovery and bounded picker navigation`
tests a version-1 request whose live conflict is dropped after another administrator
commits version 2, then retries exact bytes and receives the live conflict. The
existing lost-committed-response journey remains separate. Follow-up screenshots
go to `/tmp/loom-review-evidence/ui-02-followup/viewport`. To exercise 19 pages with
bounded synthetic fixtures, Playwright deliberately reduces the destination list
limit from 12 to 1; actual authorized server responses and opaque cursors are used.
This test adjustment and response loss are labelled in the capture manifest.
