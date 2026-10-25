# Synthetic identity boundary

`IdentityAuthentication` verifies opaque bearer/session tokens and WebAuthn proofs;
`IdentityAdministration` implements controlled initialization, admission, account
state/role changes, renaming, issuance, revocation and safe reconciliation. They
share the publication actor registry and `server/application/` transaction guards.
The explicit synthetic profile registers the real `server/http/identity.ts` adapter.
Without opt-in no identity routes are registered. Software authenticators and
fault controls remain private test helpers; there is no HTTP bootstrap bypass.

An account is created without a credential. Issuance is a separate scoped attempt;
only a fresh committed issuance returns its secret. Retry/reconciliation returns
references and current status, never a stored response or another secret. Explicit
replacement retains the participant ID and atomically revokes the selected old
credential. Tokens contain 32 random secret bytes and a public UUID; only SHA-256
verifiers are stored. Passkeys store public COSE keys and counters.

The shared actor check reads the account first, then credential/parent rows in UUID
order with `FOR SHARE`. Identity administration uses a separate advisory guard,
then sorted participant `FOR UPDATE` locks and credential locks. It cannot acquire
the publication clock or add a public source event. All effects/outcomes/audits use
the same checked-out application-role connection and acknowledge only after COMMIT.
Enrollment tickets cannot become publication actors; legacy `internal` records are
accepted only by trusted publication fixtures, never either authentication channel.

WebAuthn generation/verification runs outside SQL transactions. Challenges have
expiry, a browser-binding verifier, and committed single-use consumption before
proof verification. Binding rechecks ticket/account state under the participant
guard; sign-in rechecks the counter and current passkey before inserting a session.
Recovery redemption revokes old passkeys/sessions atomically; simply issuing its
ticket does not revoke them. Passkey revocation also revokes child sessions.
Suspension denies all channels; reactivation restores only unexpired, unrevoked
credentials. The prototype treats account revocation as terminal.

Use [ADR-004](../../../../docs/adr/004-identity-admission-prototype.md) for the
**unapproved** concrete policy profile, and
[ADR-015](../../../../docs/adr/015-publication-reconciliation.md) for outcome rules.
Constructors require explicit policy and distinct deployment capability verifiers;
there are no production defaults. Deployment methods are offline trusted operations,
absent even from the private HTTP adapter. Their audit identifies the deployment
capability class; an individual operator proof/custody ceremony remains unimplemented.

Run `npm run test:identity:postgres` with local Docker. It creates/removes only its
UUID-named tmpfs PostgreSQL container and uses no existing development data.
Synthetic checks do not approve real enrollment or operator recovery policy.

Complete browsing uses additive `administration-pages-1` read-only POST operations:
`/identity/accounts/query`, `/identity/credentials/query` (one participant),
`/identity/audit/query`, and exact `/identity/accounts/lookup`. All recheck current
administrator/account/credential authority. The old GET arrays remain legacy
first100-row limited views without continuation. Never use them for full discovery.

Pages cap at25items/32KiB of complete UTF-8 JSON, with independent candidate and
one-second SQL/lock bounds. Encrypted10-minute process-local cursors bind owner,
collection/target and version; changes, expiry and restart require explicit refresh.
No secret, read audit, shared clock or private-content access is added. See
[ADR-035](../../../../docs/adr/035-complete-administrative-browsing.md), guide20,
OpenAPI and `scripts/administration-client.mjs` for complete workflows and limits.
