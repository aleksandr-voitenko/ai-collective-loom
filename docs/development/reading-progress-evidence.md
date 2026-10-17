# Private reading progress — local evidence

Implementation and verification use local synthetic fixtures from the current
merged baseline `1ae82e2`. No existing development data or credentials were changed.
The task brief covers exact owner-private supported text revisions, explicit Read/
Unread, bounded atomic selection, opt-in presentation and durable recovery while
preserving publication, personal collections and all fetching checkpoints.
[ADR-026](../adr/026-private-reading-progress.md) records choices before implementation;
the [guide](reading-progress.md) describes the usable contract.

## Acceptance evidence

`tests/integration/reading.test.ts` compares independent exact sets and every
unrelated persisted table before/after progress. It exercises Saved X / read Y1 /
new Y2 across API restart, summary independence, both absent-state orderings,
simultaneous duplicate/opposite commands, ABA, fixed batches across publication,
invalid/stale/Unicode/byte limits, rollback and quotas. Populated migration0015→0016
preserves every pre-existing table and semantic standalone/Updates replay while
creating no historical read records. Suppressed current revisions and parent
comments do not hide eligible historical/reply text; owner-known unavailable
states have no retained metadata, and another participant/admin cannot retrieve them.

`reading-recovery.test.ts` uses actual HTTPS and PostgreSQL guards in both
source/revision/credential orderings, separately from authentication probes. Native
processes preserve exact fsynced requests across response loss, replacement/revoked
credentials, API restart and process death after COMMIT. These are independent
same-machine processes, not physical-device, remote-machine or provider-agent trials.

Development React StrictMode uses JSDOM and controlled fetch/viewport stubs; those
tests are distinct from compiled Chromium. Browser journeys inspect rendered
revision IDs, actual reading requests and durable SQL state, not badge labels alone.
The native visibility fixture connects to Chromium with `noDefaults:true` so the
harness cannot force every page visible/focused. It verifies the real hidden/frozen
lifecycle and foreground restoration; JSDOM separately covers the running hidden
and unfocused gates. Ordinary OS tab/minimize behavior still needs human/platform
validation. The first complete normal browser run passed 98/99, including all eight
reading journeys. The final normal rerun passed **99/99** after the sign-out fix and
bounded episode-state refinement below, with one worker, zero retries and the
unchanged deadlines.

The flow under test is: open an exact revision → mark Read/Unread or opt in and
present its full text → inspect exact private state → reopen/recover without changing
Saved items or another revision. The Browser plugin was not available, so validation
uses the repository Playwright runner and its required closed diagnostics.
Browser URLs are isolated `https://localhost:<fixture-port>/loom` routes. Desktop
is 1440×1000 and mobile is 390×844. Screenshots are deliberate synthetic review
artifacts outside diagnostic uploads, at `/private/tmp/loom-reading-desktop.png`
and `/private/tmp/loom-reading-mobile.png`.

| Rendered check | Evidence |
|---|---|
| Page identity / meaningful content | Exact route and rendered revision IDs; nonempty page title; full selected text remains visible |
| Framework overlay | No overlay in the inspected desktop/mobile screenshots |
| Runtime health | No uncaught `pageerror` in the manual reading journey; deliberate HTTP/storage failures have separate assertions |
| Controls / focus | Keyboard Read, Unread, status failure, fixed selection, cross-tab races and sign-out assertions |
| Layout | Desktop and narrow viewport images inspected; narrow document has no horizontal overflow |
| Observation | Tall text requires all bands; known Read produces no duplicate command; hidden lifecycle and abandoned response remain unmarked |

## Executed commands and results

All commands use Node 24.19.0 on macOS arm64; PostgreSQL 18 runs in fresh disposable
Linux/arm64 containers. The shell prefix was
`PATH=/Users/tarm/.nvm/versions/node/v24.19.0/bin:$PATH`.
Docker-dependent checks required sandbox escalation; fixtures own only new resources.

