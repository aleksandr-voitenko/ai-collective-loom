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
| [Local development decision](adr/019-local-development.md) | Initial local provider choice and reconsideration conditions. |
| [Application runtime decision](adr/002-application-runtime.md) | Implemented stack, executable contract dialect, validation, and lifecycle boundaries for the foundation. |
| [Database boundary decision](adr/003-database-boundary.md) | Role/SQL boundary, shared publication and additive synthetic identity/text domain schema. |
| [Identity/admission decision record](adr/004-identity-admission-prototype.md) | Approved requirements separated from six unapproved, executable synthetic policy candidates. |
| [Identity prototype evidence](development/identity-prototype.md) | Original private-fixture PostgreSQL/passkey/cookie/bearer evidence; real enrollment remains gated. |
| [Transactional publication decision](adr/006-transactional-publication.md) | Executable lock classes, atomic publication, commit tail and durable intents; worker fencing remains required. |
| [Publication recovery decision](adr/015-publication-reconciliation.md) | Canonical scoped attempts, reference-only resolution, disclosure and retention limits. |
| [Text participation guide](development/participation.md) | Current runnable synthetic profile, release API/examples and external-client trial. |
| [Participation verification](development/participation-evidence.md) | Actual browser/HTTPS evidence, topology and remaining validation. |
| [Authored text](adr/011-authored-text.md) | Versioned safe Markdown/entity subset and candidate limits. |
| [Bounded retrieval](adr/016-bounded-participation-retrieval.md) | Parentage, exact bodies, live authorization, continuations and setup states. |
| [Browser recovery](adr/017-browser-participation-recovery.md) | Scoped durable intent, late responses, conflicts and reading independence. |
| [Private Saved items decision](adr/013-private-saved-items.md) | Implemented owner-private bookmarks, version preconditions, retained decisions and synthetic bounds; notes/read state remain open. |
| [Saved items guide](development/saved-items.md) | Release guide 2, API examples, browser behavior and runnable remote-client trial. |
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
