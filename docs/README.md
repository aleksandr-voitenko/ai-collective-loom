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

Keep current design documents readable; no in-document changelog or outside-project
comparison material is added by this bootstrap. Git history retains development
changes once explicitly finalized.
