# Routine attention controls

Guide 12 adds owner-private **Mute routine updates**, exact activity dismissal and
restoration in the synthetic text profile. The decision is
[ADR-027](../adr/027-routine-attention-controls.md); execution evidence is in
[the attention verification report](attention-controls-evidence.md).

## Browser use

Open **Attention controls** on an Updates card, or the mute controls alongside
Following. Areas have an explicit **Mute descendant topics** choice. A mute lasts
until Unmute, retains Following, and never suppresses direct mentions/replies.
Overlapping parent/child/resource choices remain independent. The control explains
other mutes in the current scope; historical events use their retained event-time
scope and structural impacts. Moving or renaming a target does not change its ID.
Private lookup and confirmation are separate from source previews. Source access
refusals withdraw the protected host, including enclosing text and expanded metadata;
Retry checks access again. Following and attention settings retain safe private
choices, removal controls and confirmation. Status and exact retries do not need
metadata hydration. Credential refusals still clear the private view and make the
shell check identity again; saved same-participant commands remain recoverable.

Protected metadata is requested explicitly in bounded batches. A refusal can arrive
from a request started before an earlier withdrawal or restoration; it still clears
older protected projections for that browser identity. This conservative rule may
require an unnecessary refresh even for apparently unrelated sources. A pending private page or recovery control does
not automatically start metadata reads after withdrawal. Fixed traversal positions
and saved commands remain independent of this display state.
A cached path cannot establish current authorization after a move or a reordered
response. Settled previews receive the same withdrawal as pending reads and full
content hosts. Private lookups and receipts do not supply source authority; use an
explicit source refresh to recheck metadata.
A fresh successful mixed response may display its own authorized fields while
older content stays withdrawn. Saved uses this exception to retain readable rows
beside unavailable references, with Unsave available for both. The exception requires
separate rendering leases; it cannot restore enclosing cached text or another
pending response. Full content hosts retain whole-view withdrawal when they cannot
isolate the fresh response. A later denial invalidates the fresh fields again.
Missing current/exact revisions leave independently authorized revision history
discoverable. The server distinguishes those misses only after checking the
resource and its owners, using optional `unavailable_scope: revision` on the
existing `404 unavailable` error. Source and history access denials still withdraw
protected views; an unclassified error cannot exempt them. No command bytes or
saved recovery semantics change.

The same withdrawal rule applies to nested replies and reference, summary-source,
change, search and organization reads. A source refusal during selection can require
Retry for the whole view. Saved drafts and exact private commands remain recoverable.
Browser components must use the boundary's protected-read API; session and command
entry points reject protected endpoints, and the application checks enforce the
transport import boundary.
Every endpoint's successful source observations are classified centrally by method
and path. An unavailable source in a successful Saved/Reading receipt revokes
content before the private decision settles. Missing revision hints are accepted
only on guarded revision endpoints. New endpoints or negative success fields must
update the classification catalogue and its server-schema coverage test.
Endpoint error policies distinguish anonymous session discovery and separate
registration/sign-in proofs from authority revocation. An anonymous probe settles
without restarting the shell; loss of an established session still withdraws all
protected views and fences pending responses. Missing identity records stay local,
while ambiguous source-operation failures remain conservative. Error evidence is
consumed once in transport, independently of caller liveness or optional schemas.
Ordinary posting refusals preserve the session and settle exact first-dispatch
rejections; uncertain retries keep their original bytes and uncertainty. Role/editor
refusals also preserve identity but withdraw protected content, because the same
capability can guard both commands and cached reads. Administrator draft, correction
and status controls remain available while account/credential metadata, selected
account details and one-time secret displays lose their separate content leases.
Only a current read can restore protected metadata; a private receipt cannot do so.
Delayed action callbacks and queries mounted by late recovery also wait for an
explicit refresh after withdrawal. The query hook enforces this before dispatch,
while allowing pagination from that query's fresh authorized response.

Audited discussion traversal uses separate response leases so a fresh structural
marker can remain navigable while older headers/bodies and pending pages are fenced.
A source-error response still withdraws the whole discussion. Posting closure is
separate: community/proposal-route responses certify it with optional
`unavailable_reason: publication_closed` after source checks. Without that hint,
unavailable remains conservative.

