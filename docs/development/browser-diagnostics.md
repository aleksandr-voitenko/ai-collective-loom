# Browser failure diagnostics

Build first, install Chromium, then use the supported entry points:

```bash
npm run app:build
npx playwright install chromium
npm run test:e2e
npm run test:browser-diagnostics
```

`test:e2e` retains the application suite's one worker, zero retries, 90-second test
deadline, 15-second action deadline, 20-second navigation deadline and assertions.
It runs through a containing process and a structured reporter. The process preserves
Playwright's nonzero exit status. Console output includes only test file/line, result
and repetition index. Look up failures at that location in the matching checkout.
Arbitrary test names, assertion arguments and error messages are omitted.

Read `browser-diagnostics/approved/run.json` for every bounded test result/duration.
Failed or incompletely captured tests also have a diagnostic JSON bundle. For a
bounded investigation, explicitly retain successful bundles too:

```bash
LOOM_DIAGNOSTICS_KEEP=all npm run test:e2e -- tests/e2e/saved-items.spec.ts \
  --grep 'simultaneous tabs reconcile|a competing Saved retry' --repeat-each 10
```

Each invocation replaces only the ignored `browser-diagnostics/` test-output
directory. Copy approved evidence before another run. Do not run browser commands
concurrently in one checkout. Direct `npx playwright test`, a reporter override or
an unrelated configuration bypasses containment and is not the supported diagnostic
command. No development database, `.env.local` or user browser profile is cleared.

## Closed diagnostic contract

Version 1 is validated by
[`scripts/lib/browser-diagnostics.mjs`](../../scripts/lib/browser-diagnostics.mjs).
Unknown keys are rejected at every depth; this is an allowlist, not a secret scrubber.

- `run.json`: Git SHA and dirty flag, Node/Playwright versions, platform/architecture,
  numeric GitHub run/attempt, fixed job category, planned/ended counts, status,
  test results and omitted count. Test identity is a SHA-256 identifier, allowlisted
  source filename, line/column, repetition and retry. No arbitrary title or path.
- Test bundle: the same metadata, original result/error count, failed/recent step
  categories and source locations, attachment-omission count, and browser capture.
  No locator arguments, assertion values, error text, stack or attachment names.
- Capture: Chromium version, context/page ordinals, navigation sequence, relative
  milliseconds, allowlisted route templates, method and HTTP status, request
  completion/failure category, and console-error/browser-exception occurrences.
  Unknown routes/errors become fixed categories. URL origins, IDs, query values,
  fragments and embedded credentials are never copied. Context-owned fixture
  `request.get/post` calls have page ordinal 0. Node HTTP clients and `route.fetch`
  internals are outside this observer; their assertions still run normally.
- Pre-close view: readiness/online state, shell/account/sign-in presence, capped
  alert/status counts and fixed Save/Unsave/sign-in/retry control counts. No input
  values, text, DOM serialization or images. `pending` contains bounded requests
  outstanding at a pre-close snapshot; later events explain their disposal. It
  does not claim those requests are still alive after teardown.
- Fixture events: server start/readiness/close, context close and collector finish.
  The live connection count helps identify incomplete server teardown. A completed
  close callback establishes zero connections even if socket-close listeners are
  still queued. `complete` means observed collection/disposal finished within the
  contract, not that the test passed or all browser activity was retained.
- `approval.json`: validation succeeded or input was withheld with a fixed safe
  reason. Any invalid candidate withholds the entire candidate. Only a freshly
  generated, validated refusal record is eligible for upload in that case.

For missing controls, compare the failed expectation location with the page's route,
navigation sequence, control counts, account/sign-in presence and identity/data API
statuses. For navigation failures, inspect the document request's terminal event and
whether DOM-ready/load occurred. A 401 before sign-in can be expected; a status alone
is not a diagnosis. Exceptions retain their occurrence/page, not arbitrary text.
These files deliberately do not identify the participant. Account/view ownership
continues to be asserted by the application scenarios themselves.

## Bounds and lifecycle

| Boundary | Limit and omission behavior |
|---|---|
| Events per test | Last 256; `events_dropped` is explicit. |
| Contexts/pages per test | 8 contexts, 16 pages including closed persistent contexts; overflow marks capture incomplete. |
| Pending requests | 64 active and 64 retained pre-close descriptors; overflow marks capture incomplete. |
| View inspection | First 128 buttons, 9 fixed control categories; counts cap at 32, button truncation is explicit. |
| Snapshot time | 200 ms Chromium execution deadline and 400 ms host deadline per page; context pages sampled concurrently. Failure/timeout is explicit. |
| Reporter steps | 16, retaining failed steps preferentially; omitted count is explicit. |
| JSON document | 128 KiB serialized UTF-8, checked before parsing and writing. Oversize capture becomes a safe incomplete fallback. |
| Whole candidate | First 128 planned tests, up to 128 bundles plus the run manifest; below 17 MiB including the approval record. Omitted tests remain counted. |
| Hosted retention | 3 days for prompt triage without long-lived browser-derived artifacts. |

