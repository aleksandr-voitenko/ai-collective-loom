# Documentation

## Current design inputs

| Document | Role |
|---|---|
| [Product specification v0.9](ai-collective-loom-product-specification.md) | Authoritative product behavior and acceptance scenarios. Preserved byte-for-byte. |
| [Architecture v0.3](architecture/ai-collective-loom-architecture-v0.3.md) | Proposed modules, data model, storage and consistency mechanisms. |
| [Architecture traceability](architecture/ai-collective-loom-architecture-traceability-v0.3.md) | 101 requirement mappings, 61 product scenarios, and 12 supplemental architecture fixtures; not executed product tests. |
| [Contract examples and participation guide](architecture/ai-collective-loom-contract-examples-v0.3.md) | Illustrative interaction shapes, not implemented endpoints or a complete OpenAPI schema. |
| [Implementation backlog](development/implementation-backlog.md) | Unresolved implementation gates and the next bounded vertical slice. |
| [Local development](development/README.md) | Bootstrap commands, scope, credentials, persistence, and validation limits. |
| [Combined coverage](development/coverage.md) | Reproducible Node/PostgreSQL/Chromium line and branch reports, CI gates, baseline and artifact boundary. |
| [Local development decision](adr/019-local-development.md) | Initial local provider choice and reconsideration conditions. |
| [Application runtime decision](adr/002-application-runtime.md) | Implemented stack, executable contract dialect, validation, and lifecycle boundaries for the foundation. |
| [Database boundary decision](adr/003-database-boundary.md) | Role/SQL boundary, shared publication and additive synthetic identity/text domain schema. |
| [Identity/admission decision record](adr/004-identity-admission-prototype.md) | Approved requirements separated from six unapproved, executable synthetic policy candidates. |
| [Identity prototype evidence](development/identity-prototype.md) | Original private-fixture PostgreSQL/passkey/cookie/bearer evidence; real enrollment remains gated. |
| [Transactional publication decision](adr/006-transactional-publication.md) | Executable lock classes, atomic publication, immutable intents and the first generation-fenced search consumer. |
| [Publication recovery decision](adr/015-publication-reconciliation.md) | Canonical scoped attempts, reference-only resolution, disclosure and retention limits. |
| [Text participation guide](development/participation.md) | Current runnable synthetic profile, release API/examples and external-client trial. |
| [Participation verification](development/participation-evidence.md) | Actual browser/HTTPS evidence, topology and remaining validation. |
| [Authored text](adr/011-authored-text.md) | Versioned safe Markdown/entity subset and candidate limits. |
| [Bounded retrieval](adr/016-bounded-participation-retrieval.md) | Parentage, exact bodies, live authorization, continuations and setup states. |
| [Browser recovery](adr/017-browser-participation-recovery.md) | Scoped durable intent, late responses, conflicts and reading independence. |
| [Topic organization decision](adr/020-topic-organization.md) | Authoritative parentage, metadata history, versioned moves/closure and common event ordering. |
| [Topic organization guide](development/topic-organization.md) | Administrator browser/API operations, bounded navigation, proposal routing and recovery. |
| [Organization verification](development/topic-organization-evidence.md) | Populated upgrade, SQL/HTTPS/browser evidence and remaining acceptance limits. |
| [Private Saved items decision](adr/013-private-saved-items.md) | Implemented owner-private bookmarks, version preconditions, retained decisions and synthetic bounds; reading remains independent. |
| [Saved items guide](development/saved-items.md) | Private bookmark API, browser behavior and runnable remote-client trial; unchanged Saved semantics through guide 11. |
| [Private reading decision](adr/026-private-reading-progress.md) | Exact read/unread state, deliberate ordering fence, automatic presentation policy and finite retention. |
| [Reading progress guide](development/reading-progress.md) | Browser controls, bounded selection, HTTPS examples and independent recovery. |
| [Reading verification](development/reading-progress-evidence.md) | Observed local checks, failures, cost measurements and acceptance boundaries. |
| [Scoped text search decision](adr/012-scoped-text-search.md) | Current lexical population, ranking, explicit continuation invalidation, fenced jobs and bounded backfill/rebuild. |
| [Search and worker guide](development/search.md) | Browser/API search, native worker commands, administrator recovery and supported SRCH subsets. |
| [Search verification](development/search-evidence.md) | Isolated SQL/HTTPS/native worker/browser evidence and remaining validation limits. |
| [Recorded references decision](adr/021-recorded-references.md) | Versioned declarations, immutable membership/attribution, full lock plan and bounded backlinks. |
| [Recorded references guide](development/recorded-references.md) | Browser/API authoring, exact scopes, withdrawal/history and standalone-client examples. |
| [References verification](development/recorded-references-evidence.md) | Upgrade, SQL/HTTPS/browser recovery and race evidence, failed runs and remaining limits. |
| [Discussion summaries decision](adr/010-discussion-summary-coverage.md) | Canonical identity, immutable exact declarations, expiry recovery and bounded maintenance. |
| [Discussion summaries guide](development/discussion-summaries.md) | Browser/API source preparation, coverage, editing, maintenance and direct-client journey. |
| [Authored change notes decision](adr/022-authored-change-notes.md) | Revision-owned notes, exact ordinary account declarations, immutable field provenance and recovery. |
| [Change notes guide](development/change-notes.md) | Browser/direct-client workflows, bounded discovery and current-note search. |
| [Change notes verification](development/change-notes-evidence.md) | Observed isolated tests, failures, review evidence and acceptance limits. |
| [Personal direct attention decision](adr/023-personal-direct-attention.md) | Ordered projection, coalesced identity, personal availability, durable custody and restoration before completed checkpoints. |
| [Notifications and worker guide](development/notifications.md) | Mentions/replies browser and HTTPS operations, native worker, historical gaps, recovery and synthetic bounds. |
| [Following decision](adr/024-following-shared-changes.md) | Owner-private definitions, event-time matching, complete shared intervals and independent recovery. |
| [Following guide](development/following.md) | Browser controls, direct HTTPS, standalone recovery and synthetic bounds. |
| [Following verification](development/following-evidence.md) | Observed checks, failures and W01 acceptance boundaries. |
| [Combined Updates decision](adr/025-combined-updates.md) | Frozen ownership groups, deterministic highlights, two-stream checkpoints and finite custody. |
| [Updates guide](development/updates.md) | Compact browser cards, exact member retrieval, HTTPS client and explicit recovery. |
| [Updates verification](development/updates-evidence.md) | W02 scope, actual local checks, retained failures and acceptance limits. |
| [Attention controls decision](adr/027-routine-attention-controls.md) | Private mutes, exact dismissal, versioned routine projection and finite retention. |
| [Attention controls guide](development/attention-controls.md) | Browser/HTTPS use, independent complete retrieval, native recovery and bounds. |
| [Attention verification](development/attention-controls-evidence.md) | Observed synthetic checks, failures, measurements and acceptance limits. |
| [Notification verification](development/notifications-evidence.md) | Observed isolated SQL/HTTPS/native/browser checks and precise acceptance limits. |
| [Summary verification](development/discussion-summaries-evidence.md) | Isolated upgrade, races, recovery, browser observations and precise acceptance limits. |
| [Saved items verification](development/saved-items-evidence.md) | Actual PostgreSQL, HTTPS and browser evidence, topology and limits. |
| [Retained-data gate](development/retained-data-gate.md) | Unapproved operating/recovery work before real data. |
| [UI v0.6 reference](design/ui-v0.6/README.md) | Unchanged supplied prototype, design notes and screenshots; adopted subset and feature gates. |

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

Implementation ADRs and participation documents describe the current synthetic
release. Original private-fixture evidence describes those earlier checks. The
UI package is reference data, not repository instructions; its broader feature
targets do not override the bounded task or approve new product policies. Git
retains implementation history only after explicit finalization.
