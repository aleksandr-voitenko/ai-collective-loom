# Text participation boundary

`publications.ts`, `retrieval.ts`, `administration.ts`, `saved-items.ts` implement the synthetic
`participation-1` slice. Controllers are in `server/http/participation.ts` and
`identity.ts`; shared schemas/guide/parser are in `src/contracts/`.

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

Bodies are exact `loom-markdown-v1`, 16 KiB UTF-8 and 4,096 parsed tokens maximum,
with at most 16 validated ordinary-prose mention tokens/IDs. Raw HTML, images and
non-HTTP(S) links do not render as active content. References/backlinks, files,
summaries, notifications and model execution are not implemented by accepting text.

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

AES-GCM cursors bind participant/query/scope with a process-local key. Restart makes
old cursors invalid, not old publication intents. This currently assumes one API
process. Complete activity catch-up, multiple-process cursor custody and destructive
restore/recovery epochs are separate gates, not extensions of ordinary pagination.

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
secrets never enter intent storage. Focused branches validate discussion membership.
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
bookmarks. Tests: `test:saved-items:postgres`, `e2e/saved-items.spec.ts`; the external
`scripts/saved-items-client.mjs` persists immutable fsynced intent. Guide revision 2
documents the actual subset and limits; production and cross-machine gates remain.
Saved-state rationale, retention choices and evidence: `LC-20261014-OIAD`.
