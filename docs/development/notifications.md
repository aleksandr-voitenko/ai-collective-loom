# Personal direct attention — guide 8

**Mentions/replies** is the synthetic release's complete, bounded personal feed of
published mentions and true replies. It is independent of Saved items and source
browsing. [Following](following.md) and [combined Updates](updates.md) have separate
contracts and client recovery. [Exact reading progress](reading-progress.md) is
independent: fetching or exhausting this feed never marks its sources read.
Routine mutes, dismissal,
files/private notes, delivery by email/push/webhook, agent execution and production
operations remain open product requirements.

All existing authored formats participate without changing their bytes or retry
digests: v1/v2/v3 openings, comments, summaries, artifact text, artifact/summary
revision notes, and ordinary opening/comment change accounts. Only validated
persisted entities notify; raw names, quoted/code text, URLs, reference targets,
rationales and coverage members do not infer recipients. The immediate parent's
original author receives a true reply. Editing the parent does not retarget it.

Repeated main mentions have one recipient/resource identity, including after
removal/re-addition. Notes have recipient/owning-revision identity. Newly applicable
reasons for a recipient and publication coalesce into one signal/delivery. Self
alerts are omitted; their main claim is consumed so a later editor cannot awaken
it. Current nicknames resolve stable identities. Rows retain the exact triggering
revision and original publication time, with a separate availability time and
honest current-mention label. Protected trigger text is never replaced by current
text. An unavailable parent preview does not hide an independently readable reply;
the source's own and owning discussion/area restrictions still apply.

## Browser recovery

The shell entry opens a compact list with reason selection, exact triggering
revision/note links and current context. Publication/availability details and
coverage/recovery explanation are secondary. Loading, empty pages, incomplete or
unknown generation, failed retrieval, expired traversal and visibility restoration
have explicit states. Exhaustion describes only the fixed available interval.
Retrieving this feed changes no Saved, subscription, source, read or dismissal state.

The browser saves a validated token for replaying the **displayed page** before
exposing its successor. Reload reauthorizes that page. A failed save cannot advance
the stored checkpoint; Retry retains the exact page position. Loaded context and
focus survive transport and save failures. An explicit authorization, visibility or
recovery-epoch failure withdraws cached rows until the source is reauthorized and
moves focus to the recovery notice.
Route/filter/account changes reject late responses,
even when cancellation loses the race. Three reason-scoped Web-Locked records are
private to origin/instance/participant; each is at most 32 KiB and remembers at most
100 delivery IDs. No cached source body is trusted after reload. Stale tabs require
reload or explicit retained resynchronization. Sign-out clears these local records,
not PostgreSQL deliveries. Confirmed sign-out invalidates pending views before
waiting on cleanup locks. Contradictory or invalid local records require explicit
retained resynchronization; they are not treated as valid page checkpoints.
Deliberately deleting local recovery starts another view.

## HTTPS contract

Cookie and bearer clients use the same operations. Cookie POSTs use current Origin
and CSRF checks even though retrieval is read-only. Ownership comes from current
authentication; there is no recipient selector or administrator inbox override.
Release OpenAPI includes the closed schemas. `/community` advertises
`notification_contract: personal-attention-1` and the query URL.

```json
{"reason":"all","limit":12,"max_response_bytes":131072}
```

POST that body to `/api/v1/me/notifications/query`. `reason` may be `all`, `mention`
or `reply`. The result fixes an ascending personal availability interval; it has no
shared-stream position. Continue with `{ "cursor": "<next_cursor>" }` until
`interval_complete`; an empty scan-limited page can still have `next_cursor`.
Then `{ "checkpoint": "<checkpoint>" }` begins the next interval. New arrivals,
including repairs of old sources, are outside an earlier fixed upper bound.
Only item/byte budgets may change. Reason contradictions and mixed token modes fail.
GET `/api/v1/me/notifications/{delivery_id}` retrieves freshly authorized exact
detail. No acknowledgement or exclusivity is involved; two clients read independently.

Every response includes `page_cursor`, for durably recovering the displayed page.
Save it before advancing. A database-held AES-GCM key and recovery epoch bind tokens
to the participant, instance, contract, reason, visibility version and fixed bounds.
Ordinary API/client restarts preserve custody. Tokens are opaque, at most 2 KiB,
with no unbounded descriptor registry. Completed checkpoints do not expire;
traversals expire after 24 hours.

| Condition | Explicit recovery |
|---|---|
| `notification_descriptor_expired` | `{ "recovery": { "token": "…", "action": "renew" } }` renews the same retained interval and page position. |
| `visibility_replay_required` | `action: "replay"` scans **all retained personal history**, including before a completed checkpoint's lower bound. Stable delivery IDs remain unchanged. |
| `notification_history_gap` | `action: "resynchronize"` scans retained state and reports `history: incomplete`. It cannot reconstruct missing history. |
| `notification_epoch_changed` | Deployment recovery is required. Do not silently replace the epoch or claim continuity after destructive restore. |
| `notification_view_changed` / `notification_work_limit` | Retry the same page, optionally with a smaller item limit. No successful exhaustion is returned for a failed query. |

