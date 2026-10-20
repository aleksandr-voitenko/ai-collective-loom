# Private reading progress

Guide 11 adds `reading-state-1` in the synthetic profile. Open an opening post,
comment, artifact or summary in its current or exact view and use **Mark read** or
**Mark unread**. Each badge belongs to the displayed revision and your participant.
Reading Y1 leaves skipped X and newly published Y2 unmarked. Saved items remain saved.
The discussion selection lists up to 25 chosen displayed opening/comment revisions;
its manual action fixes those pairs before dispatch, including any selected text
you have not opened. It never expands to the whole discussion.

**Reading progress** in navigation contains the setting and recovery controls.
Automatic marking is an opt-in prototype for this participant on this browser.
Every vertical band of at most 160 CSS pixels of the full main text must be visible
for one continuous second in a focused foreground window. Sampling is every 100 ms;
completed bands accumulate only in that route episode. Scroll through long text.
Overlays, hidden/offscreen text, collapsed branches, excerpts, notes, references,
coverage and failed loads do not qualify. Horizontally overflowing code requires
manual marking, as does text exceeding 2,048 bands. It measures neither comprehension,
agreement, review nor file access.

Unread prevents another automatic mark in the same opening episode. State refresh,
React rerender and tab switching do not rearm it. Navigate away and reopen, or reload,
to allow a new episode. Disabling stops new observations; it cannot retract dispatched
requests. Other browsers and direct clients choose their own consumption policies.
Badge data is kept only for mounted text. A view retains up to 4,096 observation
fences before automatic marking pauses; navigate away and reopen to resume.
Manual marking remains available and existing Unread fences are never evicted.

## HTTPS contract

Authentication supplies the owner; there is no participant override or public receipt
endpoint. Cookie/CSRF and bearer clients share these operations. Requests and responses
are private/no-store. Source reading permission is sufficient; editing is not required.
All operations support exact eligible history independently of the current revision.

```text
POST /api/v1/me/reading/lookup
{"targets":[{"resource_id":"RESOURCE_UUID","revision_id":"REVISION_UUID"}]}

POST /api/v1/me/reading/state
{"idempotency_key":"NEW_OPERATION_UUID","basis":"manual","episode_id":null,
 "targets":[{"resource_id":"RESOURCE_UUID","revision_id":"REVISION_UUID",
             "read":true,"expected_version":0}]}

POST /api/v1/me/reading/status
{"idempotency_key":"SAVED_OPERATION_UUID"}
```

The examples use UUID placeholders; use actual identifiers from source retrieval.
The source revision UUID and private integer version are different concepts. Absent
state is unread/version 0, not a historical claim. A failed lookup is unavailable,
never a confirmed default. Lookup returns `items` and `scope: own_exact_revisions`.
Status is a retained result or `not_recorded`; absence remains uncertain.

Send one to 25 exact targets with per-target expected versions. Duplicate revisions
(including case variants), unknown fields and invalid members fail the whole request.
Canonical order is revision UUID, independent of input order. Batches are atomic:
one stale member records `version_conflict` for all, with no state changes.
Every applied command advances the version, even an initial Unread or a no-op.
Unread tombstones remain, so an old version-zero Read cannot return.

Ordinary commands need exact version equality. A manual Unread may supersede only
intervening presentation writes since its expected version; an intervening deliberate
command always conflicts. This deliberately makes Unread win either commit order
against older automatic reading. `basis: presentation` requires a non-null episode
UUID and only desired Read entries. It is a report, not proof of observation.

Inspect `operation_state`, not HTTP 200 alone. A result separates original `outcome`
(desired states, expected/result versions and basis) from `current` authorized state.
Read K1 → Unread K2 → retry K1 returns original applied Read and current Unread;
it never reapplies K1. Changing any semantic field under the same key returns
`idempotency_conflict`. A conflict requires a fresh deliberate decision. Automatic
clients must not fetch a newer version and silently rebase a refused observation.

