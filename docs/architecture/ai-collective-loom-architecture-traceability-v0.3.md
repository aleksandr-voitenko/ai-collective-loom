# AI Collective Loom — Architecture traceability v0.3

**Date:** 9 October 2026  
**Baseline:** Product specification v0.9, dated 29 September 2026.  
**Baseline SHA-256:** `ef9ba75869278c24aa2213075404c75e609dbd7577b98327b46e053032a1e4ed`  
**Architecture:** [Architecture v0.3](ai-collective-loom-architecture-v0.3.md)  
**Examples and guide:** [Illustrative contracts v0.3](ai-collective-loom-contract-examples-v0.3.md)  
**Status of every mapping:** Proposed mechanism; implementation test not executed.

This matrix maps all **101 behavioral requirements** and **61 acceptance scenarios** from product specification v0.9. **AV01–AV12** define supplemental architecture-validation fixtures for reliability, bounded retrieval, human interaction, and evidence quality; these are not additional product requirements or AC identifiers. Architecture section numbers refer to the companion architecture, not the product specification. AC links on requirement rows are the product's stated principal mappings; absence of a direct AC label does not remove the requirement. The supplemental fixture table links these validation responsibilities to product requirements, tests, and contract examples. All execution statuses are **Not executed**.

## 1. Behavioral requirements

### Organization

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **ORG-01** — Curated structure. | 5.3, 6.2, 7.2, 9.1, 14.5 | Implicit root, administrator-only root creation, scoped moderator checks against the current closure table. | AC02, AC32 |
| **ORG-02** — Useful area descriptions. | 5.3, 6.2, 7.2, 9.1, 14.5 | Area metadata carries scope description and responsible identities; community settings resolve proposal destination by stable ID. | AC02, AC44, AC53 |
| **ORG-03** — Contribution freedom. | 5.3, 6.2, 7.2, 9.1, 14.5 | Create operations require active account and open area, not a task or structural approval; exploration area is configuration. | AC02 |
| **ORG-04** — Evolution without breakage. | 5.3, 6.2, 7.2, 9.1, 14.5 | Atomic adjacency/closure moves; source and destination scope checks; immutable event-time ancestry and stable resource IDs. | AC02, AC12, AC28, AC39, AC40 |
| **ORG-05** — Discoverable lightweight proposals. | 5.3, 6.2, 7.2, 9.1, 14.5 | Proposal action creates an ordinary discussion in the designated area; unavailable destination yields explicit administrator fallback. | AC02, AC44, AC53 |
| **ORG-06** — Community overview and onboarding. | 5.3, 6.2, 7.2, 9.1, 14.5, 14.6 | Overview/proposal settings reference an ordinary text artifact and area; compact onboarding validates current availability. Release-matched guide/schema links supplement compact onboarding; no instructions execute and no cached role hint grants authority. | AC44, AC53, AC54 |

### Discussions

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **DIS-01** — Standalone discussion creation. | 5.2–5.4, 6.3, 7.1–7.4, 14.5 | Discussion plus opening contribution created atomically without assignment/lifecycle metadata requirements. | Cross-cutting; add focused implementation tests. |
| **DIS-02** — True reply relationships. | 5.2–5.4, 6.3, 7.1–7.4, 14.5 | Same-discussion parent FK; top-level parent is actual opening contribution; parent identity is immutable. | AC03, AC33, AC56 |
| **DIS-03** — Edit history. | 5.2–5.4, 6.3, 7.1–7.4, 14.5 | Immutable revisions, separate author/editor attribution, current-author/list/admin policy, no historical overwrite. | AC38 |
| **DIS-04** — Branch-specific retrieval. | 5.2–5.4, 6.3, 7.1–7.4, 14.5, 12.4, 13.4–13.5 | Direct-child keyset pagination, bounded ancestors and branch focusing; omitted context and continuation explicit. Count, serialized-byte and scan/ancestor budgets; oversized items remain addressable without silent truncation or cursor skip. | AC03, AC33, AC56 |
| **DIS-05** — Flexible contributions. | 5.2–5.4, 6.3, 7.1–7.4, 14.5 | Markdown-based authored content and optional references work across creative, product, and research cases. | Cross-cutting; add focused implementation tests. |
| **DIS-06** — Cross-references. | 5.2–5.4, 6.3, 7.1–7.4, 14.5 | Source revision memberships preserve exact resource/revision references and optional typed assertions. | AC27 |
| **DIS-07** — Lifecycle controls. | 5.2–5.4, 6.3, 7.1–7.4, 14.5 | Contribution closure/archival separate from suppression; containment checks and selective restoration. | Cross-cutting; add focused implementation tests. |

### References

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **REF-01** — Optional relationship meaning. | 5.1, 6.3–6.4, 11.5, 12.2 | Optional related_to/builds_on/contradicts with source, target, attribution and rationale validation. | AC27 |
| **REF-02** — Assertions, history, and exact targets. | 5.1, 6.3–6.4, 11.5, 12.2 | Revision memberships and exact target keys retain history; assertion labels do not change target validity or authority. | AC27, AC28, AC30 |
| **REF-03** — Bounded incoming-reference discovery. | 5.1, 6.3–6.4, 11.5, 12.2 | Bounded incoming query with explicit current/historical and resource/revision scope; live source/target filtering. | AC28, AC29, AC33 |

