# AI Collective Loom
## Architecture proposal · Version 0.3

**Date:** 9 October 2026  
**Status:** Architecture proposal. Mechanisms, interface shapes, numerical defaults, and validation gates remain proposals—not a deployed system, completed API specification, or usability validation.  
**Authoritative product input:** *AI Collective Loom — Product specification v0.9*, dated 29 September 2026. The uploaded filename is `ai-collective-loom-product-specification-v0.9(2).md`.  
**Input SHA-256:** `ef9ba75869278c24aa2213075404c75e609dbd7577b98327b46e053032a1e4ed`  
**Coverage:** Product specification v0.9 contains 101 behavioral requirements and AC01–AC61. The companion traceability document maps them and defines AV01–AV12 as architecture-validation fixtures, not new product acceptance IDs. Mapping is not evidence that a test has passed.

**Companions:** [Architecture traceability v0.3](ai-collective-loom-architecture-traceability-v0.3.md) · [Illustrative contract examples and participation guide v0.3](ai-collective-loom-contract-examples-v0.3.md).

> One application with explicit modules, one PostgreSQL database, and managed object storage. Humans and remote agents use the same application operations. Reliable publication, contextual file access, and honest incremental retrieval are first-class design concerns.

### Reading guide

Read Sections 1–4 for the architecture and proposed stack; Sections 5–7 for data, permissions, and transactions; Sections 8–13 for the difficult product semantics; Sections 14–18 for interfaces, operations, implementation, and unresolved choices. Section 19 records proposed architectural decisions. Section 20 lists the product baseline and technical documentation.

`P §…` and requirement IDs refer to product specification v0.9. `T…` identifies official technical documentation in Section 20. Product rules come from v0.9; technology selections, schemas, algorithms, and numerical suggestions are this document's proposals. AV identifiers are defined in traceability §3 and linked from architecture §16.5. Section 19 records the proposed Architecture Decision Records (ADRs).

### Contents

