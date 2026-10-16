# Discussion summaries in synthetic participation

Contract `participation-1`, guide 7 adds optional authored discussion summaries.
[ADR-010](../adr/010-discussion-summary-coverage.md) records the decisions;
[verification](discussion-summaries-evidence.md) distinguishes executed checks from
remaining acceptance work. Product v0.9 and imported architecture/UI baselines
remain unchanged. Use synthetic accounts and content.

## Browser journey

Open a discussion's **Summary** section. Absence, unavailability and a failed lookup
are separate states; ordinary reading and replies remain available. **Create first
summary** opens the existing durable composer. Any currently eligible contributor
can win first creation; the winner becomes an editor. Discussion authorship alone
does not grant later editing. A competing creator receives an explicit refusal
and can inspect the discussion's canonical summary.
Successful creation refreshes the Summary section in place with the canonical link;
reading and replying stay on the same discussion.

Write the title/text, mentions and recorded references. **Prepare declared sources**
captures eligible opening/comment revisions at one database boundary. Full scope
is limited to 100 candidates; it never silently truncates. Choose **Explicit
selection (partial)** to include selected exact revisions instead. Inspect the
source list and follow exact/context links. Fetching and preparation publish nothing
and do not mark anything read. Coverage is an author's claim, not proof of reading
or correctness.

Publication durably saves text, title, mentions, references, declaration, expected
base and key before dispatch. The source set stays fixed when contributions arrive
or change. A new comment is uncovered; an eligible covered R1 with current R2 is
changed, including a reference-only edit. Linked artifact updates do not retarget
their exact references or independently change this discussion's coverage.

Open the summary for exact/current text, history, editors, compact coverage and
bounded declared/current source expansion. Full/partial, uncovered, changed and
unknown may coexist. Unknown never means zero. Protected members do not expose IDs,
previews or totals through either detail or dedicated coverage routes. Suppressing
a source leaves independent summary prose readable under the summary's own context.
Summary/discussion/exact-revision suppression governs its own reads and derivatives.

**Summary maintenance** filters uncovered, changed, partial, unknown or no active
editor; add caller editability or current topic/descendant scope. Pages scan at
most ten summaries, return five, and can be empty but incomplete. Administrators
can edit an abandoned summary without erasing its no-active-editor condition.
An external account named archivist has ordinary permissions. Only administrators
manage the explicit editor list; reassignment changes neither authorship nor
coverage. The browser retains an uncertain editor command for exact retry.

Updating can keep the immediate base's complete declaration unchanged, even when
some old members become unavailable, or explicitly replace it with a fresh prepared
set. New membership and new references require current eligibility. Coverage-only
revisions are explicit publications with normal attribution. No automatic refresh
or timestamp bump occurs. A conflict requires inspecting the comparison revision;
correction creates a saved new draft and requires an explicit declaration, never
automatically selecting later sources. The older-format correction preserves the
comparison revision's recorded references. Failed comparison/save, reload, stale
tabs, account/route changes and lost acknowledgements preserve the original request.

After a confirmed update, **Start another revision** loads the current summary,
including its title, text, mentions and references, into a new saved draft. It keeps
that revision's source declaration unchanged until you explicitly prepare another
set. The new draft has a new request key and current expected base, and survives
reload. A failed current-revision fetch or local save leaves the completed request
intact so you can retry the action.

## HTTP contract

The release-matched OpenAPI is `GET /api/v1/openapi.json`; executable closed schemas
are in `src/contracts/summaries.ts`. UUID examples below are placeholders.

| Operation | Route and important fields |
|---|---|
| Lookup optional canonical summary | `GET /api/v1/discussions/{discussion}/summary` |
| Prepare full source set | `POST /api/v1/summary-preparations`: `idempotency_key`, `discussion_id`, `scope: "full"` |
| Prepare partial set | Same route with `scope: "selected"`, `members: [{contribution_id, revision_id}]` |
| Inspect private preparation | `GET /api/v1/summary-preparations/{id}` and `/members` |
| Browse current sources for selection | `GET /api/v1/discussions/{id}/summary-sources` |
| Create first summary | `POST /api/v1/summaries`: key, discussion, title, content, `coverage: {preparation_id}` |
| Revise summary | `POST /api/v1/summary-revisions`: key, resource, expected revision, title, content, coverage |
| Keep exact base declaration | Revision coverage may be `{carry_forward_revision_id: expected_revision_id}` |
| Reconcile publication | `POST /api/v1/summaries/status`: `operation_kind: "summary.create"` or `"summary.revise"`, key |
| Compare and inspect coverage | `GET /api/v1/summaries/{id}/revisions/{revision}/coverage`, `/members`, `/sources` |
| Discover maintenance | `GET /api/v1/summaries/maintenance`: optional `filter`, `editable`, `topic`, `descendants` |
| Administrator reassignment | `POST /api/v1/summaries/editors`: key, resource, `expected_version`, `participant_ids` |
| Clean expired private members | `POST /api/v1/summary-preparations/cleanup` with `{}` |

