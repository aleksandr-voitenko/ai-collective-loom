# Recorded references verification

This task starts from merged PR #6, `7787325aeec8638ff648d5f5c27f7b3f5bfec5d4`,
in an attached isolated worktree. The original checkout and existing development
data were not reset. All accounts/content are synthetic and databases are temporary
tmpfs PostgreSQL containers. Implementation and local verification stopped before
staging, committing or publishing for user review. Finalization and PR creation
were subsequently authorized separately. Product/architecture/UI imported baselines
remain unchanged; no merge, deployment or existing-data reset was performed.

Environment: Node 24.19.0, macOS arm64, Docker Desktop Linux/arm64 PostgreSQL,
actual local HTTPS, Playwright 1.64.0 / Chromium 156 and virtual WebAuthn. The
standalone client runs as a separate local Node process, not a provider-agent or
cross-machine trial. Dependencies installed with `npm ci --ignore-scripts`.

## Acceptance and decisions

The user-supplied task brief requires one persistence/API/browser slice for explicit
text-source references and bounded backlinks, preserving v1 interpretation/retry,
exact revisions, current authority, proposal references and existing personal state.
[ADR-021](../adr/021-recorded-references.md) was written before implementation.
Explicit v2 lists were chosen over inline syntax; known IDs/same-instance links
avoid an indexing dependency; rationale is displayed but not searched. No worker
or inferred/backfilled relationships were introduced. Contract review added
explicit withdrawal provenance so another editor's removal is attributable.

Evidence maps to the implemented DIS-06/REF-01–03/SRCH-07 portions, not full broad
AC27–30/33/34/37/39 completion:

- `references.test.ts`: ordinary human/agent policy, complete durable projections,
  original/change/withdrawal attribution, carry-forward, exact targets after edits/
  moves, safe unavailable handling, discussion versus opening, eligible nested
  replies, Unicode/uniqueness/FKs, atomic rollback, concurrent retry, cross-citation
  locks, native worker restart/rebuild and index-independent backlinks.
- `references-retrieval.test.ts`: populated 0008 upgrade preserving text/mentions/
  outcomes/Saved/organization/proposals/search and original uncertain v1 retry;
  hidden-candidate scan continuation, caller/scope/history/filter bindings,
  publication/move/restoration/expiry/API-restart invalidation; deterministic real
  SQL barriers before/after source/target/owner/selected-revision guards and credential
  revocation, with documented coherent result or restart.
- `references-client.test.ts`: restarted external HTTPS client retains exact v2
  intent; human/agent revision/withdrawal parity; maximum declarations, escaped
  rationale/response budgets, request/cursor limits and real SQL timeout.
- `web/references.test.tsx`: development StrictMode completion/focus, failed-position
  retry, stale route/account/query results, known-target scope and external-link
  rejection. `e2e/references.spec.ts`: actual browser exact navigation, keyboard/
  narrow layout, correction/reload, persistent restart, competing tabs, lost
  acknowledgement, failed autosave, page refresh and route/account ownership.
  A retained uncertain v1 edit is also retried after a later v2 source publication.

## Checks and observed failures

Early focused runs passed 8 publication/reference tests, 13 retrieval/race tests
(including eight subtests), and four StrictMode tests. The standalone/client-limit
run passed two and failed one assertion expecting 503 for the documented work-limit
error; the HTTP contract uses 429, and the assertion was corrected accordingly.

The initial build could not create `dist` under the new worktree's sandbox path;
the authorized elevated build passed. Early typechecking identified discriminated
content-union and label-index typing issues, corrected before browser verification.
No runtime check is claimed from those failed commands.

Focused browser command: `npm run test:e2e -- tests/e2e/references.spec.ts`.
All runs used the normal runner, one worker, unchanged timeouts and no retries.

| Run | Result | Evidence and correction |
|---|---|---|
| 1 | 2 passed / 3 failed | [Validated bundle](recorded-references-evidence/browser-01/run.json). Exact `getByLabel` selectors included nested select text; use exact accessible combobox names. |
| 2 | 4 passed / 1 failed | [Validated bundle](recorded-references-evidence/browser-02/run.json). Refilled textarea needed its accessible textbox name. |
| 3 | 4 passed / 1 failed | [Validated bundle](recorded-references-evidence/browser-03/run.json). Storage was restored before queued dispatch finished; wait for explicit refusal and enabled Publish before restoring it. |
| 4 | 5 passed | Normal focused command passed after those harness corrections, before adding withdrawal projection. |
| Full 1 | 51 passed | [Normal suite result](recorded-references-evidence/browser-full-01/run.json), with withdrawal projection. |
| Legacy regression | 1 failed | [Validated reproduction](recorded-references-evidence/browser-legacy-red/run.json), command below; the frozen v1 editor incorrectly displayed references from a newer v2 source. |
| Full 2 | 52 passed | [Final normal suite result](recorded-references-evidence/browser-full-02/run.json), including the corrected legacy recovery regression. |