The browser uses additive `private-controls-1` projections:

- GET `/api/v1/me/following/private`; POST its `/lookup`, `/state` and `/status`.
- POST `/api/v1/me/attention/private/mutes/lookup` and `/mutes/state`;
  `/dismissals/lookup`, `/dismissals/state`, `/status` and `/list`.
- POST `/api/v1/me/attention/previews` with `{targets:[{kind,resource_id}]}`
  for1–25 distinct targets. This protected response owns titles, paths and overlap.

Private lookups for an unrecorded identity return default version0 without testing
source existence. A new Follow/Mute/dismissal still requires current eligibility.
Known safe removal and exact recovery work without source reads. Private responses
contain no source availability, titles, paths, overlap or protected counts. Existing
endpoints and command digests are unchanged; switching projection does not re-key or
reinterpret saved commands. Original and current outcomes remain distinct. The old
native example continues to exercise the legacy compatible response contract.
See the [verification report](attention-controls-evidence.md) for executed checks.

**Dismiss this update** first prepares a fixed selection and shows separate shared
event and personal signal counts, including direct sources beyond the two previews.
Inspect its exact IDs before confirming. A card over 100 inputs is refused; expand
its sources and use **Dismiss these source inputs** for an explicitly smaller set.
Later revisions and later personal deliveries cannot join the saved command.
Dismissal of shared event E before its personal delivery N exists leaves N eligible.
Continuing mentions retain their signal identity; a new revision-note signal has
its own eligibility.
Switching the card's selection cancels pending preparation and clears its
unconfirmed selection. This also applies when an expanded source changes from
Complete shared/personal inputs to a routine subset. Prepare again to review the
new selection; an already saved command retains its exact inputs. If preparation
finds a changed or unfinished attention projection, **Refresh attention selection**
recovers the displayed fixed view. An expired descriptor offers **Renew fixed
Updates view** with the original displayed page and expansion budgets.
If preparation finds inputs in an unresolved command from another traversal, the
card exposes that command's Check/Retry controls and blocks a replacement dismissal.
After exact recovery and an explicit selection refresh, any remaining inputs can
be reviewed for a new dismissal. The previous Undo receipt keeps its original
identities and versions; inspect those saved identities separately from the new selection.

Confirmation keeps the displayed card and an adjacent **Undo dismissal / restore
these inputs** action. Keyboard focus stays there without scrolling to the top.
After successful Undo, focus moves to **Dismiss this update** so another deliberate
dismissal can prepare and review current versions without reloading the card.
Undo retains the original applied versions. If another choice intervened, it
reports a conflict instead of adopting newer versions. Acknowledge that notice to
prepare another deliberate choice, or review current dismissed inputs in settings.
**Refresh attention selection** applies private choices to the same captured view.
It preserves subjects, Following definitions, personal reasons, group IDs/order,
both intervals and unknown-history qualification. **Refresh scope from retained
history** deliberately opens a fresh scope instead. Restore leaves independent
mutes intact; neither action fabricates a new publication or rewinds a checkpoint.
An older page response cannot clear an attention-change notice observed while that
request was pending. A subsequent deliberate refresh can acknowledge current choices.
A decision completing after navigation still notifies the same signed-in identity's
current view, so its stale selection offers refresh and its mute controls recheck
state. Signing out or changing identity fences that notification.

**Show all matching groups in this interval** and complete record/member retrieval
bypass attention filters, including when routine selection is empty. Routine counts
describe remaining inputs; complete counts describe all authorized represented
inputs. Source records, shared events, personal signals and groups are different
units. **Mentions/replies** remains all-retained, including dismissed signals, and
links to the explicitly filtered personal routine view. Current authorization still
applies everywhere. Unknown history, retention gaps and visibility changes take
precedence over private filtering.

**Attention settings** pages active mutes and dismissed inputs with explicit
refresh and restoration. Unavailable owner-held entries retain safe IDs/settings
without cached titles, paths or bodies. Administrators cannot select another
owner's private choices. Closed-to-contributions does not imply unreadable.

Attention viewing and actions never mark anything read or change Saved. Deliberately
opening full text afterward uses the independent opt-in
[reading policy](reading-progress.md). Dismissing a reading conflict notice, an
attention conflict notice and an activity input are three different actions.

