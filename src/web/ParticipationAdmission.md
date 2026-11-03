# Participant admission review (UI-04)

Admission and credential management remain on `/loom/admin`. Create the account,
then issue access. Find an existing account by nickname under **Participant
accounts → Manage credentials**. Creation, issuance and revocation remain separate.

## Scope and acceptance

Name the affected participant in creation, management and handoff. Explain the
next step without requiring its UUID. Existing management must not claim new
creation. A lost response remains unconfirmed until the existing exact request
is reconciled; confirmed issuance never retrieves an old one-time secret.
Recover by revoking the lost agent credential and issuing another for the same
participant. Preserve identity, authorization leases and exact-request custody.

This presentation increment adds no route, backend contract, authentication
fallback or human passkey recovery flow. Single-step agent replacement and a
more prominent participant directory remain follow-ups.

## Finding ledger

| ID | Journey | Before evidence | Impact | Acceptance condition | Change | Retest evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| UI04-01 | Creation | `before-created-{desktop,mobile}.png`: success leads with a UUID and does not explicitly state the access step. Observed interaction problem. | The administrator must infer whether access is ready. | Name the created participant; explain that access still needs issuance; keep the ID secondary. | Nickname-based result, next-step notice and expandable account details. | `created-*`; mounted creation regression. | Fixed |
| UI04-02 | Returning | `before-manage-{desktop,mobile}.png`: nickname lookup works, but Manage credentials still says “Account created”. Credential controls say “this account”. Observed misleading feedback. | Existing identity management appears to create it again; selected-account context is weak. No duplicate was observed. | Never claim creation while managing an existing account; name its credential list; retain context after a failed read. | Focused nickname heading, named credentials, local lookup errors and return-to-admission action. | `existing-participant-*`, `credential-read-error-*`; compiled nickname return and mounted lookup/selection tests. | Fixed |
| UI04-03 | Handoff/recovery | Live button-only inspection found Done without a selection action. Recovery required discovering Revoke and issuing again. Secret-bearing page text was deliberately not captured. Explicit guidance is a design hypothesis, not an observed authentication failure. | Extra inference and manual selection during a one-time handoff. | Make handoff actionable; distinguish uncertain issuance from confirmed issuance with an unavailable secret; recover on the same identity. | Select-to-copy, one-time/closing guidance, agent-specific revoke/issue instructions and a confirmed-secret-unavailable notice. | `handoff-*-masked.png`, `issuance-{pending,unconfirmed,recovered}-*`; compiled response-loss/reload/reconcile/revoke/issue journey. | Fixed within this increment; direct replacement deferred |

The second corrective pass removed a contradiction found in the first candidate:
“Access has not been issued yet” must disappear once issuance is dispatched and
its outcome is uncertain. The regression asserts this explicitly.
The third pass labels an uncertain agent request **Retry same credential issuance**
and **Check credential issuance**, translates its network failure into actionable
feedback and retires an earlier secretless receipt when a new issuance begins.

## Reproduction and evidence

Use Node 24.19.0, installed dependencies, Docker and Playwright Chromium. Use the
repository npm entry point to contain restricted diagnostic output:

```sh
npm run app:build
LOOM_ADMISSION_REVIEW_SCREENS=1 npm run test:e2e -- participation.spec.ts --grep 'rejected admission'
```

The existing admission regression also exercises the creation result, held and
repeated issuance, committed-response loss, reload/reconciliation, revoke then
issue, one-time selection, keyboard completion, navigation/nickname lookup,
failed credential read/retry and unchanged identity. Its duplicate/invalid
nickname and authority-loss cases remain; empty nickname is disabled. No new
browser test identity is added. Existing administration cases cover account
switching, late responses, withdrawal and bounded paging. Assertions do not
prove general usability.

Opt-in PNGs/provenance go to `/tmp/loom-review-evidence/ui-04/after`, separately
from diagnostics, at 1440×1000 and 390×844. This is separate Playwright Chromium
with disposable PostgreSQL/HTTPS and virtual WebAuthn, not the operator's Chrome
session. The test holds/drops one real committed issuance response and replaces
one credential-page read with HTTP 503, scoped to that fixture context. Other
responses remain real. The helper checks source/build hashes and restores size.

One-time display images use Playwright's capture-time textarea mask; filenames
and manifests explicitly say masked. No DOM or cosmetic CSS is fabricated.
Review captures, cookies, passkeys, state exports, raw responses and traces must
never be added to Git or diagnostic artifacts.

## Limits

The live baseline used the signed-in `staging_admin` Chrome tab. Successful
administrator-only account browsing established access. No administrator or
pre-existing agent credential changed. The deployed revision was not established.
The ZIP records public script names and the staging marker without treating
matching names as proof of a deployed revision.

The candidate is the compiled app at its own fixture URL, recorded per image.
Fixture TLS/virtual WebAuthn do not validate physical devices, mobile passkeys or
public certificates. No admission dialog was added; native dialog cancellation
is outside this increment. Human passkey recovery, recipient delivery/connection,
clipboard handoff and subjective first-time comprehension remain unverified.
Select-to-copy selects text; it does not copy or deliver it automatically.