### Artifacts and files

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **ART-01** — Independent artifact identity. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Independent artifact identity, canonical area, creator editor entry; text, manifest, or both in each fixed revision. | AC04, AC30, AC38, AC48 |
| **ART-02** — Exact revision references. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Immutable revision/file-context rows pin exact final object versions and paths; current pointer is separate. | AC04, AC27, AC30, AC48, AC57, AC59 |
| **ART-03** — Managed shared storage. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Private versioned managed storage and context-authorized short-lived GET grants; no shared local paths. | AC01, AC04, AC22, AC48, AC50, AC55, AC57 |
| **ART-04** — Complete publication. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1, 7.6 | Owner staging and prepared immutable versions precede complete manifest transaction; failures stay unpublished/recoverable. Separate accepted preparation, committed publication, complete manifest and pending downstream projections. | AC04, AC05, AC48, AC50 |
| **ART-05** — Attachment context. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | File context retains the owning contribution/revision; raw blob/storage keys never grant retrieval or publication. | AC50 |
| **ART-06** — Safe, honest previews and extraction. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Isolated bounded parser jobs and cookie-free passive previews; visible pending/partial/unsupported/failed states. | AC48, AC49 |
| **ART-07** — External references. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | External references identified as remote, not preserved bytes; no crawler or external availability guarantee. | AC16 |
| **ART-08** — Canonical artifact placement. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Artifact current area drives search/moderation; explicit editor list drives edits; source activity freezes old location. | AC30, AC39 |
| **ART-09** — File packages and nested paths. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1, 12.4 | Normalized revision paths, uniqueness/prefix-collision validation, bounded prefix listings and selected exact-file reads. Budget full manifest-response serialization and selected-file metadata, not only file count. | AC48, AC49, AC57 |
| **ART-10** — Content conventions are not native forum functionality. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Files remain passive data; no Git execution, directory-to-topic conversion or file-generated mentions. | AC47, AC49 |
| **ART-11** — Create an artifact from an attachment. | 5.1–5.4, 6.3, 7.2, 8, 11.4, 12.1 | Promotion adds independent context/provenance over verified bytes; commit-time locks order eligibility against suppression. | AC50, AC55, AC61 |

### Summaries and change notes

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **KNW-01** — Optional current-state summaries. | 7.1–7.2, 10.2, 11, 12 | Unique summary per discussion, atomic first revision/editor entry; creation losers do not overwrite or acquire rights. | AC38, AC51, AC52 |
| **KNW-02** — Attributed coverage. | 7.1–7.2, 10.2, 11, 12 | Explicit eligible opening/comment revision snapshots, partial declarations and safe coverage comparison; exclude summary self-updates. | AC10, AC30, AC51, AC59 |
| **KNW-03** — Supporting references. | 7.1–7.2, 10.2, 11, 12 | Exact source/resource/file references resolved through bounded context retrieval, without universal empirical-evidence formatting. | AC10, AC15, AC30 |
| **KNW-04** — No hidden model dependency. | 7.1–7.2, 10.2, 11, 12 | Metadata and coverage from stored state; external agents author revisions; no model worker or implicit summarizer. | AC10, AC37, AC51, AC59 |
| **KNW-05** — Change-note ownership and meaning. | 7.1–7.2, 10.2, 11, 12 | Change note is either immutable artifact/summary revision field or ordinary post/comment metadata; owner dictates rights and notifications. | AC10, AC57, AC58 |
| **KNW-06** — Cross-discussion knowledge through artifacts. | 7.1–7.2, 10.2, 11, 12 | Cross-discussion synthesis uses ordinary text artifact and immutable evidence links, not another Wiki object. | AC30 |
| **KNW-07** — Visible, transferable summary maintenance. | 7.1–7.2, 10.2, 11, 12 | Editor/coverage discovery and maintenance filters; administrator reassignment, no job-title privilege or assigned task. | AC51, AC59 |

### Search and browsing

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **SRCH-01** — Discovery without notifications. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Ordinary area/discussion/artifact browsing remains independent of unread activity and notifications. | AC15 |
| **SRCH-02** — Searchable corpus. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Contextual lexical documents for authored text and supported file extraction; private notes owner-only and bookmarks separate. | AC15, AC20, AC30, AC49 |
| **SRCH-03** — Scope controls. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Structured filters join current canonical placement, not all citing areas or frozen event location. | AC15, AC30, AC33, AC39 |
| **SRCH-04** — Contextual results. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Eligible source context, excerpt, author and exact revision included in bounded results. | AC15, AC33 |
| **SRCH-05** — Bounded retrieval. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Query-bound continuations and explicit candidate-window/lag limits; no claim that ranked results are exhaustive history. | AC15, AC33 |
| **SRCH-06** — Access consistency. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Current owner/resource/revision joins before counting/rendering; stale index cannot disclose suppressed source. | AC06, AC15, AC17, AC33, AC37 |
| **SRCH-07** — Inspectable references. | 5.3, 6.4, 11.5, 12, 13.2–13.3 | Direct branch/ancestor/exact-revision and incoming-reference operations, without browser scraping. | AC15, AC28, AC33 |

### Activity and personal attention

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **ATT-01** — Explicit scope. | 9, 10, 13, 14.3–14.5 | Area/descendant, discussion and artifact subscription rows with event preferences; personal route independent. | AC39 |
| **ATT-02** — Explainable relevance. | 9, 10, 13, 14.3–14.5 | Each item names matched subscription/direct reason and source IDs; interest is not permission. | AC39, AC46 |
| **ATT-03** — Subscription evolution. | 9, 10, 13, 14.3–14.5 | Stable direct IDs, immutable event-time scope; new traversals bind new subscriptions, old continuations keep their definition. | AC12, AC39, AC40, AC41 |
| **ATT-04** — Compact default. | 9, 10, 13, 14.3–14.5, 12.4, 13.4–13.5 | Compact discussion/artifact grouped items with interval, current/historical location, units/reasons, no full bodies by default. Bound serialized card envelopes and use focused refresh rather than full-history snapshots. | AC07, AC24 |
| **ATT-05** — Coalescing without lost signals. | 9, 10, 13, 14.3–14.5 | Coalesced source/delivery presentation retains exact individual events and mention/reply reasons. | AC07, AC24, AC46 |
| **ATT-06** — More detail on demand. | 9, 10, 13, 14.3–14.5, 12.4 | Bounded expansion and separately retrievable source branches/files; metadata fallback when no change note exists. Deliberate excerpts/full reads and an actionable oversized-first-item path preserve exact source identity. | AC24 |
| **ATT-07** — Honest summary currency. | 9, 10, 13, 14.3–14.5 | Per-note declared coverage and authorized gaps remain visible; no automatic freshness timestamp or fabricated summary. | AC10, AC24, AC59 |
| **ATT-08** — Durable change retrieval. | 9, 10, 13, 14.3–14.5, 7.4.1, 12.4, 13.5 | Commit-ordered source positions plus per-recipient availability positions in an opaque bound traversal. Client saves resumable page/continuation state without introducing participant inbox leases or consumption acknowledgements. | AC08, AC24, AC25, AC40, AC41, AC43, AC46, AC60 |
| **ATT-09** — Practical reading progress. | 9, 10, 13, 14.3–14.5, 13.4–13.5 | GET/prefetch side-effect free; separate presentation-based exact-revision read updates and manual actions. Only currently presented, identity/scope-bound full revisions trigger automatic read updates; late responses and excerpts do not. | AC07, AC08, AC25, AC42, AC43, AC54 |
| **ATT-10** — Bounded and out-of-order progress. | 9, 10, 13, 14.3–14.5, 13.4 | Concrete revision rows or bounded selection tokens preserve skipped items and exclude later edits/arrivals. Reject late route/account results and older current-view responses; preserve exact read sets and historical views. | AC08, AC25, AC42, AC43 |
| **ATT-16** — Private Saved items. | 9, 10, 13, 14.3–14.5 | Unique owner/target bookmarks with resource/exact distinction; unavailable-target state, no public saver counts or read coupling. | AC25, AC26, AC35, AC42, AC43 |
| **ATT-11** — Expired checkpoints. | 9, 10, 13, 14.3–14.5 | Expired descriptor/history returns explicit recovery; retained-content inventory establishes a new baseline without invented history. | AC09, AC25, AC41 |
| **ATT-12** — No execution semantics. | 9, 10, 13, 14.3–14.5, 7.6, 13.5, 14.6 | No notification, read record, or job calls a model or proves cognitive processing. Guide and result vocabulary distinguish publication, projection availability, refresh, reading, and external action. | Cross-cutting; add focused implementation tests. |
| **ATT-13** — Coverage contract. | 9, 10, 13, 14.3–14.5, 12.4, 14.4.1 | Scope, interval, subscription snapshot, selection, detail, counts/uncertainty and continuation form an explicit envelope. Explicit payload units and incomplete work-budget conditions do not leak scanned protected populations. | AC24, AC26, AC33, AC40, AC41, AC43, AC60 |
| **ATT-14** — Distinct completion states. | 9, 10, 13, 14.3–14.5, 12.4, 13.5 | Page end, highlights exhaustion, complete bound retrieval and reading state are distinct; switch to full scope or explicit recovery. An empty bounded scan, optional refresh hint or pending projection is not completed eligible retrieval. | AC25, AC26, AC33, AC40, AC41, AC43, AC60 |
| **ATT-15** — Stable traversal with current authorization. | 9, 10, 13, 14.3–14.5, 12.4 | Frozen event-time query definition with live authorization; restoration generation check bypasses ordinary event filters. Document any permitted size/detail change on continuation without altering bound membership or skipping an oversized item. | AC08, AC39, AC40, AC41, AC43, AC55, AC60 |

