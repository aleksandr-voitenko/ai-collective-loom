# ADR-017: Browser participation and recovery ownership

Status: implemented subset for the synthetic participation browser. This does not
select automatic reading, Saved items, Following or feed checkpoint behavior.

## Durable intent

Before any publication POST, write and read back a versioned local record keyed by
HTTPS origin, stable Loom instance ID and participant ID. Retain operation kind,
UUID key, path, exact semantic body, target parent/base and state. No credential or
signed grant belongs in that record. Store per operation, so writing one draft
does not overwrite another tab's unrelated publication. Quota or malformed storage
fails closed before dispatch; do not evict unresolved work to make room.

The synthetic bound is 32 records and 1 MiB per participant/instance. Unresolved
records have **no automatic expiry**: silently losing deduplication identity is
worse than an explicit full-storage error. This differs from the architecture's
proposed expiring draft policy and requires production retention/privacy approval.
Resolved records can be removed explicitly; JSON export preserves recoverable
intent. Sign-out offers export and explicitly clears the current identity's local
records. The browser warns that unconfirmed work might already have committed.
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