Collection never reads request/response bodies, headers, cookies or browser storage.
It does not intercept application requests or hold routes, Web Locks or sockets.
It snapshots before explicit page/context closure, including persistent Chromium,
using a short-lived CDP session with no retained remote object handles. Capture
errors do not throw through the original test. Listeners are removed on disposal.
The shared fixture preserves browser-before-server teardown (`LC-20261014-WZF5`),
without force-closing server connections or weakening application shutdown guards.

## Private intermediates and CI upload

Playwright 1.64 can generate raw error-context files even with tracing disabled.
The wrapper contains these in a private directory, consumes arbitrary console
output without retaining it, and deletes raw reporter files/attachments when the
child exits. Existing explicit synthetic screenshot calls still run; their images
are not retained by this command. Trace/video/automatic screenshots stay off.
This replaces the raw JSON reporter; historical curated visual evidence is unchanged.
A hard kill can leave private intermediates: treat them as potentially sensitive,
never upload them, and remove them before sharing the workspace.

`candidate/` and `capture/` are outside the upload path. The gate rejects extra keys,
unexpected filenames, oversized files, directories and symlinks, then reconstructs
approved JSON. Raw reports, attachment names/bodies, storage-state files, environment
files, TLS keys and browser profiles cannot enter that schema. Canary checks
supplement allowlisting; they do not establish arbitrary-secret detection. This
boundary assumes reviewed collector/test code, not a hostile process modifying
files between validation and upload.

CI prepares a `not_started` manifest before dependency/service startup, then runs
diagnostic verification and the normal browser suite. An `always()` gate validates
the candidate even after a failed browser or earlier step. Upload requires that
gate's explicit output; no `continue-on-error`, permission expansion, checkout
credentials or retry increase is used. Names contain run ID, attempt and job.
Only `browser-diagnostics/approved/*.json` is uploaded, with three-day retention.

For an authorized hosted failure-path check, dispatch the same workflow with
`verify_failure_upload=true`. After the normal browser suite, this opt-in step runs
the isolated probe configuration directly through the containing runner. Its eight
controlled failures must leave the step and run failed; the subsequent validator
and upload must still succeed. Download that run's artifact and validate every
file, failure status, run/attempt identity and retention. The input defaults to
false and does not affect push or pull-request checks. Later integration steps are
skipped by the intentional failure, so use normal CI runs for full-suite evidence.

The action uses the verified immutable
[`actions/upload-artifact` v5.0.0 commit](https://github.com/actions/upload-artifact/tree/330a01c490aca151604b8cf639adc76d48f6c5d4)
and its [declared inputs/runtime](https://github.com/actions/upload-artifact/blob/330a01c490aca151604b8cf639adc76d48f6c5d4/action.yml).
This is test plumbing, not a product ADR. Revisit the contract on dependency upgrades,
new context-construction patterns or a need for richer evidence; equivalent
disclosure and teardown probes are required before adding capture fields or media.

`not_started`, a run left `running`, missing/unfinished collector or a capture issue
means collection is incomplete. Probe runs are identified by `diagnostics.probe.ts`;
application runs name the participation/Saved specs. No artifact delivery is
promised after hard runner loss, forced kill, unavailable validation tools or
artifact-service failure. Local checks do not establish a hosted upload; that
requires an authorized workflow run.

## Verification of the diagnostic path

`test:browser-diagnostics` runs a separate, intentionally failing Chromium child
against synthetic loopback HTTP fixtures. Its configuration does not change the
application suite's settings. The outer harness requires exit 1 and checks every
approved file, including reporter/run metadata and attachment omissions. It fails
if an expected failure passes, capture is wrong, canaries leak, bounds are exceeded
or raw Playwright output survives normal exit.

Eight failing children cover a missing control in a second tab, failed navigation, 401/pending API
requests, an exception with a one-time-secret input visible, capture failure, event
truncation, persistent-context disposal, unexpected browser closure and teardown failure. Validator probes
reject injected metadata, arbitrary attachments, oversized files and symlinks.
These secret displays/faults do not change Loom authentication or application code.
See [actual evidence and unresolved causes](browser-diagnostics-evidence.md).