Failure bundles were copied only from `browser-diagnostics/approved` before the
next invocation. They contain closed categories/locations, not raw reports, text,
credentials or screenshots. Polling can record transient failed expectation steps;
the table uses each test's terminal result. No timeout/retry/diagnostic guard was
relaxed.

Final review found a compatibility display gap: Composer initialized references
from the current source whenever the retained request was not v2. An uncertain
v1 edit could therefore display later v2 declarations, although its retained body
and dispatched retry remained unchanged. Existing cases did not combine an old
uncertain revision edit with a later reference-bearing current revision. The
focused command `npm run test:e2e -- tests/e2e/references.spec.ts --grep 'uncertain v1 edit'`
failed the zero-declarations assertion before the fix. Initialization now treats
a retained v1 body as authoritative with no declarations. The final normal suite
passes the same assertion, preserves the original body/result and leaves the
newer source revision current. This is observed red/green evidence for that bug.

## Completed local verification

Each command ran to completion using Node 24.19.0. Independent PostgreSQL suites
used separate fixtures; normal browser workers/timeouts/retries were unchanged.
Counts include nested test cases. No required local check remains failing.

| Command | Observed result |
|---|---|
| `npm run check` | Passed: imported/document checks, 64 bootstrap tests, 5 hook tests, typechecking, 42 application/contract/web tests and build. |
| `npm run test:references:postgres` | 26 passed; final run includes withdrawal rollback/disclosure, both target-revision race orders, all semantic identity fields and maximum escaped 16-reference/full-body representation. |
| `npm run test:search:postgres` | 46 passed. |
| `npm run test:migrations:postgres` | 9 passed. |
| `npm run test:app:postgres` | 9 passed. |
| `npm run test:publication:postgres` | 16 passed. |
| `npm run test:identity:postgres` | 22 passed. |
| `npm run test:participation:postgres` | 12 passed. |
| `npm run test:saved-items:postgres` | 10 passed. |
| `npm run test:organization:postgres` | 15 passed. |
| `npm run test:e2e` | Final normal run: 52/52 passed, zero retries; approved summary retained above. |
| `npm run test:browser-diagnostics` | Passed: 8 intentional controlled failures, upload-candidate canaries/byte limits/lifecycle and 4 fail-closed cases. Intentional child failures remained failures. |
| `git diff --check` | Passed; no applied migration/imported snapshot edits or staged files. |

The required CI reference suite was added alongside existing PostgreSQL checks;
all new unit/web/browser tests participate in the existing normal test globs.
Closed diagnostics add only reference file/route/control categories. Existing
timeouts, retries, limits, guards and upload handling remain intact.

Separate visual review used an isolated real HTTPS/Chromium fixture and captured
only authenticated synthetic content, after credential setup closed. Inspected
the [desktop outgoing view](recorded-references-evidence/screens/source-desktop.png),
[390px exact incoming view](recorded-references-evidence/screens/incoming-mobile.png)
and [target confirmation](recorded-references-evidence/screens/picker-desktop.png).
Scope, exact links, attribution and rationale remain readable without horizontal
clipping; keyboard selection/refresh focus is separately asserted in browser tests.
These curated images are outside the diagnostic upload candidate. The temporary
review script initially used `.ts` outside the repository's ESM package and failed
before execution on top-level await; running it as `.mts` produced the inspected
images. No UI pass was inferred from that failed invocation.

## Memory reconciliation and limits

Root, participation, search and tests memory were checked against the final
contracts, membership storage, retrieval, browser ownership and test assertions.
Updated guide version/format population, removed the stale unsupported-backlinks
claim and recorded bounded read/lock/cursor/withdrawal rules at participation scope.
Search memory now covers both formats and excluded rationale; tests memory records
the new race/StrictMode/browser fixtures and the dispatch-completion barrier.
Relevant inherited Lore: `LC-20261012-6OTQ`, `LC-20261014-9EU9`,
`LC-20261014-S0JX`, `LC-20261014-6LGH`, `LC-20261014-IGI9`,
`LC-20261015-94TS`, `LC-20261014-3D4P`.

Summary/coverage/change-note, file/path and private-note integration, attention,
production capacity, multi-API cursor custody, retained-data upgrade/erasure/restore
operations and real identity proof remain open. Hosted CI/upload and physical
device/usability/cross-machine/provider-agent trials are not performed by local
verification. Existing Compose persistence/S3 tests are outside this text change
and were not run against development services.
