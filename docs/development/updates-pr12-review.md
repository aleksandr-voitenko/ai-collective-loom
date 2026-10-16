# Updates PR12 recovery review and browser CI investigation

Lore task `LC-20261017-5QRE`, following `LC-20261017-FUWG` and starting at
`70dd9a03614471bf718c3e545063029e491dc10a` on `codex/combined-updates`.
The user requested both reviewed recovery fixes, regression tests, investigation
of the failed browser CI run, relevant checks and a stop for review without staging
or committing. The existing [W02 evidence](updates-evidence.md) remains historical.

## Scope and decisions

Restore the selected scope/reason when a history gap occurs before any descriptor,
and offer explicit incomplete resynchronization on successful unknown-history pages.
Preserve frozen descriptor semantics, current authorization, separate stream clocks,
source/delivery identity, Saved state and independent standalone feeds. No API,
schema, worker, dependency, CI retry or timeout change is required. Acceptance covers
personal/mention and explicit-artifact/reply scopes, populated pre-0013 retained
structure, baseline/reload/newer traversal, persistent qualification and inventory links.

The [first finding](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/12#discussion_r4299188014)
was a tokenless resynchronization request omitting scope/reason. The server applied
its default Following/all scope while the toolbar and local key still represented
the user's selection. The browser now supplies that selection when there is no
token. Descriptor-bound requests continue using their frozen token.

The [second finding](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/12#discussion_r4299188017)
was a missing browser action: resynchronization existed only in the error branch,
but unknown structural history is a successful, qualified response. Ready unknown
pages now offer **Establish an incomplete new baseline**, using the displayed token
and budgets. The warning explains that older activity is not reconstructed.
History qualification follows component history flags after newer activity and reload;
retained topic/artifact/personal-attention links remain available. This reuses the
existing server contract without inventing historical facts or a complete checkpoint.

## Regression and verification evidence

Prior tests exercised saved-descriptor recovery and server unknown-history refusal,
but omitted these initial browser states. Three new StrictMode tests and three real
Chromium scenarios cover the two scope variants and unknown-history upgrade path.

- The three targeted StrictMode cases first failed: recovery omitted scope/reason
  in two cases; the unknown-history baseline button was absent in the third.
- The same Chromium cases failed against the original compiled UI at the request
  comparisons and missing action. [Red evidence](evidence/updates/pr12-browser-red/run.json).
- After the UI fix, the first browser run passed 6/8, including the populated upgrade.
  The new publication fixture lacked v3's explicit null change fields. The next run
  passed 6/8 after that correction but exposed an incorrect observer column
  (`participant_id` instead of `personal_deliveries.recipient_id`). Both fixture errors
  were corrected without changing product validation or assertions. Evidence:
  [first run](evidence/updates/pr12-browser-first-fix/run.json),
  [second run](evidence/updates/pr12-browser-fixture-correction/run.json).
- All 11 Updates StrictMode tests passed after the fix. The corrected Updates browser
  file passed 8/8, including scope/reason persistence, later matching shared/personal
  activity, incomplete-history disclosure and unchanged clocks/deliveries/Saved state.
  [Targeted browser evidence](evidence/updates/pr12-browser-targeted/run.json).
- An initial typecheck rejected untyped link-name/path tuples under strict indexed
  access. Declaring the fixed tuples `as const` corrected the tests; typecheck passed.
- `npm run check` passed: 64 bootstrap, 5 hooks and 76 application/contract/web tests,
  documentation checks, TypeScript and the production build.
- `npm run test:updates:postgres` passed 23/23, including independent stream recovery,
  authority races, frozen definitions, capacity, populated upgrades and native restart.
- Full `npm run test:e2e` passed 91/91, including all eight Updates scenarios.
  [Complete browser evidence](evidence/updates/pr12-browser-full/run.json).
- `npm run test:browser-diagnostics` passed its eight intentional child failures,
  upload-candidate canary/bounds/lifecycle assertions and four fail-closed validation
  cases. The [controlled-failure manifest](evidence/updates/pr12-diagnostics/run.json)
  is intentionally failed; the enclosing validation command exited successfully.

Focused commands changed only test selection. All browser commands use the normal
containing runner, one worker, zero retries and unchanged 90s test/15s action/20s
navigation deadlines. Local checks use Node24.19.0, Playwright1.64.0 and macOS arm64
with disposable local PostgreSQL and real HTTPS/virtual WebAuthn.

The red checks used:

```sh
node --import tsx --test --test-name-pattern 'tokenless|ready unknown' tests/web/updates.test.tsx
npm run test:e2e -- tests/e2e/updates.spec.ts --grep 'tokenless|pre-0013'
```

Green focused checks used the complete `tests/web/updates.test.tsx` and
`tests/e2e/updates.spec.ts` files. The StrictMode gap responses also use the actual
HTTP 410 status observed through the real API.

Two attempts to start the CI-focused repetitions were rejected because automatic
permission review timed out; neither started a test process. Sandbox-only Docker
access was denied. The user then authorized continuing, and browser verification
resumed. These local interruptions are separate from the earlier hosted failures.

## Hosted browser failure

The [push run](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38962954655)
failed its local-integration browser step. Its validated artifact records 88 tests
ended: 85 passed and three failed. Each failed on the first `GET /loom` with the
collector's `network_changed` category, which maps directly to Chromium
`net::ERR_NETWORK_CHANGED`. The server had reported ready; no app shell, sign-in
flow or feature assertion had been reached. Context/server teardown completed.

| Test at the reviewed commit | Failing operation |
|---|---|
| `following.spec.ts:70` — settings refresh | `change-browser.ts:20`, initial navigation |
| `following.spec.ts:179` — visibility recovery | `change-browser.ts:20`, initial navigation |
| `participation.spec.ts:1334` — parameterized replacement-draft restart | `participation.spec.ts:45`, initial navigation |

The closed artifact hashes test names and retains source locations. Local diagnostic
repetition includes all three replacement-draft variants. Downloaded artifacts contain
only approved JSON, without raw errors, credentials, bodies, DOM or private attachments.
[Failed-run evidence](evidence/updates/pr12-push-browser-failed/run.json).

Artifact `12074132241` (`browser-diagnostics-38962954655-1-local-integration`) had ZIP
SHA-256 `79dda4aa58efb72bef1d9aa9c9e4b6bdfe95006c0341b2ea68497996c47bbc14`, matching
GitHub's digest. The run manifest and all three failure bundles passed the repository's
closed validators before copying; the approval record reports four files.

The [successful PR run](https://github.com/aleksandr-voitenko/ai-collective-loom/actions/runs/38962990102)
records 88/88 browser passes. Its merge commit `9d6b179cad072389cd35de679a48ae6e93815f31`
and the failed push commit have the identical Git tree
`ab22ac5935c76d961e0975dbd592f5f387c6aa6d`, verified using GitHub commit metadata and
local Git. [Successful-run evidence](evidence/updates/pr12-pr-browser-passed/run.json).
Artifact `12073848187` had matching ZIP SHA-256
`50513bd97c2975ede013aefd40527fec2c933272dabab262ab342cd26404b1d3`.

This establishes an intermittent initial-navigation failure on unchanged hosted
sources. It does not establish what changed in the host/network or prove that future
runs will pass. The recovery findings occur after successful navigation and are not
the operations that failed in this push run. No speculative retry, sleep, Chromium
flag or CI guard change was made. The failed hosted run remains failed; no workflow
was dispatched or rerun during implementation verification.

The following local diagnostic command passed 15/15 (five scenarios, three repeats),
with all 15 captures complete and no capture issues:

```sh
LOOM_DIAGNOSTICS_KEEP=all npm run test:e2e -- tests/e2e/following.spec.ts tests/e2e/participation.spec.ts --grep 'Following refresh adopts|shared visibility failures|Write another selects' --repeat-each 3
```

[Repetition evidence](evidence/updates/pr12-ci-repetitions/run.json) retains every
approved capture. Only selection, repetition and passing-capture retention changed;
workers, retries and deadlines stayed normal. The failure did not recur locally.
These macOS repetitions do not establish that the earlier Linux-hosted condition
has been corrected; the complete 91/91 normal local run is separate evidence.

## Memory and review boundary

The current guide and README describe the browser recovery path. Tests memory now
records the previously missing boundaries. Updates memory describes tokenless versus
descriptor-bound recovery, persistent history warnings and the explicit incomplete
checkpoint exception. Root memory's architecture summary remains accurate.
Historical W02 results, imported baselines and previous task records remain unchanged.
Final evidence validation accepted all nine retained run manifests and 33 diagnostic
bundles. Documentation and whitespace checks passed. At the review handoff, HEAD was
`70dd9a0`, the index was empty and the repair remained an unstaged reviewable diff.
The user subsequently authorized finalizing these fixes as Lore task
`LC-20261017-5QRE`, committing, pushing and updating PR12.
