# ADR-041: Explicit persistent local pilot

Status: implementation for opt-in local evaluation. Automated results are reported
separately. This authorizes only the operator's public, synthetic or non-sensitive
trial material on localhost; production, sensitive data, broader retention/erasure
and agent execution remain outside this decision. Imported baselines are unchanged.

## Installation and custody

`scripts/pilot.mjs` requires an explicit private external instance directory and
acknowledgement of `local-pilot-1`. There is no implicit `.env.local`, development
project selection, default participant password or authentication bypass. Exclusive
creation records a random installation identity, owner, local Docker endpoint and
platform, fixed HTTPS origin, concrete policy, selected release and private custody.
Repeated initialization refuses. Missing configuration or a required named volume
is an error, never an invitation to provision an empty replacement community.

One immutable Docker image contains the compiled browser/API and three maintained
workers. The installation retains a private release snapshot, build hashes, source
revision, dependency lock and immutable provider/runtime pins. Application containers
do not mount checkout build output or tests. A checkout update does not select a new
runtime or apply schema. Separate API/search/notification/file-text containers use
no automatic restart loop; exits remain visible until an explicit start. Worker
readiness is separate from API/database readiness and processing completeness.

A dedicated namespace anchor retains the one loopback HTTPS mapping. PostgreSQL
and SeaweedFS share that namespace without host database/storage ports; this preserves
FileStorage's loopback-only admission. Each installation has distinct volume/network/
container ownership labels, database, buckets and random credentials. Validate all
existing resources and their topology before mutation. Named volumes are required
before any container creation. Container replacement retains those same volumes.
Bounded lifecycle locks refuse concurrent operations. A dead-controller recovery
command only releases its own stale lock after checking maintenance ownership; it
never guesses whether a publication, migration or backup completed.

The controller assumes a trusted host/Docker operator, matching ADR-034. It cannot
protect against that operator reading local secret files, changing labels or mounting
volumes independently. Private paths and label/topology checks prevent accidental
cross-installation actions. Acceptance installations carry a separate kind and test
owner. Only that exact kind/owner/identity can invoke `destroy-test`; the retained
CLI has no volume deletion or global prune command.

## HTTPS and enrollment

The origin is `https://localhost:<fixed-port>`, with RP ID `localhost`. Initialization
creates an installation-specific ten-year CA and a one-year leaf. Startup validates
name, time, signing chain and private-key pairing. Explicit leaf renewal keeps the
same CA and origin. The tool never installs trust or changes Keychain, hosts, firewall
or global runtime settings. Direct clients use the retained CA with verification;
browser trust is a separate manual action. Cookies retain Secure/HttpOnly/SameSite
and use an installation-specific namespace: localhost cookies otherwise cross ports.
A new restore identity therefore cannot automatically consume source browser cookies.
Stored credentials remain exact; enrollment/sign-in at the isolated destination is
explicit. Development and synthetic preview retain their existing cookie names.

The pilot calls the maintained identity services with ADR-004's unchanged numeric
policy: eight-hour sessions, five-minute challenges, one-hour enrollment tickets,
90-day agent credentials and existing finite concurrent credential limits. Bootstrap
creates exactly one human administrator and writes its one-time enrollment ticket
privately. Normal startup never enters provisioning. Deployment recovery is a
separate explicitly confirmed offline invocation using the existing restricted audit
and same administrator identity. Redemption retains the existing revocation semantics.
The running API and workers receive application/storage configuration, not deployment
bootstrap/recovery capabilities. Participants receive only ordinary participant
credentials through the existing administration UI/API.

The controller finalizes both ticket handoffs in the maintenance container: after
the selected runtime exclusively creates the 0600 file, it transfers the open inode
to the private output directory's UID/GID and flushes it. The host then verifies
private ownership and readability before reporting delivery. This remains compatible
with already-selected release images and respects Docker Desktop UID translation;
running the entire helper under the host UID would not provide that compatibility.
Permissions are never broadened and secrets never pass through command arguments
or console output. Failed/uncertain delivery retains the existing explicit recovery
contract rather than issuing another ticket automatically.

The operator must control this private directory and verify the intended human
before handing out an enrollment/recovery ticket. This is a single-operator trial
custody procedure, not proof of an external person's identity or production recovery
approval. Loss of an issuance response never replays the secret; explicit replacement
uses the existing audited service. Physical passkeys remain a separate device trial.

## First-run presentation