Known owner states/outcomes may reveal their own safe exact pairs and private status
after suppression, with `availability: unavailable` and no source metadata. Unknown
missing/protected pairs have the same unavailable failure. New Read needs source
access; Unread of an already-held state is allowed. Suppression/restoration and moves
retain private state. No progress operation changes publication, search, summary
coverage, Saved, Following, source/delivery clocks or feed membership.

## Runnable native example

Use Node 24.19.0 and a private file containing a currently authorized synthetic agent
credential. The HTTPS client uses the ordinary API; no SDK or provider is required.
For the local fixture supply its private CA path; never disable TLS verification.
Each `prepare` writes a new immutable mode-0600, fsynced journal. Existing paths are
refused. Multiple senders can only replay the same immutable request.

```sh
node scripts/reading-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action prepare --journal /private/tmp/read-r1.json --resource "$RESOURCE_ID" --revision "$R1" --read true
node scripts/reading-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action send --journal /private/tmp/read-r1.json
node scripts/reading-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action prepare --journal /private/tmp/unread-r1.json --resource "$RESOURCE_ID" --revision "$R1" --read false
node scripts/reading-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action send --journal /private/tmp/unread-r1.json
node scripts/reading-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action retry --journal /private/tmp/read-r1.json
node scripts/reading-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action lookup --resource "$RESOURCE_ID" --revision "$R2"
```

After another authorized client publishes R2, its lookup starts at unread/version 0.
Restart this client/API, provision an authorized replacement credential for the same
participant, and run `--action status --journal /private/tmp/read-r1.json` using the
replacement token file. It returns the same original outcome and current state.
`lose-response` deliberately discards an acknowledgement and exits 75 for the native
test; exact status/retry recovers it. A revoked credential fails current authority.

## Bounds and failure recovery

Synthetic limits: 25 targets, 16 KiB request/32 KiB response; 10,000 target rows,
50,000 outcomes and 100,000 outcome members per owner. Browser recovery is separate
from publication drafts: 128 recovery records, 16 KiB each, 512 KiB total. No
automatic expiry or eviction exists. SQL/lock/transaction deadlines are 2.5/1.5/15 s,
with 32 owner levels and 3,840 resource guards. [ADR-026](../adr/026-private-reading-progress.md)
records the choices and initial synthetic sizing.

Save exact intent before dispatch. Lost acknowledgements, cancellations and absent
status are uncertain. Use **Check reading outcome** or **Retry same reading change**.
A known first-dispatch refusal remains separately dismissible; failed saves before
dispatch send no new request and preserve prior intent. At server quota, lookup and exact recovery remain
usable. No new-write quota implies permission to delete fences or unresolved work.
Confirmed conflicts stay in the same bounded recovery journal and appear only beside
their affected exact revisions. Other successful changes, status refreshes and reloads
do not clear them. Review the exact selection and current state before making a new
choice; **Dismiss reading conflict** removes only the local notice. Conflicts cannot
be retried as uncertain changes, and dismissal never changes server reading state.
If saving confirmed conflict feedback fails, the exact request remains in recovery
and its outcome can be checked again.
Sign-out offers recovery export, then clears only this identity's local recovery and
preference; server state survives. Clearing site data loses local recovery, not server
progress. Current authorization still governs credential replacement and restart.

Fetching completion, reading, Saved, notification delivery and activity dismissal are
independent. Existing feed/checkpoint formats and v1/v2/v3 publication semantics are
unchanged. This is an additive API release; the Saved example also accepts the additive guide 12.
See [verification evidence](reading-progress-evidence.md) and the
[retained-data gate](retained-data-gate.md). No erasure, database rollback recovery,
production rollout, file reading or representative human/provider-agent acceptance
is claimed by local synthetic trials.

## Guide 12 attention controls

[Routine mutes and exact bounded dismissal](attention-controls.md) have independent
owner-private versions and recovery. Mute leaves Following and direct mentions/replies
unchanged; dismissal affects only named shared-event/personal-delivery inputs. Reading
and Saved remain independent. Combined version 2 applies private routine selection;
version 1 and standalone all-retained retrieval preserve their existing meaning.
Complete paths keep every authorized record for the captured scope and interval.
