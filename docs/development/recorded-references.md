# Recorded references in synthetic participation

Contract `participation-1`, guide 5 supports explicit references from discussion
openings, comments and text artifacts. Use synthetic accounts/content only.
[ADR-021](../adr/021-recorded-references.md) records representation, attribution,
authorization, concurrency, compatibility and continuation decisions.

## Authoring

Use **Add reference**, enter a known ID or same-instance Loom link, select kind
and resource versus exact revision, then **Check target** and confirm the scope.
This works with indexing stopped and never fetches arbitrary URLs. Untyped and
**Related to** may omit rationale; **Builds on** and **Contradicts** require a short
nonblank rationale. These are the author's assertions, not permissions or consensus.
**Change target** preserves logical identity. **Remove reference** withdraws only
when the new source revision is explicitly published. Picker/read actions have
no Save, Follow, read-state, notification or target-publication effects.

Use existing `/api/v1/discussions`, `/replies`, `/artifacts` and `/revisions`
publication routes with complete content:

```json
{
  "format": "loom-markdown-v2",
  "text": "The follow-up builds on the retained measurement.",
  "mentions": [],
  "references": [{
    "reference_id": "10000000-0000-4000-8000-000000000001",
    "target": {
      "kind": "artifact",
      "resource_id": "20000000-0000-4000-8000-000000000001",
      "revision_id": "30000000-0000-4000-8000-000000000001"
    },
    "relationship": "builds_on",
    "rationale": "Uses the same measurement protocol."
  }]
}
```

Replace illustrative IDs with eligible resources; allocate a UUID once per logical
assertion. Omit `revision_id` for resource-only scope. Kinds are `discussion`,
`contribution`, `artifact`; a discussion container has no revision and differs
from its opening contribution. Exact R1 stays R1 after R2, source edits or moves.
Target edit rights are neither needed nor granted. No target revisions, placement,
status, events or reciprocal assertions change. Ordinary HTTP(S) links stay inert
as relationships; no old text, Saved state, drafts or administrative rows are scanned.

At most 16 declarations, 512 UTF-8 bytes per rationale and 16,384 combined
text/rationale bytes are accepted. Existing mention/parser limits remain. Duplicate
logical IDs or target resource/revision scopes fail even with different types.
UUID spelling/order canonicalizes; exact text/rationale Unicode and line endings
remain. NUL/unpaired surrogates fail and HTML remains inert.

Identical immediate-base carry-forward preserves original and last assertion-change
attribution; the source revision independently names its publisher/time. Changes
record the current editor. Omission withdraws current membership while retaining
history; reintroduction under the same logical ID preserves the original origin
and records the new editor. For a withdrawn reference, its latest eligible
withdrawal revision separately identifies the
withdrawing editor/time. Suppressed withdrawal revisions withhold that attribution.
A reference can remain unchanged when its target
becomes unavailable; resolved target metadata/links are withheld while authored
declaration IDs/rationale remain. New/changed declarations require current target
read eligibility and correct exact revision ownership. Missing/protected errors
do not distinguish existence. Available historical targets do not depend on the
availability of the current revision.

## Reading and continuation

All routes require current authentication. Strict schemas are served at
`GET /api/v1/openapi.json`, with the release guide at `/api/v1/guide`.

| Route | Meaning |
|---|---|
| `GET /api/v1/references/target?kind=artifact&resource_id=ID&revision_id=R1` | Validate exact target; omit revision for resource scope. |
| `GET /api/v1/resources/ID/revisions/R1/references` | Outgoing membership for that exact source revision. |
| `GET /api/v1/references/incoming?kind=artifact&resource_id=ID` | Current-source references to resource-only scope. |
| Incoming with `revision_id=R1` | Only citations to exact R1, without aggregate scope. |
| Incoming with `history=all` | Retained memberships, including changed/withdrawn history. |

Optional incoming `relationship` is `untyped`, `related_to`, `builds_on` or
`contradicts`. Items include declaration/direction, exact source revision,
original/latest assertion participant/time, source publisher/time, current location
and full-content/context routes. Metadata is not full text. Exact source/target
links never substitute newer revisions.

