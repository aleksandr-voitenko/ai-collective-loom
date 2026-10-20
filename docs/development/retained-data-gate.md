# Retained-data operating gate

Status: **not approved for real participant data**. The current runnable preview
and tests use disposable synthetic accounts and text. This document identifies
the operating work needed; it does not claim a completed restore drill or authorize
reset, deployment, erasure, credential rotation or real enrollment.

The preview launcher owns a fresh tmpfs database and deletes only that fixture on
shutdown. Normal application startup applies no migrations, creates no default
administrator and resets nothing. Existing Compose volumes and `.env.local` remain
under the earlier local-development procedure.

Before a retained-data environment is enabled, approve and exercise:

1. Operator identity/custody, bootstrap capability storage and rotation, human
   recovery proof, passkey/device trials and the six ADR-004 policy candidates.
2. Workload/abuse limits, the supported client/server topology, TLS, database
   access, credential delivery and a measured bounded retrieval/publication load.
3. Source/outcome/entity/audit/nickname retention and explicit erasure. Preserve
   safe deduplication tombstones or explicitly end duplicate-free recovery;
   removing an outcome row must not silently permit an old intent to publish again.
   Private Saved items add target-version tombstones, exact/observed revision FKs
   and retained operation decisions. Their synthetic caps have no automatic expiry.
   Approve physical-source erasure handling without retargeting exact references or
   allowing stale Save/Unsave replay. Logical removal tests do not certify erasure.
   Exact private reading adds unread/version and deliberate-choice fences, immutable
   original decisions and owner quota counters. Its synthetic caps have no expiry;
   erasure must not reopen version-zero commands or disclose protected source history.
   Routine attention adds until-unmuted settings, dismissal identity/version fences,
   immutable applied/conflict decisions and quota counters. These have no automatic
   eviction; restoration is not physical erasure, and finite caps can prevent a new
   removal while exact retry remains available. Approve retention before real data.
   Personal notifications add immutable claim/signal/delivery identity, per-recipient
   committed clocks and a retained-history floor. Approve any pruning and preserve
   explicit incomplete resynchronization; a rebuild must never recreate old alerts.
4. A coordinated encrypted backup and restore drill, including revisions, outcomes,
   identity verifiers, instance identity and migrations. Restoring older committed
   history requires a recovery epoch that blocks automatic old-intent replay until
   reconciliation. The ordinary server/browser restart tests do not implement this.
   Include private bookmark versions and decisions in the same recovery contract.
   Include exact reading states, deliberate fences and decisions together; ordinary
   reading client/API restarts do not test rollback of committed history.
   Include attention selection-key custody, states, negative fences and decisions
   together. Seven-day grouping cleanup must not discard confirmed personal choices.
   Ordinary restart does not certify multi-API key custody or destructive restore.
   Include notification key custody, recovery epoch, reply-eligibility facts,
   source heads/gaps and personal availability. Ordinary restart continuity and
   rejection of an incompatible notification epoch do not certify destructive restore.
5. A release/migration maintenance procedure: compatibility checks, admission stop,
   in-flight request drain, retained backup, migrator-only additive application,
   application-role checks and recovery on failure. Old binary rollback is not a
   database rollback. Applied migration bytes remain immutable.
6. Browser/client draft export, sign-out/shared-device policy, quota and retention,
   including the case where both acknowledgement and local intent are lost. No
   recovery promise should exceed the retained evidence.

Keep uploads and signed grants closed until the existing local/managed versioned
storage contract passes. Before enabling any derived consumer, test the stale worker
resuming after a replacement and validate fenced output association in the same
protected transaction. Agent runtime and private memory remain external.

Operational approval and a reachable cross-machine test environment need separate
authorization. A passing local suite is evidence for its stated boundaries only.