The browser presents community initialization as a focused first-run screen after
normal admission and sign-in. Workspace navigation, empty topic controls and routine
administrator panels stay out of that screen. Participants without administrator
role get an explicit waiting state and deliberate refresh. To avoid premature
organization decisions, fresh setup asks only for the community name and supplies
the existing topic/overview defaults. The explanatory panel is omitted. Saved setup
requests retain their full earlier content; hiding fields must not replace it with
defaults. The exact journal, rejection/correction rules and authorization fences
are reused; a
committed-looking community does not settle an uncertain setup command. Confirmation
reveals the current workspace route; corrected drafts retain the existing
`/loom/admin?intent=...` recovery link. No extra installation settings, password
bootstrap, automatic mutation or new schema is introduced.

The prior shell hard-coded “Synthetic preview” for every runtime. Additive authenticated
community metadata now selects “Local pilot” or “Synthetic preview”; the underlying
legacy synthetic protocol profile and finite evaluation policies stay unchanged.
Nextcloud's focused installation flow informed the separation of setup from everyday
use, not the styling or authentication/storage choices. Reconsider the gate if the
product adds supported pre-setup participant workflows.

## History, policies and updates

All existing identity, publication, private-state, file, notification, rate and
capacity contracts remain. No history/outcome/tombstone pruning, quota reset or
limit increase keeps an installation running. Existing eligible abandoned-upload
cleanup and bounded operational-observation expiry retain their own semantics.
Sleep/offline time removes availability; it does not delete data or extend stored
deadlines. Capacity exhaustion is an explicit operator decision point.

Start validates exact applied migration filenames/checksums against the selected
release. Ahead, changed or pending history refuses. Update freezes a candidate,
requires the same provider pins/platform and an unchanged applied prefix, takes a
coordinated encrypted backup with all writers stopped, then uses the maintained
transactional migration runner. Release selection stays stopped until explicit start.
An interruption journal records candidate, previous release and backup. Explicit
resume validates those identities and rechecks the transactional migration history;
it never labels an older binary as database rollback. Retain both releases and the
backup while diagnosing interruption. A missing/ambiguous journal or release refuses.

## Cold backup and isolated restore

The narrow pilot adapter reuses native inventory, authenticated HTTPS verification,
archive normalization and `recovery-bundle.mjs`. The original synthetic recovery
controller retains its original ownership admission. Pilot verification obtains
route accounting and outcome classification from its selected image, preserving
release identity even if checkout build output changes. The adapter accepts only the
pilot's fixed, labeled provider topology; it cannot select arbitrary Docker volumes.

Drain API/transfers and all workers, reject unmanaged connections/tablespaces/volume
consumers, inventory every table and exact object version, stop both providers and
verify clean PostgreSQL control state. Encrypt native volumes and required private
configuration, including keys, with a separately held random GnuPG key. The existing
1 GiB representation limits, 16 MiB JSON limit and completion-last integrity checks
are unchanged. A successful capture leaves the source stopped. Interrupted capture
has no success claim. The instance directory alone is not a backup of Docker volumes;
the selected release/image and separate decryption key are recovery prerequisites.

Restore requires fresh private custody and new owned storage, a different loopback
origin and the exact release/platform. It never reuses live origin/journals or enrolls
fixture accounts. Initial whole-table/native-version equality establishes quarantine
integrity. Independently captured authenticated HTTPS expectations must pass before
VERIFIED. The original narrow allowances for verifier request charges and attributable
operational samples remain; authoritative tables, publication budgets and private
state have no blanket exemption. The source is unavailable and locked during
verification. Failure leaves the destination quarantined and the API stopped.

Historical restoration may omit later deletions, revocations, publications, outcomes
and consumed checkpoints. Missing status remains uncertainty. Live cutover,
reconciliation, rollback fencing, cross-version recovery and scheduling are excluded.
Reconsider this arrangement for public/multiple-host deployments, provider upgrades,
external metadata services, online backup, larger data or a changed trust model.

## Acceptance boundaries

`test:pilot:postgres` executes actual CLI lifecycle/capture/restore against the pinned
native providers and compiled image, with independent HTTPS and native assertions.
`pilot.spec.ts` uses the normal compiled Chromium diagnostics/coverage runner, a
retained browser profile and actual browser/API process loss. Test-owned resource
teardown checks exact ownership and never discovers a personal installation.
Defaults, source identity, diagnostic bounds, normal deadlines and zero retries
remain mandatory. Browser certificate exceptions are confined to fixtures; direct
HTTPS checks validate the real CA. Native software/WebAuthn authenticators are test
devices, not Touch ID evidence. Mac reboot, Docker restart, sleep/resume and physical
passkey usability require the README's manual checklist and remain unverified until
observed. Native restart evidence alone does not establish snapshot recovery.