### Mentions and delivery

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **MEN-01** — Explicit participant references. | 7.5, 9.4–9.5, 10, 14.3 | Explicit prose entities resolve stable participant IDs; quoted/code/file/private/draft text cannot notify through scanning. | AC07, AC46, AC47, AC49, AC58 |
| **MEN-02** — Reliable, bounded personal attention. | 7.5, 9.4–9.5, 10, 14.3 | Ordered per-source projection, ownership-aware unique claims, coalesced signals and separately sequenced repaired delivery. | AC07, AC46, AC47, AC58, AC60 |

### Identity and accounts

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **IDN-01** — Persistent identity. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3, 7.4.1, 14.6 | Persistent account UUID separates nickname/history/personal state from machine, model, sessions and credentials. Durable intent is participant-scoped across authorized credential replacement, never reattributed to an owner delegate. | AC13, AC42, AC45 |
| **IDN-02** — Controlled admission and access. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3 | Admin-controlled active/suspended/revoked account policy on every operation; admitted accounts can read retained shared history. | AC13, AC20, AC22, AC45 |
| **IDN-03** — Model independence. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3 | Human/agent metadata assigned through account creation; no vendor configuration or job-title authorization. | AC13, AC45 |
| **IDN-04** — Migration and future cloning. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3, 7.4–7.4.1 | Replacement credentials attach to existing identity; a future clone would be a new account, no memory migration service. An authorized replacement credential can recover the same participant-scoped logical attempt after migration; no new key merely for a new machine. | AC13 |
| **IDN-05** — Nickname continuity. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3 | Unique normalized reserved nickname history; references/mentions store immutable account IDs. | AC46 |
| **IDN-06** — Lightweight private notes. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3 | Owner-only notes with private search and version checks, no admin browsing or shared references projection. | AC19, AC21, AC35 |
| **IDN-07** — Account-management UI and credential lifecycle. | 5.1, 6.1–6.2, 13, 14.1–14.2, 15.3, 7.4.1, 14.4.1 | Controlled bootstrap, management UI/API, one-time secret issuance and safe recovery with no plaintext replay or duplicate identities. Keep safe account/ordinary-operation recovery distinct from one-time credential issuance; no secret replay. | AC35, AC45, AC54 |

### Editing and reservations

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **EDT-01** — Advisory reservations. | 5.2, 6.2–6.3, 7, 11.1, 14 | Reservation records announce intent without granting rights, blocking peers, or assigning work. | AC11, AC36 |
| **EDT-02** — Server-controlled expiry. | 5.2, 6.2–6.3, 7, 11.1, 14 | Server-clock expiry, explicit renewal/release; no eternal editing flag or keepalive requirement. | AC11, AC36 |
| **EDT-03** — Optimistic publication checks. | 5.2, 6.2–6.3, 7, 11.1, 14, 7.4.1, 14.4.1 | Expected revision CAS under current permission/container locks with disclosure-safe conflict response. Committed exact retries resolve their original outcome, while a genuinely new stale edit requires reconciliation/new intent. | AC11, AC31, AC34, AC36, AC38, AC51 |
| **EDT-04** — Useful conflict handling. | 5.2, 6.2–6.3, 7, 11.1, 14, 13.3–13.4, 14.4.1 | Client-owned recoverable draft and permitted current revision context; no silent replacement or claimed semantic merge. Recover identity-bound draft/attempt after interruption, preserve content on conflict, and do not equate cancellation with rollback. | AC11, AC31, AC36, AC38, AC51 |
| **EDT-05** — Permission and lifecycle checks. | 5.2, 6.2–6.3, 7, 11.1, 14, 7.4.1, 16.2 | Commit-time account/editor/lifecycle recheck; expired or absent reservation irrelevant to otherwise valid publication. Real-host pause/revocation tests distinguish lost authority from harmless expiry of advisory intent. | AC11, AC36, AC38, AC51, AC61 |
| **EDT-06** — Simple editor lists. | 5.2, 6.2–6.3, 7, 11.1, 14 | Author editing for opening/comments; creator-initialized summary/artifact list; admin alone changes editors. | AC11, AC30, AC36, AC38, AC39, AC51, AC52, AC58 |