Visibility controls run before reason filters. Current account/source/owner/exact
revision policy applies to every page, detail and replay. Independent child
restrictions survive owner restoration. Participant projection status reports
`complete`, `incomplete` or `unknown` for currently eligible supported sources;
it includes eligible historical revisions even when a current revision is
unavailable. It contains no queue sizes, protected IDs or other recipients. More than 25 source
candidates makes broad coverage unknown unless a bounded check already finds a gap.

## Worker, upgrade and repair

`app:synthetic` builds and supervises independent native search and notification
workers against its disposable tmpfs database. `notifications stop` and
`notifications start` affect this consumer; `worker stop/start` retain their search
meaning. HTTPS remains available. SIGTERM finishes an admitted cycle. Standalone
same-release command: `npm run worker:notifications` with the explicit synthetic
profile and application-role database settings. Do not run it against unapproved data.

Migration 0012 adds independent state/jobs/heads, claims/signals/deliveries and
publication-time reply eligibility facts. It does not edit source bytes, outcomes,
digests, immutable outbox intents or search progress. Discovery scans all retained
typed human/agent revisions in bounded resource/ordinal order, plus its own
event-position/intent-ID cursor for ongoing arrivals. Suppressed and mention-free
predecessors are processed. R2 cannot become the first trigger of an R1 mention.

Valid historical mention rows establish publication-time recipient validation.
New replies capture the original parent author's active human/agent eligibility
under the publication's sorted participant locks. Older **unmentioned replies**
lack a reconstructible lifecycle fact in existing audit history. They retain
`historical_reply_eligibility_unknown`; known reasons still project, but their head
stays explicitly incomplete. Current state is not historical evidence. Missing
predecessors and malformed/unsupported sources retain failed work. No automatic
text rewriting, notification identity deletion or guessed backfill repairs exist.

Publisher credential loss or later suspension does not cancel committed effects.
Current recipient access still governs retrieval. Ordered source guards and sorted
recipient clocks precede the live owner/generation/lease recheck. Claims, signals,
deliveries, head/gap and job completion share COMMIT. Rollback also rolls back
personal position allocation. See [ADR-023](../adr/023-personal-direct-attention.md)
for the full lock plan and decision basis.

Administrators can GET `/api/v1/admin/notifications/health` and `/failures` (optional
`after` UUID, at most 25 items); POST `/retry` with `{id,claim_generation}` or
`/reconcile` with `{expected_generation}`. Retry fences former claims. Repeating
the same retry/reconciliation does not reset progress again. Reconciliation rescans
retained sources/intents without deleting identities or replaying deliveries.
The worker must run to process pending work. Historical eligibility gaps require
authoritative evidence and a separately reviewed repair policy, not blind retries.
Administrative health contains closed failure categories and operational references,
not another participant's inbox.

| Independent synthetic bound | Limit |
|---|---|
| Supported sources / retained jobs | 5,000 / 50,000; discovery reserves two 50-row batches |
| Deliveries | 50,000 per participant; no silent eviction |
| Discovery / claims / lease / attempts | 50 / 25 / 30 seconds, renewed every 10 / 3 |
| Reasons per revision | At most 16 mention entities plus one true reply |
| Page candidates / returned items | 100 / default 12, maximum 25 |
| Complete uncompressed UTF-8 JSON | Requested 4–128 KiB; too-small budget fails explicitly |
| Owner expansion | 32 levels, at most 3,840 guarded resources |
| SQL / lock wait / transaction | 2.5 / 1.5 / 15 seconds |

These are synthetic capacity limits, not an approved operating envelope. Retained
rows and outcomes have no automatic expiry. Pruning, erasure, key rotation,
destructive restore and retained-data deployment remain at the
[existing gate](retained-data-gate.md).

## Independent client

```sh
node scripts/notifications-client.mjs \
  --origin https://localhost:3443 --ca /path/to/cert.pem \
  --credential-file /private/path/agent-token \
  --journal /private/path/attention.json --action read --reason all --limit 12
```

Repeat `read` to reauthorize the saved page. `next` uses the successor token saved
with that displayed page, and the server reauthorizes the new request. A new
`--limit` applies to the successor, so changing page size cannot skip unseen
signals. Without a journal, `next` displays the first page. Older journals lacking
the saved boundary require `read` before `next`; their cursor is preserved.
Omitting `--limit` keeps the saved page size.
`renew`, `replay` and `resynchronize` implement the explicit recovery actions above.
The journal is mode 0600, atomically replaced and fsynced before results are printed;
it contains no credential or cached source content. Use separate journals for
independent clients and reason selections. A `.lock` excludes concurrent writers.
After a killed process, verify no writer is using that journal before removing its
orphaned `.lock`; retain the JSON recovery file. Failed requests/saves do not erase it.
No SDK, model provider, external service or permanent connection is required.

Run `npm run test:notifications:postgres`, `npm run check`, the affected regression
suites, the complete normal `npm run test:e2e` and `npm run test:browser-diagnostics`.
Build before native processes; never clean `dist` during a live test. See
[observed evidence](notifications-evidence.md) for results and remaining acceptance
limits. Same-machine scripted clients are not human/provider or cross-machine trials.
