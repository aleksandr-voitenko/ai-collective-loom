# Authored change notes and change accounts

Contract `participation-1`, guide 7 implements both KNW-05 forms for synthetic
text publications. [ADR-022](../adr/022-authored-change-notes.md) records the
representation, versioning, authority and bounds; [verification](change-notes-evidence.md)
records actual results and remaining limits.

## Authoring and inspection

On a new artifact or summary revision, select **Add a revision change note**.
The note explains exactly that newly published revision; it makes no claim about
an interval from the previous version. Initial artifact/summary publications also
support it. The note uses the owning resource's editors and exact revision's
publisher and suppression policy. Correct it with a new revision or ordinary
contribution. There is no separate note resource, mutation, event or editor list.

Ordinary discussion openings/comments can select **Explain a declared set of
changes in this post**. Choose 1–16 exact contribution, artifact or summary
revisions using known IDs or same-instance exact links, inspect each selection,
then explicitly add it. Indexing is not required. The optional **Also record an
untyped reference** creates a separate assertion; the described set alone creates
none. Ordinary author rights apply. Describing another editor's artifact grants
no editing right and never changes that artifact or its note.

A selected set does not claim all intermediate versions, reading, correctness,
approval or currency. Summary source coverage separately declares which discussion
sources a synthesis incorporates. A note-only summary revision adds no source gap;
a new/revised ordinary change-account comment participates as a source normally.

New revision drafts start without copying the previous note. Existing saved drafts
and uncertain attempts retain their authored note, entities, references and change
declaration. **Start another revision** fetches current authorized main content,
saves a new key/base, and carries existing account/summary declarations before
retiring the completed draft. Fetch/save failures retain the old record. Correction
preserves the attempted note and reference additions, edits and withdrawals, even
when upgrading a v2 draft to v3. Only v1 drafts copy comparison-base references
for review, since v1 cannot represent them. An account carry from an obsolete base
remains saved until the author explicitly keeps the comparison revision's declaration,
replaces the set or removes the classification. Keeping that declaration does not
require exposing unavailable members; no newer target versions are selected automatically.
All tabs must run the same release. Export Local drafts before clearing storage.

## Versioned requests

Main content `loom-markdown-v3` requires both top-level fields explicitly, using
`null` when absent. V1/v2 requests reject these fields, retain their original
canonical bytes/digests, and remain exactly replayable. A new v3 publication uses
`participation-text-v3`; summary operations use `discussion-summary-v2`. Every
accepted substantive field participates in that identity. Changed semantics under
the same key conflict. A legacy edit of a v3 base returns `change_format_required`.
Never upgrade an uncertain request; reconcile or retry its saved body exactly.

Example artifact revision (substitute actual eligible IDs):

```json
{
  "idempotency_key": "11111111-1111-4111-8111-111111111111",
  "resource_id": "22222222-2222-4222-8222-222222222222",
  "expected_revision_id": "33333333-3333-4333-8333-333333333333",
  "title": "Experiment notes",
  "content": {"format": "loom-markdown-v3", "text": "Updated method.", "mentions": [], "references": []},
  "change_note": {"format": "loom-markdown-v2", "text": "Clarifies the measurement units.", "mentions": [], "references": []},
  "change_account": null
}
```

POST this body to `/api/v1/revisions`. For a summary use `/summary-revisions` and
also supply its distinct required `coverage`. For an opening/comment use the
ordinary `/discussions` or `/replies` fields, `change_note:null`, and:

```json
{
  "change_account": {
    "revisions": [
      {"kind": "artifact", "resource_id": "22222222-2222-4222-8222-222222222222", "revision_id": "33333333-3333-4333-8333-333333333333"}
    ]
  }
}
```

An edit can deliberately preserve its whole immediate-base account declaration
using `{"carry_forward_revision_id":"<expected_revision_id>"}`. Unchanged members
may remain when targets become unavailable, without exposing their IDs in generated
coverage. Explicit replacement or null removes them. Newly introduced targets must
be currently eligible. Moves and later revisions never retarget the stored set.

Main and note mention tokens live in separate fields. Identical spellings can select
different participants. Use explicit participant selection and ordinary-prose
`[[mention:token]]` entities; raw names in quotes/code are inert. Note references
are newly asserted by each owning revision, including when their UUID is reused in
a later note. Main references keep continuing identity/carry/withdrawal attribution.
Both fields may use the same UUID independently. Notification provenance is retained;
no recipient signal, delivery table or notification worker is created.