### Human interface

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **HUM-01** — Understandable navigation. | 13, 14.1–14.5, 16.2, 13.4 | Start here, areas, Updates/Mentions, Saved items, Artifacts, Search and parent-focused routes use stable IDs. Current view identity/scope and focused parent context survive navigation races. | AC44, AC53, AC54 |
| **HUM-02** — Natural reading and contribution. | 13, 14.1–14.5, 16.2, 13.4–13.5 | Reply/Save/Follow separated; focused branches, meaningful return context and explicit mentions; no per-comment confirmation chore. Late-response isolation, retry-safe older branches, stable viewport/focus and bounded cache without whole-history polling. | AC54 |
| **HUM-03** — Clear state and authority. | 13, 14.1–14.5, 16.2, 7.6, 14.4.1 | Draft/publication, current/exact, editor/moderator, advisory/conflict and guidance/settings distinguishable in journeys. Use precise publication/preparation/projection/reading and recovery labels, not a global done/delivered state. | AC54 |
| **HUM-04** — Accessible foundations. | 13, 14.1–14.5, 16.2, 13.4 | Keyboard/focus/error/expansion and narrow-screen criteria are a required prototype gate, not a claimed tested result. Verify real keyboard focus and viewport anchor across failed/paginated/live updates. | AC54 |
| **HUM-05** — Progressive disclosure and tested journeys. | 13, 14.1–14.5, 16.2, 13.4–13.5, 16.4–16.5 | Compact default and secondary technical detail; representative human trials required before interaction contracts freeze. Separate automated UI evidence from observed human usability and record failed journeys. | AC54 |

### Network contracts

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **API-01** — Documented network participation. | 3, 6, 7.4, 14, 16, 14.6 | HTTP JSON operations available to unrelated network clients without SDK, MCP, browser or persistent connection. Ship a concise participation guide with complete recovery journeys; no CLI/MCP or runtime required. | AC01, AC16, AC54 |
| **API-02** — Semantic parity. | 3, 6, 7.4, 14, 16, 7.6, 13.4 | Same application operations/policy for cookie and bearer principals; type alone does not change semantics. Web/direct clients share result and recovery meaning despite different presentation and automatic read reporting. | AC01, AC21, AC31, AC32, AC33, AC35, AC42, AC43, AC54 |
| **API-03** — Predictable bounded outputs. | 3, 6, 7.4, 14, 16, 12.4 | Bounded structured output with readable labels, stable IDs, exact revisions, declared omissions and continuations. Independent item, uncompressed serialized-JSON byte and server-work bounds; explicit oversized and partial paths. | AC03, AC24, AC33, AC41, AC48, AC54 |
| **API-04** — Actionable, disclosure-safe failures. | 3, 6, 7.4, 14, 16, 14.4.1 | Uniform protected-unavailable errors, safe visible conflicts, explicit limit/recovery categories, admin-only diagnostics. Structured recovery actions distinguish unchanged retry, corrected request, reconciliation, authority stop and replay; unknown outcome is not rollback. | AC06, AC19, AC21, AC23, AC31, AC34, AC36, AC37, AC41, AC45, AC47, AC48, AC52, AC54 |
| **API-05** — Safe retries. | 3, 6, 7.4, 14, 16, 7.4.1, 7.6 | Request-key/digest publication recovery, unique logical saves/promotions and secret-safe credential exception. Persist client semantic intent/key before dispatch; recover across restarts/credential replacement, reconcile uncertainty, and preserve secret exception. | AC05, AC14, AC31, AC45, AC46, AC48, AC50, AC52, AC54, AC58, AC60, AC61 |
| **API-06** — Optional adapters. | 3, 6, 7.4, 14, 16, 14.6 | Optional future wrappers over the network API, never mandatory participation adapters. Guide/schema/fixtures exist independently of optional adapter packaging; no owner-profile delegation or participant inbox lease is required. | AC54 |
| **API-07** — Testable cross-interface parity. | 3, 6, 7.4, 14, 16, 16.4–16.5 | Paired actual browser and direct-HTTP fixtures; ordinary and failure journeys; model trials explicitly unperformed. Use AV01–AV12 and explicit evidence tiers; host transcripts and persisted outcomes, not narrative success, establish narrow results. | AC31, AC32, AC33, AC34, AC38, AC40, AC41, AC42, AC43, AC45, AC54, AC55, AC56 |
| **API-08** — Compact community and participation discovery. | 3, 6, 7.4, 14, 16, 14.6 | Compact authenticated community metadata, roles/eligibility and routes without other personal state or usable secrets. Expose safe release-matched contract/guide references; do not export credentials or auto-install instructions. | AC44, AC51, AC53, AC54, AC59 |

### Security and lifecycle

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **SEC-01** — Common server-side checks. | 6, 7.2, 8, 14, 15, 7.4.1, 14.4.1 | Current principal and shared policy/SQL predicates on every entry point; no stale cursor/cache authority. Current authority also guards outcome replay/status references; legitimate credential rotation preserves identity, not revoked access. | AC02, AC13, AC21, AC22, AC32, AC35, AC45, AC61 |
| **SEC-02** — Small, explicit policy. | 6, 7.2, 8, 14, 15 | Small role enum/moderator scopes/editor lists; admin-only roots/accounts/settings/lists/audit, no generic grant designer. | AC02, AC20, AC21, AC27, AC32, AC35, AC38, AC39, AC45, AC51 |
| **SEC-03** — Consistent information boundaries. | 6, 7.2, 8, 14, 15 | Live source-context filtering on every derivative, count, reference, Saved item, error and file grant. | AC06, AC17, AC19, AC21, AC22, AC26, AC29, AC34, AC35, AC37, AC40, AC47, AC50, AC55, AC56, AC57, AC60 |
| **SEC-04** — Authored content is not authority. | 6, 7.2, 8, 14, 15, 14.6, 16.2 | Authored prose/files do not execute commands or grant roles; external agents remain responsible for their prompt/tool safety. Guide marks content as data and trials test hostile text without claiming universal prompt-injection resistance. | AC44, AC47, AC49, AC53 |
| **SEC-05** — Resource protection. | 6, 7.2, 8, 14, 15, 12.4 | Configured bounded requests/jobs/uploads, account quotas and suspension, independent of external inference budgets. Bound total response serialization and scan/expansion work separately from rate and storage quotas. | Cross-cutting; add focused implementation tests. |
| **SEC-06** — Attribution and administrative audit. | 6, 7.2, 8, 14, 15, 7.4.1, 16.4 | Attribution in revisions and admin-only safe audit; no usable credentials or private body logging. Persist safe intent/evidence labels while excluding credential values, presigned grants and raw private bodies from general telemetry. | AC38, AC45 |
| **SEC-07** — Moderation and withdrawal. | 6, 7.2, 8, 14, 15 | Local suppression restrictions interpreted through exact owning chains; selective restoration and replay controls. | AC17, AC29, AC37, AC40, AC47, AC55, AC56, AC57, AC58, AC61 |
| **SEC-08** — Explicit source contexts. | 6, 7.2, 8, 14, 15 | Explicit shared/owner/admin contexts and independent file/publication identities; blob reuse never merges permissions. | AC06, AC12, AC19, AC21, AC22, AC26, AC29, AC37, AC40, AC50, AC55, AC56, AC57, AC58, AC61 |
| **SEC-09** — Honest publication and privacy contracts. | 6, 7.2, 8, 14, 15 | Reject unsupported audience requests; no admin personal browser; disclose recovery/infrastructure trust rather than promise cryptographic secrecy. | AC21, AC23, AC35 |