| Command | Observed result |
|---|---|
| `npm run check` | Final pass: document baselines, 64 bootstrap, 5 hook, 84 application tests, typecheck and production build |
| `npm run test:reading:postgres` | 15/15 pass |
| `npm run test:app:postgres` | 9/9 pass |
| `npm run test:publication:postgres` | 16/16 pass |
| `npm run test:identity:postgres` | 22/22 pass |
| `npm run test:participation:postgres` | 12/12 pass |
| `npm run test:saved-items:postgres` | 10/10 pass |
| `npm run test:organization:postgres` | 15/15 pass |
| `npm run test:search:postgres` | 46/46 pass |
| `npm run test:references:postgres` | 26/26 pass |
| `npm run test:summaries:postgres` | 14/14 pass |
| `npm run test:changes:postgres` | 12/12 pass |
| `npm run test:notifications:postgres` | 16/16 pass |
| `npm run test:following:postgres` | 18/18 pass |
| `npm run test:updates:postgres` | 23/23 pass |
| `npm run test:migrations:postgres` | 9/9 pass |
| `npm run test:browser-diagnostics` | Final pass: 8 controlled child failures, canary/bounds/lifecycle checks and 4 fail-closed cases |
| `npm run test:e2e -- tests/e2e/reading.spec.ts -g background` | Final native lifecycle/late-response case passed |
| `LOOM_READING_REVIEW_SCREENS=1 npm run test:e2e` | Final normal pass: 99/99, including all 8 reading journeys and the unchanged sign-out regression |
| `node --import tsx --test tests/web/reading.test.tsx tests/unit/reading-presentation.test.ts` | Final focused pass: 8/8, including bounded episode fences |

The 15 PostgreSQL/migration suites above contain 263 passing tests. Reading was
rerun after the read-only error-response refinement and passed 15/15 again (23.31s).
Typechecking and `node --check scripts/reading-client.mjs` also passed.

The temporary orchestration script invoked these npm commands sequentially and
retained private full logs under `/private/tmp/loom-reading-regression-*` and a
count-only `/private/tmp/loom-reading-regressions.json`. No raw logs are approved
browser artifacts. Migration/storage/persistence CI checks remain mandatory.
Local storage and persistence checks were not run against existing development
services because the task authorizes isolated fixtures only.

## Cost, failures and limits

Before selecting caps, a schema-shaped temporary fixture measured 10,000 states at
1,564,672 bytes and 50,000 single-member outcomes at 21,897,216 bytes, including
indexes; insertion together took 238ms. A separate 4,000×25-member outcome shape
occupied 12,165,120 bytes. These omit actual API/guard cost and do not forecast load.
The real schema/API case uses 25 states and one batch, then 40 lookups and 40 exact
replays. Owner counters remain 25 states / 1 operation / 25 members. That run took 4448ms;
relation sizes including indexes were states 24,576 bytes, operations 65,536 bytes,
owners 24,576 bytes. It ran alongside isolated browser work, so it is an observed
cost, not a throughput benchmark or latency target.

Final review found that page traversal could retain old badge entries indefinitely.
Only mounted text now retains badge data. Two bounded collections retain the first
private version and episode exclusions; reaching 4,096 entries pauses automatic
observation until reopening, without dropping Unread fences or manual controls.
The synthetic identifier/version collections serialized to 335,897 bytes before this
bound was adopted; that is a representation size, not a JavaScript heap measurement.

Early PostgreSQL runs exposed fixture mistakes: reply edits supplied an artifact
title, a move was attempted after suppressing its current source, encrypted tokens
were compared byte-for-byte, and a credential barrier intercepted authentication
instead of the final reading transaction. Corrections preserve intended behavior;
the subsequent 14-case run and the expanded 15-case regression run passed.

The initial browser run passed 3/6 and exposed asynchronous controlled-checkbox
state restoration at opt-in. The setting now updates its controlled state during
the input event and persists under the recovery lock. The next two runs passed 7/8;
their remaining fixture incorrectly assumed headless tab switching disabled
Playwright's focus emulation. A separate CDP session could not override the harness
session. The focused frozen-lifecycle attempt had the same limitation. Native
Chromium without default focus overrides then exposed fixture viewport and HTTPS
interception setup mistakes. After correction, native hidden/foreground and late
navigation assertions passed. One fixture failure interrupted collection, explicitly
retained as `collector_unfinished`; it was not treated as complete diagnostics.
All failed-run approved bundles were copied before the next invocation replaced
them; no timeouts, retries, worker counts or diagnostic schema bounds were relaxed.
The first normal 99-case run exposed changed sign-out warning ordering when Web
Locks were unavailable. Drafts remained intact and sign-out succeeded, but the
existing warning no longer began with its established draft-clear message. Reading
cleanup now follows existing cleanup, preserving that message and adding its own
failure detail. The unchanged regression supplies the failing/passing check.
Approved earlier runs are retained in [the reading evidence directory](evidence/reading/).
The [final browser run](evidence/reading/browser-full-final/run.json) and
[PostgreSQL command totals](evidence/reading/postgres-results.json) retain safe
machine-readable summaries. Detailed private test logs are not copied into the repository.
The native fixture setup failures are not attributed to `ERR_NETWORK_CHANGED`;
the retained evidence does not establish that error as their cause.

