# Controlled identity prototype

This file preserves the original private-fixture evidence. The later
[participation slice](participation.md) enables the same protocol only through an
explicit synthetic profile and adds a browser administrator workspace. Default
startup still exposes no identity routes. There is no real-user invitation flow,
approved production identity policy or trusted identity header.

[ADR-004](../adr/004-identity-admission-prototype.md) distinguishes product
requirements from six concrete, unapproved policy candidates. The task implements
that synthetic profile to make the decisions reviewable; it does not approve the
architecture wholesale or authorize real enrollment.

```bash
nvm use
npm ci --ignore-scripts
npm run check
npm run test:identity:postgres
npm run test:publication:postgres # build first
npm run test:app:postgres # build first
npm run test:migrations:postgres
```

The new additive `0003_identity_prototype.sql` adds credential verification/session
metadata, nickname reservations, initialization, WebAuthn public keys/challenges,
safe outcomes and restricted audit records. It seeds no account or capability.
Existing `0001`/`0002`, migration history guards and role separation are preserved.
No new migration was applied to the existing development database for this task.

## Observed local evidence

On Node 24.19.0/macOS arm64 with the pinned PostgreSQL 18.4 Linux/arm64 image:

| Check | Observed scope |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | A clean install from the updated lockfile passed; `@simplewebauthn/server` is pinned to 14.0.3. |
| `npm run check` | 64 bootstrap, five hook and 19 application/unit/router tests passed; typecheck and actual server/browser build passed. Four new unit tests cover closed identity inputs, verifier/channel separation, CSRF and explicit policy validation. |
| `npm run test:identity:postgres` | 22 tests passed, including the parent test. Actual application-role transactions, private Fastify injection requests with cookie/bearer semantics and ES256 software-authenticator signatures were used. No verifier mock or identity header was used. |
| `npm run test:publication:postgres` | 16 tests passed, including controlled absent outcomes, current authority, all-stage rollback, lost process responses, killed connections and committed clock/event coverage. |
| `npm run test:app:postgres` | Nine tests passed; compiled API/browser startup, real role readiness, dependency failure, disclosure-safe responses and graceful shutdown remain intact. |
| `npm run test:migrations:postgres` | Nine tests passed; procedural SQL, ordering, immutable checksums, ahead/behind history, rollback and role separation remain intact. |

The identity assertions inspect participant, reservation, credential, public key,
outcome, audit and publication rows/identities. Two bootstrap/account requests are
held after both observe absent outcomes, then converge on one logical account.
Distinct nickname attempts race and admit one account. Two validated enrollment
ceremonies initially see one active ticket and bind only one passkey. Two valid
signatures initially read the same counter; only one can advance it. These are
controlled PostgreSQL races, not only response-code assertions.

The harness loses acknowledgements **after COMMIT**, returns a safe unavailable
response, then reconciles the original participant/credential references without
duplicating an account or replaying a secret. A deliberate replacement revokes the
uncertain predecessor for that same participant. Failures after the audit insert
roll back admission/issuance and their reservations, credentials, outcomes and audit.

Current suspension, expiration, revocation and role changes are checked through both
channels, including actors verified before the state change. Ordinary participants
cannot administer or read audit; recovered administrator credentials can resolve
the same participant's earlier outcomes. Verified browser/bearer actors also publish
through the existing operation with persisted participant provenance.

Tests reject invalid origin/RP/challenge/signature/user-verification/user-handle,
cross-origin embedding, repeated proofs, expired challenges and wrong browser
binding. They exercise passkey/session/agent limits, logout, parent revocation,
administrator-assisted recovery, offline first-administrator recovery, and bounded
authentication starts. Bodies, no-store/Vary headers, application diagnostics,
lists, audits and persisted verifier/outcome records are checked for sampled secret
disclosure. Session secrets appear only in Set-Cookie; agent/ticket secrets appear
only in their fresh authorized issuance response.

## Remaining gates

Approve or revise the six policy candidates before production exposure or admitting
real participants. Operator capability custody/rotation and identity-proof ceremonies
for administrator-assisted recovery are not implemented. Deployment audits identify
a capability class, not an individually authenticated operator. Decide retention/
erasure and distributed abuse controls; the profile's per-process throttle, fixed
limits and bounded 100-row administrative lists are not a production operating plan.
Expired/consumed challenges and safe outcomes have no cleanup procedure in this
prototype. Its explicit timing/credential limits are test inputs, not approved quotas.

Actual browser/OS passkey enrollment, synced-device interoperability, TLS/cookie
behavior in a browser, accessibility/usability, administrator UI and real human/
agent trials were **unperformed**. Software-authenticator HTTP tests do not complete
AC45/AC54 or the first full participation slice. Public publication routes and domain
constructors remain disabled; workers still require generation-fenced effects.
The updated CI job is configured but has not executed. Hosted/provider operations,
destructive restore and production enrollment are outside this evidence.