Membership labels are `current`, `carried_forward`, `changed`, `withdrawn`, or
`current_unavailable` when the eligible current membership cannot be determined.
Historical mode reauthorizes source/owner/revision eligibility. Suppressed sources
hide backlinks; discussion/area suppression covers their owned content. An
individually suppressed reply parent does not hide eligible children. Target
suppression alone does not suppress independently authored referring text.

**References** and **Referenced by** expose scope/history/relationship selectors,
exact links and secondary technical details. Loading, unavailable, failed and empty
states differ. Failed pagination preserves the previous page and retry position.
Explicit refresh/continuation focuses the results heading; selection returns focus
to Add reference. A changed view requires **Refresh references**.

Pages default to 12/max 25 items within 4–128 KiB uncompressed serialized UTF-8 JSON.
Scan at most 100 candidates; an empty page with `next_cursor` is incomplete.
Metadata expansion has 32-owner walks and at most 3,840 resource guards. No hidden
population count or whole graph is returned. Each SQL statement has a 2.5-second
deadline (`reference_work_limit`, HTTP 429). `response_budget_too_small` reports
an authorized measured minimum; raise the budget without skipping that item.

Order is source revision UUID then reference UUID. Encrypted stateless cursors are
at most 2 KiB and expire five minutes after traversal begins. They bind caller,
scope, history, filter, order and publication/visibility/organization boundary.
Keep semantic parameters; only `limit`/`max_response_bytes` may change. Publications,
moves, suppression/restoration, expiry or API restart can cause `references_changed`
(409): refresh from the start. Each page uses one short authorized snapshot; a
conflicting write waits or causes explicit restart, never mixed metadata.

## Compatibility and direct clients

V1 documents, mention semantics and old hashes remain unchanged. V2 uses
`participation-text-v2`; every reference field participates in operation identity.
Changed target/type/rationale under one key conflicts. Exact retry returns the
original revision without restoring a later-withdrawn reference. V1 editing a v2
base fails `reference_format_required` (409); use complete v2 content and an
explicit empty list for deliberate withdrawal, including when the base is empty.

Persist complete draft/intent before POST. Existing Web Locks, failed-autosave
refusal, explicit correction, stale-tab separate drafts, account/route ownership,
reload/restart and export rules apply to references. Never downgrade or re-key
uncertain journals. Reload all tabs onto the same release.

The standalone client accepts a JSON declaration array on **prepare**:

```sh
node scripts/participation-client.mjs --origin https://APPROVED-HOST --credential-file /private/agent-token --journal /private/intent.json --action prepare --parent PARENT-UUID --text-file /private/reply.txt --references-file /private/references.json
node scripts/participation-client.mjs --origin https://APPROVED-HOST --credential-file /private/agent-token --journal /private/intent.json --action lose-response
node scripts/participation-client.mjs --origin https://APPROVED-HOST --credential-file /private/agent-token --journal /private/intent.json --action retry
node scripts/participation-client.mjs --origin https://APPROVED-HOST --credential-file /private/agent-token --journal /private/intent.json --action inspect
```

Use `--ca /private/ca.pem` for an explicitly trusted synthetic certificate.
Preparation fsyncs the complete body without credentials; later processes send
that retained request. Inspect checks exact text, format and reference fields.
Omitting `--references-file` retains the previous v1 payload/digest.

Search/rebuild support both formats' source-authored title/body. Rationale is
displayed but not searched. Resolved target titles/bodies never become source
search content. Direct relational backlinks need no worker.

DIS-06/REF-01–03 are implemented for this text population; SRCH-07 gains bounded
reference expansion. Summary/coverage/change-note, file/path and private-note
integration remain open. Reference portions of AC27–30/33/34/37/39 do not complete
the broad scenarios. No attention, graph visualization, inference, production
capacity, provider-agent or cross-machine trial is claimed. See [observed evidence](recorded-references-evidence.md).
