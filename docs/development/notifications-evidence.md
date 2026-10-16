# Personal direct-attention evidence

Task scope is [ADR-023](../adr/023-personal-direct-attention.md) and the user's
generation + retrieval + browser increment. Product/architecture/UI snapshots stay
unchanged. Checks run on macOS arm64, Node 24.19.0, disposable Linux/arm64 PostgreSQL,
real loopback HTTPS, native Node worker/client/API processes and Chromium where
listed. No existing development data, hosted deployment or provider account is used.

## Full-diff review follow-up

The follow-up review compared the complete uncommitted migration, worker,
publication integration, retrieval/HTTP/schema, browser/client, supervision, CI,
tests and documentation changes with the original request. It preserves the
original scope and historical-eligibility decision. Five issues were reproduced
and repaired:

| Issue | Repair and regression boundary |
|---|---|
| Standalone `next` could skip unseen deliveries when its page size changed, and could skip the first page with a new journal. | Persist the displayed size and validated successor tokens, then use the saved boundary for the next authorized request. This also avoids reconstructing previous byte-budget membership. First use exposes the first page. Legacy journals without the boundary retain their cursor and require an explicit `read`. The native HTTPS regression failed on the skipped delivery ID before the fix. Earlier restart coverage always used limit 1. |
| A hidden current revision made health ignore pending readable historical revisions and report complete. | Compare the ordered head with the latest eligible retained ordinal under the existing guards. The real PostgreSQL/HTTPS regression observed complete instead of incomplete before the fix, then checks the original signal after processing. Earlier policy tests projected all revisions before suppression. |
| Visibility/authorization failure left old source rows visible in the browser. | Withdraw cached rows on explicit policy, epoch or authentication failure; retain the recovery position and focus the recovery notice when the old paging control disappears. Transport/save failures still retain context and focus. Chromium failed on stale rows after visibility invalidation; StrictMode tests reproduced retained context after 401 and lost recovery focus. |
| Sign-out fenced views only after asynchronous cleanup, allowing a late response to repopulate a reason already cleared. | Announce/invalidate identity immediately after confirmed server logout, create cleanup stores under that generation, and stop cleanup if a later identity takes ownership. The browser regression holds the second reason's Web Lock and releases a delayed response during cleanup. Earlier coverage released the response only after sign-out completed. |
| A syntactically valid local record could contain contradictory cursor/checkpoint modes. | Validate the closed displayed-page request shape, preserve an invalid record and offer explicit resynchronization. The StrictMode regression failed before the fix; previous corruption coverage used invalid JSON only. Invalid opaque tokens also offer explicit retained restart, without treating epoch mismatch as continuity. |

Approved red browser evidence was retained before subsequent invocations:
[sign-out](evidence/notifications/review-signout-red/run.json) and
[visibility](evidence/notifications/review-visibility-red/run.json). Each targeted
run used the normal worker/retry/deadline settings. A new unit assertion initially
stalled while formatting an HTMLElement equality failure (about 2 GiB resident
memory and sustained CPU after more than a minute); that attempt was interrupted.
Changing the assertion to compare Boolean presence produced the expected failure
in about one second, without changing the behavioral expectation or timeout.

The initial post-fix `npm run check` passed 54 application tests and its normal
build/bootstrap/hooks checks. The following completed checks include the additional
authentication-cache and focus regressions:

| Command | Observed follow-up result |
|---|---|
| `npm run check` after authentication and focus repairs | Passed: 64 bootstrap, 5 Lore hook and 55 application contract/unit/web tests, documentation/baseline checks, typechecks and build. |
| `npm run test:notifications:postgres` after the final standalone continuation repair | 16 passed, 0 failed. Real PostgreSQL/HTTPS and native-process coverage includes changing page sizes, persisted exact successor boundaries, fresh/legacy journal recovery, and historical projection health. |
| `npm run test:migrations:postgres` | 9 passed. |
| `npm run test:publication:postgres` | 16 passed. |
| `npm run test:identity:postgres` | 22 passed. |
| `npm run test:participation:postgres` | 12 passed. |
| `npm run test:saved-items:postgres` | 10 passed. |
| `npm run test:organization:postgres` | 15 passed. |
| `npm run test:search:postgres` | 46 passed. |
| `npm run test:references:postgres` | 26 passed. |
| `npm run test:summaries:postgres` | 14 passed. |
| `npm run test:changes:postgres` | 12 passed. |
| `npm run test:app:postgres` | 9 passed. |
| Complete normal `LOOM_NOTIFICATION_REVIEW_SCREENS=1 npm run test:e2e` | 73 passed before the focus refinement and 73 passed again afterward. Workers=1, retries=0 and normal deadlines remained unchanged. The final run exercises cached-row withdrawal, recovery focus, retained replay after completed checkpoints, and sign-out while cleanup is blocked. |
| `npm run test:browser-diagnostics` | Verifier passed: 8 controlled failures, complete upload-candidate canaries/bounds, lifecycle and 4 fail-closed validation cases. Its child run's failed status is intentional; the verifier exited 0. |

