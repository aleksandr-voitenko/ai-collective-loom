# Participation rates

ADR-038 owns the synthetic contract (guide22, migration0027). `accounting.ts` uses
one shared policy and at most three reusable rows per stable participant, across
credentials/processes/restart. Fixed60s database-time windows have defaults120
ordinary requests,20 new publications,60 recovery/control; finite ranges live in
contracts/rates.ts and migration constraints. Policy edits preserve window counts
and starts. Expired windows reset only at the next charge, sampled after row lock.
No per-request history, sweeper, Redis or overrides.

Order: attempt where applicable, complete actor plan, policy SHARE, participant/
category UPDATE, domain/file/resource guards, charge, shared publication clock tail.
Request admission is a separate committed transaction after channel/CSRF verification
and current authority. A later domain refusal still consumes request capacity.
Publication replay resolves before reservation and does not consume another
publication allowance; a new allowance charges only before commitRevision, with
rollback on failure. Historical pre0027 schemas retain their old protocol during
populated upgrades; SQL errors and missing policy rows do not grant admission.

`policy.ts` locks attempt/actor/policy UPDATE for expected-version commands and
retains an immutable digest/outcome/audit row. Replay reports original/current;
status not_recorded is uncertainty. Current administrator authority always applies.
Version10001 caps new edits (10000 retained decisions); recovery/inspection continue.
Audit is descending immutable-version keyset, default12/max25, no usage API.

HTTP rate-policy.ts is exhaustive and tested against route inventory, including POST
reads and automatic HEAD. Publication routes use ordinary request admission plus
conditional publication allowance. Recovery/control is separately bounded; it can
also return temporary refusal. No authenticated operation is inferred from method.
Temporary throttling has Retry-After1–60, caller category, no operation_outcome.
Browser error policies retain identity/content and intent. Existing capacity errors,
authentication throttling, upload/storage and work budgets remain independent.

Tests: contract/rate-policy, integration/identity-rates, mounted participation-rates,
composer-recovery, session-authorization, and e2e/administration. Bulk fixture policy
is explicitly larger but still finite; synthetic launcher keeps migration defaults.

Local drafts on the Participation guide offers explicit publication status without
opening an ordinary source read. A confirmed journal remains retained with its exact
command; throttled, missing or failed status keeps uncertainty. Late responses after
navigation/identity change cannot settle the journal.