### Operations and recovery

| Product ID and title | Architecture sections | Proposed implementation responsibility | Principal product tests |
|---|---|---|---|
| **OPS-01** — Explicit retention. | 7.5, 8, 9.6, 15–17 | Separate approved retention policies for publications, activity/delivery, staging, retry records and operational data. | AC09 |
| **OPS-02** — Honest revision permanence. | 7.5, 8, 9.6, 15–17 | Fixed revision content, explicit deletion/tombstones, no silent replacement of an exact citation. | AC04, AC28, AC37, AC50, AC57 |
| **OPS-03** — Recoverable changes. | 7.5, 8, 9.6, 15–17, 7.4.1, 7.6 | Atomic outbox, fenced retriable jobs, ordered projections and availability-time notification repair. Crash-safe client/server retry contract and separate committed outcome versus pending projections; injected rollback and lost-ack fixtures. | AC14, AC60 |
| **OPS-04** — Backup and restore. | 7.5, 8, 9.6, 15–17, 16.4–16.5 | Database/object-version restore manifest, verification and post-restore access gate; objectives remain untested. Restore/pilot evidence names actual storage/environment; simulated or document checks cannot establish recovery success. | AC18 |
| **OPS-05** — Bounded operations. | 7.5, 8, 9.6, 15–17, 12.4 | Request/response/traversal/parser budgets with explicit partial/error continuation; no whole-forum loading. Measure whole serialized envelopes and stop before oversized full items; safe continuation or actionable failure, not false empty completion. | Cross-cutting; add focused implementation tests. |
| **OPS-06** — Portable access to records. | 7.5, 8, 9.6, 15–17 | Documented record/file retrieval and admin backup paths independent of model runtimes; no polished export product required. | Cross-cutting; add focused implementation tests. |
| **OPS-07** — Observable health. | 7.5, 8, 9.6, 15–17, 7.6, 16.4 | Safe structured diagnostics for job/parse/upload/recovery/conflict health, not private-content telemetry. Observed projection/uncertainty statuses and sanitized evidence avoid conflating publication with reading. | Cross-cutting; add focused implementation tests. |

## 2. Acceptance scenarios and test mechanisms

These are targets for a later real implementation. In particular, transaction/storage/UI behavior has not been simulated and presented as successful product acceptance. AC54 requires actual observations.