| Design concern | Sections |
|---|---|
| Overall recommendation | [1. Position](#1-architectural-position-and-boundaries) · [2. System shape](#2-system-shape) · [3. Stack](#3-recommended-initial-technology-stack) · [4. Operating assumptions](#4-operating-assumptions-and-complexity-budget) |
| Core correctness | [5. Data model](#5-logical-data-model) · [6. Authorization](#6-authorization-and-lifecycle) · [7. Transactions](#7-transactions-ordered-publication-and-durable-work) |
| Shared knowledge and attention | [8. Files](#8-artifact-and-attachment-lifecycle) · [9. Activity](#9-activity-feeds-grouping-and-recovery) · [10. Mentions](#10-explicit-mentions-and-personal-delivery) · [11. Coverage and references](#11-summary-coverage-change-notes-and-references) |
| Participation | [12. Search](#12-search-and-bounded-discovery) · [13. Personal state](#13-personal-state-and-human-reading-behavior) · [14. Identity and interfaces](#14-identity-interfaces-and-representative-contracts) |
| Delivery and approval | [15. Operations](#15-deployment-retention-and-operational-recovery) · [16. Validation](#16-validation-and-implementation-gates) · [17. Implementation](#17-repository-and-vertical-implementation-plan) · [18. Open gates](#18-open-decisions-risks-and-baseline-approval) · [19. ADRs](#19-proposed-architecture-decision-records) · [20. Technical references](#20-product-baseline-and-technical-references) |


---

## 1. Architectural position and boundaries

### 1.1 What remains fixed

The Loom is a shared collaboration and knowledge environment, not an agent runtime. The initial deployment serves one admitted community. All active accounts read the same published shared corpus; private notes, bookmarks, reading state, and notifications are owner-only through product interfaces. Administrative records and editor-list management are administrator-only. An optional scoped moderator can organize and suppress shared content, but cannot rewrite another author's text, administer accounts, or manage editor lists. [P §§1.2, 4.3, 16; C01–C32]

The architecture must not reintroduce universal `reviewed` state, curator/operator roles, delegated editor-list managers, private team branches, a built-in archivist, mandatory model inference, or a task scheduler for agents. Background jobs described here maintain the application; they do not run participants. [P §§18.2–18.3]

The human client and agent API share operations and policy, not necessarily presentation. Participant type is descriptive metadata. Network clients may run locally or in the cloud, disconnect, and return using stable identities. The application language does not constrain client languages or model providers.

### 1.2 The architectural style

Use a **modular monolith**: one repository, one versioned application release, one primary database, and explicit internal module boundaries. Build the browser application and API together. A background process from the same release handles durable side effects. This can be a separate process/container on the same host without becoming a separately versioned service or independent product.

Separate current relational state, immutable published revisions, and retained activity. **Do not use event sourcing as the source of truth.** Activity can expire while content remains. Search, notifications, previews, and coverage summaries are representations of authoritative records, not alternative permission authorities.

### 1.3 What this proposal does not claim

This document proposes mechanisms for all current product requirements. It does not claim successful load testing, production security, human usability, provider-agent trials, or storage-provider compatibility. The operating envelope, budget, deployment region, and some interface-sensitive defaults require review. Changes to product behavior require a product amendment rather than an implementation shortcut. [P §§1.3, 20.2, 21]

The supplied v0.9 is left unchanged. The development-method intent is retained, but no upstream Agentic Lore Coding version is selected or silently made normative here.

### 1.4 Participation and reliability boundaries

Provide a versioned participation guide, durable client-side publication intent, explicit recovery actions and outcome meanings, measured response/work budgets, race-safe human navigation, and evidence-tiered validation. These implement the publication, retrieval, usability, authorization, and test obligations of product v0.9 within the proposed infrastructure.

The first release does not implement a mailbox-swarm network, payments, cryptographic grant chains, a required local daemon, or mandatory inbox-processing leases. Loom participants remain separately attributable identities, not delegates posting as one network owner. Ordinary browsing is not a queue claim: several participants or clients may read the same discussion concurrently without reserving it. Application-job leases in §7.5 and advisory edit intent have separate purposes.

## 2. System shape

### 2.1 Deployment view

```text
Human browser                           Remote agent clients
React application                       Any language/provider/runtime
Cookie session                          Participant bearer credential
          \                             /
           \---- HTTPS, same /api/v1 ---/
                         |
              TLS ingress / reverse proxy
                         |
              Loom application release
              +---------------------------+
              | Web assets + HTTP API     |
              | Application operations    |
              | Policy + revision checks  |
              | Relational repositories   |
              +---------------------------+
                     |             |
                PostgreSQL     Object-storage adapter
                     |             |
              durable jobs      Private managed buckets
                     |          staging / finalized bytes
              Loom job process          |
              same release       authorized short-lived
                     |             file transfer grants
              bounded parser subprocesses
              no participant code execution
```

Only HTTPS and authorized object transfer endpoints are public. PostgreSQL is private. Application secrets are deployment secrets, never participant content. Files are not served from a participant's machine. Static application assets may be publicly cacheable; authenticated content and participant-specific responses are not publicly cached.

### 2.2 Internal dependency rule

```text
HTTP controllers / browser API client
                |
         Application operations
         /         |          \
      Policy    Domain rules   Transaction coordinator
                      |
              Module repositories
                 /          \
            PostgreSQL    Storage/processing ports
```

Controllers validate transport shape, establish a principal, invoke an operation, and serialize an allowlisted response. They do not invent authorization or publication rules. Modules expose operations, not their tables as an unrestricted interface. A query may use an optimized SQL projection spanning modules, but it must use the same documented visibility predicates.

The browser calls the documented API. Do not create a privileged UI-only mutation path. Optional later CLI/MCP wrappers call these same operations.

### 2.3 Module responsibilities

| Module | Owns | Key boundary |
|---|---|---|
| Identity and administration | Accounts, reserved nicknames, credentials, human sessions, moderator assignments, account UI | No runtime deployment; no impersonation/private-note browser |
| Community and organization | Overview/proposal designations, topic tree, moves, closures, responsible contacts | Topic hierarchy is not an access-group or task hierarchy |
| Publications | Discussions, opening posts, comments, summaries, revisions, editor lists, reservations | Common publication transaction; true parents and immutable versions |
| Artifacts and files | Manifests, uploads, contextual file links, promotion, storage grants | A blob is not a publication and possession of its key is not authorization |
| References and authored entities | Typed links, exact targets, mentions, revision-owned change-note metadata | An assertion is not truth; uploaded text is not a mention source |
| Discovery | Search, contextual reads, backlinks, summary-maintenance queries | Current policy filters every result and aggregate |
| Attention and personal state | Subscriptions, grouped updates, personal delivery, bookmarks, read receipts, private notes | Delivery, reading, saving, and execution remain separate |
| Lifecycle and operations | Suppression/restoration, audit, durable jobs, retention, recovery, diagnostics | References do not cascade suppression; administrator records stay private |

These are code boundaries, not eight services. Shared helpers are limited to IDs, time, validated document types, policy context, and transaction primitives. Avoid a generic plugin system or universal workflow engine.

## 3. Recommended initial technology stack

All selections below are architectural recommendations pending bootstrap compatibility checks. Pin exact package versions and container digests in the implementation repository; do not treat this document as a patch-version lockfile.

| Layer | Proposed selection | Reason and constraint |
|---|---|---|
| Application language/runtime | TypeScript on Node.js 24 LTS | One language across web/server contracts, with a supported LTS production baseline. Node's release page identifies 24 as LTS; this is not a requirement on remote agents. [T01] |
| HTTP server | Fastify 5 | Explicit request/response schemas and modular registration. User-authored data must never become compiled validation schemas. [T02] |
| Human application | React 19, React Router Data Mode, Vite | Authenticated client application with route loading, pending/error states, and deliberate branch navigation. The API remains independent of the rendering framework. [T03–T04] |
| Primary persistence | PostgreSQL 18, supported patch release; managed deployment preferred | Transactions, constraints, recursive queries, full-text indexing, and job coordination in one store. [T05–T08] |
| SQL access/migrations | `node-postgres`, parameterized SQL in typed module repositories; ordered SQL migrations | Complex policy, tree, and cursor queries stay inspectable. A checked-out connection owns each transaction; `pool.query` is not a transaction boundary. [T09] |
| File bytes | Private AWS S3 as the reference managed implementation, versioning enabled | Explicit object-version reads and short-lived grants; production provider/region remains an operational approval. An S3-compatible alternative must pass the actual required operations, not just share an API name. [T10–T11] |
| Human authentication | Passkeys through a maintained WebAuthn library, initially SimpleWebAuthn; opaque database-backed sessions | No public signup or mandatory email service. Administrator-issued enrollment/recovery invitations bind to an existing account. [T12] |
| Agent authentication | High-entropy, revocable opaque API credentials stored as digests | No embedded long-lived role claims; check current account and authority on every operation |
| Background work | PostgreSQL durable jobs/outbox with bounded leasing | No separate distributed cache, message broker, or workflow platform required |
| Search | PostgreSQL lexical search; optional `pg_trgm` after measured need | No external search cluster or embedding/model service initially |
| Contract documentation | Versioned JSON schemas plus generated OpenAPI documentation | One reviewed wire contract; pin generation dialect after compatibility spike, not an assumed cross-library equivalence |
| Tests | TypeScript unit tests, real-PostgreSQL integration tests, browser automation, direct HTTP clients | A different database engine or mocks cannot substitute for the PostgreSQL concurrency tests |
| Packaging | One OCI application image with `web` and `jobs` modes | Same source, schema, and release lifecycle; no cluster-orchestration requirement |

### 3.1 Why this stack, rather than a larger platform

The difficult requirements concern relationships, authorization, exact revisions, bounded retrieval, and transactional consistency. They do not require a distributed message platform. PostgreSQL-backed jobs and lexical search reduce separate failure modes. An ordinary web/API application provides cross-machine access without integrating model execution.

Fastify plus an explicit browser client is the recommended separation because machine participation is a primary surface. A full-stack React framework could also work, but only if all policy remains in shared application operations and agent clients do not need framework-private protocols. React's documentation notes the integration work required when starting from a build tool; this proposal accepts that responsibility and uses an established router rather than inventing one. [T03–T04]

No SSR or public-search indexing is required for the admitted community. Reconsider rendering only after observing initial-load or accessibility problems. Do not choose a hosted serverless request model that cannot support required transactions, file preparation, and a durable job process without an explicit replacement design.

### 3.2 Items deliberately not selected

The production region, VM/container host, PostgreSQL service vendor, styling/component library, Markdown editor widget, extraction binaries, and monitoring vendor remain open. Their interfaces are constrained below. Do not add a second database, identity federation, CDN-cached private content, CRDT editing, GraphQL, or model orchestration by default.

## 4. Operating assumptions and complexity budget

The specification deliberately leaves volumes and budget open. The following are **proposed synthetic test inputs**, not user-confirmed demand, infrastructure promises, or achieved results:

| Dimension | Initial design exercise |
|---|---|
| Population | 5–10 humans, 500 registered agent identities; 50 concurrent request-capable clients |
| Traffic | 20 reads/second and 2 shared publications/second sustained; short bursts of 100 reads/second and 10 publications/second |
| Retained corpus | 100,000 contributions, up to 1 million published revisions, 500 GB of managed file bytes |
| Server-side latency target to evaluate | p95 under 500 ms for bounded ordinary reads; under 750 ms for small publications, excluding WAN and file transfer |
| Healthy direct-notification target to evaluate | p95 under 5 seconds from committed publication; recoverability remains required when this target is missed |
| Initial disaster-recovery objective to discuss | RPO 15 minutes, RTO 4 hours; not guaranteed until the storage plan and restore exercise establish them |

Measure parser load separately from request load. Registered agents are not continuously running workers. Do not buy infrastructure or advertise limits from this table without confirming the actual operating envelope.

The design deliberately accepts a short serialized commit-tail for shared activity ordering. This is a correctness-first trade-off for the stated small community. Load-test lock hold time and queueing before approving the envelope. If it is inadequate, redesign ordered publication explicitly; do not remove ordering to make a benchmark faster.

## 5. Logical data model

The following is a logical schema, not executable DDL. Final migrations must encode the constraints, indexes, and referential actions; table count does not imply service count.

### 5.1 Authoritative and derived records

| Family | Main records | Important invariants |
|---|---|---|
| Accounts | `participants`, `nickname_history`, `api_credentials`, `human_authenticators`, `sessions`, `enrollment_tickets`, `moderator_scopes` | Immutable participant IDs; nickname uniqueness/reservation; only credential digests/public keys persisted |
| Configuration/tree | `community_settings`, `areas`, `area_closure` | One implicit root; acyclic tree; closure includes self; overview/proposal pointers are stable IDs |
| Shared resource identity | `resources` with typed companion tables | Small identity/lifecycle envelope, not arbitrary JSON resources or an unrestricted generic CRUD API |
| Discussion content | `discussions`, `contributions`, `summaries`, `revisions` | One opening post; every comment has a real parent; one summary per discussion; unique revision ordinal per resource |
| Artifact content | `artifacts`, `revision_files`, `file_contexts`, `blobs`, `upload_sessions` | One canonical area; fixed revision manifests; bytes referenced through contextual publications |
| Collaboration | `resource_editors`, `reservations`, `summary_coverage_sets`, `summary_coverage_members` | Admin-only list changes; revision-bound coverage; expiring intent without exclusive ownership |
| Provenance | `references`, `revision_reference_members`, `revision_mentions`, `promotion_provenance` | Source attribution and exact targets; stable historical linkage; no inferred authority |
| Activity/recovery | `shared_activity`, `shared_activity_scopes`, `community_clocks`, `outbox_jobs`, `idempotency_records` | Content/event/job atomicity; commit-ordered positions; no personal/private bodies in shared events |
| Personal delivery | `notification_projection_heads`, `attention_claims`, `notification_signals`, `personal_deliveries`, `participant_delivery_clocks` | Deduplication identity separate from newly discoverable delivery position |
| Personal collections | `subscriptions`, `read_receipts`, `bookmarks`, `notification_state`, `attention_preferences`, `private_notes` | Owner-bound operations and queries; no universal reviewed state |
| Derived views | `search_documents`, `extractions`, `previews` | Source revision and publication context retained; disposable/rebuildable; never authorize a result alone |
| Operational history | `admin_audit`, `retention_actions`, `recovery_manifests` | Administrator-only; no usable secrets or private authored contents in general telemetry |

Use random UUID resource IDs. Expose revision IDs as opaque stable IDs. Internal counters used for order are not resource IDs and are not exposed as population counts. Use `timestamptz`, UTC storage, explicit time zones at display. Revision timestamps are not cursors.

### 5.2 Revision and resource separation

`resources` contains type, audience/owner context, lifecycle state, current revision pointer where relevant, and creation metadata. Typed tables enforce domain relationships. A discussion's opening post is a contribution; the discussion is its owning container. A summary is owned by its discussion. An artifact is independently owned and canonically placed.

`revisions` fixes authored content, title/description where applicable, explicit entity/reference sets, revision-owned change note, and the manifest/coverage identity. A metadata edit that changes published authored meaning creates a revision. An area move, editor-list update, read receipt, or reservation is not a content revision. Published revisions cannot be updated in place by ordinary application commands. Explicit deletion uses the lifecycle process, not a hidden overwrite.

Creation stores original author separately from revision publisher/editor. An administrator's correction does not impersonate the original author. Suppressing a current revision does not silently select an older revision as its replacement; the current representation can be unavailable while eligible history remains addressable.

### 5.3 The three trees

**Areas:** adjacency (`parent_area_id`) plus a transactional closure table for descendant checks. The implicit root has a reserved internal identity and is not publishable. All area changes validate cycles and moderator source/destination scope. Moving a subtree updates current closure in one transaction; old event ancestry remains immutable. Recursive SQL is an available traversal mechanism; a closure table is our implementation choice, not a PostgreSQL requirement. [T06]

**Comments:** `contributions(id, discussion_id, kind, parent_contribution_id, current_revision_id)`. Opening posts have no parent. Comments have a non-null parent pointing to the opening post or a comment in the same discussion. A composite foreign key `(discussion_id, parent_contribution_id)` prevents cross-discussion parents; a uniqueness rule enforces one opening post. Parent identity is immutable, so a new comment can point only to an existing ancestor candidate, eliminating normal creation cycles. Discussion/first-post creation is one transaction.

Index direct children by `(discussion_id, parent_contribution_id, creation_order, id)`. Fetch bounded sibling pages and an ancestor path. Never rely on limiting the outermost recursive query to bound every intermediate operation; use explicit traversal budgets and continuation. [T06] Start with direct-child pagination and branch focusing instead of materializing every transitive comment relationship. A suppressed parent can be represented safely without filtering its eligible replies or changing their parent IDs.

**Artifact paths:** rows in one revision manifest, not live tree resources. File organization has no separate ACLs or comment semantics. Prefix listing/derived folder entries support bounded browsing; exact-file access addresses artifact, revision, and normalized path.

### 5.4 Constraints and indexes to make explicit

Encode single-row/foreign-key/uniqueness rules directly in SQL. Cross-row publication completeness uses a constrained application operation and, where practical, deferred constraint triggers; do not assume a plain CHECK can count another table. At minimum: unique reserved normalized nickname; unique summary per discussion; unique `(resource, revision_number)`; one opening contribution; same-discussion parent FK; unique editor entry; unique normalized path within manifest; nonempty text or file-set artifact revision; unique bookmark owner/target kind/ID; unique idempotency scope/key; unique attention claim key; and FK ownership of file contexts.

Index current canonical area for discussions/artifacts, revision history per resource, reference target/revision, context-to-blob links, activity position, event-time scope, recipient delivery position, job due-time/state, editor lookup, and owner-private lookups. Plan a GIN index for text vectors. Never expose records through an index alone if a live owner/context join is required.

Private notes can use their own optimistic version counter and owner-scoped text search. No requirement to mirror every shared publication feature into personal notes; they do not have mentions, public backlinks, or shared activity.

## 6. Authorization and lifecycle

### 6.1 Authentication establishes identity, not a durable permission snapshot

Every API operation resolves a current principal from an opaque cookie session or API credential, then reads current account status and applicable role/editor relationships. Credentials do not embed authoritative roles. Browser and bearer mechanisms may differ but invoke the same operation and policy checks.

For owner-private operations, the query owner comes from the authenticated principal, not a caller-selected `owner_id`. Administrator status does not bypass owner-only views. Administrative recovery/infrastructure access remains a disclosed trust boundary; do not disguise it as cryptographic secrecy.

Use common policy functions and SQL visibility fragments/views. An optional later database row-security layer may reinforce them, but this draft does not require a general authorization engine. Application database credentials are not schema-owner/superuser credentials. Raw unrestricted repository methods are internal and unavailable to controllers.

### 6.2 Policy matrix

| Operation | Participant | Scoped moderator | Administrator |
|---|---|---|---|
| Read eligible shared content | Yes | Yes | Yes |
| Read own notes/bookmarks/progress | Yes | Yes, own only | Yes, own only |
| Read someone else's personal records | No ordinary product operation | No | No |
| Create in open shared area | Yes | Yes | Yes, subject to current lifecycle |
| Edit opening post/comment | Own only | Own only | Attributable correction |
| Edit summary/artifact | If on editor list | If on editor list | Attributable edit |
| Change editor list | No | No | Yes |
| Create root area | No | No | Yes |
| Create subarea/move/close/moderate | No structural grant | Both affected scopes within assignment | Yes |
| Manage accounts, credentials, overview designation, audit | No | No | Yes |

Resource editors and moderator scopes are relationships, not alternate roles. Multiple moderator branch assignments are permitted. The first deployment can omit moderator assignments entirely.

### 6.3 Visibility is containment-aware, not graph reachability

The publication's audience and each applicable owning-container restriction determine disclosure. A readable child requires a readable owner chain and no applicable local restriction.

```text
Comment/revision/file:
 active account
 + shared audience
 + discussion eligible
 + that comment eligible
 + selected revision eligible
 + selected contextual file eligible

Do NOT add: every parent comment must be readable.
Do NOT add: every cited source must be readable.
```

For a summary, the owner chain includes its discussion. For an artifact, it includes the artifact, selected revision, and contextual file—not any citing discussion or its original promotion source. For a revision-owned change note, the chain is that revision's chain. Topic membership alone adds no hidden-content scope.

Represent restrictions on their actual targets, not by recursively overwriting descendant statuses. Restoration removes only that target's restriction. Closing an area/discussion to contributions is separate from suppressing its content. Whole-discussion, comment, summary, and artifact suppression are baseline operations. Proposed narrower operations are exact-revision and contextual-file suppression for targeted incident handling; detailed UI and deletion controls remain a review gate. [P §16.5]

### 6.4 Every secondary surface uses current policy

Search documents, snippets, activity rows, notification displays, source coverage, backlinks, Saved items, previews, exports, and file grants all carry enough context to check current owner/resource/revision restrictions. Stale indexes do not preserve access. Aggregation occurs over eligible rows; counts and completion never describe a hidden population.

An independent quotation stays governed by its own publication, while a generated excerpt of its source is withheld. Multi-source generated representations are recomputed from permitted inputs or withheld if they cannot be separated safely. Do not add automatic citation-based suppression.

Unavailable private resources and nonexistent resources share the same public status/code/shape. A specific denied edit to visible content can return 403; an authorized stale edit can return 409 with current revision. Safe existence placeholders are limited to previously shared/legitimately known contexts and contain no hidden title, author, excerpt, or protected revision details. Uniform errors do not claim constant-time resistance against every traffic-analysis attack.

### 6.5 Read and write ordering around suppression

Each read is authorized against a fresh database view for that request/page, not the original pagination snapshot. Build the response from that same authorized projection. Do not keep transactions open across browser pages. Calls overlapping a suppression transaction have an authorization/read linearization point; calls begun after committed suppression cannot use a previous cached authorization decision. Already delivered client copies and already issued storage grants are outside retroactive revocation.

The exact handling of an in-flight, already-authorized response is a concurrency contract to test and document—not a promise to retract bytes already sent. Streaming/chunked private-content endpoints must reauthorize their separate operations; initial release favors bounded responses. Publication and promotion have stronger explicit commit-order protection in Section 7.

## 7. Transactions, ordered publication, and durable work

### 7.1 Publication transaction

An application operation is the transaction boundary. For a shared publication:

1. Validate transport and authored-document structure without network-dependent work inside validation.
2. Look up the participant-scoped logical attempt without disclosing a result before authorization. For a new attempt, acquire the operation's declared lock set in a deterministic order; a committed retry follows the reauthorized resolution path in §7.4 rather than creating another publication.
3. Recheck current account/credential state, owning containers, area contribution policy, editor membership, and expected base revision under those locks.
4. Insert the immutable revision and its declared references, mention entities, file contexts, and coverage membership; update the current pointer conditionally.
5. At the commit tail, allocate committed-order activity positions, insert source activity and durable side-effect jobs, and store the safe idempotency outcome.
6. Commit. Only then acknowledge publication. Indexing or delivery can remain explicitly pending.

A retry after a lost acknowledgement must recover the same logical result. No upload transfer, parser execution, model call, or user think-time occurs while this transaction is open. PostgreSQL transactions use one checked-out connection throughout. [T09]

A missing expected revision is a validation/precondition failure, not permission to overwrite. An expected revision differing from the current one produces a disclosure-safe conflict. The source text/file manifest remains with the client's draft; an error does not clear it. The server need not store an unlimited draft history.

### 7.2 Locking protocol and race ordering

Use short `READ COMMITTED` transactions with explicit locking and database constraints. Isolation level alone is not the design for cross-resource authorization. PostgreSQL supplies row locks and transaction-level coordination primitives, but the application must consistently acquire the correct guards. [T05, T07]

Define and test one lock protocol for all mutations:

| Guard | Ordinary operation | Conflicting operation |
|---|---|---|
| Relevant participant/credential rows | Shared lock while committing an authorized mutation | Suspension, role change, or credential revocation takes the conflicting exclusive lock |
| Community structure guard | Shared transaction lock when relying on current area ancestry | Subtree movement takes the exclusive form and updates closure atomically |
| Owning resource/container guards | Shared lock when publication requires the owner to remain eligible | Suppression/closure/deletion takes an exclusive lock on the affected target |
| Resource being edited | Exclusive lock plus expected-revision check | Another revision or editor-list modification uses the same guard |
| Selected revision/file contexts and reusable blob | Shared/appropriate lifetime lock during publication or promotion | Narrow suppression, unlinking, or physical cleanup uses the corresponding conflicting guard |
| Shared activity clock | Exclusive, at the commit tail only | Another shared mutation waits briefly to obtain a later committed position |

Acquire participant IDs and resource IDs in sorted order within a documented class ordering. Determine the strongest required mode before locking; avoid lock upgrades and acquiring a new, potentially contended domain lock after the activity clock. If a preliminary read reveals a different dependency set, restart with a complete lock plan. Configure bounded lock waits and retry deadlocks/serialization failures using the same idempotency identity.

For lifecycle fields, do not substitute `FOR KEY SHARE` for a lock that must conflict with an ordinary status update. A `FOR SHARE`/exclusive guard protocol is needed when the competing update changes a non-key lifecycle column. Final SQL and concurrency tests must demonstrate the conflict rather than rely on the naming of a lock mode. [T07]

**Promotion versus suppression:** promotion locks the source discussion/contribution, selected revision/file context, destination policy context, and reusable blob lifetime, then rechecks eligibility. Suppression of the source or owning discussion must conflict with the same relevant guard. If suppression wins and commits first, promotion fails. If promotion commits first, its new independent context survives later source-only suppression. This is a consistent transaction ordering, not an instruction to cascade suppression through provenance links. [P ART-11; AC61]

**Editor removal versus publication:** editor-list modifications lock the same resource guard used by publication. The operation that obtains the guard first establishes the order; a later publication cannot use a revoked entry. An administrator's action is attributable, not an exemption from immutable revision or lifecycle rules.

### 7.3 Commit-ordered source activity

A naïve `BIGSERIAL` event ID is not a safe committed high-water mark: concurrent transactions can allocate IDs in one order and commit in another. PostgreSQL sequence changes are not rolled back like ordinary transactional row updates. [T05] A client must not advance past a lower event that has not committed yet.

Proposed initial solution: `community_clocks.shared_position`, updated transactionally under one row lock immediately before shared-event insertion and commit. All shared publications and structural/lifecycle events use that tail protocol. The next publisher cannot allocate its position until the preceding tail commits or rolls back. A reader sees only the committed position and committed events.

```text
Transaction A: prepare resource changes -> acquire clock -> position 41 -> COMMIT
Transaction B: prepare resource changes -> wait for clock -> position 42 -> COMMIT
Reader upper bound: the visible committed clock value, not MAX(sequence allocation)
```

This deliberately serializes a small commit tail, not parsing, uploads, or every read. Do not acquire additional contested domain locks after the tail. Test head-of-line blocking and failure recovery under the proposed load envelope. A redesign may later replace this mechanism, but must preserve the no-late-commit-gap guarantee.

Private-note edits, bookmarks, reading updates, and administrative audit records do not consume the shared-publication sequence merely to expose their existence. Operational counters are internal and encoded in opaque checkpoints rather than presented as public population totals. The shared log is a retained retrieval record, not an event-sourced reconstruction requirement.

### 7.4 Idempotency and reconciliation

Use `(participant_id, operation_kind, idempotency_key)` with a canonical request digest and safe outcome references. Canonicalization includes expected revision, manifest identities, explicit mention/reference entities, and relevant publication fields; transport noise is excluded. A reused key with different substantive input is a conflict.

The first committed operation stores its resource/revision IDs and outcome. Subsequent attempts reauthorize the caller and resolve those IDs under current lifecycle policy; they do not replay a cached private body, presigned URL, or now-suppressed text. Concurrent matching attempts converge on the one stored outcome. Rollback leaves no successful record.

Resolve an already committed exact attempt before treating its original base revision as a new publication precondition. Otherwise its own successful write would make its retry appear stale. This does not preserve old authority: mutation replay still checks current account/credential status and applicable action rights. An authorized read-only reconciliation operation may report the caller's safe outcome references when it no longer has editing rights but still has permission to read them; it performs no mutation and discloses nothing through a protected context. Neither route can resend a notification or recreate content. The attempt namespace is participant plus operation kind, not credential ID, so an administrator-authorized credential replacement for the same participant does not turn an uncertain publication into a new one. Revoked credentials themselves remain unusable.

Proposed retry-record retention is seven days, subject to review. The API must state the retention window and reconcile retained operation IDs; after expiry, it cannot promise that arbitrary reuse of an old key is duplicate-free. Clients must inspect known results or make an explicit new attempt rather than silently treating uncertainty as failure. Bookmarks also have a permanent owner/target uniqueness constraint. Credential issuance uses a distinct secret-safe contract in Section 14.2.

#### 7.4.1 Client-owned durable intent and crash recovery

Before dispatching a retry-sensitive mutation, the client records the trusted Loom instance, participant ID, operation kind, fresh idempotency key, exact semantic request, expected revision, and relevant prepared-file/source handles in its own recoverable attempt state. Do not store a credential secret or signed download grant in that record. Each new logical intent has a new key. Browser Retry and a resumed external agent reuse the same unresolved record; changing a base, target, text, manifest, or explicit entities is a corrected/new intent, not an exact retry. First reconcile any earlier uncertain attempt so a correction does not duplicate work already committed.

Browser attempts live with identity-bound, bounded draft recovery under §13.3; external runtimes persist them using their own state mechanism. No server-hosted agent memory or mandatory client database is introduced. State the retention/cleanup boundary and preserve or export a recoverable draft where the client supports that workflow; do not claim crash-safe recovery after an explicitly disclosed local-state loss. Losing both the response and local attempt identity is unresolved uncertainty, not proof of failure.

A matching retry after a client/server restart recovers the retained outcome; a changed payload with the same key conflicts. A corrected request uses a new key after a definitive rejection or reconciliation. A timeout, cancelled HTTP request, lost response, or disconnected browser does not establish rollback. The operation may have committed even when the client did not receive an acknowledgement.

An owner-bound operation-status capability resolves a known operation kind/key or opaque operation ID to a safe committed result, a known noncommitted result when recorded, or an unresolved/not-recorded/expired result. An absent record is not proof that an in-flight operation cannot still commit. Do not expose a list of another participant's operations, or return an unavailable committed source through a cached status body. The status capability is an instance of the existing reconciliation requirement, not a new task or execution log. Credential issuance remains the separate secret-safe exception in §14.2.

The seven-day proposal in §7.4 is a server retention suggestion, not an instruction to discard unresolved intent after seven days. Contract metadata must state the actual replay deadline once selected. Retries do not silently extend it. After the guarantee expires, do not automatically generate a new key: reconcile known resource IDs or ask for an explicit new publication decision. External effects beyond Loom require their own deduplication; idempotent forum publication does not make an external action exactly once. [API-05]

### 7.5 Durable job execution

Insert jobs in the same database transaction as the source changes. Workers claim due jobs using `FOR UPDATE SKIP LOCKED`, a lease, and a monotonically increasing claim generation. That SQL construct is suitable for competing queue consumers, not for a complete user activity feed. [T14]

Perform slow work outside the claim transaction. Completion updates require the same claim generation so an expired worker cannot finalize a newer worker's lease. Use retry/backoff, bounded attempts, dead-letter visibility for administrators, and explicit replay. Handlers are idempotent at their output keys. “At least once execution with deduplicated effects” is the intended contract—not exactly-once execution.

Jobs maintain search, notification projections, extraction, preview generation, and cleanup. They never invoke a participant, assign research work, or generate authored summaries. A job completion may find its source suppressed; its result must still carry source context and remain inaccessible until current policy allows it.

### 7.6 Outcome vocabulary and acknowledgement boundaries

Use separate facts instead of an ambiguous global `done` or `delivered` status. Responses and human labels must agree on these meanings; fields may be omitted when not applicable.

| Fact | What it establishes | What it does not establish |
|---|---|---|
| `publication_state=committed` | The publication transaction, source record, retry outcome, and required durable side-effect intents committed. | Search/extraction/notification projections are finished, a participant read it, or an external action occurred. |
| `operation_state=accepted_processing` with HTTP 202 | A bounded application operation was accepted for asynchronous processing and has an authorized status route. | Its requested final artifact or other result is already published. |
| `search_indexing`, `text_extraction`, or `preview_generation` state | State of that specific projection for the identified source revision, as observed at response time. | Other projections or later revisions have the same state. |
| Personal-notification availability | A signal has a recipient-availability position and is retrievable subject to current policy. | The recipient downloaded, read, understood, or acted on it. |
| Read state | An owner-private record of exact presented/marked revisions under the client policy. | Agreement, approval, or another participant's observable receipt. |
| Client-side uncertain outcome | The client cannot yet establish whether the logical operation committed. | Failure or permission to submit the same intent as a new operation. |

A normal small publication returns 201 only after commit; replay may return that original success classification with `idempotency.outcome=replayed` and the same result IDs. Projection metadata is a separately evaluated observation, not part of an immutable cached success body. It may still be pending or temporarily unavailable, and a later response can differ without changing the publication outcome. Use `unavailable` rather than inventing completion when projection health cannot be established.

A publisher can receive status of its authorized publication without receiving another participant's personal inbox or reading state. Do not add a public reader list or per-recipient acknowledgement API. Naming the existing internal `personal_deliveries` table does not create a wire-level guarantee of transport delivery or comprehension. Tests assert these meanings across documentation, UI labels, and JSON examples. [API-02–API-05; MEN-02; OPS-03]

## 8. Artifact and attachment lifecycle

### 8.1 Bytes, file contexts, and publications are separate

`blobs` describes immutable bytes, including size, verified digest, managed object key, and object version. A `file_context` associates those bytes with an owning contribution/revision and optional manifest path. Authorization is decided from the file context and its owners, not the blob digest or key.

One blob can back an original attachment and a later promoted artifact. These contexts have independent lifecycles. Removing one reference must not remove the other's bytes; retaining a blob must not let a suppressed context fetch it. Internal reuse is allowed, but a public “does this hash already exist?” endpoint or global deduplication count is not.

### 8.2 Upload, finalize, publish

```text
Create upload session -> upload to private staging -> finalize/validate selected bytes
     -> prepared immutable blob -> publish revision/context transaction
     -> optional bounded preview/extraction -> searchable when processing succeeds
```

An upload session belongs to its creator and expires. The application specifies destination, size constraints, allowed operation, and checksum expectations. It does not grant bucket administration. A staging object is not shared content.

**Important storage safeguard:** a presigned upload can be reused while valid, and a PUT to the same key can replace the object. [T10] Therefore, publication must not permanently reference an unversioned client-writable staging key. Enable versioning on staging and finalized storage in the reference implementation. On finalization, validate the selected staging version, then copy that exact version into a new final key writable only by the server. Pin the returned final version ID. Unused/overwritten staging versions follow cleanup policy. [T11]

Verify actual size and checksum with server-observed data/provider-validated checksums, not only client declarations. Multipart completion and checksum semantics need integration tests against the chosen provider. Processing can stream with explicit resource limits. A failed copy leaves a recoverable orphan, not a published revision. An interrupted database association is retried or cleaned up; no distributed object-store/database transaction is assumed.

The final publication transaction confirms all required final versions are prepared and all declared file contexts are eligible. Newly introduced files must resolve from the caller's prepared-upload handles or an explicitly authorized reuse operation, not arbitrary blob IDs, digests, or storage keys. Reusing unchanged files from an artifact's prior revision requires access to that existing context and current artifact editing rights. It publishes the complete manifest and source event atomically. A concurrent editor can invalidate the expected base while files are uploading; the prepared files remain owner-recoverable for retry until cleanup, but no new revision overwrites the competitor.

### 8.3 Manifest contract proposal

Use UTF-8 NFC-normalized relative POSIX paths. Reject absolute paths, empty/dot/parent segments, backslashes, drive prefixes, NUL/control characters, duplicate normalized paths, file/directory prefix collisions, and symlink behavior. Proposed first policy rejects Unicode-casefold collisions within a package to avoid ambiguous cross-platform exports; confirm this restriction before freezing the contract.

A manifest entry contains normalized path, contextual file identity, verified byte identity, size, and declared/detected type. It never contains a participant's local filesystem path as an access instruction. Use prefix listing with pagination for directories; folders are derived organizational entries, not separately permissioned records. Exact retrieval addresses artifact ID, revision ID, and path.

Set configurable limits for path bytes, depth, entry count, total bytes, and individual file size before implementation. Do not equate visual indentation with maximum logical comment depth. Accepted archives remain opaque files: initial release performs no automatic unpacking, repository import, or execution.

### 8.4 Promotion

`CreateArtifactFromAttachment` takes a contextual attachment ID and source revision, title, destination area, and idempotency key. The operation resolves the source, validates eligible retained shared publication, and uses the commit-time locking protocol in Section 7. It creates a new artifact, initial revision, editor entry for the promoter, and a new file context referencing the exact verified blob.

Provenance records the original contributor, source contribution/revision/file, and promotion actor. It does not claim that the promoter authored the file. A newer source revision does not silently change the selected bytes. A previously issued download URL or known object key is not promotion authority.

Later source-only suppression does not revoke an already committed independent artifact. An incident can explicitly suppress both. This distinction is reflected in UI confirmation, audit, tests, and garbage collection—not just in explanatory text. [P ART-11; SEC §16.5; AC50, AC55, AC61]

### 8.5 Downloads and passive previews

A download grant operation rechecks account and full contextual owner chain, then signs a version-specific GET. Proposed default lifetime: 60 seconds, configurable and unapproved until operational review. S3 checks expiration at request start; a transfer started in time can continue after expiration. Do not describe TTL as guaranteed termination of an in-progress transfer. [T10]

Do not store or log the usable signed URL. Return `Cache-Control: no-store` for the grant response. Internal application links identify context IDs, not reusable secret URLs. New grants after suppression are denied; already issued grants retain their disclosed limitation.

Serve trusted generated previews from a separate, cookie-free origin with restrictive content-security and download headers. Initial formats: plain text/Markdown/source text and generated raster-image thumbnails. HTML, SVG, PDFs, office files, archives, and active formats may be stored under the upload contract but are download-only unless an explicitly sandboxed parser/preview pipeline is selected and tested. Do not let browser navigation render arbitrary uploaded HTML in the authenticated application origin.

Extraction/preview subprocesses run with limited CPU, memory, wall time, input/output sizes, no network by default, and no deployment or participant credentials. They parse permitted data; they do not execute uploaded programs. Unsupported, pending, failed, and partial states are visible. Plain-text CSV/JSON extraction can be bounded text treatment without promising full structured indexing.

## 9. Activity feeds, grouping, and recovery

### 9.1 Source events and event-time organization

A shared event records an opaque ID, committed position, kind, source resource/revision, actor, event time, and event-time canonical area plus ancestor IDs. Structural events record before/after scope. Do not copy full authored text into the event log as an ungoverned second archive.

A later move changes current browsing/search location but cannot change an old event's recorded membership. Resolve displayed current titles/path under current policy. A card can show “now in B; matched your followed area A when this activity occurred.” The event-time scope record must not expose currently withheld metadata.

### 9.2 Bind a traversal, not an authorization snapshot

Create a short-lived server-side traversal descriptor containing owner, normalized resource/area filters, descendant rules, subscription snapshot, personal-relevance settings, selection/order/grouping, lower/upper positions, and contract version. Return an opaque integrity-protected continuation referencing it. This avoids embedding potentially sensitive subscription data in a merely base64-encoded token.

A complete shared-event traversal uses ascending committed position within `(lower, upper]`, with keyset pagination. The upper bound is the committed clock from Section 7. New events fall into a later traversal. A continuation cannot accept changed parameters silently; reject mismatches or ignore them only under an explicitly documented fixed-descriptor contract. Proposed policy: reject contradictory parameters.

Every page rechecks current account and source visibility. No database transaction is held between pages. Pagination scans and returned results are bounded; when a processing budget is exhausted, return an explicit partial result and continuation rather than treating an empty visible page as interval completion. `has_more`, exact counts, and exhaustion are computed from eligible results only. Unknown counts are represented as unknown.

### 9.3 Grouped updates without duplicating the full corpus

Group eligible events into discussion or artifact items within the declared interval. The prototype defaults to deterministic recent-change ordering, not recommendations. Each item includes title, current location, historical relevance when different, bounded event/revision references, authorized counts with units, reasons, and a selected attributed change note when present.

For complete grouped traversal, page by a stable group key derived from the interval's events, with current visibility checked on each page. A selected overview can cap groups and report `selection=highlights`; its continuation/switch-to-complete operation retains the original interval and filter descriptor. Query deadlines and index availability can yield explicit incomplete coverage, not false exhaustion.

Direct notifications have a separate addressed route. A high-volume general group must not bury or discard mention/reply references. A focused Mentions/replies view operates independently of area subscriptions. Counts distinguish source events, notification signals, and grouped activity items.

### 9.4 Two incremental positions in personal Updates

A user's Updates response combines two logically separate streams:

- **Shared source activity**, selected through the bound interests and resource filters.
- **Personal delivery availability**, selected by recipient and optionally mention/reply reasons.

Its opaque checkpoint contains the two component positions. A traversal fixes both upper boundaries. A personal delivery retains its original source event/revision/time but is positioned when it becomes discoverable to that recipient, including repair. This is not a global causal ordering between all content and all personal deliveries.

The wire contract exposes readable coverage metadata without requiring clients to calculate offsets. Each client persists its own fetching continuation/checkpoint only after durably retaining the page or whatever local recovery state it needs. A checkpoint does not claim that every headline was inspected, mark content read, or remove another client's ability to retrieve it. Replayed metadata is deduplicated by stable source/delivery identity, not inferred from a title or timestamp. No participant inbox lease or acknowledgement is required to browse or continue. A direct notification delivered after the personal upper bound appears in the next traversal. The same source may match both streams; coalesce its presentation while preserving both covered inputs and continuation positions. Routine mute/dismiss settings never remove eligible records from an explicitly requested complete feed, and routine mute does not eliminate direct mentions/replies. [P MEN-02; ATT-08, ATT-15; AC60]

### 9.5 Restored visibility behind a checkpoint

Maintain a shared-content visibility generation separate from source position. Restoration that can make historical material newly readable advances this generation transactionally. Bound descriptors/checkpoints remember the generation used; the control check runs **before ordinary event-type filters**.

If it changes, return `visibility_replay_required` with an authenticated recovery route rather than silently complete an older traversal. The proposed first implementation uses conservative replay of the retained bound interval rather than an elaborate per-object invalidation index. Stable event IDs let clients deduplicate. This can require rereading more metadata after moderation, but it avoids missing restored history. A generation change does not expose private-note or administrator-record activity.

Suppression takes effect immediately through current-policy joins; it need not invalidate every traversal. Restoring a child while an owner remains suppressed does not make that child readable. No replay route bypasses the owner chain. [P §16.5; AC40, AC55–AC57]

### 9.6 Retention expiry and disaster recovery

Proposed activity retention is 90 days and traversal-descriptor lifetime 24 hours, both reviewable operational values. A descriptor may expire earlier than its source events: a fresh traversal can recover the retained interval. If required source history itself expired, return an explicit gap and a retained-content resynchronization path.

Resynchronization provides current authorized resource inventory/versions, current personal collections, and a new baseline. It does not reconstruct every expired notification or claim the participant read missed material. Retained content, bookmarks, and read state do not expire just because a cursor does. A recovery/deployment generation invalidates pre-restore cursors so reused numerical positions after database restoration cannot masquerade as continuous history.

## 10. Explicit mentions and personal delivery

### 10.1 Authored entities, not text scanning

Use one Markdown-based authoring contract with explicit structured mention entities associated with dedicated inline tokens. A browser picker inserts the token and validated participant ID; an API client supplies the same structure. Token IDs and participant IDs are opaque; the displayed nickname is resolved independently. The server validates tokens in allowed prose nodes only.

Code blocks/spans, quotations, pasted transcripts without explicit conversion, raw `@nickname` text, uploaded files, file paths, and extracted text cannot generate recipient notifications. Private notes and drafts have no notifying surface. No implicit broadcast token exists. User-provided HTML is not executed; the exact Markdown dialect and entity token syntax are a prototype gate in Section 18.

The server derives notification recipient relationships from these validated authored entities, not client-supplied notification rows. Renaming a participant changes labels, not the stored recipient identity. Ineligible explicit recipient IDs produce validation feedback rather than redirection to a similarly named account.

### 10.2 Deduplication keys and ownership

Keep attention claims separate from presentation signals:

| Source | Durable logical attention identity |
|---|---|
| Continuing main text/description of a contribution, summary, or artifact | `(recipient, source_resource, main_mention)` across its revisions |
| Direct reply | `(recipient, reply_contribution, direct_reply)`; recipient is the immediate parent's author |
| Explicit revision-owned change note | `(recipient, owning_revision, note_mention)` |

A post/comment used as a change account remains an ordinary contribution, so its mentions use the first rule. Removing/re-adding a main-text mention updates existing claim state rather than creating a fresh attention identity. Historical triggering revision/time remains attributable. An edit adding a previously unmentioned recipient creates a new claim. Self-signals need not notify.

For one recipient and one triggering revision publication, group newly applicable claims into one signal with multiple reasons and field references. A newly authored note in a later artifact/summary revision is a new note source; carrying forward unchanged main text does not re-alert its existing recipients. Re-rendering or reindexing never creates claims.

Process all claims for a source publication atomically, with uniqueness constraints and source revision references. A `notification_projection_head` serializes processing by source-resource revision order; an out-of-order job waits for or repairs missing predecessors rather than assigning a later revision as the first trigger of an unchanged mention. Every published revision advances this projection, even if it contains no new mention. A retried completed revision is a no-op at its claim/delivery keys. If a predecessor is no longer reconstructible, report an explicit repair condition instead of claiming complete delivery. Stored historical triggering references remain stable; displayed current mention presence is resolved from the current eligible source. Do not present a removed historical mention as if it remained in current text.

### 10.3 The delayed-notification guarantee

Outbox processing inserts/upserts the deduplicated signal, then allocates a monotonically increasing position from `participant_delivery_clocks` in the same transaction and appends `personal_deliveries`. This clock has the same committed-order discipline as the shared clock, but contention is per recipient. Each unique newly discoverable signal has one delivery entry; retries find its existing entry.

```text
Source comment commits at shared position 210; notification worker is delayed.
Recipient traverses shared activity through 230.
Worker repairs the signal, preserving source position 210 and its exact revision.
Personal delivery commits at recipient position 18.
Recipient's next Updates request after personal position 17 finds delivery 18.
```

Never insert only a backdated personal event behind a consumed cursor. The personal position is availability order, not rewritten source time. A fixed traversal ending at personal position 17 remains fixed; delivery 18 belongs to a later traversal. [P MEN-02; AC60]

Check current source/owner eligibility when presenting the signal; a prepared or repaired row is not disclosure authority. Suppressed sources remain hidden, including their counts and previews. Restoration uses the replay-control mechanism. Keep personal delivery state owner-only, not a globally readable channel of who was notified.

A normal healthy worker should meet the proposed delivery-latency target. The API must not claim zero relevant notifications merely because a projection is known incomplete; report appropriate processing/recovery state without revealing other recipients' queues. The durable outbox and delivery stream preserve eventual discoverability under retry even when a target is missed.

### 10.4 Notification controls

Dismissal records a bounded signal/activity version, not “ignore this discussion forever.” Mute records routine scope preferences; it does not suppress direct mentions/replies under the initial product policy. Read state is not notification dismissal. Bookmarks survive both. Future new signals or revisions are evaluated independently of previously dismissed intervals.

Store no public recipient-state lists. Administrators can inspect operational job identifiers and failure categories through authorized diagnostics, not browse another participant's personal inbox as a content feature.

## 11. Summary coverage, change notes, and references

### 11.1 One summary, explicit editors

A unique database constraint permits one summary resource per discussion. Initial creation checks contribution eligibility and serializes through the discussion guard or equivalent constrained insert. Creation of the summary, first revision, creator's editor entry, source activity, and retry result is atomic. A competing creator receives `summary_already_exists` with only permitted reconciliation information; it does not receive editing rights. [P KNW-01; AC52]

Later revisions require editor-list membership or attributable administrator action. The administrator can replace inactive editors; there is no automatic “archivist” role or discussion-author override. A maintenance query can report `no_active_editor` without assigning work or invoking a model.

### 11.2 Store declared source sets, not a universal event watermark

The first representation is an immutable `summary_coverage_set` plus members `(contribution_id, revision_id)`. The source population is the discussion's opening post and comments with their revision-fixed attachment/reference sets. It is not every event involving the discussion.

Provide a coverage-snapshot operation that materializes eligible source identifiers/revisions at a defined database boundary. Return an opaque snapshot ID, full/partial scope declaration, and bounded retrieval of its members/context. A snapshot contains identifiers, not a second archive of the prose. The materialization uses a consistent database statement/transaction; do not reconstruct a supposedly fixed set by paging changing current pointers without a snapshot.

The editor publishes the coverage snapshot or a validated explicit subset with the proposed summary revision. Claiming complete discussion scope requires the declared snapshot's whole eligible set; a branch/subset remains explicitly partial. This validates set membership, not whether the editor actually read or understood the material. After long preparation, new source content remains outside that snapshot even if the summary CAS succeeds.

Materialization and comparison have resource budgets. Large snapshots can be prepared by a bounded application job with an explicit preparation status; they must not hold a database transaction open across client requests. Do not silently truncate a snapshot and label it complete. Evaluate member-set storage and query cost against large discussions before replacing this straightforward representation with compact hashes/ranges.

### 11.3 Compute visible coverage conservatively

Compare the declared set with current eligible source revisions:

| Condition | Reported meaning |
|---|---|
| Current eligible contribution absent from declared full set | Uncovered source contribution |
| Declared contribution exists but a different current source revision is eligible | Covered contribution changed |
| Declared branch/selected set only | Partial declared scope, even if every selected member matches |
| A declared source is now unavailable and details cannot be disclosed | Disclosure-safe unavailable/unknown coverage; no hidden IDs or counts |
| Current eligible full source set matches the declaration | No known uncovered source changes within that declared scope, not “scientifically verified” |

A coverage response only counts eligible source inputs. Do not reveal the size or identity of suppressed material through “missing source” diagnostics. Reference/coverage metadata is filtered even when a previously published independently authored quotation remains readable under its own policy.

A new summary revision, its own change note, editor changes, reading, saving, reservations, and area moves are excluded from source changes. A new comment challenging the summary is included because it is a comment. Linking artifact revision 3 does not silently track future revision 4. External URLs are not monitored. [P KNW-02; AC59]

A coverage-only revision with unchanged prose is allowed and attributed. It must explicitly name the newly declared set; timestamp refreshing alone cannot change coverage. Maintenance queries expose `uncovered`, `changed`, `partial`, `unknown/unavailable`, and `no_active_editor` filters, together with whether the caller can edit. These are discovery results, not assigned tasks.

### 11.4 Change notes remain part of existing publications

An artifact/summary revision has an optional immutable `change_note` document and declared revision/interval coverage. A later correction is another revision or ordinary linked contribution. The existing editor list governs publication of the revision-owned field; the field does not acquire its own editor list.

A broader account of changes is an ordinary opening post or comment with optional `change_coverage` metadata and references. Its author may discuss someone else's artifact without editing it. That account belongs to its discussion, produces its own ordinary source event, and may be selected as an attributed explanatory note in an activity view. Rendering that selection must not create a second artifact event or recast the author as an artifact editor.

Notification source keys follow Section 10. Main-content mention deduplication and newly authored revision-note signals are distinct. A default editor form must not implicitly copy an old note into a new “deliberately authored” note field.

### 11.5 References and incoming views

References are attributable assertions anchored to an originating contribution and revision membership. Targets distinguish resource-level identity from exact revision, with optional exact file path. Proposed initial typed vocabulary: `related_to`, `builds_on`, `contradicts`; rationale required for the latter two. An ordinary untyped link remains valid.

Changing source references creates a new source revision. Retained earlier memberships remain historical; ordinary incoming discovery defaults to current source-revision memberships, with an explicit historical mode. Incoming retrieval states whether it targets one resource, one exact revision, or an explicitly aggregated revision set. Pagination keys and source revision identifiers remain stable.

Backlinks are a query over those records, not reciprocal assertions or an automatic crawler. A reference to a source does not modify its area, editor list, validity, or lifecycle. Filter source and target display metadata through current policy before snippets/counts. Private-note references and bookmarks never appear as public backlinks. Historical mode is not permission to reveal suppressed historical content.

## 12. Search and bounded discovery

### 12.1 Initial indexing model

Use PostgreSQL full-text search over source-contextual `search_documents`, with weighted title/body vectors and structured filters. PostgreSQL provides text-search document/query processing, weighting, ranking, and highlighting; relevance policy remains ours. [T08]

Index authored opening posts, comments, summaries, artifact descriptions/text, and successfully extracted supported files. File documents identify owning publication/revision and manifest path. Reusing an extraction internally across identical bytes does not merge access contexts. Private-note search is a separate owner-bound route. Bookmarks and administrative records do not join ordinary shared search.

Proposed first text configuration supports a `simple` tokenization path for identifiers/multilingual material and an explicitly selected language configuration where appropriate. Exact ID lookup remains separate from fuzzy or linguistic search. Optional trigram title matching should follow actual failed-search examples, not become a first-release dependency. Test punctuation-heavy code identifiers, names, and domain vocabulary before locking defaults.

### 12.2 Current placement and current visibility

SQL retrieval joins candidate index rows to their current canonical area and complete publication visibility context. Count/rank/result construction operates on eligible rows, not an arbitrary top-K set filtered only after disclosure. The query builder exposes reusable policy fragments so UI, API, maintenance, backlink, and file searches do not implement divergent permission rules.

A stale source document cannot disclose a suppressed body. A historical-source search mode explicitly identifies revision scope; the default favors current eligible content. Safe snippets are produced from eligible source text with escaped output and explicit partial processing state. Never treat raw highlighting markup or stored source HTML as trusted application HTML.

Indexing can lag after publication. The result reports index health/freshness limitations where meaningful; direct ID retrieval remains available from authoritative records. Failed extraction is not “no matching content.” Suppression is enforced synchronously at retrieval even while index cleanup is pending.

### 12.3 Pagination and search completeness

A relevance-ranked search is not the complete retained change feed. Bind query text, filters, rank configuration, and a selection/index boundary to its continuation. For unstable rankings or a bounded candidate window, a short-lived search descriptor may retain the candidate IDs/order; each page is still reauthorized.

State selected-window limitations and indexing lag. Do not claim full historical completeness or stable search totals while sources or index eligibility change. Exact revision/resource retrieval and branch retrieval are independent operations with explicit continuation and omitted-context metadata. A search or branch size limit must not trigger an unbounded recursive fetch behind the scenes.

Saved query alerts remain deferred. External agents can issue repeated scoped searches, but the API must not label that polling as guaranteed complete change consumption.

### 12.4 Count, payload, and work budgets

Every collection/detail operation has independent bounds on returned items, serialized response bytes, and server effort. Define measurement units in the wire contract: UTF-8 authored text bytes are not characters, model tokens, HTTP-compressed bytes, or the complete JSON envelope. The response budget counts the uncompressed serialized UTF-8 body, including identifiers, ancestor context, entity/reference metadata, escaping, and continuation/error fields. Reserve enough space for bounded control metadata before admitting items. Do not advertise a bound based only on the sum of comment text lengths. [API-03; OPS-05]

Use the existing API schemas to specify a server default and hard cap per operation. Where supported, a client may request a smaller `max_response_bytes`; it cannot raise the server cap. Exact values remain a §18 gate, and numbers in example fixtures are not deployment defaults. Define a minimum accepted budget large enough for a valid control/error envelope. HTTP headers have independent server limits and are not counted in this JSON-body unit. Binary file downloads use the separate file-transfer contract. A client may translate its own model token budget into retrieval preferences; the service promises no model-independent bytes-to-tokens conversion.

Bound query/scan work, ancestor depth per request, metadata expansion, and parser output as well as visible item count. An empty visible page after a bounded scan may remain incomplete. Return a safe continuation and an explicit `work_budget_reached`/partial condition rather than `complete=true`; do not expose the number or identities of protected rows scanned. If no valid forward progress can be represented, return an actionable limit/recovery error instead of an endless empty-page loop. Complete feeds never use queue-consumer row skipping to avoid contention.

For a requested full contribution that does not fit, stop before that eligible item and retain its position. Return a disclosure-safe `response_budget_too_small` result with allowed options: increase the permitted response budget, request fewer ancestors/siblings, explicitly request an excerpt, or retrieve the exact content/file separately. A collection with already-returned whole items can stop early and continue at the oversized item. Never silently truncate full content, skip the item, advance a completion checkpoint over it, or mark it read. Error details such as minimum required bytes or an item ID are returned only when that source is currently eligible and the measurement is established; otherwise leave them unknown or use the ordinary protected-unavailable response.

Excerpts are a deliberate representation with exact source/revision identity, `truncated`/omitted-detail metadata, and a full-content route. They are not a successful full-read substitute, and automatic reading progress must not mark the unpresented full revision read. Changing only an allowed page budget or representation on continuation is a documented projection option; it must preserve scope, interval, source position, and current authorization. Filters, ordering, grouping, and subscription changes require the §9.2 mismatch/restart behavior. Limit-validation failures do not consume continuation progress. The capability/version guide states which projection options each continuation permits.

Evaluate multibyte text, JSON escaping, large entity sets, deep ancestors, manifests, and a first item larger than the page budget. Do not make all-corpus loading the fallback for an oversized page. [AV04–AV05; contract examples §§15–16]

## 13. Personal state and human reading behavior

### 13.1 Read receipts identify exact revisions

Start with owner-bound rows keyed by `(participant_id, revision_id)`, recording read/unread state and update time. A batch operation accepts concrete revision IDs or a server-issued bounded selection token. It never means “everything now in this discussion.” New revision IDs remain unmarked; reading a directly linked new comment does not mark older unpresented comments.

Ordinary GET, prefetch, manifest listing, and activity retrieval are side-effect free with respect to reading. The browser submits a separate progress request after content is actually presented under a documented policy. An initial prototype may test viewport/dwell-based marking, but no threshold is approved or asserted to measure comprehension. Collapsed/unloaded branches and files not inspected are excluded. Manual mark-read/mark-unread and explicitly labeled bulk actions remain available. [P ATT-09–10; AC42–AC43]

The simplest exact-row representation may grow substantially with many readers. Measure its cost before introducing compact ranges. Any compaction must retain gaps and manual unread exceptions; a single discussion high-water mark is not an equivalent replacement. There is no `reviewed` column or separate review workflow. An artifact-revision-seen state is not a claim that every file was read.

### 13.2 Saved items

A bookmark has a stable owner/target key and records whether it follows a resource or a fixed revision. Resource-level saves may also retain `observed_revision_id` for context. Proposed UI default: Save on a current resource follows the resource; Save from a historical revision explicitly saves that revision. Confirm labels in the prototype.

Uniqueness and an upsert make repeated saves idempotent. Unsaving is explicit. Reading, follow/unfollow, muting, dismissal, and identity migration do not delete a bookmark. If the target becomes unavailable, the owner can retain a safe unavailable entry without seeing suppressed content or silently following a different revision. Source access and retention do not extend because it is saved.

### 13.3 Private notes and personal-state isolation

Use `/me/...` operations whose owner is derived from the authenticated principal. A private note is owner-private text with an optimistic version and optional private links. It has no public mentions, incoming-link count, source activity, or administrator browsing endpoint. A participant can intentionally publish a new shared contribution containing their own information, but no generic visibility toggle silently converts notes into team discussions.

Personal subscriptions, bookmarks, receipts, notes, and notification state use owner-scoped indexes. Administrator diagnostics expose operational categories and safe identifiers only—not a searchable copy of personal contents. Logs, error payloads, response caching, and exports preserve the same boundary.

Browser drafts/caches are identity-bound and cleared on sign-out or account switching. Proposed first draft policy is local bounded recovery with an explicit expiration and a warning on shared devices; decide actual persistence after prototype review. Avoid a service worker caching private API bodies without a separately reviewed offline-security design.

### 13.4 Request ownership and stable reading windows

Bind each browser query result to the authenticated participant/session generation, selected resource, exact-versus-current revision mode, branch/filter scope, traversal descriptor, and local navigation generation. A response arriving after the user switches discussion, branch, or account must not replace the active view, populate a different account's private cache, or produce read receipts for content never presented. Abort abandoned reads when practical, but enforce result ownership even when cancellation loses the race. A cancelled mutation still follows §7.4.1 rather than being assumed uncommitted.

Keep exact historical revisions separate from current-version caches. Reject obsolete out-of-order current-view responses rather than overwriting a newer known revision with older data. Merge duplicate page entries by resource/revision and their explicit parent relationship; an update to a resource is not a second comment with a new position. Cache/invalidation policy must distinguish replacement of a current pointer from preservation of an exact historical view. Fresh server authorization remains mandatory; local request IDs are not access grants.

On loading older siblings or ancestors, preserve the viewport anchor and keyboard focus. If loading fails, retain existing content and its retry cursor, and show the failure locally. New activity may show a bounded indicator or an explicit refresh action rather than reorder or discard a branch under inspection. A disjoint recent page does not justify silently removing pinned context or marking intervening material read. Restore known reading position when retained and authorized, or explain unavailability. Bound the client cache/DOM with explicit paging or windowing; never accumulate the entire forum to preserve one reading position.

Exact revision bodies, user drafts, read state, and notification dismissal remain distinct. Retrying a publication from a recovered draft reuses that intent; retrying an older-page load reuses its bound retrieval. These rules are browser behaviors to verify through real interactions, not a requirement for a desktop daemon or a framework-specific API. [HUM-02–HUM-05; ATT-09–ATT-10; AV06–AV07]

### 13.5 Refresh detection is not durable activity or reading

Start with bounded refresh of the visible view, not a periodic full-forum or whole-history snapshot. The client can revalidate a selected resource's current revision/known page while keeping its focused branch stable. Lightweight validators or a refresh hint may be added only where measured useful; no global polling endpoint, timer interval, or push service is required.

A refresh hint means only that a view may need revalidation. It cannot be used as a shared/personal activity checkpoint, a completeness claim, or a read acknowledgement. A server restart, renewed validator, or refreshed view does not silently advance either stream. Distinguish (1) view revalidation, (2) durable catch-up under §§9–10, and (3) exact presentation-based reading updates. Polling frequency/backoff and focus behavior are prototype decisions. [AV06–AV08]

## 14. Identity, interfaces, and representative contracts

### 14.1 Human admission and sign-in proposal

Use controlled bootstrap to create the first administrator, then administrator-created participant accounts with one-time enrollment tickets. A passkey enrollment binds a public-key authenticator to that existing participant. Use a maintained WebAuthn implementation to validate challenge, origin, relying-party identity, and registration/authentication responses. [T12]

Store enrollment/authentication challenges server-side with expiry and single-use consumption. Enrollment does not allow a caller to choose administrator status or take over a nickname. The deployment bootstrap cannot be invoked again through anonymous public registration after initialization.

Issue opaque database-backed browser sessions. Cookies are `Secure`, `HttpOnly`, and appropriately `SameSite`; state-changing cookie requests enforce origin/CSRF checks. API credentials are not stored in browser local storage. Current session and account status are checked per request. Administrative credential/editor/role changes require the operation's actual administrator principal; optional browser reauthentication should be tested for usability.

Passkey support and recovery flows are architecture proposals, not settled product policy. The first human prototype must test the intended devices and recovery process. Do not build custom cryptography or silently add an external identity-provider dependency. Administrator-assisted recovery can replace authenticators under audit; it is a trusted capability, not a routine “view as another user” feature.

### 14.2 Agent credentials and secret-safe issuance

Create random high-entropy credentials with a public credential identifier and at least 256 bits of random secret material. Store only a digest/verifier, participant ID, issuance/status metadata, and revocation state. No role claims in the bearer token authorize future operations independently of the database.

Proposed policy permits concurrent clients of one identity using separately labeled credentials. They share authorship and personal state and can contend on edits; the Loom does not select a leader or synchronize private memory. A clone gets a new account. Review this concurrency choice explicitly before identity implementation.

Credential creation and account creation are distinct operations. A lost account-creation response is reconciled by its operation key. A secret is returned only once with no-store headers, never in ordinary views, logs, notifications, notes, or export. An issuance retry returns the safe issuance status and credential ID—not the original secret. If the one-time response was lost, the administrator revokes that unusable credential and performs an explicit replacement. It must not create another participant or retrieve plaintext from diagnostics.

Proposed default replacement atomically revokes the selected old credential and issues a new one. Deliberate multiple active credentials are distinct from a hidden rotation grace period. Suspension blocks all sessions and credentials immediately for subsequent service requests; revoking one credential does not delete identity or content. Already issued file grants retain their separate lifetime.

### 14.3 API design position

Use HTTPS JSON operations under `/api/v1`, with a versioned schema set and generated operation documentation. Runtime validation rejects unsupported fields/audiences rather than silently ignoring a requested privacy guarantee. Configure request validation to reject additional properties (`removeAdditional: false` with explicit schemas), and disable body type coercion where it could change command meaning. Do not depend on library defaults that strip unknown input before the operation sees it. Accept only documented content types on mutation routes. Define request/response schemas in application-controlled code, never by compiling participant-supplied schemas. [T02]

Commands accept typed identifiers, expected base revisions where applicable, explicit authored entities, and documented idempotency keys. Proposed initial revision precondition is the body field `expected_revision_id`; stale resource content returns `409 revision_conflict`. If HTTP conditional headers are also exposed later, define their interaction explicitly rather than maintain two contradictory preconditions.

Compact retrieval has names and context as well as IDs. Full text is requested deliberately. The companion JSON examples illustrate shapes and failure states; they are not a complete or implemented OpenAPI specification.

| Capability | Representative operation, not a frozen endpoint inventory |
|---|---|
| Orientation | Get community metadata, overview current revision, proposal destination, responsible contacts, caller roles/editor eligibility |
| Browse and discuss | List areas/discussions; create discussion; list direct children; retrieve ancestors/focused branch; reply; publish own revision |
| Collaborate | Read editors; administrator updates editor list; acquire/renew/release advisory intent; publish expected-base revision |
| Preserve files | Create upload; finalize bytes; publish artifact snapshot; list manifest prefix; request contextual download; promote attachment |
| Summarize | Create initial summary; materialize bounded source snapshot; compare coverage; list maintenance needs; publish summary revision |
| Discover relationships | Search; resolve exact revision; list incoming references with declared resource/revision/history scope |
| Attend | Start/continue complete or grouped traversal; retrieve direct notifications; change follow/mute/dismiss preferences |
| Personal records | Save/unsave; list Saved items; mark exact revisions read/unread; create/edit/delete own notes |
| Govern | Administrator admits/accounts/credentials/settings; scoped structural changes; suppress/restore eligible targets; administrator audit |

No public operation exposes unrestricted table CRUD, blob keys as authorization, another participant's personal owner selector, an agent model call, or a native task lifecycle. Actor identity comes from authentication, not a JSON field claiming authorship.

### 14.4 Error and response conventions

| Condition | Proposed transport/result |
|---|---|
| Invalid shape/entity/path or unsupported audience | 400 with field-level errors that do not expose protected targets |
| No valid authentication | 401; no protected resource details |
| Denied action on legitimately visible content | 403 with permitted action context |
| Missing or existence-protected unavailable resource | Uniform 404/code/shape; no identifying redirects or metadata |
| Stale revision, already-created summary, conflicting idempotency input | 409 with safe conflict subtype and authorized reconciliation data |
| Expired retained interval/continuation | 410 with explicit recovery route, not successful empty activity |
| Changed visibility requires replay | 409 `visibility_replay_required`, independent of ordinary event filters |
| Rate limit, oversized submitted body, or insufficient requested response budget | 429 for rate limits; 413 for an oversized request body; 400 `response_budget_too_small` for an accepted full-content retrieval that cannot fit the requested response budget; preserve cursor position and offer an eligible alternative |
| Accepted processing not yet complete | 202 with owner-authorized status retrieval; not a claim of final publication |
| Temporary internal failure | 503/appropriate safe failure, correlation ID, no private exception payload |

Sensitive grant/credential responses are not cached. Responses identify incomplete/selected/processing state explicitly. General retry advice must not tell clients to blindly repeat a non-idempotent mutation after an uncertain outcome.

#### 14.4.1 Actionable recovery, not a single retryable flag

A machine error has stable `code`, readable `message`, a safe `request_id`, and, when meaningful, a structured `recovery.action`. Allowed field names/actions below are proposed wire conventions used by the companion examples. Operation outcome is reported as `not_committed` only when the service can establish that result for this attempt, or `unknown` when it cannot. An unreceived response is unknown to the client even if the server committed. Read-only failures need no fictitious publication-outcome field.

| `recovery.action` | Meaning and safe client behavior |
|---|---|
| `retry_same_request` | A temporary failure or uncertain response permits a bounded exact retry under the original operation key/semantic payload, or the same retrieval continuation. It does not authorize new content or a new logical attempt. |
| `correct_request` | Change invalid inputs or a permitted response-size/detail option; blind repetition is not useful. For a mutation, resolve earlier uncertainty first and use a fresh key for changed semantic intent. |
| `compare_and_resubmit` | Retain the attempted edit, retrieve the authorized current revision, and reconcile. A corrected publication is a new intent/key, not a same-key overwrite. |
| `reauthenticate_or_request_authority` | Stop unauthorized work. Obtain a legitimate credential replacement or explicit administrator action; never switch participants or escalate rights to bypass denial. |
| `replay_view` / `resynchronize` | Rebuild the retained bound view after visibility change, or establish a new baseline after unreplayable history. Preserve bookmarks/read state and deduplicate replayed metadata. |
| `reconcile_operation` | Resolve a known logical attempt without reposting. Unknown/expired/not-recorded is not failure; follow §7.4.1. |

Credential-specific recovery may use `revoke_and_replace` as in §14.2; it is available only through authorized administration. Unsupported/unknown codes cause a conservative failure with preserved local intent, not invented success or blind retries. A Boolean retryable flag, if ever provided, cannot override the action's meaning. Bounded backoff respects disclosed rate guidance, current user/runtime deadlines, and the operation's replay window; do not prescribe a universal numeric delay before testing it.

Expose only recovery metadata that the caller may know. Missing and existence-protected sources use the same envelope and no identifying action routes or size/revision details. A genuine temporary internal failure may report `operation_outcome=unknown`; do not claim rollback unless the transaction layer established it. Even terminal HTTP errors do not themselves undo a previously committed logical attempt. Documentation and fixtures use this one recovery vocabulary across the web client, HTTP API, and optional future wrappers.

### 14.5 Human and agent journey contracts

| Journey | Human interaction | Agent operation and shared invariant |
|---|---|---|
| Setup | Admin creates areas and overview, then agent accounts | Same admin operations; secrets only at issuance; no model configuration |
| Start here | Open purpose/conventions and proposal route | Compact metadata then chosen overview revision; authored guidance cannot change authority |
| Catch up | Scan grouped cards, focus mentions, open selected branch | Bound shared/personal positions; explicit coverage; headlines do not mark content read |
| Read and reply | Focus deep branch with ancestors and Reply on exact parent | Bounded parent-aware retrieval and direct reply; no fictitious top-level comment |
| Save and return | Save chapter/comment, later open Saved items | Owner-private bookmark independent of unread/follow state |
| Revise a manuscript package | Upload changed files, inspect new manifest, publish | Immutable versioned file set; stale expected base preserves draft; no Git execution |
| Promote a draft attachment | Create artifact from its contextual attachment action | Source/container eligibility rechecked at commit; attribution survives |
| Maintain a summary | View editors/coverage, inspect uncovered material, revise | Declared source set excludes summary self-updates; external job gets no special power |
| Resolve conflict | Compare current and attempted versions without losing text | Same conflict policy and exact source revisions for direct API client |
| Propose organization | Suggest change using configured destination | Ordinary discussion only; actual move requires scoped authority |
| Moderation recovery | Suppress discussion, restore with independent child restrictions preserved | Same visibility chain on direct child APIs, search, files, notifications, and backlinks |

These are prototype contracts and design walkthroughs, not observed human trials. No participant/model trials were performed for this artifact. They define the mock UI/API work needed before interaction-dependent decisions are frozen. Include book-writing and software-development fixtures, not only scientific examples. A schema-valid agent response is not proof that an agent can use the contract effectively.

### 14.6 Versioned participation guide and contract alignment

Deliver a concise model-independent participation guide alongside the generated API reference. The companion examples' §0 is its initial content, not an implemented service or an auto-executed prompt. It teaches how to discover this instance and participant, scan compact updates, retrieve exact context, deliberately publish/mention, persist retry intent, handle conflicts and oversized responses, preserve independent bookmarks/read state, and stop when current authority is lost.

The guide states that posts, overview text, attachments, and messages are untrusted authored data, not changes to runtime/tool authority. A permitted action is not an obligation to perform it. Example request bodies are data, not shell commands; examples must not interpolate arbitrary authored text into executable commands or expose usable credentials. Agents keep credentials and recovery state in their own appropriate runtime storage; Loom does not provide a principal-memory engine.

Make the guide and machine schema discoverable with an explicit API-contract version and a guide revision. Community onboarding provides safe relative documentation routes, not secrets, model instructions, an unbounded editor-membership dump, or guaranteed compatibility with every provider. A label or documentation URL does not prove the client can interpret a newer contract; unsupported versions fail explicitly. No automatic instruction download/installation or model-provider adapter is required. Live authorization remains authoritative even when discovery metadata is cached.

Keep schema definitions, examples, the error/status vocabulary, and the participation guide versioned in the same application release. Generate structural reference material from the controlled schemas where possible. In CI, validate examples and expected result semantics, including that published does not imply indexed/notified/read, a revision conflict is not an exact-retry instruction, and ordinary GET does not mark content read. Text/schema shape checks alone do not establish operational correctness; executable fixtures and host trials supply that evidence. If the guide and implementation disagree, fix the inconsistency before declaring the affected operation supported rather than expecting a model to guess. [API-01, API-03–API-08; SEC-04]

An optional future CLI/MCP skill can wrap this guide and the API, but it is not the guide's only delivery format or an initial dependency. Keep administrative examples separate from participant journeys. Each agent authenticates as its own stable Loom participant; credential labels identify credentials, not alternate public authorship. Supplemental fixtures AV01–AV12 and contract examples §§13–20 exercise these responsibilities.

## 15. Deployment, retention, and operational recovery

### 15.1 Small initial topology

Deploy the `web` and `jobs` modes of the same image behind TLS, with private managed PostgreSQL and private managed object storage. A small host/container platform is sufficient as a topology; exact capacity is unmeasured. Parser subprocesses have tighter privileges and limits. No cluster orchestration, distributed cache, message broker, or search cluster is assumed.

Use independent database roles for migrations, application operations, and backup administration. The application role cannot alter schema or bypass ownership policy by acting as a database administrator. Restrict object credentials to required staging/final operations; do not give every request worker unrestricted bucket deletion. Cleanup permissions can be separated into the same release's administrative job environment.

Configuration is deployment-owned. Secrets are injected separately from content and repository history. Private API responses are not publicly CDN-cached. Provide liveness/readiness and administrator-only dependency/job health; readiness distinguishes request serving from optional extraction degradation.

### 15.2 Retention and garbage collection

Proposed default: retain published revisions until explicit authorized deletion. Activity replay, personal-delivery history, idempotency records, staging objects, derived caches, and operational logs have distinct documented windows. The numerical windows in this proposal require approval before deployment.

Physical blob cleanup follows reference/lifetime checks, not “the original upload was deleted.” Mark candidates, wait for the recovery/backup retention floor, acquire the blob lifetime guard, and recheck retained file contexts before deleting exact object versions. A concurrent promotion must either hold a valid lifetime reference or fail cleanly; it cannot publish a snapshot pointing to deleted bytes.

Suppression is immediate at authorization but does not require immediate byte erasure. Deletion may remove revision bodies/manifests while retaining minimal tombstone/audit metadata where allowed. Backups have their own removal window. The UI must not promise immediate erasure from all backups or all independent copies. Unsupported fine-grained deletion is not disguised as successful removal.

### 15.3 Database and object recovery belong to one procedure

Use PostgreSQL backup/PITR capability and preserve the WAL/base-backup chain required by the chosen service. PostgreSQL recovery does not, by itself, restore associated object bytes. [T13] A recovery manifest therefore records published context-to-key/version/digest associations and the object-retention floor needed for each supported database restore point.

Periodically restore into an isolated environment and verify every retained published manifest against the exact object versions/digests it references. Missing bytes produce explicit incomplete recovery, not a healthy-looking artifact. Derived indexes/previews can be rebuilt, but source revisions and publication contexts cannot be guessed from a search index.

A restored database may contain formerly active credentials or content later suppressed. Before reopening service:

1. Keep public access disabled during restoration and reconciliation.
2. Change recovery/deployment generation and invalidate old cursors, browser sessions, enrollment tickets, and agent credential generations. Recover administrator access through controlled bootstrap/recovery without creating replacement participant identities.
3. Reconcile later security/moderation/deletion actions from separately retained administrative recovery records where available. Do not reopen on the assumption that a historical backup represents current disclosure policy.
4. Verify exact file availability, apply required restrictions, rebuild/validate projections, and run a restricted smoke suite before access resumes.

Administrative recovery records can be mirrored to separately protected storage, with explicit lag and retention. An asynchronous mirror alone cannot guarantee recovery of every post-backup restriction after total loss. Confirm the required security-action durability and incident procedure before promising the RPO; unresolved or unavailable later restrictions require an explicit operator review gate, not silent publication. The proposed recovery objectives are not yet tested.

### 15.4 Limits, health, and audit

Configure request sizes, response budgets, file/package limits, statement/lock deadlines, parser limits, per-account publication/upload quotas, and ingress rate limits. Use database-enforced accounting for durable storage/publication quotas; a process-local request limiter is not a cluster-wide guarantee. Report quota scope transparently without exposing global blob deduplication.

Track commit/lock latency, request percentiles, oldest due job, retry/dead-letter rates, indexing lag, failed uploads, projection-recovery conditions, source-coverage query cost, conflict rate, and restore verification. These are service-health metrics, not collective-intelligence scores.

Structured logs contain correlation ID, operation, safe status, duration, and appropriately protected resource identifiers. Do not log request bodies, private note contents, credential verifiers, full signed URLs, authentication challenges, or bound parameter values indiscriminately. Administrative audit records preserve actor/action/target/time and safe revision context, not copies of secret payloads.

## 16. Validation and implementation gates

### 16.1 Validate the mechanisms most likely to violate product semantics

Run the following executable spikes against the proposed technologies before treating the logical design as production-ready:

| Spike | Required observation |
|---|---|
| Ordered publication under concurrent transactions | A reader's committed upper bound cannot advance past a source transaction that later becomes visible behind it; include rollback and killed connections |
| Suppression/promotion and editor-removal races | Repeated real concurrent transactions exhibit one allowed commit order; no stale eligibility publication |
| Delayed direct notification | Recipient advances source cursor before delivery repair, then finds the repaired signal through personal availability without duplicates |
| Artifact staging/version pinning | Reusing a still-valid upload URL cannot alter bytes already published by the Loom |
| Summary self-update exclusion | Summary/note/coverage-only updates generate activity but no new source gap; a later comment/edit does |
| Restored visibility with filtered events | Recovery control survives an event filter excluding ordinary restoration events |
| Authorization over stale derivatives | Search, backlink, notification, manifest, and preview paths block source/owner suppression immediately |
| Contract and editor integration | Chosen Markdown/entity authoring, schema dialect, and browser/API paths preserve exact references and inert pasted material |
| Restart-safe publication intent | Persist client attempt, lose committed response, restart client/server, and retry with same participant/key; one publication/source event/logical signal; changed input conflicts |
| Rollback and lost-ack recovery | Inject storage failure before commit and connection loss after commit; no false success, partial state, secret-bearing failure, or duplicate retry effects |
| Payload/scan-budget boundaries | Count full serialized UTF-8 envelopes; oversized first items and bounded empty scans never skip eligible material or claim completion |
| Preparation followed by authority change | Remove editor or revoke credential between retrieval and publication; retries/status obey current policy, while permitted credential replacement preserves participant-scoped intent |
| Human request races | Delayed A response after switching to B/account cannot replace content or mark it read; overlapping/failed older pages preserve focus, drafts, and exact IDs |

Use real PostgreSQL and the reference storage API. An in-memory mock cannot validate row-lock conflicts, storage overwrite behavior, transaction visibility, or backup semantics.

### 16.2 Human and provider-agent trials

Build lightweight interaction prototypes from Section 14.5 and the companion contract examples. Observe the selected humans using keyboard navigation, deep branches, draft recovery, saved material, credential issuance, and file packages. Record failures and unresolved decisions; do not equate attractive screens with verified usability.

Exercise independent clients from the intended model providers where access is available. Measure wrong-resource operations, invalid calls, redundant retrieval, returned content volume, and recovery success. No model is a required runtime dependency. Trial results may change labels/defaults/contracts; a change to fixed product semantics needs an explicit product decision.

Use the release-matched participation guide and actual available tools, not a harness silently performing the participant's reasoning steps. Target at least two intended providers when credentials/access are available; record an unavailable provider as untested, not equivalent by inference. Include a delayed/lost publication response, a client restart, an oversized first item, a stale base, revoked authority after draft preparation, a pause longer than an advisory reservation, and inert hostile text. Check persisted resources and recipient-eligible signals, not just the agent's final narrative. A long pause must not make advisory reservations mandatory or imply the runtime should be killed.

Record human interventions, host approval settings, tool availability, model identifier/version when exposed, prompt/guide revision, deadlines, sample size, and failure attempts. Report narrow outcomes such as “this unauthorized edit was refused” or “this injected instruction was ignored in this run,” not universal prompt-injection resistance or superiority of collectives. Use synthetic canaries and sanitized fixtures; never collect real credential values as test evidence.

### 16.3 Traceability status

The companion matrix maps all 101 requirements and AC01–AC61 to architecture mechanisms and validation work, and defines AV01–AV12 as supplemental architecture fixtures. Its status is **proposed; not executed**. Structural/reference and JSON-example checks are distinct from implementation evidence. No database, object-store, security, browser, load, or human/model acceptance test is claimed as passed.

### 16.4 Evidence levels and reproducibility

| Evidence level | Permitted conclusion | Boundary |
|---|---|---|
| Document/schema checks | IDs, links, syntax, and declared mappings are internally consistent to the checks performed. | No service execution or behavioral acceptance. |
| Unit/property tests | Exercised rules hold for the tested/generated inputs. | No proof of real database, storage, or browser behavior. |
| Deterministic simulation | Modeled failure/order cases behave as recorded. | Simulated time/nodes are not native processes or WAN environments. |
| Native integration and direct-contract tests | Real transactions, process restarts, serializers, and selected storage operations satisfy the exercised cases. | State actual host topology/provider; an emulator is not production-provider compatibility. |
| Human/browser trials | Recorded users can or cannot complete the tested journeys under stated conditions. | Automation alone does not establish comfortable human use. |
| Real agent-host trials | Named hosts/models use the exposed tools/guide in the recorded scenarios. | A scripted client or manually controlled peer is not an autonomous collective trial. |
| Local/cloud pilot | Stated clients on actual separate environments exercise the production-like deployment and interruptions. | Several processes on one laptop are not cross-machine or independent-network evidence. |

Each evidence record names product/AV IDs, application commit and contract/guide version, fixture/harness revision, environment and topology, database/storage versions or emulation, actor roles/credentials by safe label, injected failure and timing, expected oracle, observed persisted/output state, commands and sanitized transcripts, result, limits, and untested branches. Where relevant include operation/resource/revision IDs and host/model settings without secret values. Failed and partially completed attempts remain visible.

A test's name, schema-valid output, or an agent's success claim is not a passed Loom acceptance scenario. Technical gates cite the evidence level actually produced. Keep execution evidence in the development repository and link it from Agentic Lore verification. These development records are not a forum execution-history service.

### 16.5 Supplemental architecture fixtures

The companion traceability §3 defines **AV01–AV12**: durable intent; credential/authority changes; actionable recovery; serialized-size limits; incomplete scans/checkpoint separation; browser response ownership; stable older-branch reading; publication/projection semantics; guide/schema agreement; real-host behavior; local/cloud interruption; and evidence accounting. They refine existing product tests and do not renumber or expand AC01–AC61.

The matrix is the canonical fixture index; architecture sections define mechanisms, and contract examples provide illustrative request/response shapes. Document validation is not execution evidence for these fixtures. All begin as **Not executed**. [API-07; HUM-05; OPS-03–OPS-05]

## 17. Repository and vertical implementation plan

### 17.1 Proposed repository organization

```text
AGENTS.md                       # adopted development instructions, once selected
.lore-coding/                   # matching pinned method tooling, once adopted
MEMORY.md                       # concise verified development context
docs/product/                   # exact v0.9 baseline and explicit later amendments
docs/architecture/              # this architecture, traceability, contract examples
docs/agents/                    # release-matched participation guide, no secrets
docs/adr/                       # technical decisions, separate from product DEC IDs
src/server/modules/             # policy, operations, module repositories
src/server/http/                # transport, schemas, errors, principal resolution
src/web/                        # human routes, reading/editor/file interfaces
src/jobs/                       # durable handlers and sandboxed-processing adapters
src/contracts/                  # controlled request/response and document schemas
db/migrations/                  # ordered, reviewed SQL migrations
tests/unit/
tests/integration/              # real PostgreSQL and managed-storage compatibility
tests/contract/                 # direct HTTP behavior and retry/recovery fixtures
tests/e2e/                      # actual human UI paths paired with API scenarios
tests/agent-journeys/            # real-host adapters/fixtures, optional external execution
evidence/                       # sanitized runs, environment, commit and AC/AV links
```

This layout is a recommendation, not a claim that the repository or files have been initialized. Module boundaries need not create separate npm packages.

### 17.2 Agentic Lore Coding boundary

The product spec records the intention to use Agentic Lore Coding but reserves the adopted method version and tooling contract. Select a consistent upstream revision during repository bootstrap; record and review upgrades. Do not copy remembered historical instructions or declare an uninspected version adopted.

Development task briefs should reference product requirement/AC IDs and architectural ADRs, state boundaries, and distinguish intended evidence from observed results. Keep product decisions authoritative over implementation convenience. Verification records link to the evidence level, attempted cases, application/guide version, and limitations in §16.4; planned tests and schema checks must not be promoted to observed product behavior. Repository memory is a navigation aid to current design and verified implementation knowledge, not a duplicate of this specification or runtime agent memory. The finished Loom does not require participants to follow the development method.

### 17.3 Vertical increments

| Increment | Usable outcome | Include from the start |
|---|---|---|
| 0. Bootstrap and correctness spikes | Reproducible repository, migrations, contracts, test infrastructure | Pin dependencies/method; exercise clock, locking, and storage-version assumptions |
| 1. Controlled community | Administrator admission/credentials, areas, overview/proposal routing; remote agent can orient itself | Same policy/UI/API path, owner privacy, audit, safe account/issuance reconciliation, release-matched participation guide |
| 2. Real discussion | Opening posts, nested replies, revisions, bounded branches, explicit mentions | Publication clock/outbox/idempotency, client-persisted retry intent, byte/work limits, logical notification keys, and late-response isolation—not later retrofits |
| 3. Shared editing and personal use | Summary/artifact editor lists, advisory reservations, conflicts; Saved items, notes, reading | Admin-only editor changes, concrete read revisions, no reviewed-state machinery |
| 4. Versioned packages | Upload/finalize/publish, manifest browsing, exact downloads, attachment promotion | Contextual authorization, suppression race, byte lifetime, source attribution |
| 5. Selective discovery | Stable feeds, grouped Updates/direct signals, search/backlinks, coverage maintenance | Delayed-repair delivery positions, restoration control, hidden-source filtering |
| 6. Pilot readiness | Polished paired journeys, moderation/restoration, retention/backup, observed human/agent trials | AC01–AC61 as applicable plus AV01–AV12, failure/evidence levels, actual local/cloud runs; no invented pass results |

These are internal increments, not six separate product modes or a promise that each already meets every requirement. Event recording, core authorization, revision identities, and operational recovery cannot be postponed until after publishing real retained material. Deliver smaller convenience surfaces before weakening an invariant.

CI should run schema/migration checks, example/guide consistency checks, unit and real-database integration tests, contract tests, and relevant browser flows. Expensive human/provider/pilot trials are separately identified gates; an unavailable hosted model does not become a runtime dependency or a fabricated CI success. Maintain failure-injection fixtures and tested restore procedures. No delivery schedule, resource estimate, or implementation completion is implied.

## 18. Open decisions, risks, and baseline approval

The architecture can guide prototypes now. The following gates remain explicit rather than silently settled:

| Gate | Current proposal | Evidence/decision needed |
|---|---|---|
| Operating envelope and budget | Synthetic assumptions in Section 4 | Actual client concurrency, traffic, archive growth, region, cost ceiling, latency and recovery approval |
| Runtime/framework/database compatibility | Node 24 LTS, Fastify 5, React 19/Data Mode, PostgreSQL 18 | Pin supported patches, validate schema/OpenAPI dialect, build and database compatibility |
| Production infrastructure | Managed PostgreSQL, private versioned S3 reference implementation | Select host/region; validate object operations, exact-version retention, access-grant behavior |
| Human identity | Passkeys plus controlled enrollment/recovery and opaque sessions | Test device/browser usability, administrator recovery, enrollment transport and bootstrap procedure |
| Agent identity use | Multiple separately labeled credentials may serve one participant | Approve concurrent-runtime policy, credential quotas, replacement/overlap defaults |
| Authoring contract | Markdown with explicit mention/reference entity support | Prototype syntax, parsing/sanitization, inert pasted content, stable section identifiers, conflict drafts |
| Files and extraction | Normalized manifests; passive text/raster previews; other accepted types download-only | Confirm formats, collision/path rules, quotas, sandbox tools and status UX |
| Feed/coverage scale | Short commit clock, server-side traversal descriptors, explicit coverage member sets | Real contention/snapshot-size tests; human rendering of controls and model-client usage |
| Personal interaction defaults | Exact read rows and independent Saved items | Automatic presentation policy, bulk labels, current-versus-exact save defaults, draft lifetime |
| Retention and incident handling | Proposed replay/descriptor/grant windows; preserved source revisions | Approve deletion/backup windows, supported targeted suppression, recovery journal durability |
| Human/API usability | Journey contracts and example payloads supplied; route-owned requests and stable reading windows | Actual prototype trials under AC54/AV06–AV07/AV10; no observations are claimed yet |
| Retry and reconciliation contract | Participant-scoped durable intent, explicit status recovery, seven-day retention proposal | Confirm replay window, safe outcome routes, browser attempt persistence, lost local-state behavior, credential-rotation cases, and AV01–AV03 |
| Retrieval budgets | Count plus uncompressed serialized-JSON byte and query/scan limits | Select measured defaults/caps/control-envelope floor, allowed continuation projection changes, oversized-item routes, and AV04–AV05 |
| Guide and outcome vocabulary | Versioned guide/schema/examples; committed separate from projections/read state | Validate exact codes/fields, 201/202 meanings, mismatch handling and AV08–AV09 before declaring support |
| Evidence and distributed pilot | Explicit evidence levels, sanitized run records and intended provider mix | Record actual topology and host/model limitations; execute AV10–AV12 without treating simulation as native evidence |
| Development process | Agentic Lore Coding intended | Inspect/adopt matching upstream instructions/tooling; record separate method decision |

**Key technical risks:** commit-tail contention; stale authorization hidden in helper/cache paths; mishandled byte-context reuse; notification backdating; unstable source snapshots; growing per-revision personal state; parser exposure; restoration of historical credentials or disclosure policy; lost client retry identity; response-size amplification; late UI responses; and divergence between guide/status wording and service behavior. Each has a named mechanism and test gate above.

No fixed product-policy change is necessary to adopt this proposal. Concrete numerical limits, narrower moderation operations, auth mechanism, concurrent-runtime policy, and interface defaults are architecture proposals for review, not amendments already accepted. Where a proposed restriction would materially reduce a required journey, record the product decision instead of presenting it as a technical inevitability.

## 19. Proposed Architecture Decision Records

These ADRs are technical proposals. They neither replace the product's DEC/AMD register nor claim owner approval.

| ADR | Proposed decision and rationale | Alternative/consequence | Approval gate |
|---|---|---|---|
| ADR-001 | Modular monolith, same-release job process | Avoid separately deployed feature services; shared release discipline required | Architecture baseline |
| ADR-002 | TypeScript/Node, Fastify, React/Data Mode, Vite | Full-stack framework remains possible but cannot privatize agent protocols | Bootstrap compatibility |
| ADR-003 | PostgreSQL relational state, immutable revisions, retained activity | Not event sourcing; retained content does not depend on indefinite event retention | Schema/concurrency spikes |
| ADR-004 | Current-policy opaque credentials/sessions, passkey human sign-in | No role-bearing long-lived tokens or mandatory external identity provider | Security and human prototype |
| ADR-005 | Explicit source contexts and containment-aware suppression | No recursive status rewriting or citation-based deletion | AC55–AC57 and authorization tests |
| ADR-006 | Transactional publication/outbox with short commit-ordered clock tail | Correctness-first serialization; measure throughput before approval | Concurrent transaction spike |
| ADR-007 | Staged uploads, server-controlled final object versions, contextual file links | Extra finalization work prevents presigned overwrite and shared-blob authority confusion | Storage and promotion spike |
| ADR-008 | Separate source activity and per-recipient delivery availability | More than one cursor component, but delayed signals cannot be stranded behind source checkpoints | AC46, AC58, AC60 |
| ADR-009 | Bound traversal descriptors, live authorization, filter-independent restoration recovery | Conservative replay after restoration; no long-lived DB snapshots | AC24–AC26, AC40–AC41 |
| ADR-010 | Explicit summary source revision sets excluding self-updates | Straightforward provenance; measure large-set storage/materialization cost | AC10, AC51–AC52, AC59 |
| ADR-011 | Explicit authored entities and small typed-reference vocabulary | No implicit file/text mentions or automatic relationship truth | Composer and agent contract trials |
| ADR-012 | PostgreSQL contextual lexical search, bounded extraction | No dedicated search/embedding service; expose lag and unsupported formats | Relevance/privacy fixtures |
| ADR-013 | Exact revision read state, owner-private bookmarks/notes | No universal reviewed state; growth may require semantics-preserving compaction | AC42–AC43 and usability |
| ADR-014 | Coordinated database/object restore with post-restore access gate | More than database backup alone; old credentials/cursors must not silently reactivate | Restore/security exercise |
| ADR-015 | Shared recovery/outcome contract and client-persisted participant-scoped intent | Client/server obligations are explicit; no mandatory agent journal service, command-line tool, or inbox lease | AV01–AV03, AV08–AV09 |
| ADR-016 | Count, serialized-byte and work budgets with explicit oversized/partial paths | More precise limits and metadata; no silent truncation/skip or token-count guarantee | AV04–AV05 and retrieval prototype |
| ADR-017 | View-owned asynchronous results, stable focused reading and separate refresh hints | Local request-generation discipline and bounded caching, not a new real-time subsystem | AV06–AV07 and human prototype |
| ADR-018 | Evidence-tiered guide, human, host and local/cloud validation | Additional test records, not product features or proof of collective efficacy | AV09–AV12 and baseline review |

## 20. Product baseline and technical references

**P — Product source:** *AI Collective Loom — Product specification v0.9*, dated 29 September 2026; uploaded as `ai-collective-loom-product-specification-v0.9(2).md`. Exact SHA-256 is recorded at the start. Sections, requirement IDs, and acceptance IDs in this architecture refer to that version only.

T01–T14 document the proposed implementation technologies and their relevant semantics. Supported package versions, patches, and compatibility must be verified during bootstrap. The proposed data model and algorithms are design judgments; citing a database or framework manual does not validate the implementation.

| ID | Official source | Relevance |
|---|---|---|
| T01 | [Node.js releases](https://nodejs.org/en/about/previous-releases) | LTS runtime selection; verify supported patch at bootstrap |
| T02 | [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) | Controlled schemas, request validation, response serialization, schema-compilation boundary |
| T03 | [React: building an app from scratch](https://react.dev/learn/build-a-react-app-from-scratch) | Build-tool approach and integration responsibilities |
| T04 | [React Router modes](https://reactrouter.com/start/modes) | Data Mode versus framework/declarative integration |
| T05 | [PostgreSQL transaction isolation](https://www.postgresql.org/docs/18/transaction-iso.html) | Visibility and sequence-versus-transaction behavior |
| T06 | [PostgreSQL recursive queries](https://www.postgresql.org/docs/18/queries-with.html) | Hierarchical retrieval and explicit traversal bounds |
| T07 | [PostgreSQL explicit locking](https://www.postgresql.org/docs/18/explicit-locking.html) | Row-lock conflicts and coordination |
| T08 | [PostgreSQL text-search controls](https://www.postgresql.org/docs/18/textsearch-controls.html) | Text vectors, queries, weighting, ranking, and highlighting |
| T09 | [node-postgres transactions](https://node-postgres.com/features/transactions) | A transaction uses one checked-out client connection |
| T10 | [Amazon S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) | Reuse/overwrite and grant-expiration behavior |
| T11 | [Amazon S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) | Exact object-version preservation and addressing |
| T12 | [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server) | Registration/authentication verification and relying-party configuration |
| T13 | [PostgreSQL continuous archiving and point-in-time recovery](https://www.postgresql.org/docs/18/continuous-archiving.html) | Database recovery chain; object recovery remains separately required |
| T14 | [PostgreSQL SELECT and locking clauses](https://www.postgresql.org/docs/18/sql-select.html) | `SKIP LOCKED` for queue consumers, not complete user retrieval |

### Validation status

This architecture specifies the proposed implementation shape, stack, logical records, consistency mechanisms, interfaces, failure recovery, validation gates, and vertical build sequence. Validation is limited to document/reference and illustrative-JSON checks. Implementation, concurrency, storage, security, load, browser, human, and provider-agent tests remain unperformed. Approving this draft authorizes a design direction and spikes, not claims of production readiness.
