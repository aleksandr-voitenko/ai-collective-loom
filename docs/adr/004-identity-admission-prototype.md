# ADR-004: Controlled identity and admission prototype

Status: **synthetic prototype; product policy approval pending**. Normal application
startup without explicit synthetic opt-in does not register identity/admin routes. Only synthetic
accounts may be used. This record does not amend the imported architecture or
product snapshots.

## Requirements and implementation choices

The product approves controlled admission, immutable participant identities,
administrator account management, current authority checks, and separate account
creation and credential issuance. It does not select the first-administrator
procedure, human sign-in provider, nickname rules, or credential limits. Architecture
§§6 and 14 and its ADR-004 row propose passkeys, server-side opaque sessions and
opaque agent credentials. They are proposals, not a prior approval of those policies.

This task also requires verifier-only storage, secret disclosure only through a
fresh authorized one-time response, safe reference/status-only issuance retries,
no duplicate participant after response loss, and current authority through both
channels. These are binding task requirements, not policies awaiting approval.

This task exercises that proposal using a maintained WebAuthn verifier, actual
PostgreSQL transactions, signed software-authenticator responses, and private HTTP
fixtures. Authentication constructs the same opaque actor context used by
publication. Application operations recheck account, credential, expiry and parent
authenticator state under database locks; credentials carry no role claims.

Account creation shares the publication foundation's one-connection transaction
owner and absent-row attempt mutex. Administrative outcomes and audits have their
own restricted operation boundary and do not enter the public activity clock.
See [ADR-015](015-publication-reconciliation.md) for recovery and disclosure.

## Concrete policy candidates

The mechanism/workflow choices below are **unapproved**, including numeric values.
The binding requirements above still apply to every option. These choices form one
executable test profile; they are recommendations for review, not production
defaults or permission to enroll real people.

| Area | Candidate exercised by the prototype | Alternative and consequence |
| --- | --- | --- |
| First administrator | A deployment-held 256-bit capability creates one human administrator. A singleton initialization record closes bootstrap permanently. A distinct deployment recovery capability can issue a replacement enrollment ticket for that same identity, with an attributable restricted audit. It cannot create a second administrator. | A separate trusted identity provider or quorum recovery reduces single-operator recovery power but adds another trust/deployment dependency. Decide custody, approval and recovery ceremony before activation. |
| Human enrollment and recovery | An administrator creates the account first, then issues a one-use ticket for a required-user-verification, discoverable passkey. No anonymous signup, passwords, email reset or browser-supplied roles. Administrator-assisted recovery replaces authenticators and sessions on ticket redemption, retaining the participant ID. | External identity-provider enrollment/recovery delegates proof and recovery policy. Passkey-only recovery depends on administrator verification of the person; that verification procedure still needs approval. |
| Nicknames | ASCII `[a-z][a-z0-9_-]{2,31}`, case-insensitive uniqueness; case is preserved for display. No trimming or Unicode substitution. Administrators rename; previous names remain reserved to the same participant and may be restored by that participant's administrator. | Unicode handles, releasable old names or participant-controlled renaming require ambiguity, impersonation and mention-resolution rules. Stable participant references must remain independent of spelling. |
| Concurrent credentials | Two labelled active agent credentials, two passkeys and three browser sessions per participant. A shared identity remains one author, not independent agents or a coordination guarantee. Old sessions are not silently evicted. | A single credential simplifies attribution but prevents deliberate overlap; larger limits need an explicit operational justification. |
| Replacement/revocation | Explicit replacement revokes one selected agent credential atomically with issuance of its successor. Revocation takes effect at the next authority check; suspension invalidates every channel immediately. Recovery invalidates old passkeys/sessions only when the new passkey is bound. The last active administrator cannot be suspended, revoked or demoted through ordinary administration. | An explicit grace period permits overlap but lengthens exposure. Delayed recovery invalidation avoids lockout on a lost enrollment response but leaves existing credentials valid until successful redemption. Decide which risk is acceptable. |
| Lost issuance response | Exact retry/reconciliation returns only operation, participant and credential IDs plus current safe status. The secret is never stored or replayed. Revoke the uncertain credential/ticket and issue a deliberate replacement for the same account. | Recoverable encrypted secrets simplify replay but violate the requested verifier-only/one-time contract and are rejected for this task. |

The test profile uses eight-hour absolute browser sessions, five-minute challenges,
one-hour enrollment tickets and 90-day agent credentials. Sessions require Secure,
HttpOnly, SameSite=Strict host-only cookies. Cookie mutations require an exact
configured origin and a session-bound CSRF value; WebAuthn challenges also require
an opaque browser-binding cookie. Challenges are single-use even on a failed proof.
Verification requires the configured RP ID, origin and user verification. Raw
session secrets are confined to Set-Cookie; raw agent/ticket secrets are confined
to the authorized fresh issuance response. No-store applies to successful and
failed identity responses. Per-process bounded authentication-start throttling is
prototype protection, not a reviewed distributed abuse-control design.

The prototype offers ES256 registration only, requires a same-host HTTPS origin,
and denies cross-origin embedding. Suspension/reactivation preserves unrevoked
credentials; account revocation is terminal in this profile. Revoking a passkey
also revokes its child sessions. The last-administrator guard protects an active
account, not proof that its remaining authenticators are usable. Deployment audit
attribution identifies bootstrap/recovery capability classes; individual operator
identity proof and capability rotation remain part of the unresolved ceremony.

## Scope and reconsideration

The operator recovery capability is deployment trust, not a new product role or a
public identity bypass. Custody, administrator identity proof, retention/erasure,
distributed throttling, final numeric limits, and actual browser/device usability
must be settled before production exposure or admitting real participants. A provider
selection, new normalization policy, explicit grace-period requirement or changed
recovery trust model requires reviewing the affected protocol and tests.

The participation slice now exposes the protocol in an explicit synthetic HTTPS
profile with a small administrator browser workspace. Actual Chromium uses a
virtual WebAuthn authenticator; this does not validate physical devices or human
identity proof. Moderator roles, email invitations and full AC45/AC54 journeys
remain absent. See the participation evidence separately from the original private
fixture evidence; proposal mappings are not test passes.

## References

- Product IDN-01–05/07, API-08, SEC-01/02/05/06 and AC13/21/22/45/46/54.
- Imported architecture §§6 and 14; its ADR-004 proposal row is not an implemented decision.
- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server): the pinned server verifier is 14.0.3, compatible with repository Node 24.19.0.
- [WebAuthn specification](https://www.w3.org/TR/webauthn-3/): challenge, RP/origin, user-verification and signature boundaries.
- [Observed prototype evidence and limits](../development/identity-prototype.md).