Exact command/count summaries are in
[review-commands.json](evidence/notifications/review-commands.json). Approved
evidence was preserved for the [first complete review run](evidence/notifications/review-browser-first/run.json),
the [final complete run](evidence/notifications/review-browser-final/run.json), its
[validation](evidence/notifications/review-browser-final/approval.json), and the
[diagnostic probes](evidence/notifications/review-diagnostics/approval.json).
The final desktop and mobile captures linked below were recaptured and visually
inspected during this follow-up. No test guard, assertion, retry or deadline was
weakened. The interrupted assertion-formatting attempt above is not counted as a
completed behavioral test.

## Initial implementation checks

| Command | Observed result |
|---|---|
| `npm run app:typecheck` / `npm run app:build` | Passed after resolving initial TypeScript union/reference and fixture-shape errors. |
| First `node --import tsx --test tests/integration/notifications.test.ts` | 2 passed, 1 failed: final test expectation retained stale current-revision metadata after later edits. Corrected the expectation to require the latest current revision while preserving the original trigger and delivery. |
| First expanded `npm run test:notifications:postgres` | 9 passed, 0 failed, approximately 37 seconds. Covers actual native lease expiry, death around COMMIT, delayed availability, bounded recovery, populated upgrade and client/API restart. |
| `node --import tsx --test tests/web/notifications.test.tsx` | 3 passed: development StrictMode, failed durable save/position/focus, explicit corrupt-record recovery and late filter/route/account rejection. |
| `npm run check` | Passed: documentation/baseline checks, bootstrap units, Lore hook tests, application typechecks, 53 contract/unit/web tests and compiled build. |
| `npm run test:notifications:postgres` after authorization/capacity additions | 13 passed, 0 failed, approximately 37 seconds. |
| `npm run test:migrations:postgres` | 9 passed. |
| `npm run test:publication:postgres` | 16 passed. |
| `npm run test:participation:postgres` | 12 passed. |
| `npm run test:search:postgres` | 46 passed. |
| `npm run test:references:postgres` | 26 passed. |
| `npm run test:summaries:postgres` | 14 passed. |
| `npm run test:changes:postgres` | 12 passed. |
| First complete normal `LOOM_NOTIFICATION_REVIEW_SCREENS=1 npm run test:e2e` | 69 passed, 2 failed of 71; workers=1, retries=0, normal deadlines. Approved diagnostics retained in [browser-first](evidence/notifications/browser-first/run.json). |
| `npm run check` after browser repairs | Passed, including 53 application contract/unit/web tests and build. |
| `node --import tsx --test tests/integration/notifications-recovery.test.ts tests/integration/search-limits.test.ts` after repairs | 10 passed. Includes read-only temporary-error recovery and actual preview search/notification stop/start with HTTPS available. |
| Complete normal `LOOM_NOTIFICATION_REVIEW_SCREENS=1 npm run test:e2e` after repairs | 71 passed, 0 failed; workers=1, retries=0, normal deadlines. [Final manifest](evidence/notifications/browser-final/run.json) and [validated approval](evidence/notifications/browser-final/approval.json) retained before diagnostic verification. |
| `npm run test:browser-diagnostics` | Passed: 8 intentionally failing probes, complete upload-candidate canaries/bounds, lifecycle and 4 fail-closed validation cases. [Approved probe evidence](evidence/notifications/diagnostics/approval.json). The child failure status is expected; the verifier exited 0. |
| Final `npm run test:notifications:postgres` | 14 passed, 0 failed, approximately 37 seconds. Adds ordinary opening/comment account edits, inert reference/coverage authors, current mention removal and publication-time ineligible reply recipients. |
| `npm run test:app:postgres` | 9 passed. |
| `npm run test:identity:postgres` | 22 passed. |
| `npm run test:saved-items:postgres` | 10 passed. |
| `npm run test:organization:postgres` | 15 passed. |
| Final `npm run check` | Passed on the final source/test/documentation diff: 64 bootstrap tests, 5 Lore hook tests, 53 application contract/unit/web tests, documentation/baseline checks, typechecks and build. |

Safe command/count summaries are retained in [commands.json](evidence/notifications/commands.json).
Raw browser output, request content and private failure contexts are not retained
in these artifacts.

## Observed failures and repairs

The initial PostgreSQL assertion failure concerned current metadata, not changed
trigger history. Its final assertion now compares the original signal plus the
verified latest current revision. Initial TypeScript failures were fixed before
runtime testing; no checks were bypassed.

The first complete browser run found two patch regressions. Chromium blurred a
paging button when native `disabled` was set during retrieval; JSDOM did not model
that behavior, so the StrictMode test missed it. The native failure reproduced the
required keyboard-focus boundary. Notification controls now retain focus with
`aria-disabled` and an explicit busy guard. The original focus assertion remains.
The sign-out change also replaced a specific draft-cleanup error with a generic
message. The existing test caught it; the original message is restored, with
independent notification cleanup and an additional accurate failure sentence.
No test assertion, worker, retry, deadline or guard was relaxed. Approved failure
records were copied before rerunning; private raw contexts were inspected only and
were not promoted into evidence. Previously retained diagnostic probe evidence
remains under `change-notes-evidence/diagnostics-final/`.