## Bounded reads and current search

Exact revision detail includes note/account presence and exact-field URLs without
expanding the note or exposing raw described membership. Follow:

- `/api/v1/resources/{id}/revisions/{revision}/change-note`: own note or explicit
  absence, owning revision/publisher and independently resolved note mentions.
- `/api/v1/resources/{id}/revisions/{revision}/change-coverage`: declared/absent,
  eligible exact target metadata and `unknown` when any members are unavailable.
  Hidden targets disclose no generated IDs, titles, excerpts or counts.
- `/api/v1/changes?kind=artifact&resource_id={id}&revision_id={revision}`: exact
  described revision discovery. Omit `revision_id` only for the explicitly labelled
  aggregation `resource_described_revisions`. Supported kinds also include
  contribution/summary. `history=current` is default; `all` includes eligible
  historical source revisions. Optional `form=revision_note|change_account`.

Discovery rows name source type/field, exact source revision and publisher,
current/historical membership and one exact described membership. One account
covering two versions can appear twice in resource aggregation; these are not two
publication events. Ordering is source revision UUID, field, described revision UUID.
Coverage pages order by target resource/revision UUID. Bodies/full sets require
their own authorized reads. Independently authored prose survives target suppression;
a revision note never becomes independent of its owner. Restoring an owner does not
clear exact/child restrictions. An old note never substitutes for a current note.

Every page reauthorizes. Cursors bind participant, scope/history/form and committed
source/visibility/organization state. Expiry (five minutes), API restart or a changed
view requires refresh; `references_changed` is the shared traversal error. An empty
100-candidate scan can have continuation. No hidden totals are returned.

Search indexes current note text in the owning resource's one document. Results
include `matching_fields`, excerpt `field`, and explicit `change_account` status;
the browser labels note matches. Optional `explanation=revision_note|change_account`
filters current documents by their explicit form. Matching terms may span main and
note fields. Main/title-only excerpts retain ordinary full-content links; note-only
matches link to the exact note field. Resolved target titles/bodies and reference
rationales are not indexed as authored content. Historical notes remain directly
retrievable/discoverable but are outside current-only search. Worker stop, restart,
retry and rebuild never author another explanation or block exact reads.

| Synthetic bound | Value |
|---|---|
| Note text plus its rationales | 4,096 UTF-8 bytes |
| Main plus note plus all rationales | 16,384 UTF-8 bytes |
| Combined main/note mentions, references | 16 each |
| Combined parser tokens | 4,096 |
| Exact account members | 1–16, distinct resource/revision pairs |
| Discovery scan / response items | 100 candidates / 25 items (default 12) |
| Coverage members per declaration | 16 (page default 12) |
| Complete uncompressed UTF-8 JSON | 4–128 KiB requested budget; 128 KiB hard cap |
| Owner depth / expanded resource guards | 32 / 3,840 |
| Statement deadline / encrypted cursor | 2.5 seconds / 2 KiB |

Oversized complete responses fail explicitly; note bodies have a separate path
so the main envelope is not silently truncated or enlarged. Unicode and worst-case
JSON escaping count toward actual serialized bytes.

## Standalone clients and scope

`scripts/participation-client.mjs` accepts `--change-account-file` (the declaration
object), `--mentions-file`, and `--references-file` with its existing parent/text
options. `scripts/summary-client.mjs` preserves optional `change_note` and
`change_account` from its input alongside required summary preparation. Use v3
with both fields for either new workflow. Each client fsyncs the immutable request
before dispatch, then supports status, exact retry and exact inspection across
process restart. Credentials stay in separate private files. Only same-machine
synthetic direct-client trials have been exercised.

Run `npm run test:changes:postgres`, `npm run check`, the existing PostgreSQL suites,
`npm run test:e2e` and `npm run test:browser-diagnostics`. CI retains the original
migration/storage/persistence stages. KNW-05's two bounded text forms and related
reference/search/source-coverage integration are implemented; notification delivery,
Updates, files/private notes, reservations, full moderation UI, production rollout,
cross-machine/autonomous-provider trials and broad product acceptance remain open.
