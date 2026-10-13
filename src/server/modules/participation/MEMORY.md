# Text participation boundary

`publications.ts`, `retrieval.ts`, `administration.ts` implement the synthetic
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

Retrieval pages contain metadata + exact full-content paths. Default 12, max 25,
scan max 100, serialized response budget 4–128 KiB. Maximum escaped accepted text
fits the 128 KiB full-body path. Empty pages may have a continuation. Child order is
created_at/ID; other collections use UUID order, not a claimed recency/name sort.
Ancestors are nearest-parent first with explicit unavailable entries. Exact eligible
history may be read when current is suppressed; withhold that current revision ID
and editing hint. No ordinary read changes receipts, delivery or source activity.

AES-GCM cursors bind participant/query/scope with a process-local key. Restart makes
old cursors invalid, not old publication intents. This currently assumes one API
process. Complete activity catch-up, multiple-process cursor custody and destructive
restore/recovery epochs are separate gates, not extensions of ordinary pagination.

Browser `IntentStore` records origin/instance/participant/kind/key/body before POST,
caps 32 records/1 MiB, fails closed without evicting uncertain work, and exports JSON.
15-second transport deadlines and cancellation do not prove rollback. Known conflicts
preserve drafts and current-version comparison; corrected intent is explicitly new.
Identity generation plus view ownership guards all late results. Sign-out explicitly
clears this identity after export opportunity. Unresolved records do not auto-expire.
`scripts/participation-client.mjs` uses a private fsynced journal and actual HTTPS;
it is runnable elsewhere but only same-machine execution has been observed.

Tests: `test:participation:postgres` (real TLS/SQL/standalone processes), `test:e2e`
(actual Chromium, virtual WebAuthn, persistent browser process restart), authored
rendering/recovery units plus retained identity/publication/runtime/migration suites.
Build before real browser/runtime suites; do not run a cleaning build concurrently
with tests that spawn compiled files. Fixtures own fresh tmpfs containers only.
No logged/screenshot credential secret, reset, deployment or physical-device trial
is implied. See `docs/development/participation-evidence.md` for actual results.
