# Browser CI reliability follow-up

Scope: investigate the two recurring failures after reading progress merged,
repair the affected test boundaries, retain regression coverage, and verify the
complete normal browser suite. Preserve exact summary/reply navigation, actual
Chromium hidden/frozen behavior, late-response exclusion, browser-before-server
disposal and the closed diagnostic contract. No application behavior, CI settings,
retry policy, test deadlines, dependencies or existing data change.

## Reported failures

The branch [run 39009485413](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/39009485413)
and merged-main [run 39014746388](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/39014746388)
each passed 98/100 browser cases. Both failed the Following opening-text assertion
and the reading lifecycle case after its final behavior assertion. The intervening
[PR run 39009499692](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/39009499692)
passed 100/100 on an identical source tree. The main failure's approved bundles are
in [evidence/ci-browser-reliability/ci-main](evidence/ci-browser-reliability/ci-main).

Fifteen unchanged/assertion-instrumented repetitions of each case passed on
Node 24.19.0/macOS arm64. These successes did not establish a fix. All browser
commands used `npm run test:e2e`, one worker, zero retries and normal deadlines.
Diagnostic selection/repetition and environment differences below are explicit.

## Native Chromium cleanup

The native lifecycle test must connect with `noDefaults:true`; the ordinary
Playwright context's focus override prevents this test from producing actual
hidden/frozen state. That requirement is unchanged (reading Lore
`LC-20261017-PAXI`). Installed Playwright 1.64's CDP default-context close disconnects
the transport; it does not shut down the externally owned Chromium process.

A disposable Ubuntu 24.04/arm64 probe launched that same Chromium executable,
connected without defaults, wrote synthetic local storage, then used the old
disconnect/SIGTERM/parent-exit/profile-removal sequence. One of five tests failed
with `ENOTEMPTY` during profile removal; each test attempted three browser cycles.
The probe classified the error by a fixed-code assertion, without publishing raw
errors, browser text or profiles. Its [source and approved failure evidence](evidence/ci-browser-reliability/native-linux-red)
are retained. This reproduces a concrete cleanup race matching the CI boundary;
the original hosted bundles do not contain their raw filesystem error.

`nativeLifecycleBrowser` in `tests/e2e/reading.spec.ts` now owns launch and disposal:
snapshot pages, send CDP `Browser.close`, require successful process exit, dispose
the tracked context and remove its profile. Failed startup/shutdown still cleans
up its owned process and propagates failure. It no longer silently catches a
redundant browser-close error. The normal regression writes ten synthetic 100 KB
storage entries immediately before each of three shutdowns, then asserts that the
browser is disconnected and its profile is absent.

The final helper/regression passed ten Linux repetitions (30 browser cycles) with
complete approved captures. This bounded Linux probe used a static synthetic HTTP
server instead of the PostgreSQL/HTTPS application fixture; it validates cleanup,
not reading behavior. The same new regression and the original hidden/frozen,
foreground-reopening and abandoned-response case passed five repetitions each
through the normal macOS PostgreSQL/HTTPS runner (10/10).

An earlier graceful-shutdown probe also passed 30 Linux cycles but did not dispose
the collector's tracked context, so its captures were incomplete. The final helper
and final Linux run above correct and verify that diagnostic ownership boundary.

## Following navigation assertions

The original hosted failure is at the page-wide `getByText('Navigation opening')`
assertion. It did not recur in the local repetitions, a delayed-response/CPU probe,
15 Linux-Chromium repetitions, or 100 additional current-context navigations.
The original CI error category therefore remains unconfirmed; the closed bundles
do not establish a strict-locator error or an application navigation failure.

There is a reproducible assertion gap: a reply can legitimately have the same text
as the opening. The old page-wide locator is then ambiguous and can also identify
the wrong contribution while the opening is loading. The regression now gives the
opening and reply identical text. With both revisions rendered, the original
assertion failed at its text lookup. After binding checks to each contribution ID,
exact revision ID and full prose, five repetitions passed. Focused reply navigation
also requires the opening's full body to be absent. Current R2 summary context,
historical R1 text and contribution-only focusing assertions remain intact.

This repairs the assertion boundary identified by CI and adds stronger identity
coverage; it is not proof of the unobserved original CI exception's cause. Hosted
CI for this working-tree change has not run.

## Verification and memory

`npm run check` passed: 64 bootstrap tests, five hook tests, 87 application tests,
typechecking and build. Documentation validation also passed after the evidence
and scoped-memory changes.

`npm run test:e2e` passed **101/101**, with one worker, zero retries, normal
deadlines and zero omitted tests. This includes the strengthened Following journey,
all ten reading cases, the new cleanup regression and the remaining browser suites.
The [full-run manifest](evidence/ci-browser-reliability/full-browser/run.json)
records completion on Node 24.19.0/macOS arm64; the containing runner validated the
approved output and exited zero. There were no incomplete captures.
Approved manifests and the two controlled red cases are retained in
[evidence/ci-browser-reliability](evidence/ci-browser-reliability).
The Linux browser/probe used an isolated container without host networking or a
Docker socket. Linux browser navigation used Playwright's loopback forwarding to
the normal host fixture. These are diagnostic environments, not hosted amd64 CI.

`tests/MEMORY.md` now records exact contribution/revision assertions and native
process ownership. Root memory and the older server-fixture teardown decision
(`LC-20261014-WZF5`) remain accurate: browser resources still close before the
synthetic server. No public command or product contract changed.
