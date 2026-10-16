# Authored change notes: verification evidence

The review diff is based on main `6913ebbdf6c67dc50fc497f17a9351c7fa4a8ff0`,
pulled with a fast-forward after the user's branch instruction. This records the
implementation checks before authorized finalization (LC-20261016-T9G8).
Tests use Node 24.19.0 on macOS arm64, disposable local
PostgreSQL containers, loopback HTTPS, Chromium virtual WebAuthn and synthetic
accounts/content. Existing development data and imported baselines are untouched.
The [task contract](../adr/022-authored-change-notes.md) and [guide](change-notes.md)
define the delivered behavior and synthetic bounds.

## Direct acceptance evidence

`npm run test:changes:postgres` exercised ownership (human Alice's note vs agent
Bob's ordinary account), exact R1/R2 membership after R3/moves, distinct main/note
mentions and assertions, immutable rows and one ordinary source event. It checks
summary note-only exclusion and ordinary account source gaps, protected metadata
omission with safe carry/removal, wrong-target/duplicate/Unicode/size refusals,
same-key changed semantics, concurrent retries, injected rollback stages and
post-COMMIT acknowledgement loss.

Additional tests cover populated pre-0011 source/mention/reference/summary/Saved/
search/digest preservation, pre-upgrade outcome recovery, retained summary
preparations, fsynced standalone client journals and server/process restarts.
Client inspection accepts canonicalized entity order and UUID spelling while the
saved request remains byte-for-byte unchanged across status/retry/inspection.
Observed PostgreSQL guard barriers cover source/target/owner/exact suppression and
editor/credential revocation in both commit orders. Derived search checks use the
native worker, stop/start and rebuild without blocking exact reads or publishing
another source event.

Bounded discovery inspected 100 hidden candidates before an empty continuation,
then returned the remaining three eligible memberships. The empty page measured
914 bytes and the next page 3,874 bytes under a 4,096-byte budget. Escaped accepted
main text measured 74,919 JSON bytes and the separate note 25,484 bytes, each below
131,072. Coverage traversed all 16 exact members without truncation. These are
synthetic observations, not production capacity claims.

Browser scenarios exercise both authoring forms, new-revision note absence,
saved-note reload, failed saves, correction, uncertain dispatch, competing tabs,
persistent Chromium restart, late target selection while typing, keyboard focus
and 390px layout. Conflict correction can explicitly carry the comparison revision's
declaration without expanding unavailable target IDs or losing attempted text.
Development React StrictMode separately tests late route/identity
responses, failed-page position/retry and safe authored rendering. Curated
[desktop note](change-notes-evidence/screens/note-desktop.png),
[mobile note](change-notes-evidence/screens/note-mobile.png) and
[mobile account](change-notes-evidence/screens/account-mobile.png) screens were
copied from the synthetic per-test output separately from approved diagnostics.
All three screens were visually reviewed for attribution, exact scope, safe authored
text and narrow layout.

## Observed commands

All final commands below exited zero. Browser execution retained the normal one
worker, zero retries and existing deadlines. Command output is retained in
[commands](change-notes-evidence/commands/check-complete.txt); individual links
below identify the relevant run.

| Command | Observed result |
| --- | --- |
| `npm run check` | [Passed](change-notes-evidence/commands/check-complete.txt): document checks, 64 bootstrap tests, 5 hook tests, typechecking, 50 application/contract/StrictMode tests and build. |
| `npm run test:changes:postgres` | [12 passed](change-notes-evidence/commands/feature-complete.txt), including direct acceptance, complete immutable state and recovery checks described above. |
| `npm run test:app:postgres` | [9 passed](change-notes-evidence/commands/regression-app.txt). |
| `npm run test:publication:postgres` | [16 passed](change-notes-evidence/commands/regression-publication.txt). |
| `npm run test:identity:postgres` | [22 passed](change-notes-evidence/commands/regression-identity.txt). |
| `npm run test:participation:postgres` | [12 passed](change-notes-evidence/commands/regression-participation.txt). |
| `npm run test:saved-items:postgres` | [10 passed](change-notes-evidence/commands/regression-saved-items.txt). |
| `npm run test:organization:postgres` | [15 passed](change-notes-evidence/commands/regression-organization.txt). |
| `npm run test:search:postgres` | [46 passed](change-notes-evidence/commands/regression-search-second.txt). |
| `npm run test:references:postgres` | [26 passed](change-notes-evidence/commands/regression-references-second.txt). |
| `npm run test:summaries:postgres` | [14 passed](change-notes-evidence/commands/regression-summaries-final.txt), rerun after the direct-client repair. |
| `npm run test:migrations:postgres` | [9 passed](change-notes-evidence/commands/regression-migrations.txt). |
| `npm run test:e2e` | [67/67 passed, no omissions](change-notes-evidence/browser-full-final/run.json); approved normal-run diagnostics retained. |
| `npm run test:browser-diagnostics` | [Passed](change-notes-evidence/commands/diagnostics-final.txt): eight expected controlled child failures, upload-candidate canaries/bounds, lifecycle and four fail-closed validation cases. |
| `git diff --check` | Passed before finalization; no applied migration or imported specification edits. |

## Failed runs and repairs

The [initial feature output](change-notes-initial-test.txt) is retained. Its real
summary eligibility gap excluded v3 ordinary accounts; adding v3 to both source
eligibility and exact authorization made that test pass. Discovery helper failures
were fixture repairs: full publication objects had accidentally become query
parameters. Initial typechecking also caught fixture optional-value accesses.

Initial browser failures and follow-ups are retained under
`change-notes-evidence/browser-initial`, `browser-second` and `browser-third`.
A note textarea needed a stable accessible name after entry/reload. Fixtures then
added actual journal-save barriers before reload or one-write fault injection;
a click/fill completion did not prove asynchronous Web Lock persistence. A reply
journey used the wrong control name; the existing product label is Post reply.
The StrictMode fixture also needed a valid exact target link for its delayed fetch.
No retry, deadline, guard or assertion was relaxed.

The first complete normal browser run completed 66 tests with one failure in the
existing reference correction case. V3 compatibility had broadened reference
adoption to same-format v2 corrections, replacing attempted edits. That repair
restricted base adoption to format upgrades; the remaining v2→v3 gap is addressed
in the PR #9 follow-up below. Approved failure evidence is retained in
`change-notes-evidence/browser-full-initial`; this is an application repair,
distinct from the fixture repairs above.

Existing search/reference/summary upgrade tests initially failed because SELECT *
now included added columns. Their expected snapshots now add exactly the migration's
`source_field:main` and empty note projections while still comparing every old
value. Their full suites subsequently passed. This was a fixture adaptation to an
additive migration, not removal of preservation assertions.

The strengthened standalone-client case first failed with
[“Retained note differs from journal”](change-notes-evidence/commands/client-normalization-red.txt)
for equivalent reordered entities and uppercase UUIDs. Client inspection now applies
the server's canonical ordering/spelling for comparison without changing retained
intent. The complete feature suite subsequently passed with that case included.
The earlier fixture used already canonical values and missed this boundary.

One later feature rerun overlapped `npm run check`'s rebuild: two HTTPS fixture
starts saw `dist/web/index.html` temporarily absent. The
[10-pass/2-fail output](change-notes-evidence/commands/feature-build-collision.txt)
is retained. The build completed successfully, then the full feature suite passed
with no concurrent build. Fixture teardown removed its disposable test resources;
existing development containers were not changed.

Final staged whitespace validation found spaces on 13 otherwise blank lines in
five retained failure logs. Formatting-only normalization preserved their messages
and results; the complete staged whitespace check then passed.

## Review scope and remaining gates

Memory reconciliation covers root, participation, search and tests: guide 7, v3
semantic versions, note/account ownership and bounds, summary source eligibility,
current-note indexing, field provenance and durable browser recovery. Source
anchors are the new contracts, migration 0011, change-context/storage/reads,
summary-context, worker/search, Changes/Composer/IntentStore and the tests above.
Earlier Lore context remains relevant: LC-20261016-B8DO, LC-20261016-V9U4,
LC-20261016-UA6O, LC-20261015-94TS and LC-20261014-S0JX.

Material choices: exact selected sets rather than intervals; notes bind only the
new owning revision; no separate note identity; v3 explicit nullable fields with
unchanged older digests; exact-field retrieval within existing response ceilings;
explicitly labelled resource aggregation; current-only note search. No user product
decision is inferred from a passing test count.

Notification delivery, Updates/subscriptions/reading state, file/private-note
integration, reservations, broad moderation UI, retained-data procedures,
cross-machine/autonomous-provider trials, physical authenticators, production
capacity and deployment remain unimplemented or unverified. Hosted CI is checked
separately on the PR after finalization. CI includes the new suite and retains migration/storage/persistence
stages. Local storage smoke/persistence interruption is outside this isolated
increment and was not rerun against existing development services.

The local implementation and verification are complete for review. The scoped
synthetic limits and unperformed broader gates above remain explicit.

## PR #9 follow-up: preserve references during v2→v3 correction

The [review finding](https://github.com/aleksandr-voitenko/ai-collective-loom/pull/9#discussion_r4290345747)
identified a missing browser transition at `f67b7e2`. Existing cases covered v1→v2,
v2→v2 and v3→v3 corrections, but did not check a v2 draft against a concurrent v3
revision. The format-wide adoption condition replaced fields that v2 already
represented. A newly saved correction could lose reference additions and rationale
edits, and restore deliberately withdrawn references after retiring the old draft.

The correction now adopts comparison references only for v1 drafts. V2→v3 retains
the attempted reference list while adding the v3 envelope; the existing explicit
comparison gate, account handling and save-before-retire journal transition remain.
This follows the original requirement to preserve attempted edits, rather than
treating every format upgrade as permission to replace supported fields. The fix
does not change server formats, digests, schema, guards, retries or test deadlines.

The new `changes.spec.ts` case uses actual Chromium, virtual WebAuthn, HTTPS and
disposable PostgreSQL. It edits an existing rationale, removes a resource reference,
adds a different target, and saves the v2 attempt before another editor publishes
v3 with a note. After rejection, correction and reload, it compares the complete
saved content/body, new key/base and retired old key. It then verifies the actual
published content and withdrawal history. The comparison editor's note is not copied.

The [red run](change-notes-evidence/v3-correction/browser-red/run.json) failed at
the complete corrected-content assertion (`changes.spec.ts:87`) before the fix.
The [green run](change-notes-evidence/v3-correction/browser-green/run.json) passed
the entire journey afterward. An initial exact-label combobox selector failed
before reaching correction; a later exact-label lookup of the reloaded textarea
failed after the content checks passed. Both use stable role/relationship selectors
now. Typechecking also caught an asymmetric matcher passed to a typed fixture
builder; the expected value is now built directly. The original failures are
retained in `v3-correction/browser-fixture-initial`, `browser-fixture-reload` and
`commands/check-initial.txt`. These fixture repairs did not relax assertions.
Staged whitespace validation found one trailing blank line in the retained final
typecheck log; removing it preserves the command output.

Local checks on pinned Node 24.19.0/macOS arm64:

| Check | Observed result |
|---|---|
| Focused browser regression | [1/1 passed](change-notes-evidence/v3-correction/commands/browser-green.txt), after the expected red run. |
| `npm run test:e2e` | [68/68 passed](change-notes-evidence/v3-correction/browser-full/run.json), with normal one-worker/zero-retry deadlines and no omissions; includes existing v1 adoption, v2/v3 correction, frozen retry and summary recovery cases. |
| `npm run test:changes:postgres` | [12/12 passed](change-notes-evidence/v3-correction/commands/changes-postgres.txt), including legacy format refusal and exact replay. |
| `npm run test:references:postgres` | [26/26 passed](change-notes-evidence/v3-correction/commands/references-postgres.txt), including carry, edit and withdrawal provenance. |
| `npm run test:summaries:postgres` | [14/14 passed](change-notes-evidence/v3-correction/commands/summaries-postgres.txt), including summary references and durable recovery. |
| `npm run check` | [Passed](change-notes-evidence/v3-correction/commands/check.txt): 50 application/contract/web cases, typechecking and build, plus baseline/hook checks. |
| Final test typecheck | [Passed](change-notes-evidence/v3-correction/commands/typecheck-final.txt), after the reload selector repair. |
| `npm run test:browser-diagnostics` | [Passed](change-notes-evidence/v3-correction/commands/diagnostics.txt): eight expected controlled child failures, canary/bounds/lifecycle validation and four fail-closed cases. |

Participation memory and ADR-022 now distinguish v1 reference adoption from
v2→v3 preservation; test memory records the missing transition and its assertions.
The change-notes guide describes the same behavior. Root memory's ownership,
format and recovery summaries remain accurate. The relevant implementation anchors
are `Composer`'s `adoptsBaseReferences` and `correct`, and unchanged `IntentStore.replace`.
Hosted checks are evaluated separately for the pushed follow-up head. Other backend
suites and development-service storage/persistence checks were not rerun locally
for this browser-only correction; their earlier results above remain historical.
