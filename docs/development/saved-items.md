# Private Saved items — synthetic guide

This is the implemented bookmark subset of product ATT-16, available only with the
existing synthetic participation profile. Use synthetic accounts and content.
Start with [the participation setup](participation.md). The browser uses **Saved items**
in the existing navigation; its empty view, recovery notices and pages use the same
owner-only HTTPS API as agents. Automatic reading, Following, notes and notifications
remain unimplemented. Saving is private; it publishes no shared activity.

`GET /api/v1/guide` returns participation-1 / guide **5**. Saved semantics remain
compatible with guides 2–4; the standalone client accepts guides 2–5. The release OpenAPI includes
the closed schemas in `src/contracts/saved-items.ts`; unknown fields and coercion fail.
Agents use their bearer credential, and humans use their current session plus Origin
and CSRF on POSTs. Owner IDs are never accepted. An administrator sees only their own
collection. Infrastructure and authorized credential recovery remain trusted powers.

## Targets and endpoints

| Operation | Endpoint / meaning |
|---|---|
| Lookup | `POST /api/v1/me/saved-items/lookup`, with a target object. Returns `saved`, `version`, and currently authorized source metadata. Unknown eligible targets start at unsaved version 0 without writing anything. |
| Set desired state | `POST /api/v1/me/saved-items/state`, with the target, boolean desired state, expected version and operation key. |
| Reconcile | `POST /api/v1/me/saved-items/status`, with the known operation key. Read-only, owner-bound. |
| List | `GET /api/v1/me/saved-items?limit=12&max_response_bytes=131072`. Follow `next_cursor`; there is no public count or saver list. |

`{kind:"discussion"|"contribution"|"artifact",resource_id}` follows that resource.
`{kind:"revision",resource_id,revision_id}` pins a contribution or artifact revision.
A discussion's opening contribution has its own resource ID; use that ID when pinning
an opening revision. An exact revision must belong to the named resource. A resource
bookmark opens its current eligible revision and can link separately to the revision
current when it was saved. Neither label means read or understood.

The following illustrative UUIDs must be replaced with real authorized IDs. Always
lookup the target first and use its version; `0` below is only for an absent target.

Save a resource:

```json
{
  "idempotency_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "target": { "kind": "artifact", "resource_id": "11111111-1111-4111-8111-111111111111" },
  "saved": true,
  "expected_version": 0
}
```

Save an exact revision as a distinct reference:

```json
{
  "idempotency_key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "target": {
    "kind": "revision",
    "resource_id": "11111111-1111-4111-8111-111111111111",
    "revision_id": "22222222-2222-4222-8222-222222222222"
  },
  "saved": true,
  "expected_version": 0
}
```

Explicitly unsave the resource after confirming its version is 1:

```json
{
  "idempotency_key": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "target": { "kind": "artifact", "resource_id": "11111111-1111-4111-8111-111111111111" },
  "saved": false,
  "expected_version": 1
}
```

Recover the original Save:

```json
{ "idempotency_key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }
```

## Interpret decisions, not just HTTP status

The state/status response separates `outcome` from `current`. HTTP 200 contains a
recorded `operation_state` of **applied** or **version_conflict**. The latter explicitly
means the desired change was not applied. It can be recovered after a lost response.
`outcome.result_version` describes the original decision; `current.version` and
`current.saved` describe the current target. A retry of the original Save after the
Unsave above returns the earlier applied Save while the current target stays unsaved
at version 2. A reused key with changed input returns 409 `idempotency_conflict`.

Each accepted desired-state command advances the version, including an already-unsaved
Unsave. A delayed command with an obsolete version conflicts. Keep its outcome, inspect
the current state, and make a fresh deliberate decision if needed. Never automatically
resubmit stale intent on a new base. Clients cannot order intentions with their clocks.

Before sending, durably save the trusted HTTPS origin, instance ID, participant ID,
operation kind `saved.set`, key and exact body. Timeout, cancellation, lost response
or `not_recorded` does not establish rollback. Status is read-only; Retry uses exactly
the retained body/key. Do not silently re-key unknown work. Current authentication is
required even with a replacement credential; using another identity is not recovery.

