# Browser CI reliability follow-up

The initial investigation below records `LC-20261017-AKEL` (PR #14). Its Following
failure cause was unresolved. The [remaining Following failure](#remaining-following-failure)
section records the subsequent deterministic reproduction and application fix.

Initial scope: investigate the two recurring failures after reading progress merged,
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
The original CI error category remained unconfirmed in that investigation; the closed bundles
do not establish a strict-locator error or an application navigation failure.

There is a reproducible assertion gap: a reply can legitimately have the same text
as the opening. The old page-wide locator is then ambiguous and can also identify
the wrong contribution while the opening is loading. The regression now gives the
opening and reply identical text. With both revisions rendered, the original
assertion failed at its text lookup. After binding checks to each contribution ID,
exact revision ID and full prose, five repetitions passed. Focused reply navigation
also requires the opening's full body to be absent. Current R2 summary context,
historical R1 text and contribution-only focusing assertions remain intact.

This repaired the assertion boundary identified by CI and added stronger identity
coverage; it did not prove the unobserved original CI exception's cause. Hosted
CI had not run at preparation of that task record.

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

## Remaining Following failure

The merged-main [run 39061861320](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/39061861320)
passed 100/101 browser cases on `2687226`. All reading cases passed; Following
failed at the exact opening-text assertion. PR #14's push and PR browser runs had
passed on the same source tree. The [approved CI evidence](evidence/following-revalidation/ci-main)
shows community revalidation completing just before the failed assertion, after
the opening's text and reading controls had mounted.

`ContributionBody` in `src/web/ParticipationApp.tsx` gave its `ReadingText` and
`ReferenceViews` siblings the same revision key. Reading instrumentation introduced
that collision (`LC-20261017-PAXI`). When community revalidation rerendered mounted
contributions, React could leave an extra copy of the reading subtree. A controlled
probe observed one opening article containing two exact prose bodies and two
reading-control sets; its failed assertion was a strict-locator error. Scoping
locators to the exact revision cannot distinguish these duplicate subtrees.
The original CI bundles omit raw errors, so their exception category remains
unavailable; the ordering and assertion boundary match the reproduced defect.

Reading and reference siblings now use separate `reading:` and `references:` key
prefixes while retaining revision-based remounts. Removing the keys would discard
the intended revision ownership boundary. No timing delays, retries, timeout
changes, dependency changes or CI configuration changes were needed.

The new `following.spec.ts:151` regression holds the real community response until
the opening and reply each display their exact text and enabled reading controls.
It changes only the fixture's community name through the normal administrator API;
observing that name after release proves the parent render has committed. It then
requires one article, exact prose body, reading-control set and source-reference
region per contribution, with both manual reading controls enabled. This closes
the uncontrolled-response-order gap in the existing navigation test. The original
current R2 / historical R1 summary and focused-reply journey remains unchanged.

Before the key fix, this final regression failed at `following.spec.ts:181`, where
the exact body count must be one; the article count had already passed. Its
[approved red evidence](evidence/following-revalidation/regression-red) is retained.
After the fix, the regression and original navigation journey passed five times
each with the normal runner:

```sh
npm run test:e2e -- tests/e2e/following.spec.ts --grep 'summary change context|summary context keeps one exact' --repeat-each 5
```

The [macOS focused run](evidence/following-revalidation/targeted-green/run.json)
passed 10/10. The [Linux Chromium run](evidence/following-revalidation/linux-focused/run.json)
also passed 10/10 using Playwright 1.64.0's official Ubuntu 24.04/arm64 container,
with `PW_TEST_CONNECT_WS_ENDPOINT` and `PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>'`
connecting to the normal host PostgreSQL/HTTPS fixture. Its run metadata describes
the macOS Node runner, not the remote browser platform. The image digest was
`sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f`.
The owned container was removed after verification. This is Linux browser evidence,
not a hosted amd64 CI result.

`npm run check` passed all 64 bootstrap, five hook and 87 application tests,
typechecking and the production build. Scoped memory now records the sibling-key
constraint and the render barrier. Root memory and README need no change: public
commands, contracts and ownership remain the same.

The unfiltered `npm run test:e2e` then passed **102/102** on Node 24.19.0/macOS
arm64, including all 11 Following and ten reading cases. It used the unchanged
one-worker, zero-retry configuration and normal deadlines. There were zero skipped
or omitted tests and zero incomplete captures. The containing runner exited zero
and validated the [full-run manifest](evidence/following-revalidation/full-browser/run.json)
and approved output. Retained documents were also checked against the closed
diagnostic schemas. Hosted CI was pending when this task record was prepared.
