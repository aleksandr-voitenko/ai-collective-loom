# Search indexing administration

`/loom/admin/search` is the administrator-only shared-text indexing page. The
shared Administration navigation links here alongside Community and the other sections.
Participant Search, file-text processing and other Administration tools keep their
own behavior. The shared page gutter, 820px column, restrained white sections and narrow
layout follow Community settings. Primary sections are Status, Failed jobs and
Maintenance; technical identifiers are secondary disclosures.

## Observations

Entry loads GET `/api/v1/admin/search/health` and the first bounded GET
`/api/v1/admin/search/failures`. Refresh status repeats health and the currently
requested failure page, including the exact continuation of a failed page request.
These reads never requeue jobs, rebuild or change settings. There is no polling.

Health supplies worker availability, initial scan completion, change-discovery
catch-up, capacity and pending/running/succeeded/failed job counts for its current
index generation. The main status prioritizes capacity limitation, worker
unavailability, failures needing attention and work/discovery in progress. Otherwise
it says No queued work observed. This is not an Up to date or coverage claim.
Scan completion, discovery and processing remain separately labelled observations.
No completion percentage, ETA, document count or invented stalling threshold is used.
The participant coverage algorithm remains server-owned and is not reconstructed.

Initial loading and unavailable observations have no invented zero values.
A transient failed refresh can retain an earlier authorized observation, explicitly
labelled as earlier. Success clears that read error. Command outcomes are independent.
Each read family sequences its responses; StrictMode, navigation and identity
ownership fence stale results. Every displayed observation checks its authorization
lease. Withdrawal hides metadata and prevents dispatch. Explicit Check access
verifies the same current administrator before fresh protected reads.

## Failed jobs

One page of at most 25 rows is retained. Next page fetches only the returned after
continuation; Retry this page repeats the failed requested continuation. First page
remains available after traversal or page failure. Successful and failed explicit
navigation focus the section heading. Pages replace, rather than append to, rows.
No failed jobs on this page makes no claim about failures outside that page.

Failure labels map the server's closed categories to short descriptions; attempt
count and Retry job are contextual. Job/resource/revision/event/intent identifiers,
index generation, claim generation and original failure code appear in Job details.
No source body or decorative resource lookup is fetched.

The failure operation includes earlier generations, unlike health's current-index
counts. Earlier-generation rows are labelled and cannot retry. Unobserved/different
current generations require fresh health; refreshing never changes a retained retry's
job ID or claim generation. A validated `{accepted:true}` acknowledges retry;
it does not mean the job succeeded. Separate fresh reads inspect processing.

Pending, rejected, acknowledged and uncertain retry feedback stays beside the
affected row in Failed jobs, with the exact-request recovery control. The current
page position identifies it without promoting technical IDs. If the row leaves
the page, its result keeps that bounded position without retaining old job metadata.
On another page or reopening without the row, the retained result appears first,
explicitly separate from observed processing. Feedback updates do not move focus
or scroll the reader. Rebuild feedback stays in Maintenance.

## Maintenance and uncertainty

Rebuild index opens a native focus-contained dialog. It explains the retained-source
rebuild, potentially incomplete search coverage during processing, and preservation
of published content and Saved items. Cancel sends no command and restores focus.
Confirmation retains the generation selected when the dialog opened. Pending controls
prevent duplicate submission. Rebuild is a secondary maintenance action.

The POST contracts are unchanged:

- rebuild: `{expected_generation}`; validate exactly the next-generation response;
- retry: `{id, claim_generation}`; validate the closed accepted response.

These endpoints do not accept idempotency keys and have no per-request status API.
They cannot use the publication IntentStore schema. `search-maintenance-recovery.ts`
uses existing verified-storage writes and Web Locks for one 2KiB record scoped to
origin, instance and participant. It stores only the exact request, sequence and
uncertain/acknowledged/rejected state. It persists uncertainty before transport,
serializes cross-tab dispatch and refuses replacement while unresolved. Reload and
reopening restore the record without sending a command. Sign-out's existing local
cleanup includes this slot and warns before clearing an uncertain request.
Command errors bind to the retained request, sequence and settlement state. A
storage event adopting a superseding attempt/settlement retires its obsolete error,
without clearing independent health or page errors. Reading unchanged uncertain
custody preserves its error and never establishes acknowledgement.
An attempt that fails before its send callback starts shows Request not sent in
that attempted action's context. Its local feedback is separate from any older
acknowledged recovery record; those stored bytes and their outcome remain unchanged.
Failure after transport begins, including failure retaining an acknowledgement,
does not establish non-dispatch. If another tab left an unresolved request before
the unsent attempt, Review retained request exposes its original recovery controls
without replacing its payload or sending a command.

The server serializes rebuilds with the discovery guard: current generation N
advances to N+1; an exact request for N also acknowledges an already-current N+1.
Retry locks its job and accepts a previously advanced claim generation within the
current index. These acknowledgements are convergent, not proof that this particular
administrator alone caused the transition. The page says request acknowledged,
never rebuild completed or job succeeded based on the receipt.

A first definitive rejection, including search_changed without an unknown-outcome
marker, permits a later deliberately prepared command. After uncertainty, permission,
unavailability and generation conflicts do not establish rollback. Exact replay
retains the original guards and remains uncertain if it cannot acknowledge them.
A newer index or missing row never settles that request. If the index advances
beyond the replay window, the API cannot resolve the original outcome: the retained
request remains unresolved and replacement commands remain blocked in that browser
slot. No shared rejection helper or backend recovery behavior changes.

Local custody/receipt-validation failure cannot report success. Late command results
after withdrawal, identity change or departure cannot settle the slot, navigate or
refresh another view. Recovery bytes alone do not authorize a read or write.

## Verification and review

Mounted tests: `tests/web/search-administration.test.tsx` and the existing production
session-authorization tests. Real PostgreSQL/HTTPS/WebAuthn journeys live in
`tests/e2e/search.spec.ts`, alongside participant Search regressions.

Opt-in synthetic actual-application PNG capture:

```sh
npm run app:build
LOOM_SEARCH_REVIEW_SCREENS=1 npm run test:e2e -- search.spec.ts
```

`tests/helpers/search-indexing-review.ts` writes viewports, optional full-page
supplements and source/build/fault/checksum manifests under
`/tmp/loom-review-evidence/ui-03`, outside diagnostic output. Before views use the
merged UI-02 application. Seeded operational states and dropped/failed responses
are labelled; authentication state, credentials and traces remain private.