## Conflict-feedback repair

Self-review reproduced an independent-operation race: A's version conflict used the
same error string as B's successful completion. B could erase A's only notice, while
the opposite completion order displayed A's notice beside B too. Single-target tests
missed both cases. The two new StrictMode regression cases first failed on these
specific assertions, then passed after retaining confirmed conflicts in the existing
bounded journal. Exact target/body/key custody now drives revision-specific feedback
through unrelated completion, refresh and reopening, until explicit dismissal.

Known conflicts cannot dispatch as uncertain work. Additional storage assertions
cover failed conflict saves and dismissal, late first refusals and duplicate responses
after dismissal. These preserve exact records or their deliberate removal, with no
new feedback cache, increased quota, server-state change or automatic rebasing.
The focused web/presentation command passed 11/11; `npm run check` then passed all
87 application tests, typechecking, build and existing baseline/bootstrap/hook checks.
The first regression run was interrupted when a failed assertion tried to serialize
a DOM element; Boolean presence assertions fixed that diagnostic problem. The first
broader check caught unsupported `exact` options in Testing Library role queries;
removing those options preceded the final passing check. Neither was a product fix.

The new Chromium journey checks a real refused Read, an unrelated successful Read,
reload, exact-source notice placement, narrow-screen recovery and keyboard dismissal,
then verifies both server states remain unchanged by dismissal.
`LOOM_READING_REVIEW_SCREENS=1 npm run test:e2e` passed **100/100**, with one worker,
zero retries and normal deadlines; its [approved run](evidence/reading/browser-conflict-full/run.json)
has no omitted cases. After a final correction to the conflict-save failure message
(the original request had already been sent), `npm run check` passed again with
87 application tests and the rebuilt browser. The final focused browser run passed
**9/9** under the same one-worker, zero-retry deadlines; its
[approved run](evidence/reading/browser-conflict-focused-final/run.json) has no
omitted cases. The preceding focused run passed 8/9, including the conflict case.
Its native lifecycle test reached the final source-state assertion successfully
before failing during cleanup. The [retained failed run](evidence/reading/browser-conflict-focused-first/run.json)
and diagnostic bundle show completed context/server disposal, but do not establish
the exact failure cause. No test or cleanup behavior was changed before the passing
rerun; that intermittency remains unconfirmed rather than claimed fixed.

Rendered review checked the [desktop conflict placement](evidence/reading/conflict-desktop.png)
and [narrow-screen recovery controls](evidence/reading/conflict-mobile.png).
The latter's keyboard dismissal was exercised by the browser test. These curated
synthetic images are separate from diagnostic uploads. PostgreSQL suite results
above belong to the original implementation; this repair changes browser
custody/feedback and the guide, with no database or server mutation changes.

## Review map

- Persistence and semantics: `db/migrations/0016_private_reading.sql`,
  `src/contracts/reading.ts`, `src/server/modules/participation/reading.ts`,
  `src/server/http/reading.ts`; additive guide11/community discovery.
- Browser: `Reading.tsx`, `reading-presentation.ts`, `reading-recovery.ts` and the
  two full-text integration points in `ParticipationApp.tsx`, plus compact styles.
- Direct HTTPS: `scripts/reading-client.mjs`; existing Saved client accepts guide11.
- Verification: reading integration/web/unit/browser cases, unchanged regression
  suites, new CI PostgreSQL step and fixed diagnostic vocabulary/canary assertions.
- Current documentation/memory: reading guide/ADR/evidence, feature index, backlog,
  retained-data gate and affected feature/memory statements. Imported snapshots
  and historical evidence are unchanged.

This is support for reading portions of ATT-09/10/16 and §12.3, with related
privacy/API/human-interaction preservation, not closure of compound
AC07–09/24–26/42–43/54/60. The presentation policy approximates full text exposure,
not attention or comprehension. Files, mutes/dismissal, private notes, moderation,
representative human/provider-agent acceptance, cross-machine topology, production
capacity, erasure and coordinated destructive-restore recovery remain open.
Memory review corrects stale read-state/guide claims and records the exact module,
browser custody and test boundaries; imported specifications/designs stay unchanged.