Ordinary resource exact/history/editor reads are reused. References accept
`kind: "summary"` as source or resource/exact target and preserve the existing
assertion/withdrawal rules. Coverage creates no typed assertion or notification.
Search includes eligible current summary title/body with summary identity, exact
revision, original author/publisher and discussion-derived current placement.
Source bodies are never indexed as summary prose. Direct reads, comparison and
maintenance work with indexing stopped. Saved summary targets are explicitly
unsupported; no artifact/contribution target is fabricated.

## Bounds and recovery

| Boundary | Synthetic contract |
|---|---|
| Preparation population | 100 candidates for full scope; 100 exact selected members |
| Preparation retention | 24 hours; 8 active/128 retained headers per owner; 8,192 headers total |
| Cleanup | Caller-owned, at most 800 expired member rows; header tombstones remain |
| Published membership | Immutable revision-owned copy, independent of cleanup/expiry |
| Comparison | At most 100 current candidates; otherwise null counts and explicit work-limited/unknown |
| Source pages | Scan 100; default 12/max 25 returned metadata entries |
| Maintenance | Scan 10 canonical summaries/max 5 returned; each source set bounded separately |
| Authorization expansion | At most 3,840 resource guards; owning chains at most 32 |
| Response | Complete serialized UTF-8 JSON, 4–128 KiB; no source bodies in member/maintenance pages |
| Statement deadline | 2.5 seconds; error instead of successful empty result |
| Continuation | AES-GCM, at most 2 KiB, five minutes, caller/selection/boundary-bound |

Only `limit` and `max_response_bytes` may change while continuing. Source content,
visibility, placement, editor/account state, expiry or API restart requires refresh
on `summary_changed`. No transaction spans requests. Unpublished handles persist
across ordinary restarts but never reserve authority. Exact preparation retry uses
its original set; changed fields under its key conflict. Retained capacity requires
review, not automatic eviction of old retry identities.

Exact successful publication retry resolves its retained outcome before handle
expiry. For an unpublished expired set, the server serializes the exact attempt,
checks for prior success, and commits an irreversible expiry tombstone. Only the
resulting `summary_preparation_expired` with `operation_outcome: "rejected"` permits
explicit correction of an uncertain attempt. A lost refusal acknowledgement is
still uncertain. Read-only `not_recorded` is never permission to replace a request.
The browser preserves authored fields and asks for an explicit declaration in the
new draft. A backwards clock cannot revive the original source set.

## Standalone HTTPS trial

`scripts/summary-client.mjs` uses an admitted synthetic agent, exact HTTPS origin,
credential file, optional private CA and an fsynced journal. Input JSON contains
`discussion_id`, `title`, complete `content`, and `sources: {scope: "full"}` or an
explicit selected set. To update, also supply `resource_id` and
`expected_revision_id`. Each command is a fresh process; credentials never enter
the journal. Preparation saves its request before HTTP and never silently reselects.

```bash
node scripts/summary-client.mjs --origin https://localhost:3443 \
  --credential-file /private/agent-token --ca /private/ca.pem \
  --journal /private/summary-intent.json --input /private/summary-input.json \
  --action prepare
```

Use the same paths with `inspect`, `send`, `status`, or `retry`. `lose-response`
deliberately discards a received publication acknowledgement (exit 75); a later
process reconciles or retries the unchanged body. `inspect` traverses at most four
25-member pages and retrieves each eligible exact body. No required model runtime,
inference or autonomous assignment is involved. Same-machine execution does not
establish a provider-agent or cross-machine trial.

Build first, then run `npm run test:summaries:postgres`, the existing affected
PostgreSQL suites, `npm run check`, normal `npm run test:e2e`, and
`npm run test:browser-diagnostics`. CI includes the new suite without relaxing the
normal browser settings or diagnostic bounds. Notification delivery, Updates integration,
notifications, files, reservations, full moderation UI, production capacity and
real-data recovery remain separate.

## Authored change explanations

Guide 7 adds an optional revision-owned note through v3 main content and explicit
change_note/change_account fields; summary requests then use discussion-summary-v2.
Summary source coverage is still independently required. Note-only summary updates
are excluded from their own source population; ordinary v3 change-account comments
are eligible new/revised sources. Existing v1 summary requests/preparations replay
unchanged.
See the [change notes guide](change-notes.md) for complete requests and bounds.
