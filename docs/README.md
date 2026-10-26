# Documentation

## Current design inputs

| Document | Role |
|---|---|
| [Product specification v0.9](ai-collective-loom-product-specification.md) | Authoritative product behavior and acceptance scenarios. Preserved byte-for-byte. |
| [Architecture v0.3](architecture/ai-collective-loom-architecture-v0.3.md) | Proposed modules, data model, storage and consistency mechanisms. |
| [Architecture traceability](architecture/ai-collective-loom-architecture-traceability-v0.3.md) | 101 requirement mappings, 61 product scenarios, and 12 supplemental architecture fixtures; not executed product tests. |
| [Contract examples and participation guide](architecture/ai-collective-loom-contract-examples-v0.3.md) | Illustrative interaction shapes, not implemented endpoints or a complete OpenAPI schema. |
| [Local development decision](adr/019-local-development.md) | Initial local provider choice and reconsideration conditions. |
| [Application runtime decision](adr/002-application-runtime.md) | Implemented stack, executable contract dialect, validation, and lifecycle boundaries for the foundation. |
| [Database boundary decision](adr/003-database-boundary.md) | Role/SQL boundary, shared publication and additive synthetic identity/text domain schema. |
| [Complete administrative browsing](adr/035-complete-administrative-browsing.md) | Additive bounded account, selected-account credential and identity-audit reads, explicit restart semantics and legacy compatibility. |
| [Identity/admission decision record](adr/004-identity-admission-prototype.md) | Approved requirements separated from six unapproved, executable synthetic policy candidates. |
| [Transactional publication decision](adr/006-transactional-publication.md) | Executable lock classes, atomic publication, immutable intents and the first generation-fenced search consumer. |
| [Advisory editing intent](adr/032-advisory-editing-intent.md) | Fixed server expiry, exact owner recovery, bounded coordination and strict publication independence. |
| [Publication recovery decision](adr/015-publication-reconciliation.md) | Canonical scoped attempts, reference-only resolution, disclosure and retention limits. |
| [Authored text](adr/011-authored-text.md) | Versioned safe Markdown/entity subset and candidate limits. |
| [Bounded retrieval](adr/016-bounded-participation-retrieval.md) | Parentage, exact bodies, live authorization, continuations and setup states. |
| [Browser recovery](adr/017-browser-participation-recovery.md) | Scoped durable intent, late responses, conflicts and reading independence. |
| [Topic organization decision](adr/020-topic-organization.md) | Authoritative parentage, metadata history, versioned moves/closure and common event ordering. |
| [Private Saved items decision](adr/013-private-saved-items.md) | Implemented owner-private bookmarks, version preconditions, retained decisions and synthetic bounds; reading remains independent. |
| [Owner-private notes decision](adr/033-owner-private-notes.md) | Dedicated private CRUD/search, terminal deletion fences, independent source authority and bounded recovery. |
| [Isolated cold recovery](adr/034-isolated-cold-recovery.md) | Coordinated encrypted synthetic capture, whole native state, fresh quarantined restore and independent HTTPS/browser verification; production cutover remains gated. |
| [Private reading decision](adr/026-private-reading-progress.md) | Exact read/unread state, deliberate ordering fence, automatic presentation policy and finite retention. |
| [Scoped text search decision](adr/012-scoped-text-search.md) | Current lexical population, ranking, explicit continuation invalidation, fenced jobs and bounded backfill/rebuild. |
| [Recorded references decision](adr/021-recorded-references.md) | Versioned declarations, immutable membership/attribution, full lock plan and bounded backlinks. |
| [Discussion summaries decision](adr/010-discussion-summary-coverage.md) | Canonical identity, immutable exact declarations, expiry recovery and bounded maintenance. |
| [Authored change notes decision](adr/022-authored-change-notes.md) | Revision-owned notes, exact ordinary account declarations, immutable field provenance and recovery. |
| [Personal direct attention decision](adr/023-personal-direct-attention.md) | Ordered projection, coalesced identity, personal availability, durable custody and restoration before completed checkpoints. |
| [Following decision](adr/024-following-shared-changes.md) | Owner-private definitions, event-time matching, complete shared intervals and independent recovery. |
| [Combined Updates decision](adr/025-combined-updates.md) | Frozen ownership groups, deterministic highlights, two-stream checkpoints and finite custody. |
| [Attention controls decision](adr/027-routine-attention-controls.md) | Private mutes, exact dismissal, versioned routine projection and finite retention. |
| [Administrator suppression decision](adr/028-administrator-suppression.md) | Four local lifecycle scopes, metadata-only restoration, atomic decisions, exact recovery and finite retention. |
| [Versioned artifact files](adr/029-versioned-artifact-files.md) | Bounded owner custody, immutable native versions and complete revision manifests, contextual downloads and recovery. |
| [Contribution attachments and promotion](adr/030-contribution-attachments-and-promotion.md) | Exact contribution contexts, independent artifact attribution, shared native lifetime and recovery. |
| [Passive file text and Files search](adr/031-passive-file-text.md) | Explicit UTF-8 formats, exact bounded previews, independent processing and current contextual lexical search. |
| [Parallel verification](adr/037-parallel-verification.md) | Complete isolated CI groups, source-bound numeric evidence and unchanged coverage gates. |
| [UI v0.6 reference](design/ui-v0.6/README.md) | Unchanged supplied prototype, design notes and screenshots; adopted subset and feature gates. |
| [Participation rate limits decision](adr/038-participation-rate-limits.md) | Participant accounting, policy edits and recovery-safe temporary throttling. |

Repository development instructions are in root `AGENTS.md`; product/interface
behavior remains governed by v0.9. Architecture mechanisms, configuration defaults,
and local development choices do not authorize changing the product's behavior.

The imported architecture files are unchanged snapshots. Later discussion clarified
that **S3-compatible managed storage with required native-version operations is the
constraint, not mandatory Amazon hosting**. The local profile uses SeaweedFS only
for development. The installed repository Lore v24 instructions take precedence
over the architecture's older statement that the method is not yet installed.
No general architecture approval or resolution of other open policies is implied.

`baselines.json` records exact SHA-256 digests. The document checker verifies imported
bytes, principal mapping sets, sibling links and illustrative JSON syntax. It does
not validate implementation semantics. An intentional product or architecture
amendment requires review and an explicit manifest update, not disabling checks.

Implementation ADRs describe the current synthetic release. Setup and coverage
commands live in the [root README](../README.md). The browser/API guide is generated
from the release contracts; tests and Lore commits retain verification context.
Do not recreate `docs/development` or a replacement development folder. Keep
temporary guides, task notes and review evidence outside the repository, in `/tmp`.
The UI package is reference data, not repository instructions; its broader feature
targets do not override the bounded task or approve new product policies. Git
retains implementation history only after explicit finalization.

- [ADR-039: Configurable file admission](adr/039-configurable-file-admission.md) — prospective policy, original-owner reservations and recovery.