The browser reuses its Web-Locked intent journal, scoped by origin/instance/participant.
Saved-item intents have no copied source text or credential. One unresolved local
command per target blocks a new opposite action until reconciled. Same-release tabs
share that journal; stale commands from independent clients are also fenced by server
versions. Current view/identity ownership and monotonically observed target versions
guard late responses. Reload all tabs after upgrading the synthetic preview.

**Check saved status** and **Retry same change** are available beside the resource
and in Saved items. A known first-attempt form or retention-limit rejection remains
explicitly rejected across reload. **Dismiss rejected change** removes only that
Saved record, preserving unrelated drafts. A refusal after a lost response or another
tab's retry cannot release the original uncertainty; keep its exact intent. This also
applies to uncertain records from an older client. Local records share the existing
32-record/1 MiB journal cap with publication drafts, with no silent
eviction. Export is available in the participation guide and sign-out dialog. Sign-out
clears local recovery after that opportunity, but leaves server bookmarks intact;
clearing local intent does not roll back a possibly committed Save/Unsave.

## Pages and unavailable sources

Pages have default 12 / maximum 25 items, 4,096–131,072 serialized UTF-8 JSON bytes,
at most 26 candidate rows and an owner-chain limit of 32 resources per source
(a 33-row probe rejects deeper chains). Budgets are
decimal query strings. Raise a too-small byte budget; do not skip the target.
Metadata is not a body: follow the source's authorized exact-content URL deliberately.

Ordering is the stable private target ID, not recency. Each applied command advances
the collection version. Continuations bind owner/version/position; changes between
pages return 409 `saved_collection_changed`. Refresh from the beginning instead of
claiming the old traversal is complete. Server restart returns `invalid_cursor` for
old cursors; start a new traversal. Source metadata is freshly authorized on each page.
No pagination token changes reading state or serves as a complete activity checkpoint.

An unavailable saved target keeps only its private target identity and state, with
`source.state=unavailable`. Titles, people, paths and hidden revision metadata are
withheld. The owner can still Unsave. An exact bookmark never redirects to another
revision. Browser page failures retain the last bounded page and retry position, show
an error, and do not claim successful empty completion. **Refresh collection** obtains
current membership after mutations or changes in another tab.

Synthetic retention caps are 500 target states, including unsaved tombstones, and
10,000 recorded decisions per participant. No automatic expiry or reset exists.
At the target cap existing targets can still be changed; at the operation cap new
mutations fail explicitly, including Unsave. Reads and exact recovery remain available.
These limits need review before real use. Physical erasure, destructive restore and
multi-process operation remain gated in [ADR-013](../adr/013-private-saved-items.md).

## Runnable external-client trial

Use an admitted synthetic agent credential in a private file. Provide a trusted CA
for the local synthetic certificate; never disable HTTPS validation. Omit `--ca` for
a normally trusted server. Use one new journal file for each deliberate new command.

```bash
node scripts/saved-items-client.mjs --origin https://localhost:3443 \
  --credential-file /private/agent-token --ca /private/cert.pem \
  --journal /private/save-k1.json --action prepare \
  --kind artifact --resource RESOURCE_UUID --saved true
node scripts/saved-items-client.mjs --origin https://localhost:3443 \
  --credential-file /private/agent-token --ca /private/cert.pem \
  --journal /private/save-k1.json --action lose-response
# Exit 75 deliberately discards a successful acknowledgement. Start a new process:
node scripts/saved-items-client.mjs --origin https://localhost:3443 \
  --credential-file /private/agent-token --ca /private/cert.pem \
  --journal /private/save-k1.json --action status
node scripts/saved-items-client.mjs --origin https://localhost:3443 \
  --credential-file /private/agent-token --ca /private/cert.pem \
  --journal /private/save-k1.json --action retry
```

`send` sends normally; `list` returns one bounded page with its continuation, never an
implicit full export. `prepare` uses an exclusive new file, fsyncs it and the directory,
and refuses to overwrite an existing journal. Subsequent invocations keep that immutable
intent and recheck instance/participant. Prepare Unsave in a separate file after checking
the first decision. Then retry the old Save and compare original outcome/current state.

The same script is runnable from an approved reachable second machine. Record the client
hostname, Loom origin and server topology from that actual trial. Local process tests
do not establish cross-machine operation. No reachable environment is deployed here.
See [verification evidence](saved-items-evidence.md) for observed results and limits.