Visual review of the first desktop/mobile captures found a misleading “Visibility
changed” prefix on deliberate manual replay. The result notice now describes
retained replay without claiming a change occurred. Row spacing was tightened;
the final [desktop](evidence/notifications/attention-desktop.png) and
[390-pixel mobile](evidence/notifications/attention-mobile.png) captures from the
passing rebuilt suite were visually inspected. The selected navigation entry,
coalesced reason labels, original-source/note/current-context links and collapsed
publication details are visible. Mobile labels and links wrap within the viewport;
the suite also asserts no horizontal overflow and exercises keyboard navigation
and failed-page focus. Recovery detail remains secondary, with a qualified interval
continuation. These observations do not establish comfortable human use.

## Behavioral evidence and interpretation

The SQL tests inspect claims, signals, deliveries, recipient clocks, ordered heads,
gaps and terminal jobs. Injected failure after claim/signal/delivery/head/job writes
leaves the entire pre-finalization snapshot unchanged. Native barriers pause before
COMMIT and after COMMIT; process death yields rollback or durable deduplicated
completion. An old native worker waits through the **stored PostgreSQL lease
deadline**, a replacement completes, then the old worker is resumed and cannot write.
These are deterministic process/transaction barriers, not guessed race sleeps.

An R2-only discovered job waits for retained R1; an empty predecessor advances in
order. A deliberately failed old source is repaired after other deliveries complete
an interval and while another fixed traversal remains open. It gets a later personal
position, retains original event/revision/time, appears after the completed checkpoint
and remains outside the earlier fixed upper bound. This supports the **personal**
portion of AC60, without claiming the shared Updates contract exists.

Populated pre-0012 databases retain old v1/v2/v3 source bytes, mention/note rows,
digests/outcomes, search jobs/documents/state and uncertain retry meaning. Historical
summary notes coalesce with main mentions. Old unmentioned replies retain explicit
eligibility gaps. Malformed sources, missing predecessors and unsupported intents
stay inspectable; multiple intents at a source position do not disappear.

Pages enforce personal ownership, current exact source/owner policy, fixed bounds,
100-candidate empty scans, Unicode complete-JSON budgets and explicit work failure.
Descriptor expiry renews the same interval; a simulated retained-history floor
produces a distinct gap and incomplete resynchronization. Visibility replay reaches
restored deliveries before completed lower bounds, preserving identities. Recovery
epoch mismatch fails explicitly. Native standalone clients restart independently,
and compiled HTTPS API restart preserves displayed-page recovery under durable key
custody. Retrieval does not create shared activity or Saved rows.

The complete browser run retains the existing v1→v2 and v2→v3 correction cases;
their reference additions, rationale changes, withdrawals and immutable uncertain
attempt assertions passed with the new navigation and sign-out behavior. Existing
application, identity, publication, organization, Saved, search, references,
summaries and changes suites passed. CI adds the notification suite while keeping
the existing migration, SQL/S3 and persistence stages and unchanged browser guards.

## Decision and memory review

Material evidence-based choice: historical mention rows prove old active-recipient
validation; old unmentioned replies lack sufficient audit facts. Unknown eligibility
remains a disclosed gap, rather than invented current-state history. New replies
capture eligibility atomically without changing authored formats/digests. Self-alert
omission is an explicit initial MEN-02 choice; null-signal claims prevent later
editors creating spurious alerts from those continuing main mentions.

Root, participation, search and tests memory were reconciled against the new worker,
retrieval contract, publication fact insertion and observed assertions. Obsolete
“search only/notifications unsupported” statements were replaced with scoped
personal support. Ordinary browsing/search cursor behavior and full shared Updates
deferrals remain. New notification memory holds local locking/custody/bounds.
The review follow-up reconciled notification and test memory with the final
retrieval health query, standalone saved-successor protocol, closed local recovery
schema, policy-error presentation and immediate sign-out generation fence. README
now describes the two independent supervised consumers and their stop/start
commands; it no longer calls search the only active projection.

## Limits on claims

This is a local synthetic increment. No physical-authenticator or comfortable human
usability study, actual provider-agent trial, cross-machine trial, production capacity
measurement, retained-data upgrade, pruning/erasure, key rotation, destructive restore
or hosted CI run is established. Full Updates/Following/mutes, grouping/highlights,
read/unread, dismissal, files/private notes, moderation administration and live
delivery remain unfinished requirements. Existing historical eligibility gaps are
explicit and do not imply exhaustive reconstructed past replies.
The local SQL/S3 integration and service-interrupting persistence commands were not
run against existing development services; their CI stages are preserved. All live
database changes in this task occurred in disposable synthetic test resources.