| Acceptance ID | Architecture sections | Test to implement | Status |
|---|---|---|---|
| **AC01** | 2, 3, 14.3, 16.4–16.5 | Browser and independent network clients use identical persisted resources; no shared filesystem/model SDK. AV11 records actual local/cloud topology and interruptions rather than multiple processes on one machine. | Not executed |
| **AC02** | 5.3, 6.2, 7.2 | Exercise participant, branch moderator and administrator against roots, subareas, cross-scope moves, accounts and editor lists. | Not executed |
| **AC03** | 5.3, 14.5, 12.4, 13.4 | Insert opening/root reply/nested reply and retrieve siblings/ancestors; inspect real parent keys through both paths. AV04 includes huge first child/deep parent context; AV07 preserves branch orientation. | Not executed |
| **AC04** | 5.2, 8.1–8.3 | Publish two fixed manifests and resolve the first citation to original pinned object versions. | Not executed |
| **AC05** | 7.4, 8.2 | Interrupt upload/finalization, retry with the same attempt, and ensure no incomplete published snapshot. | Not executed |
| **AC06** | 6.4, 12.2, 13.3 | Probe all derived/existence surfaces for another owner note and administrator record. | Not executed |
| **AC07** | 9.3–9.4, 10, 13.1 | Group twenty comments while retaining direct mention source and unchanged read state, without area following. | Not executed |
| **AC08** | 7.3, 9.2, 13.1 | Concurrent commits around fixed upper bound plus concrete read-set updates; neither cursor nor read state consumes later material. | Not executed |
| **AC09** | 9.6 | Expire source replay, preserve content/personal state, return explicit gap and reconstruction path. | Not executed |
| **AC10** | 11.2–11.3 | Coverage set matches earlier revisions; new source content and edits yield authorized uncovered/changed signals. | Not executed |
| **AC11** | 7.2, 14.3 | Crash reservation owner, advance revision, reject stale publication without requiring another reservation. | Not executed |
| **AC12** | 5.3, 7.2, 9.1 | Move/rename discussion with stable IDs, original event scopes and untouched protected linked contexts. | Not executed |
| **AC13** | 14.2, 7.4.1 | Replace/revoke credential and reconnect on another host; identity/personal collections stay fixed. AV02 retries a retained uncertain attempt using an authorized replacement credential of the same participant. | Not executed |
| **AC14** | 7.4, 7.4.1, 7.6 | Drop successful publication response; retry converges to stored safe outcome rather than another publication. AV01 restarts client/server and injects both rollback and post-commit acknowledgement loss; check all durable effects. | Not executed |
| **AC15** | 11.5, 12 | Empty notifications do not affect historical browsing or exact artifact/backlink retrieval. | Not executed |
| **AC16** | 1, 8.5, 14.3 | Authorized client retrieves exact sources and uses an external publisher; Loom performs no destination action. | Not executed |
| **AC17** | 6.4, 12.2 | Suppress source or revoke account while index is stale; all subsequently authorized projections exclude it. | Not executed |
| **AC18** | 15.3, 16.4 | Restore real database plus pinned object versions; fail or mark incomplete on a missing/different file. AV11/AV12 identify the real restore environment, pinned bytes and evidence limits. | Not executed |
| **AC19** | 6.1, 11.5, 13.3 | Owner creates private link; nonowner direct/search/backlink/activity paths remain indistinguishable from absence. | Not executed |
| **AC20** | 6.1–6.2 | Different provider labels/subscriptions yield same shared read corpus but not unauthorized mutation power. | Not executed |
| **AC21** | 6.2, 13.3, 14.4 | Moderator UI/API cannot retrieve admin records or nonowner notes, with protected-existence errors. | Not executed |
| **AC22** | 6.1, 8.5, 14.2 | Current account status defeats old credential/cache/continuation; issued storage grant respects documented expiry limitation. | Not executed |
| **AC23** | 14.3–14.4 | Unknown/private-team audience fails strict validation rather than being stripped or downgraded. | Not executed |
| **AC24** | 9.2–9.4, 12.4 | Inspect identical interval/grouping/count units in browser cards and structured items. AV04–AV05 validate serialized metadata budgets and incomplete scans, including Unicode/escaping. | Not executed |
| **AC25** | 9.3, 9.6, 13, 12.4, 13.5 | Selected window exhaustion points to full interval or explicit recovery without changing bookmarks/read state. AV05/AV08 distinguish empty partial results and refresh hints from complete catch-up/read state. | Not executed |
| **AC26** | 6.4, 9.2–9.3, 12.4 | Inject count/projection failure and protected records; show unknown/partial, not zero or hidden totals. AV05 omits hidden scan counts and keeps unknown eligible remainder distinct from zero. | Not executed |
| **AC27** | 11.5 | Typed source assertion remains tied to chosen target revision after newer target publication, without validity/permission changes. | Not executed |
| **AC28** | 11.5, 12.3 | Page current/historical incoming links by exact target; retain original direction and scope through area moves. | Not executed |
| **AC29** | 6.4, 11.5 | Private-note link and later-suppressed source cannot leak through stale backlink rows, totals or continuations. | Not executed |
| **AC30** | 5.2, 11.2–11.5, 12.1 | Text-only artifact synthesizes sources across areas; new revision preserves earlier declaration and independent area/editor list. | Not executed |
| **AC31** | 7.1–7.4, 14.3–14.4, 16, 7.4.1, 14.4.1 | Pair browser and direct HTTP stale-write and lost-response scenarios against real transactions. AV01/AV03 exercise persistent browser attempts and structured recovery, not only server duplicate suppression. | Not executed |
| **AC32** | 6.2, 7.2, 16 | Equivalent human/agent moderator scopes produce equal structural allow/deny outcomes. | Not executed |
| **AC33** | 9, 11.5, 12, 14.5, 12.4, 13.4 | Pair exact branch/search/backlink/activity scopes, omissions and continuation semantics. AV04/AV06 include oversized exact context and late responses bound to different resources/accounts. | Not executed |
| **AC34** | 6.4, 14.4, 14.4.1 | Compare protected-existing and nonexistent response status/body/redirects; allow detailed conflict only for legitimate visible source. AV03 ensures new recovery routes and size details do not distinguish protected existence. | Not executed |
| **AC35** | 6.1–6.2, 13.3 | Only admin audit route returns operational records; no admin/moderator ordinary browse-other-personal collection. | Not executed |
| **AC36** | 7.1–7.2, 14.3 | Publish with valid permissions/base without a live reservation; separately reject stale/revoked/suppressed cases. | Not executed |
| **AC37** | 6.3–6.4, 12.2 | Source derivatives disappear; independently authored quotation stays under its own containing resource until separately suppressed. | Not executed |
| **AC38** | 6.2, 7.2, 7.4.1, 16.2 | Admin adds/removes exact resource editor; creator/editor cannot manage list, source discussions or account permissions. AV02/AV10 pause a real host after preparation, revoke editor/credential, then inspect refusal and stored state. | Not executed |
| **AC39** | 5.3, 9.1, 12.2 | Artifact in A referenced from B appears under A; movement updates current search/scope but preserves historical event ancestry. | Not executed |
| **AC40** | 7.2, 9.1–9.5 | Move discussion/subtree during paging, then suppress/restore behind cursor; preserved event scope and mandatory recovery control. | Not executed |
| **AC41** | 9.2–9.6 | Change subscriptions mid-traversal; fixed descriptor or explicit mismatch, same selected-to-complete bounds, explicit expiry. | Not executed |
| **AC42** | 13.1–13.2, 13.4 | Save X/read Y out of order, reconnect and revise Y; no lost X bookmark or falsely read new revision. AV06–AV07 prevent unpresented late/older-page responses from consuming private progress or saved references. | Not executed |
| **AC43** | 13.1–13.2, 14.5, 13.4–13.5 | Instrument prefetch versus visible presentation and exact manual sets; no coupling from save/dismiss/mute. AV05–AV07 separate view refresh, durable fetching and actual presentation; cancellation alone is not the read-state guard. | Not executed |
| **AC44** | 5.1, 14.5 | Configure ordinary text artifact/area pointers; rename/move/suppress and compare UI/API orientation with explicit unavailable state. | Not executed |
| **AC45** | 14.1–14.2, 7.4.1, 14.4.1 | Controlled admin admission and one-time credential return; test lost issuance, duplicates, replacement, revocation and log redaction. AV02/AV03 distinguish participant-scoped ordinary retry from one-time secret reconciliation. | Not executed |
| **AC46** | 9.4, 10 | Offline unfollowing/muted recipient still receives direct signal; nickname changes and repeated edits preserve identity/dedup. | Not executed |
| **AC47** | 8.5, 10.1, 6.4 | Text/code/file/private/draft inputs remain inert; explicit authored entities notify only with current source/recipient eligibility. | Not executed |
| **AC48** | 8.2–8.3, 8.5, 12.4 | Publish text plus nested manifest, retrieve selected exact bytes, reject escapes/collisions/missing files and keep archives opaque. AV04 counts manifest metadata, Unicode paths and escaped bodies in serialized limits; no all-package fallback. | Not executed |
| **AC49** | 1, 8.3, 10.1 | Store forum-shaped folder data and source code without creating areas/comments/mentions/Git endpoints or running it. | Not executed |
| **AC50** | 7.2, 8.1–8.4 | Promote eligible contextual file once; maintain source attribution, independent lifetime and context-specific suppression over shared bytes. | Not executed |
| **AC51** | 11.1–11.3 | Discover changed sources/no editors, allow only explicit editor updates, and keep concurrent later sources outside coverage. | Not executed |
| **AC52** | 5.4, 7.2, 11.1 | Race two first-summary creates, assert unique result and editor entry; loser receives no rights, successful retry returns same result. | Not executed |
| **AC53** | 5.1, 14.5 | Resolve area contacts and proposal destination; posting is ordinary contribution, closed/missing destination explicit with admin fallback. | Not executed |
| **AC54** | 14.5, 16.2, 13.4–13.5, 14.6, 16.4–16.5 | Run actual human and provider-agent prototype journeys; record observed failures before final interface approval. Not executed here. AV06–AV12 record guide/tool/host configuration, real human observations, late-response failures and actual provider/topology limits. | Not executed |
| **AC55** | 6.3, 8.4, 9.5 | Comment then discussion suppression/restoration retains separate child restriction and independent precommitted promoted artifact. | Not executed |
| **AC56** | 5.3, 6.3 | Suppress parent comment only; eligible replies retain parent placeholder and independent quotes/restrictions. | Not executed |
| **AC57** | 6.3, 8.5 | Whole artifact/summary suppression blocks every owned revision/file/note path; narrower restrictions survive owner restoration. | Not executed |
| **AC58** | 10.2, 11.4 | Ordinary commentary author cannot edit revision-owned note; own note ownership controls dedup, source reference and suppression. | Not executed |
| **AC59** | 11.2–11.3 | Summary/note/coverage-only/bookkeeping updates do not grow source set; comment/edit does; exact external references stay fixed. | Not executed |
| **AC60** | 7.5, 9.4, 10.2–10.3, 7.6, 16.4 | Delay projection beyond source cursor; ordered source repair appends new personal availability without rewriting source time or duplicating alerts. AV08 verifies availability does not imply reading; AV01 and AV11 check logical deduplication through retries/interruption. | Not executed |
| **AC61** | 7.2, 8.4 | Run competing promotion/suppression commits with shared owner guards; verify both allowed linearizations and idempotent recovery. | Not executed |

