# Browser diagnostics and intermittency investigation — 14 October 2026

Task brief: preserve bounded, useful failure evidence locally and in the CI upload
path; test disclosure/failure handling; investigate the two PR #2 failures without
changing application behavior, assertions, retries or normal deadlines. Stop with
a reviewable diff. Staging, committing, pushing, merging, deploying and resetting
development data were not authorized during implementation. The subsequent
finalization request authorizes committing, pushing, opening a PR and observing CI,
including verification of the uploaded diagnostics; merging, deploying and data
reset remain outside that authorization.

## Baseline and inherited evidence

GitHub reports [PR #2](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/2)
merged at `d0413b20b8fcf0695316c2769c7e684d8bf2f558`. Fetched `origin/main` contains
reviewed head `ab1414d07a5f408c9168d6061ebe2c85a195a1d1` and has the same tree.
The original checkout was clean. Work starts on `codex/browser-failure-diagnostics`
from that merged main, without a merge, reset or cherry-pick.

Read the current PR review, root/scoped memory, browser specs, browser/HTTPS/auth/SQL
fixtures, Playwright/workflow configuration and previous participation/Saved evidence.
Relevant full Lore records: `LC-20261014-OIAD` (Saved implementation),
`LC-20261014-8GYV` (quota correction), `LC-20261014-WZF5` (browser-before-server
teardown). The earlier TLS teardown repair is a preservation requirement, not
evidence that either new failure has that cause.

The [historical failed push job](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38521730753/job/115712929807)
could not find the second tab's initial **Save discussion** control in the
simultaneous-tabs scenario, and failed initial `/loom` navigation with
`ERR_NETWORK_CHANGED` in the competing-quota-retry scenario. Both preceded their
race assertions. The review records 27 passing tests and these two failures;
subsequent unchanged-code runs passed, but no workflow artifacts were retained.
These are historical observations, not executions in this task or diagnoses.

The coverage gap was missing failure-evidence retention: the old JSON/list reporters
and error-context paths neither provided an approved disclosure boundary nor a CI
artifact. Existing assertions exposed failures, but did not preserve the state
needed to explain them. No shared cause or infrastructure-only cause is assumed.

## Delivered boundary

The [diagnostic contract](browser-diagnostics.md) is implemented in a shared collector,
reporter, containing runner and closed JSON validator. It covers additional tabs,
registered explicit contexts and persistent browser processes. Selected view state
is sampled before closure; requests, status, navigation, exceptions and fixture
lifecycle use fixed categories/counts. No raw bodies, headers, storage, DOM, input
values, error text or screenshots enter the approved bundle. Reporter metadata and
attachments pass through the same exclusion boundary.

The workflow prepares a not-started manifest, verifies diagnostics separately,
runs the existing application suite, validates on `always()`, then uploads only
the approved directory when the validator explicitly authorizes it. The immutable
upload action pin and inputs were read from the official repository. Artifact names
include run/attempt/job, with three-day retention and unchanged read-only repository
permissions. No existing CI stage or application assertion is removed. The original
browser command's failure is never turned into success.

Hosted upload was pending at the implementation commit's preparation. Finalization
adds an opt-in manual
`verify_failure_upload` workflow input so an authorized run can exercise the
existing controlled failures after the normal browser suite. That run must remain
failed while the upload succeeds; normal push/PR checks retain all stages.
Static workflow inspection and successful local candidate validation alone do not
establish artifact-service delivery. The hosted checks below now verify that path,
including after a failed browser step.

## Actual local topology and checks

All executions ran on one macOS arm64 host, Node **24.19.0**, Playwright **1.64.0**,
Chromium **156.0.8078.4**, local Docker **29.8.2** and the pinned PostgreSQL fixture.
Application scenarios use actual loopback HTTPS, self-signed test certificates,
native WebAuthn with virtual authenticators, fresh synthetic accounts/content and
temporary database containers. Diagnostic fault probes use their own small loopback
HTTP fixture and recognizable canaries, not a Loom authentication bypass. No existing
Compose volume, development database, `.env.local` or real account is modified.

| Executed command | Observed evidence |
|---|---|
| `npm run check` | Passed: 64 bootstrap, 5 hook and 31 application tests, TypeScript, build and imported-baseline checks. |
| `npm run test:e2e` | 29/29 passed with the normal one worker, zero retries, timeouts and assertions. Every capture completed; the default approved output contained only the run summary and approval record. [Results](browser-diagnostics-evidence/browser-suite.json). |
| `npm run test:browser-diagnostics` | Outer harness passed with eight intentionally failing children, each preserving one original error and exit status 1. It validated the entire 10-file upload candidate, canary absence, event/byte bounds, attachment omissions and normal-exit cleanup. Four additional invalid-candidate cases were withheld. [Child results](browser-diagnostics-evidence/diagnostic-probes.json). |
| Focused command below | 20/20 passed, all repetitions retained. No original failure recurred. [Every result/duration](browser-diagnostics-evidence/repetitions.json). |

The final complete browser run followed the unexpected-close capture guard and
again passed all 29 scenarios, with no incomplete bundles. Local CLI checks of
`scripts/approve-browser-diagnostics.mjs` exercised both outcomes using isolated
temporary candidates: valid input exited 0; invalid input exited 1 and authorized
only the newly generated safe refusal record through `GITHUB_OUTPUT`. This tests
the local gate protocol, not GitHub's artifact upload service.

Static verification preserved all 18 existing unnamed CI commands in order,
confirmed that Playwright settings changed only at the reporter, and checked
58 documentation links. Script syntax, retained evidence schemas and whitespace
checks passed. At the implementation review checkpoint, HEAD remained the merged
baseline and the Git index was empty.

Finalization repeated `npm run check` and `npm run test:browser-diagnostics`;
both passed. The exact manual-workflow command,
`npm run test:e2e -- --config tests/diagnostics/playwright.config.ts`, separately
exited 1 with all eight expected failures and a validated upload candidate. This
checked the new workflow entry point locally before the hosted verification below.

The representative [missing-control bundle](browser-diagnostics-evidence/missing-control.json)
is an unedited, validated **16,063-byte** output from a deliberately failing child.
It identifies the source file/line, failed expectation, second-tab discussion route,
absent Save control, initial 401, pending API request and completed teardown. Two
reporter attachments were omitted, including a named canary attachment. It retains
no canary from the page, URL, input, cookie, headers, response body, storage,
console/error text or test title. It is safe structured evidence, not a DOM dump.

Other controlled failures cover aborted navigation, a browser exception while a
synthetic one-time-secret input is visible, deliberately broken capture, event-count
truncation, persistent context closure, fixture teardown failure, and an unexpected
browser close before a snapshot. Incomplete cases are explicitly marked. The
validator refuses injected metadata, an extra attachment file, oversized input and
a symlink, leaving only its safe refusal record. A maximum-dimension capture fixture
fits beneath the byte envelope; oversized-file refusal is exercised separately.
Canary testing supplements the closed schema, not arbitrary-secret detection.

## Bounded investigation

Before execution, selected **10 repetitions of each scenario**, with no run-until-green
loop. Ran exactly:

```bash
LOOM_DIAGNOSTICS_KEEP=all npm run test:e2e -- tests/e2e/saved-items.spec.ts \
  --grep 'simultaneous tabs reconcile|a competing Saved retry' --repeat-each 10
```

Every repetition 0–9 passed for both tests. Original assertions and normal worker,
retry and timeout settings were retained. Twenty complete bundles were examined;
the largest was **66,259 bytes**, with no dropped events, browser exceptions,
request-failure events or residual connections in those runs.

For all twenty: identity self changed from the expected pre-sign-in 401 to 200;
sign-in finish was 200; discussion retrieval was 200; both tabs navigated and
rendered their asserted controls. The simultaneous-tabs scenario's Saved writes
returned 200; the quota scenario's writes returned the expected 429. Each recorded
context closure before server closure. Page/navigation ordinals, API events and
selected final controls provided consistent evidence; the unchanged assertions
specifically checked initial controls and late-response ownership.

These repetitions preceded the added observation of context-owned fixture
`request.get/post` calls; browser-originated requests and the original scenarios
were already captured. The final complete browser run and diagnostic harness cover
that additional observer. The repetition results are retained as observed, not
silently replaced with a later run.

**Both original causes remain unresolved.** There is no reproduced application
cause, narrow application repair or application red/green claim. Clean local
repetitions do not repair or explain failures on a hosted Linux runner. This task
delivers the diagnostic capability needed for the next occurrence.

## Hosted upload verified during finalization

Commit `3fb90258d382df2aac8a4e0f1c11556d9d0ea518` was pushed and
[PR #3](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/3) opened.
The following attempt-1 runs executed on Ubuntu 24.04/Linux x64 with Node 24.19.0,
Playwright 1.64.0 and synthetic fixtures. The PR checkout was merge revision
`3e216206c04db70b3fd6f8c88840578ae1f3cdaa`; the push/manual checkouts were the
implementation commit. Artifact metadata identifies these clean checkouts exactly.

| Run | Observed conclusion | Uploaded artifact ID | Downloaded contents |
|---|---|---|---|
| [Push 38534589567](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38534589567) | Both jobs passed, including all retained integration/persistence stages. | `11879762927` | 2 JSON files, 2,042-byte ZIP, 9,057 bytes expanded; 29/29 browser results passed. |
| [PR 38534647651](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38534647651) | Both jobs passed, including all retained integration/persistence stages. | `11878938374` | 2 JSON files, 2,040-byte ZIP, 9,057 bytes expanded; 29/29 browser results passed. |
| [Manual failure check 38534672211](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38534672211) | Failed only at the opt-in controlled browser step. Normal browser suite, validator, upload and cleanup passed. | `11879274350` | 10 JSON files, 14,632-byte ZIP, 156,249 bytes expanded; all 8 probe failures retained. |

The failed manual job `115754778157` preserves the browser step's failure rather
than using `continue-on-error`. Later migration/storage stages are skipped in that
intentional failure run; the two normal runs above supply their passing evidence.
Normal artifacts contain `run.json` and `approval.json`, with no incomplete captures.
The manual artifact adds eight hashed per-test bundles, each with exactly one
original error. Its largest document is **80,812 bytes**, below 128 KiB.

All three archives were downloaded from GitHub, checked for safe flat filenames,
duplicate entries, symlinks and byte limits before extraction, then every JSON file
was checked against the closed schema and expected commit/run/attempt/job metadata.
No raw attachments, URLs, credential/storage/body fields or tested secret canaries
were present. The failure artifact retains the missing second-tab Save control,
401 and pending request, failed navigation, browser exception, explicit capture
failure, truncation and persistent/explicit-context evidence. Capture omissions
remain explicit; a failed test is not reported as a passing one.

Downloaded ZIP SHA-256 digests exactly match GitHub's artifact metadata:

- Push: `7c17fa11b3b875324bfd656e21d5ce7ef3fef0927c5fcb7c2a9cf68d0bc053be`.
- PR: `7830aa01be59ea9329572b30fe7c8f41723eb9c53af60fca8de5e53633e693fc`.
- Manual failure: `cdac7aaf32f3077ca668e7a80b7be3cb903448d5046d2c460b42a6d867e15dc3`.

Each artifact has the exact name `browser-diagnostics-<run>-1-local-integration`
and a recorded expiry 259,199 seconds after creation (three days at the service's
timestamp precision). Expiry times are 17 October 2026 at 08:25:48, 08:26:53 and
08:27:28 UTC respectively. These checks verify actual uploaded bytes and configured
expiry, not future deletion or delivery after hard runner loss.

Reproduction: dispatch `ci.yml` at the implementation branch with
`verify_failure_upload=true`, confirm the failed controlled step and successful
validator/upload, list that run's artifacts through the Actions API, download the
reported artifact ID, and validate its complete candidate against the diagnostic
contract. This intentionally failed workflow is evidence of failure preservation,
not an unresolved application CI failure. Both original intermittent causes remain
unresolved; clean hosted runs do not establish a repair.

## Corrections and preservation checks

Typechecking initially caught a timer callback overload; a no-argument callback
resolved the Node/DOM typing conflict. The extended diagnostic harness then exposed
a false-incomplete counter: a socket-close listener could be queued after the
server-close callback. That new probe failed before the collector used the completed
close callback as its authoritative closure signal, then passed. This was a
diagnostic bookkeeping defect, not reproduction of either original intermittent bug.
A stress fixture also initially assumed its maximum dimensions exceeded the byte
budget; measurement showed they fit. Its assertion now verifies that bound, while
the independent oversized-file test exercises rejection. None of these corrections
changes application logic or weakens the application suite.

Root and scoped memory were checked against the final fixture ownership, collector,
runner, validation schema and actual assertions. `tests/MEMORY.md` owns the detailed
testing boundary; root and participation memory point to it. Guides and the backlog
separate verified local/hosted diagnostic delivery from unresolved intermittent causes.
Product/architecture imports, migrations, authentication,
Saved limits and existing retained data remain unchanged. File uploads/grants,
fenced worker output, real-identity/retention policy and cross-machine trials remain
behind their existing gates. No product ADR or new package dependency was needed.

Hard runner loss/forced kill can prevent delivery and leave private intermediates.
Those are explicitly not approved artifacts. Collection limits can omit events;
unknown routes/errors remain coarse categories. No cross-machine agent, physical
passkey or production-readiness claim follows from these local checks.
