# ADR-017: Browser participation and recovery ownership

Search extension: `Search.tsx` retains query, scope, filters and continuation in the
URL for reload/back. Each effect setup has its own liveness/identity check, including
development StrictMode replay. Query/page changes cancel old ownership; a late
result cannot replace a different view/account. Loading, failure, selected-window
exhaustion and indexing coverage are distinct. Explicit Refresh drops the cursor;
failed requests do not become empty success. Exact links pin the matched revision
and separate context links open current context. Search has no personal/shared write
side effects. Bounded topic and author selection reuse existing APIs. The browser
renders excerpts as text, never database HTML. ADR-012 defines selection semantics.

Status: implemented subset for the synthetic participation browser. This does not
select automatic reading, Following or feed checkpoint behavior. Private Saved items
are the separate implemented extension below.

## Durable intent

Before any publication POST, write and read back a versioned local record keyed by
HTTPS origin, stable Loom instance ID and participant ID. Retain operation kind,
UUID key, path, exact semantic body, target parent/base and state. No credential or
signed grant belongs in that record. Store per operation, so writing one draft
does not overwrite another tab's unrelated publication. Quota or malformed storage
fails closed before dispatch; do not evict unresolved work to make room.

Every journal mutation takes an exclusive [Web Lock](https://www.w3.org/TR/web-locks/)
scoped to that origin/instance/participant. A monotonically increasing record
sequence rejects stale writes, dispatches and removals. The bounded journal uses
one short lock so quota checks and save-before-remove replacements also serialize;
network requests never hold it. View-local queues order rapid input before dispatch.
This combines atomic exclusion with optimistic versions: a localStorage read/check/
write or storage-event notification alone cannot prevent a cross-tab race.

Once dispatched, an operation's semantic body cannot change or return to draft.
A stale editor saves its unsent changes under a separate key with `blocked_by`;
the original key/body/state remains intact. The replacement URL selects those saved
changes across reload. **Continue with separate draft** explicitly unlocks that
draft; no automatic POST follows. Stale Publish and Remove actions fail instead of
acting on another tab's version. A first-dispatch refusal cannot mark an attempt
rejected after another tab has started an exact retry. Late outcomes cannot downgrade
a terminal record or recreate removed records after sign-out.

Older v1 records without a sequence are read as sequence 1 without changing their
operation identity/body. This is a cooperative same-release protocol, not protection
against scripts that bypass the journal: reload all tabs onto this release before
using it. Browsers without Web Locks fail closed on mutations while retaining read/
export access. Reconsider the storage implementation if unsupported browsers must
publish, mixed-release tabs must coexist, or drafts need cross-device coordination;
no unsafe unlocked fallback is selected for this synthetic slice.

The synthetic bound is 32 records and 1 MiB per participant/instance. Unresolved
records have **no automatic expiry**: silently losing deduplication identity is
worse than an explicit full-storage error. This differs from the architecture's
proposed expiring draft policy and requires production retention/privacy approval.
Resolved records can be removed explicitly; JSON export preserves recoverable
intent. Sign-out offers export and explicitly clears the current identity's local
records. The browser warns that unconfirmed work might already have committed.
If journal cleanup fails, server logout still takes effect and the browser reports
that scoped local records remain; it does not claim they were erased.
Clearing site data or losing the device loses this recovery aid; localStorage is
not a server backup or proof against sudden hardware failure.

Typing saves a draft. Dispatch saves `uncertain` before sending; pending UI says it
is waiting for confirmation. A transport failure, 15-second deadline, navigation cancellation
or absent status does not prove rollback. Retry uses the identical key/body; status
is read-only. A known first-request validation/authority/base failure preserves the
draft and offers a deliberate corrected submission with a new key. Rejected fields
remain locked until **Prepare corrected submission** saves a replacement draft;
subsequent text, title and entity edits persist normally. Save the replacement before
removing the rejected attempt so a quota failure retains the original. Retain the
reported conflict revision ID alongside the attempt and fetch that exact version
for comparison after reload. When resuming a specific intent from Local drafts,
replace its URL's intent ID with the correction's new ID so reload selects the
saved replacement. A newer conflict still requires another explicit correction.
**Write another** likewise saves its next draft before retiring the committed record,
then selects its new key and correct target/composer route. Artifact, discussion and
reply drafts survive reload and process restart from that route.

Setup and account administration use the same first-dispatch rejection distinction,
including invalid input and reserved nicknames, with an explicit correction action.
Their field values are restored from the saved body. A refusal received while
retrying an already uncertain request, an unknown-outcome error or an absent status
does not prove the original attempt failed. Those attempts retain the same key/body
and cannot be silently re-keyed, including records left uncertain by an older client.

Credential issuance uses its existing safe recovery contract: IDs/status only on
retry, no secret in the journal, and explicit revoke/reissue on the same account.
The in-memory one-time result includes the issuing participant, credential ID, kind
and displayed nickname. The secret label uses that result, not mutable form state;
account selection is locked while an operation is pending or the secret is visible.
The user dismisses the result before selecting another credential target.
Configuration/editor changes retain server-side exact-attempt semantics; they are
not advertised as browser-recoverable publications in this slice.

## Response ownership and reading

Every request captures the identity generation. Sign-in/out and cross-tab identity
change invalidate it. Resource/branch/exact-mode changes remount the owning view;
read effects have cancellation plus an independent active-owner guard. A late
publication may remain committed on the server but cannot show success, repopulate
cleared drafts or replace another account's view. A browser process restart can
recover uncertain intent while its synthetic persistent session remains valid;
expired/revoked credentials still require current authentication.

Direct replies use pages of six, with one nested level and an explicit deeper-branch
view. Focused branches verify that the contribution belongs to the route's discussion
before showing its body or reply controls; artifacts and mismatched targets show an
unavailable-branch state. Unavailable contribution markers retain bounded traversal
to eligible replies, with no reply action on the marker itself. Page failure retains
the visible content and cursor for deliberate retry.
Success replaces a bounded page; it does not append the entire discussion to the
DOM. Native dialogs handle mobile navigation and the sign-out choice. Exact and
current revision routes remain distinct. There is no background read marking,
service worker, feed polling or silent activity checkpoint. Reconnection permits
one status check; it does not submit a new publication automatically.
An unavailable current/exact representation still offers **Revision history**.
This invokes the independently authorized, revision-filtered history endpoint; it
does not present an older revision as current or disclose a suppressed current ID.
An unavailable resource or owner still denies the history request.

The supplied UI v0.6 is a visual/interaction reference, not an authority source or
a backend. Its colors, quiet community link, row layout, responsive navigation,
avatars, parent context and adjacent recovery controls guide this subset. Its
finite sample outcomes and fixtures are never imported as persisted Loom content.
See [the integration note](../design/ui-v0.6/README.md).

Actual Chromium tests exercise native WebAuthn through a virtual authenticator,
browser-origin storage across process restart, failed pages, conflicts and delayed
responses. They are not physical-passkey, screen-reader or human-usability studies.
Production draft retention, offline/security policy, full reading-position recovery
and concurrent personal state require separate decisions and evidence.

## Saved items extension

The Saved items destination, resource Save/Unsave controls and explicit **Save this
revision** reuse the existing shell. Resource references follow current content;
exact references retain their chosen revision. Metadata says **Revision current
when saved**, never that a revision was read. Unavailable rows retain no cached title,
author or path, and keep Unsave available under owner authority.

`saved.set` intents reuse `IntentStore` without changing publication semantics. A
short additional owner/target Web Lock prevents two same-release tabs preparing
different unresolved local commands for one target; the existing journal lock still
owns quota, versions and write/read-back. Network calls hold neither lock. Before
dispatch, persist the key, target, desired boolean and expected server version as
uncertain. No source metadata or credential is copied into this record. It shares
the 32-record/1 MiB cap with publication recovery, with no implicit eviction.

Check saved status is read-only. Retry same change reuses the frozen request. A
recorded applied/conflict result retires that exact local intent; an uncertain or
not-recorded response keeps it. A conflict shows current state and requires another
deliberate choice, never automatic re-keying/rebasing. Local drafts remain a separate
view; Saved items owns bookmark recovery. Export includes both sorts of local intent.

A known first-dispatch `saved_limit_reached` refusal becomes a rejected local record,
retained across reload until **Dismiss rejected change** removes just that record.
The server refuses before recording a decision; this does not loosen retention caps
or delete tombstones. A lost response, a refusal on a later uncertain retry, or a
late first refusal after another tab has retried still retains uncertainty. The
journal's current-owner and sequence guards apply unchanged; older uncertain
records are not reclassified from a later refusal or `not_recorded` status.

Every read/action has identity and mounted-view ownership. Read sequence numbers
reject older overlapping refreshes; observed server target versions cannot decrease.
Cross-tab journal events refresh target state and announce collection changes, without
automatically publishing or reordering the collection. Late completion cannot recreate
a removed intent or replace a new view/account. Independent clients additionally rely
on [ADR-013's server preconditions](013-private-saved-items.md).

The collection keeps one page of 12 rows and bounded cursor history. Failed page loads
retain the previous page and exact attempted continuation for Retry; they show no
successful empty/end state. Collection-version conflicts require Refresh collection.
Explicit paging moves keyboard focus to the collection heading. Mobile navigation
retains the existing modal drawer, and rows stack controls below visible identity.

Explicit sign-out clears the participant's local records after the export opportunity
and explains that uncertain bookmark changes may already have completed. Server
bookmarks survive. An identity switch invalidates presentation and hides other-owner
recovery; it does not silently discard their unresolved records. Clearing site data
still loses local intent, not server bookmarks. Same-release Web Locks, synthetic
identity/retention and destructive-restore gates remain unchanged. See
[Saved items browser tests](../../tests/e2e/saved-items.spec.ts) and Lore `LC-20261014-OIAD`.

A local or cross-tab journal change invalidates an in-flight Saved collection read.
Its late response cannot clear the refresh notice or claim current completion. The
last bounded page remains explicitly stale until a deliberate refresh succeeds;
failed pagination retains the attempted cursor for Retry collection.

## Organization extension

`Organization.tsx` reuses the scoped journal, shared query/intent hooks extracted to
`participation-state.tsx`, current identity generation and route ownership. Forms
save semantic input before dispatch, restore it after reload, freeze uncertain
requests, and require explicit correction after stale-version refusal. A stale tab
creates a blocked separate draft; it cannot overwrite a dispatched change. Safe
status distinguishes original outcome from current placement without reapplying it.
Organization records coexist with publication and Saved recovery and use their
existing shared storage bound. No organization cleanup clears those other records.

Destination pages show full paths and stable IDs, preserve failed-page context and
offer explicit refresh after an invalidated hierarchy epoch. Direct subtree pages
and ancestor links use actual server state. Closing/reopening uses distinct desired
commands and describes inherited restrictions. The browser never authorizes a later
command merely because an earlier response advertised `can_organize`.

The proposal composer freezes its destination/settings version, retains its ordinary
discussion draft and stable affected-area reference, and exposes administrator
contacts when routing is closed or changed. Opening it publishes nothing. Reload
and Local drafts reopen the affected-area route with the original frozen binding.
Community-wide suggestions resume at the overview, preserving their empty initial
body and avoiding a false affected-topic reference to the destination itself.

## Reference-aware drafts

[ADR-021](021-recorded-references.md) extends the existing composer/journal with
explicit v2 declarations. The complete list and exact target/type/rationale save
before dispatch; old v1 journals never gain injected defaults. Picker validation
is independent of indexing and confirms resource/exact scope. Source-owned change
and removal take effect only on publication. Failed saves, conflict correction,
stale tabs, reload/restart and lost acknowledgement use the same durable identity
rules. Bounded reference pages retain failed positions and require explicit refresh
after invalidation. Picker/results guard route and account generations, restore
keyboard focus and reestablish liveness under development StrictMode.

After a definitive rejection, explicit correction of a v1 revision draft loads
the exact reported conflict revision (or its retained expected revision for a
format refusal). A v2 base supplies the new draft's required format and complete
reference list, including an empty list. The UI explains that this revision's
references will be copied for review; the author can deliberately change or remove them
before publication. Draft text, title and mentions remain the author's. A failed
comparison keeps legacy correction locked with a retry action; a failed save
retains the rejected body/key and form. The new body is saved before retiring the
rejection or adopting it in the editor. Uncertain/replayed v1 requests never take
this transition, and the server's v2 anti-stripping guard remains mandatory.

## Guide 7 extension — ADR-022

Note/account fields share the existing journal, ownership and uncertain-request rules. A genuinely new revision starts without a copied note; reloading a saved attempt retains its note. Starting another artifact/summary revision fetches current content and saves a new key/base before replacing the old record. Correction retains attempted notes and requires deliberate handling of an account carry from an obsolete base. Late selection uses current draft callbacks; field labels remain stable after text entry. See [ADR-022](022-authored-change-notes.md) for the complete contract and reconsideration conditions.

## Guide 11 extension — ADR-026

Exact reading uses independent bounded Web-Locked recovery so frequent presentation
does not consume publication draft custody. Persist exact command before dispatch;
attempt counts protect uncertain retries from a late first refusal. Identity fencing
precedes sign-out cleanup, with separate export. Manual Unread blocks the current
presentation episode; status refresh and effect replay cannot create a replacement
automatic intent. [ADR-026](026-private-reading-progress.md) defines thresholds,
ordering, limits and reopening. GET and feed retrieval remain free of reading effects.