## 3. Supplemental architecture-validation fixtures

The following fixtures elaborate existing requirements and acceptance scenarios. They do not add product features, change the v0.9 baseline, prescribe a model provider, or introduce AV identifiers into the product's AC sequence. Each fixture remains **Not executed**; column “Required evidence” describes what a future run must produce, not evidence of an executed implementation test.

Examples refer to numbered sections of the companion contract-examples document. Architecture sections refer to the companion architecture. Ranges in product references identify related contracts; §§1–2 provide their principal product mappings. A fixture can require several execution levels rather than treating one passing unit test as universal proof.

| Fixture | Focus and observable oracle | Existing product references | Architecture sections | Contract examples | Required evidence | Status |
|---|---|---|---|---|---|---|
| **AV01** — Durable intent, restart and logical effects | Persist client intent before send; drop a committed response; restart client and server; retry the same participant/key/input within the window. Assert one publication/revision/source event and deduplicated attention effects. Inject pre-commit storage failure and verify atomic rollback. Competing exact attempts converge; changed input conflicts. Expired/lost attempt state remains explicit uncertainty, not automatic reposting. | API-05, OPS-03; AC14, AC31, AC60 | 7.1–7.6, 13.3–13.4 | 13–14 | Real PostgreSQL/process failure injection; direct HTTP and browser recovery | Not executed |
| **AV02** — Credential replacement and current authority | Repeat uncertain recovery with an authorized replacement credential for the same participant; preserve key namespace and authorship. Revoked credentials fail. Remove summary editing after preparation: no new revision commits, even with current base/reservation. If a prior result remains readable, permitted read-only reconciliation is not a new edit. Test the converse: reservation expiry alone does not block a valid write. | IDN-01–IDN-04, IDN-07, EDT-05–EDT-06, SEC-01–SEC-02; AC13, AC22, AC36, AC38, AC45 | 6.1–6.5, 7.2, 7.4.1, 14.2 | 7, 12–13, 17 | Real transaction races, direct/browser paths and host pause case | Not executed |
| **AV03** — Recovery categories and protected failures | Assert stable safe actions for exact retry, corrected input, stale-base reconciliation, lost authority, visibility replay, history expiry and uncertain outcomes. A 503/lost response never implies rollback without proof. Changed semantic mutation uses new intent only after uncertainty resolved. Protected targets disclose no revision/size/status route; credential recovery never replays an old secret. Unknown codes preserve local intent and fail conservatively. | API-04–API-05, SEC-03; AC09, AC23, AC31, AC34, AC41, AC45 | 7.4.1, 12.4, 14.4–14.4.1, 14.6 | 6–8, 11–12, 14–15, 17 | Contract/error fixtures and real failure injection; document vocabulary checks | Not executed |
| **AV04** — Full serialized budgets and oversized first items | Measure uncompressed UTF-8 JSON including escaping, metadata, entities, ancestors and envelope. Exercise multibyte text, many references, deep context and manifests. A first full item above the accepted budget is not truncated/skipped; reject safely without advancing, or return earlier whole items with continuation before it. Explicit excerpt/full routes retain exact revision and do not falsely mark the full source read. Correct allowed representation/budget while retaining bound membership. | API-03–API-04, DIS-04, ART-09, OPS-05; AC03, AC24, AC33, AC48 | 5.3, 8.3, 12.4, 14.4.1 | 9, 15 | Actual serializer/schema and real bounded query fixtures | Not executed |
| **AV05** — Bounded empty scans and independent checkpoints | Exhaust a query/scan budget before establishing completion. Empty visible results remain explicitly partial with safe forward continuation or actionable error, no hidden scan counts. Resume to eligible material without indefinite same-position loops; restoration controls and retention errors remain effective. Client retention of a page precedes its own fetch checkpoint; neither step marks read, clears bookmarks or leases content from other readers. Refresh hints never replace durable positions. | ATT-08–ATT-15, API-03, OPS-05; AC08–AC09, AC24–AC26, AC40–AC43 | 9.2–9.6, 12.4, 13.5 | 3–4, 10–11, 16 | Real query budgets and direct/browser continuation tests | Not executed |
| **AV06** — Late response and identity/view ownership | Start reading A, navigate to B or switch account, then complete A after cancellation fails. A cannot replace B, populate the new account cache, or create false read receipts. Exercise out-of-order current-revision fetches: an older response cannot overwrite a known newer view. Historical mode remains distinct. Instrument rendered IDs and server progress requests, not just local mocks. | HUM-02–HUM-05, ATT-09–ATT-10, API-02; AC33, AC42–AC43, AC54 | 13.1–13.5, 14.5 | 10, 18 | Real browser delayed-response fixtures and human observation | Not executed |
| **AV07** — Focused branch, older pages and draft continuity | Load older siblings/ancestors while new activity arrives; fail and retry a page, including overlapping results. Keep viewport anchor, keyboard focus, existing text, local draft and retry cursor. No duplicate comments, parent changes, silent reset to latest window or unread-gap loss. Bound DOM/cache explicitly; do not preserve context by downloading the full history. Cancelling a write retains reconciliation state. | DIS-04, HUM-02–HUM-05, ATT-09–ATT-10; AC03, AC42–AC43, AC54 | 13.1–13.5, 14.5 | 18 | Real browser/keyboard fixtures plus representative human trials | Not executed |
| **AV08** — Publication, processing and attention outcomes | Test 201 committed with pending projections and 202 accepted preparation with no published artifact. Replay returns the same logical result with separately observed projection state; status polling creates nothing. Notification availability does not imply reading. Unknown health is not ready/zero. UI labels, guide and structured results agree, without exposing another participant's inbox/read state or adding a public delivery receipt. | ART-04, API-02–API-05, MEN-02, ATT-12, OPS-03; AC05, AC14, AC24–AC26, AC46, AC60 | 7.6, 9.4, 10.3, 13.5, 14.4.1 | 2, 4, 9, 13–14, 19 | Real operation/projection tests, response checks and UI labels | Not executed |
| **AV09** — Guide, schema and implementation alignment | Release guide/schema/example versions together; validate fields and executable examples when a schema/service exists. Check semantic assertions: no content-as-authority, no secret copying, exact retries versus corrected requests, no false delivered/done, and GET not read. Unsupported versions/codes are explicit. CLI/MCP remains optional; a documentation link is not an auto-install instruction. Shape-only checks are labeled separately from semantic fixtures. | API-01, API-03–API-08, SEC-04; AC31–AC34, AC44–AC45, AC47, AC54 | 14.4.1, 14.6, 16.4, 17.1–17.2 | 0–20 | Document/schema checks plus later executable conformance and host use | Not executed |
| **AV10** — Real provider-host recovery journeys | Run intended hosts through the release guide and actual tools, targeting at least two providers when available. Include lost response/restart, oversized first result, stale base, revocation after preparation, long pause beyond advisory expiry and hostile authored text. Inspect persisted effects and sanitized calls. Record human intervention and tool approvals; untested providers remain untested and no broad safety/collective-effectiveness claim follows. | HUM-05, API-07, EDT-05; AC31, AC38, AC43, AC45, AC54 | 14.6, 16.2, 16.4 | 13–18, 20 | Real model-host trials with pinned/configured context; not scripted substitutes | Not executed |
| **AV11** — Actual local/cloud pilot and interruptions | Use independently implemented local and cloud clients against the stated deployed application/database/object provider. Disconnect, lose acknowledgements, restart clients/server and resume stable identities/continuations. Check preserved exact artifacts and nonduplicated publications/signals. Identify network topology, emulators, recovery/restore exercises and missing coverage. Several local processes or simulated nodes do not constitute this evidence level. | API-01–API-02, API-05, IDN-04, OPS-03–OPS-04; AC01, AC13–AC14, AC18, AC31, AC54, AC60 | 2, 7.4.1, 9.6, 15.3, 16.4 | 4, 9, 13–14, 20 | Production-like local/cloud pilot and explicitly identified restore evidence | Not executed |
| **AV12** — Evidence provenance and limited claims | For each executed run retain application/harness/guide revision, safe role/tool labels, actual environment, injected timing, expected oracle, observed state, sanitized transcript, failures and limitations. Separate document/unit/simulation/native/browser/human/host/pilot levels. Link evidence in Lore verification without copying secrets. A test name or agent narrative is not a passed Loom acceptance case. | API-07, HUM-05; AC54; evidence interpretation for all mapped tests | 16.2–16.5, 17.2 | 20 | Evidence-record review against actual run outputs; no execution implied here | Not executed |

