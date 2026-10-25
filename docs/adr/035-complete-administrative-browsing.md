# ADR-035: Complete bounded administrative browsing

Status: implemented for synthetic local use, 25 October 2026. Supports API-03,
OPS-05 and identity disclosure/current-authority requirements; does not complete
AC45 or approve production identity, capacity, retention or exports.

## Contract and eligibility

Keep the three GET identity account/credential/audit arrays as **legacy limited
views**: the first 100 rows, without continuation or a completeness guarantee.
Their contracts and existing mutation/digest/outcome identities stay unchanged.
Guide20 introduces `administration-pages-1` through additive read-only POSTs:

- `/api/v1/identity/accounts/query`: all retained human/agent accounts, all states;
  internal fixture identities remain excluded. Stable ascending UUID order.
- `/api/v1/identity/credentials/query`: required `participant_id`, all retained
  credential kinds/states of that eligible account; ascending credential UUID.
  `state` is stored lifecycle state, while `expires_at` separately describes time
  expiry. Expiry does not remove history or change traversal membership.
- `/api/v1/identity/audit/query`: only the existing `administrative_audit` identity
  collection, ascending `(recorded_at,id)`. Preserve PostgreSQL microseconds in
  the public time and continuation; JavaScript millisecond rounding loses keys.
- `/api/v1/identity/accounts/lookup`: exactly one `id` or current `nickname`,
  case-insensitive nickname equality using the existing ASCII nickname rules.
  Historical reserved nicknames do not redirect to a renamed account.

Queries accept optional `limit`, `max_bytes`, `cursor`; target is required only
for credentials. The closed envelope contains `contract`, `scope` (collection,
participant target or null, order, `restart-on-change`), `items`, `next_cursor`,
`complete`, and fixed `expires_at`. Only `complete:true,next_cursor:null` means
exhaustion. No global count, arbitrary filter, private collection or secret is
introduced. POST avoids placing protected query/cursor values in URL logs.
Cookie POSTs retain Origin/CSRF; bearer callers retain their ordinary guards.
Failures are reads: 5xx means retry this same read, never an uncertain mutation.

## Consistency and current authority

Each request has its own REPEATABLE READ transaction. Current account first,
then credential/parent guards and administrator authority are checked before
inspecting cursor contents or target existence. Those shared guards remain held
until this request commits. A withdrawal that commits first is refused (or a
serialization conflict requires retry); one that waits behind the read takes
effect after it. Authentication outside this transaction is insufficient.
No transaction or row set is retained between requests.

Migration0025 adds three fixed private version rows. Statement triggers on account,
credential and identity-audit writes increment the corresponding row in the same
transaction, including direct database changes, deletes and truncation. Rollback
also rolls back invalidation. Version row locking orders competing commits;
UUID maxima and admission timestamps cannot provide that guarantee. These rows
are independent of publication/activity/personal clocks and capture no new audit.
They are not writable by the application role except through narrowly scoped
SECURITY DEFINER triggers. All old rows/migration files remain intact.

A continuation compares the version in its fresh snapshot with its opening
version before selecting any page. A mismatch returns `collection_changed` and
requires an explicit fresh traversal. This catches inserts behind the current key,
renames, state changes, issuance/revocation and audit insertion, including reversed
ID/time versus commit order. Versions conservatively cover the entire table:
credential changes for another account or new sessions also invalidate credential
browsing. Account changes to internal fixtures can invalidate account browsing.
This broad invalidation avoids per-target state and is a deliberate synthetic
trade-off. Retry alone never jumps to page one.

Completion means every eligible record from the unchanged collection version has
been visited through the final page's database snapshot. Transactions still
uncommitted at that snapshot and commits afterward are outside that observation;
refresh to discover them. Completion is not a durable event-consumption checkpoint,
a frozen historical export, or proof no writer exists. An opening cursor does not
freeze future writes. Reconsider broader/target-specific versions or real snapshot
custody if measured write churn makes explicit restarts impractical, or if an
approved export/retention requirement needs historical snapshot semantics.

## Cursor and independent bounds

AES-256-GCM tokens bind authenticated participant, collection, credential target,
contract/order context, collection version, last immutable key and one fixed
10-minute deadline. The process keeps one random key and instance identifier,
with no per-cursor cache. Replacement credentials for the same active participant
may continue after reauthorization; cursors never confer privilege. API process
restart returns `cursor_restart`; expiry returns `cursor_expired`; malformed,
tampered, wrong-owner, wrong-purpose/target tokens return `invalid_cursor`.
Page size and byte budget may change at the same position. Scope cannot change.
A multi-process deployment would require a separately reviewed key/lifetime policy.

Synthetic limits are independent: input JSON 4 KiB; cursor 1,024 ASCII bytes;
1–25 items (default25); complete uncompressed UTF-8 JSON 1–32 KiB (default32KiB);
at most `limit+1` candidates returned by a keyset query; one-second statement and
lock deadlines, including authority guards. Existing connection/transaction owner
bounds remain. Supporting indexes cover eligible account UUID/current nickname,
credential `(participant_id,id)`, and audit `(recorded_at,id)`. PostgreSQL may choose
small-table scans; the statement deadline bounds work independently of output.
These limits are not production capacity approval.

Measure the entire serialized success envelope, including escaping, scope,
continuation and deadline. Stop before an item that does not fit and continue from
the last returned item. An oversized first item returns `page_budget_exceeded`
without advancing; increase a small budget or seek operator correction when the
maximum cannot fit. Never truncate fields or skip the item. SQL returns an oversized
sentinel rather than transferring an unbounded text value into the process.
Exact lookup has the same32KiB output ceiling. Error envelopes have fixed safe
messages and remain within the minimum budget.

## Browser and independent clients

Extend Administration without a new management framework. Account paging and exact
lookup reuse current stable-ID actions; selected-account credential history has
its own keyed page component. Audit is deliberately opened and read-only. Keep
one mounted page per collection, at most16 prior cursor positions and at most one
additional lookup account. Previous requests reauthorize; older positions can
expire or invalidate. No automatic full traversal or accumulated row cache.

Failed page loads retain the displayed page and requested continuation; Retry
resends that read, Refresh starts over. Busy controls use aria-disabled and guarded
handlers so keyboard focus survives pending/failing requests. Requests are fenced
by component lifetime, sequence, identity and content-authority generation;
uncancellable old successes cannot restore selected copies, rows or issued-secret
views after departure/withdrawal. Private drafts and exact command recovery remain
under the existing journal rules. A cursor/page status cannot authorize a mutation.

`scripts/administration-client.mjs` imports no server code and sends only HTTPS
reads. Private credential input and exclusive0600 output files separate credentials
from bounded page metadata. Invoke once per page, passing the prior output with
`--after-page`; stop only at `complete:true`. Explicitly omit `--after-page` to
restart after invalidation/expiry/restart. No retained command or secret replay.
