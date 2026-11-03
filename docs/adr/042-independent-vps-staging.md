# ADR-042: Independent invitation-only VPS staging

Status: implementation for separately authorized deployment review. This does not
claim an executed VPS deployment, publicly trusted certificate, physical passkey or
cross-machine browser trial. The product/architecture imports remain unchanged.

## Decision and scope

Provide `scripts/staging.mjs` as a distinct controller for one explicitly acknowledged
`vps-staging-1` installation on a trusted Ubuntu/Docker host. The public origin is
explicit and immutable. Public examples use the reserved hostname
`loom-staging.example.com`; actual deployment hostnames and SSH details stay in
private operator custody outside Git. Use only non-sensitive invitation-only test
content. ADR-041's localhost pilot, ADR-034's synthetic source
controller and disposable preview retain their own admission, labels, files and
loopback guards. They cannot select or destroy staging resources.

Reuse the pilot's immutable release builder through an optional additional runtime
file list, without changing its defaults, runtime or local-engine selection. The
new adapter owns staging custody and topology. Reuse complete native inventory,
GnuPG/archive admission and the existing authenticated verifier; the verifier's
optional request transport defaults to its original HTTPS implementation. Its
accounting/observation allowances and authoritative comparisons are unchanged.

A separate controller is preferable to broadening the pilot's accepted origin or
making synthetic exposure an environment-variable shortcut. The latter alternatives
would weaken existing owners and public profile meaning. Reconsider the topology
for multiple APIs/hosts, a second proxy/CDN, managed S3, larger datasets or production
policy; those require their own trust/custody and acceptance evidence.

## Network, release and authority

Generated private Compose JSON is the actual deployment configuration. Explicitly
owned external volumes/networks exist before containers: ordinary start fails on
missing persistence. The internal RFC1918 bridge has fixed proxy/API/provider/worker
addresses. Only Caddy joins the egress bridge and publishes IPv4 TCP80/443. Explicit
immutable `init --ipv6 enabled`
also publishes those ports on IPv6 for deployments advertising AAAA; quarantine
stays loopback-only. No
PostgreSQL, S3, Docker socket, admin, test or debugger listener is published.

Caddy's immutable2.11.2 image obtains/renews certificates for the exact real hostname;
its data has a retained volume. HTTPS/HTTP redirects never target another origin.
Strict SNI/Host handling and refusal of incoming forwarded headers precede proxying.
The application keeps Fastify proxy inference disabled and validates the raw proxy
peer, exact authority, HTTPS envelope and optional Origin. Private bridge membership
alone cannot authorize HTTP, database application operations or native files.

The staging runtime/profile has explicit acknowledgement, exact HTTPS RP/domain and
bounded existing policies. It presents Staging test, with distinct runtime metadata.
All three actual workers receive the same explicit profile. This changes no numeric
limits, schemas/migrations, authentication, publication digests or saved outcomes.
Secure/HttpOnly/SameSite cookies and ordinary Origin/CSRF/WebAuthn checks remain.

FileStorage's optional staging deployment admits exactly `http://s3:8333`; absent
that selection its existing loopback rule remains. The service alias is isolated
inside the owned internal bridge. No arbitrary private-IP/hostname allowlist, URL
redirect, public S3 address, credential exposure or latest-version fallback is added.
Exact contextual authorization, native version identity and byte integrity remain.

## Custody and lifecycle

Private external instance custody records owner, deployment identity/kind, fixed
origin/subnet, platform/local Docker context, immutable compiled image/source/lock,
provider pins, credentials and offline proofs. API/workers mount only runtime
configuration; enrollment/recovery helpers alone receive operator custody. Existing
offline one-time administrator issuance/handoff and audited recovery are reused;
ordinary participant creation/enrollment/agent credentials remain the only reviewer
access. Cloud-browser incompatibility requires separate review, not a testing bypass.

Start/restart/recreate preserve data and origin, verify exact custody/topology and
applied migration history, and never initialize or seed. Lifecycle locks and the
single maintenance slot retain interruption evidence. Logs return bounded fixed
events without raw messages. Status distinguishes HTTPS readiness and explicit
certificate/DNS/proxy observations from container state and authenticated processing
health. Services use deliberate starts rather than an automatic restart loop.
Retained installations have no destructive operation. Test teardown needs its exact
acceptance owner/identity plus separate data-loss confirmation and validates all
existing targets before removing any. There is no global discovery/prune cleanup.

Upgrade freezes a candidate, requires unchanged provider/platform pins and additive
migration prefix, performs coordinated encrypted cold capture and uses the existing
transactional migrations. Interrupted selection retains both releases, backup and
journal for explicit resume. Old binaries are never called data rollback.

## Snapshot quarantine and evidence

Stop/drain every writer, refuse unmanaged activity/consumers, inventory every table
and native version, cleanly stop providers and check PostgreSQL shutdown state.
Encrypt whole native PG/SeaweedFS volumes and private configuration with independently
protected key material. Caddy ACME state is captured inside the encrypted bounded
configuration component; it is not used to give quarantine the source origin.
The existing representation limits and completion-last independent admission apply.
Capture leaves the source stopped.

Restore requires new owned resources/directory/subnet and the exact release/platform.
A distinct loopback-only `.invalid` origin, new private quarantine CA and installation
cookie namespace prevent adoption of the public origin or source browser sessions.
Only the scoped verifier resolves that quarantine name; it validates the actual CA.
Whole-inventory equality precedes independent authenticated expectations and VERIFIED;
the source is unavailable/locked and failure leaves the destination quarantined.
Later deletions/revocations/publications/outcomes/checkpoints can be absent. Snapshot
integrity proves neither live rollback continuity nor safe cutover/reconciliation.

The native staging suite runs actual Compose, PostgreSQL, pinned SeaweedFS and compiled
runtime. The compiled browser suite adds ordinary non-admin WebAuthn, same-origin UI
and committed-response recovery with a pinned fixture TLS key and scoped DNS. This
is local automated evidence, not a publicly trusted real certificate. README has
separate, initially unperformed tiers for live-VPS certificate/origin smoke, one
actual remote browser with human-assisted sign-in and an independent client on a
different machine. Normal regressions, browser containment and coverage gates stay.

Native Linux bind custody keeps operator-owned files at0600. The reduced-capability
proxy retains DAC_OVERRIDE for cross-UID reads of its read-only configuration/TLS
binds and NET_BIND_SERVICE for listeners. It receives no other host paths; host
file modes are never widened. A real independent-UID fixture failed before this
correction and validates successful config admission without changing ownership.