## HTTPS and compatible release

The current authenticated participant supplies ownership. Cookie requests require
the existing origin/CSRF proof; bearer clients use current credentials. All attention
and routine endpoints are private/no-store, closed schemas with no owner override.
OpenAPI is generated from the executable schemas at `/api/v1/openapi.json`.
Community discovery adds `attention_contract: attention-controls-1`, `attention_url`,
`routine_updates_contract: combined-updates-2` and `routine_updates_url`.

| POST path under `/api/v1/me` | Body and result |
|---|---|
| `/attention/mutes/lookup` | `{kind,resource_id}` → current settings/version, eligible source and other current-scope mutes |
| `/attention/mutes/state` | `{idempotency_key,target:{kind,resource_id},include_descendants,muted,expected_version}` → original decision and current state |
| `/attention/dismissals/lookup` | `{inputs:[{kind,id}]}` → bounded current states/versions |
| `/attention/dismissals/state` | `{idempotency_key,selection?,inputs:[{kind,id,dismissed,expected_version}]}` → atomic original decision and current states |
| `/attention/status` | `{idempotency_key}` → retained decision/current state, or `not_recorded` |
| `/attention/list` | `{collection:"mutes"|"dismissals",cursor?,limit?,max_response_bytes?}` → bounded page, explicit continuation |
| `/routine-updates/selection` | `{cursor,group_id,inputs?}` → exact bounded selection, versions, shared/personal counts and expiry |
| `/routine-updates/query`, `/members`, `/reasons` | Existing frozen Updates protocol with the separate version-2 projection |

Mute kinds are `area`, `discussion`, `artifact`; descendants must be false for the
latter two. Dismissal kinds are `shared_event`, `personal_delivery`, with separate
identity spaces. Canonical UUID normalization does not permit duplicates. Unknown
fields, unsupported kinds, duplicate members and changed semantics under an old key
fail. Every accepted command/no-op/initial negative advances target versions.
An initial Unmute fences a delayed version-zero Mute. A stale member or selection
policy retains one `version_conflict` without partially changing the batch.

Selections are authenticated, encrypted, owner/instance/policy-bound envelopes
containing exact IDs/versions and the original view/group/selection meaning. They
contain no source prose and require no growing server registry. Preparation is not
a permission grant; new dismissal rechecks current source, revision and recipient
authority. Explicit subsets must belong to the represented group. Whole-card
selection never implies dismissal of unrepresented or unknown history.

`combined-updates-1` routes, saved tokens and journals retain their old meaning.
`combined-updates-2` is a separate purpose/shape, requiring new client support. The
browser offers **Open prior saved Updates views**, preserving old recovery without
silently migrating it. Standalone shared/personal and `reading-state-1` contracts,
publication formats and digests stay unchanged. No new authored format is required.

Routine pagination after a policy change returns
`updates_attention_refresh_required`; send
`{recovery:{action:"attention_refresh",token}}` to reselect that view. If the
descriptor expired, this explicit action also renews it within the existing
grouping custody deadline, so simultaneous expiry and policy changes remain
recoverable. It never extends grouping custody or renews a dismissal selection
envelope. Ordinary retrieval still refuses expired descriptors; `renew` remains
available when the attention policy is unchanged. Complete
traversal ignores private policy changes. Visibility replay, component gaps and
epoch recovery remain distinct. After a completed checkpoint, retained-history
replay can reach restored older inputs without claiming they were newly published.

Filtered `/members`, `/reasons` and `/selection` require a fully prepared attention
projection for the cursor's policy version. Base grouping alone is insufficient.
`updates_attention_preparing` (409, `refresh_attention_selection`) means continue
the bounded overview preparation or explicitly refresh the same selection; retrying
member reads cannot advance preparation. Complete retrieval stays available.

## Durable recovery and native example

Persist the complete immutable body, key and any selection before dispatch.
`HTTP 200` means `operation_state: applied|version_conflict`; `outcome` is the
original decision and `current` is separately authorized current state. Mute K1,
Unmute K2, retry K1 reports original Mute and current Unmute without applying K1
again. Restore similarly requires current versions for its named input set.

