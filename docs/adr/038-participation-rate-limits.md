# ADR-038: Recovery-safe participation rate limits

Status: synthetic implementation contract for SEC-05, SEC-06, API-02–05 and OPS-05.
Product v0.9 and imported architecture baselines remain unchanged.

## Decision and scope

Use PostgreSQL for one administrator-managed community policy and three fixed
60-second budgets per stable participant. Human sessions and agent credentials
share identical admission semantics. Defaults and permitted ranges per window are:

| Category | Default | Range | Meaning |
|---|---:|---:|---|
| `ordinary_requests` | 120 | 1–6000 | Authenticated participation, retrieval and publication attempts |
| `new_publications` | 20 | 1–600 | Newly committed shared publication commands |
| `recovery_control` | 60 | 10–1200 | Reconciliation, essential administration and cleanup |

These are conservative test/preview candidates, not production capacity approval.
Fixed windows can admit bursts across an expiry boundary; they provide neither
smoothing nor fairness. Reconsider this choice with measured production workload,
abuse evidence or a requirement for smoothing. No Redis, per-account/topic override,
rule engine, billing, inference, scheduling or execution system is introduced.
Existing authentication-start throttling, byte/SQL/work/page limits, upload/storage
ceilings and retained-state capacities remain independent.

`src/server/http/rate-policy.ts` is the exhaustive semantic method/template mapping;
contract tests compare it to every registered participation route. POST reads spend
request capacity according to meaning. Each OpenAPI operation carries
`x-participation-rate-category`. `publication` means ordinary admission plus a
conditional transaction allowance. Status/reconciliation, identity and administrative
controls, community/guide, upload/preparation inspection and cleanup, intent release
and note deletion use recovery/control. Search and file-text status are ordinary
retrieval. Authentication ceremonies retain their separate existing throttle.
Health, runtime, OpenAPI, static browser assets, deployment capabilities and internal
workers are excluded from HTTP admission. Direct shared-publication service calls still enforce publication allowance. Schema/body/CSRF/authentication rejection before
an authenticated handler is not charged; these limits do not replace ingress defense.

## Ordering, charging and storage

Migration 0027 is additive and activates accounting. Historical pre-0027 populated
upgrade fixtures retain their old protocol until migration; current operation
requires all migrations. Only table absence identifies historical schema: query
failures, missing policy rows and incomplete migrated accounting fail closed.

Request admission is its own transaction after channel authentication and cookie
CSRF validation. It rechecks current actor authority, locks the policy FOR SHARE,
then the participant/category row. Each HTTP request is admitted once, even when a transfer reauthenticates before
accepting bytes and again in its handler. Both current-authorization checks remain.
Successful admission commits even if later domain validation refuses the request. Policy update obtains current administrator authority
and FOR UPDATE on that policy row. This orders a racing edit and each admission;
already admitted requests are not recalled. A publication allowance is a separate
admission and may observe a later policy version than its request admission.

Publication retains the existing attempt and sorted actor plan. Committed replay
is resolved with current source authorization and digest validation before reserving
new-publication capacity. New commands reserve that row before domain/file/reference
and resource guards. The count is charged only when about to call `commitRevision`;
rollback removes it, including publication/notification failures. A committed refusal
such as an expired file handle does not charge publication capacity. There are no
new contested rate locks after the shared publication-clock tail. Existing exact
file reference semantics, digests, native custody and reading state are unchanged.
Community setup counts as one publication command even though it creates its initial
structure; publication revisions, replies and attachment promotions each count once.

Database `clock_timestamp()` is sampled after acquiring the accounting row. The first
charge starts its window; the first admission after 60 seconds resets it in place.
API process clocks, credentials, sessions and restarts cannot refill it. Policy edits
preserve timestamps and counts: decreases can refuse immediately, increases provide
headroom. Clock adjustment follows database time (a backwards jump may extend a
window); Retry-After is bounded to 1–60 seconds and promises no reservation.
At most three reusable rows exist per retained participant. Expired rows are reused,
not appended or periodically scanned; there is no growing per-request history or
cleanup backlog. Participant retention itself remains an existing separate concern.

## Policy commands and recovery

The administrator UI and HTTPS API use the same inspect, versioned desired-state
command, owner-scoped status and attributable immutable audit. Commands store actor,
credential, canonical digest, key and expected/resulting versions atomically.
Concurrent stale edits return `rate_policy_conflict`. Exact replay returns original
and current policy separately without reapplying earlier limits. Current administrator
authority is required even for replay/status. Audit pages are immutable-version keysets,
default12/max25, with no server cursor storage or participant usage exposure.
At most10,000 decisions are retained, with no expiry/pruning; `rate_policy_capacity`
then blocks new edits while inspection and exact recovery remain available.

A request or publication refusal is HTTP429 `temporarily_throttled`, with category,
`retry_after_seconds`, `Retry-After` and `wait_then_retry_same_request`. It exposes no
usage, other participant state, content or credentials. It is distinct from permanent
capacity, unavailable content and authentication failure. A first throttled attempt
has no publication, source-event or notification-intent effects. A throttled uncertain
retry cannot prove the earlier operation failed. Separate bounded recovery capacity
allows reconciliation and administrator intervention after ordinary exhaustion;
if it too is exhausted, wait or use another authorized administrator's own budget.

The browser keeps drafts, exact command/key and uncertainty across reload. Throttling
neither signs out nor withdraws independently authorized content. The shell retains
identity when discovery is throttled and offers explicit Retry. Policy editing saves
before dispatch, retains uncertain/rejected commands, and allows a new version/key only
through explicit correction after a definitive first-attempt refusal. No automatic
retry loop, automatic re-key or intent clearing is introduced. The independent HTTPS
publication client keeps its journal and can recover status without a content read.

Local drafts on the Participation guide offers explicit publication status without
opening an ordinary source read. A confirmed journal remains retained with its exact
command; throttled, missing or failed status keeps uncertainty. Late responses after
navigation/identity change cannot settle the journal.

Cold recovery captures every policy, decision and rate window exactly. Physical
restore keeps full-inventory equality. Post-restore HTTPS verification necessarily
charges request admission, so ADR-034's comparison permits only bounded charges for
its authenticated participants and explicit route categories, with valid expiry
within observed database time. It refuses other participant/category changes,
overcharges, decrements and premature resets; publication counters, policy, decisions,
all prior state and native versions remain exact. It never resets or bypasses limits.

## Verification and limits

Deterministic small-budget HTTPS tests cover concurrent boundaries, shared credentials,
participant isolation, separate compiled API processes/restart, database-time expiry,
policy/admission lock races, concurrent edits, audit, additive upgrades, authorization,
rollback, lost acknowledgement, throttled retry, status and exact replay with no second
publication charge. Mounted browser and compiled Chromium tests exercise retained
journals and administrative policy recovery. Normal CI, coverage and browser diagnostics
gates remain in force; bulk regression fixtures explicitly select finite permitted
workload budgets instead of changing preview defaults or disabling admission.
Production sizing/deployment and historical publication/recovery retention remain
outside this decision. Revisit policy sizing and retained decision capacity before
approving real workloads.

## Configurable file admission

[ADR-039](039-configurable-file-admission.md) adds prospective administrator file
admission limits using existing custody and original-owner reservations. Fixed
safeguards, exact contexts, authority and recovery remain. Policy and decisions are
authoritative cold-recovery state; only PR29 request charges retain their existing
verification allowance.