### Evidence handoff

Use architecture §16.4's evidence-level definitions and record fields. Example 20 is a deliberately unexecuted template, not an actual trial. Link future records by product/AV ID and application commit. A partial or failed run remains visible, and document validation never changes an execution status to passed. Guide content and proposed schemas live with the application; actual host execution and external-action deduplication remain outside the forum.

## 4. Other confirmed boundaries

All C01–C32 remain product constraints. The architecture neither creates additional product modes nor revives superseded roles, universal reviewed-state tracking, delegated editor-list management, private team branches, model workers, or a native agent runtime. Source containment, note ownership, coverage-source exclusion, delayed delivery, and promotion-race behavior follow current DEC-006.

Product Section 20.2 remains the open-choice register. Architecture Sections 4 and 18 label numerical assumptions, technologies, mechanisms and interaction defaults as proposals; technical ADRs are not owner-approved product DEC records. The intended Agentic Lore Coding process remains separate from agent participation. Its verification records can link to the explicit evidence levels and AV fixtures without turning repository development history into a Loom runtime feature. The architecture does not introduce a messaging network, payments, delegation chains, or participant inbox leases.

## 5. Validation status and limits

Document validation covers the product baseline SHA-256; all 101 unique requirement mappings and AC01–AC61 with the product's principal mappings; distinct AV01–AV12; referenced architecture sections and companion links; Markdown table structure; and JSON syntax for the contract examples. These checks establish document consistency, not conformance to an implemented OpenAPI schema.

No application operations, SQL locking/visibility, object transfers, browser journeys, security tests, load tests, or human/model/local-cloud trials have been executed. All AC and AV execution states remain **Not executed**. Official technical references are listed in architecture §20; supported software releases and compatibility require bootstrap verification.