Exact retry/status resolves retained decisions before expiry, missing grouping or
quota checks. `not_recorded`, a timeout or a lost response remains uncertain; never
automatically re-key, rebase or select today's larger card. Known unavailable states
remain removable/restorable with safe identity only. Retained outcomes are not an
erasure promise. A refusal after a previously uncertain dispatch is not proof that
the original request failed.

`scripts/attention-client.mjs` is a runnable Node 24 HTTPS example with an exclusive,
mode-0600, fsynced immutable journal. Preparation reads back the saved command;
send/retry/status never replace its intent. Use synthetic credentials and absolute
private paths, never commit journals or tokens. The CA is optional for a normally
trusted certificate and required for the fixture's self-signed certificate.

```sh
node scripts/attention-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action prepare-mute --journal /private/tmp/mute.json --kind area --resource "$AREA_ID" --muted true --descendants true
node scripts/attention-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action send --journal /private/tmp/mute.json
node scripts/attention-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action status --journal /private/tmp/mute.json
node scripts/attention-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action retry --journal /private/tmp/mute.json
node scripts/attention-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action prepare-dismissal --journal /private/tmp/dismiss.json --selection-file /private/tmp/prepared-selection.json
node scripts/attention-client.mjs --origin "$LOOM_ORIGIN" --credential-file "$TOKEN_FILE" --ca "$CA_FILE" --action send --journal /private/tmp/dismiss.json
```

The selection file is the full `/routine-updates/selection` response. Alternatively,
`--inputs-file` accepts an explicit array such as
`[{"kind":"shared_event","id":"<event UUID>","dismissed":false}]` and obtains current
versions before saving a new restoration command. Each new deliberate action needs
its own unused journal file. `lose-response` sends the exact saved command, discards
the acknowledgement and exits 75 for synthetic testing. After authorized credential
replacement, point the same journal at the replacement credential file for the same
participant. Origin/instance/owner mismatch refuses dispatch; revoked authority
does not survive replacement. The example needs no SDK or browser automation.

Browser recovery is a separate origin/instance/participant journal. Web Locks guard
save/read-back, attempts and cleanup; network requests hold no storage lock. Failed
saves prevent dispatch. Per-target conflicts survive other successes and reopening
until explicitly dismissed. Sign-out fences identity before asynchronous cleanup
and offers export; server decisions survive. Explicitly deleting local data can
destroy unresolved custody, and no recovery promise extends beyond retained facts.
UUID case aliases identify the same mute target or dismissal input in local recovery,
so an older saved command remains discoverable and blocks a second uncertain choice.
Shared events and personal deliveries remain separate. Exact retries keep the saved
key and body spelling unchanged.

## Bounds and operating limits

| Unit | Synthetic limit |
|---|---|
| Active / retained mute identities per owner | 64 / 500 |
| Retained dismissal identities | 10,000 |
| Decisions / outcome members | 50,000 / 100,000 |
| Atomic command / list page | 100 inputs / 25 entries |
| Complete UTF-8 request / response | 64 KiB / 128 KiB |
| Selection envelope / validity | 32 KiB / 24 hours |
| Browser recovery | 128 records, 64 KiB each, 1 MiB total |
| Selection work | 100 existing view members per preparation request |

Existing Updates caps still apply: 2,000 members/view, 500/group, 256 groups,
16 owner views/128 global views, seven-day custody. Selection caches share that
custody; confirmed decisions do not. No existing quota is expanded. SQL/lock/whole
transaction deadlines are 2.5/1.5/15 seconds with the existing source guard bound.
No states, negative fences or decisions silently expire/evict. At quota, lookup and
exact recovery remain usable; even a new removal can require a capacity-policy
decision. An oversized first list entry returns `response_budget_too_small` without
skipping it. `attention_work_limit` permits exact retry after bounded validation.

Migration 0017 is additive and infers no choices from existing personal state.
State, decisions and counters commit atomically under current actor and private
owner guards, without either activity clock. Ordinary restart/credential tests do
not approve multi-API-process key custody, destructive restore or physical erasure.
See the [retained-data gate](retained-data-gate.md). Files/attachments/packages,
private notes, reservations, full moderation management, timed snooze,
push/email/webhooks, automatic acknowledgement, a universal reviewed flag,
recommendation inference and production deployment remain deferred.
