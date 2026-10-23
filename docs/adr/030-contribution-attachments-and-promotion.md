# ADR-030: Contribution attachments and independent artifact promotion

Status: implementation decision, 22 October 2026; acceptance execution is recorded
separately. Extends ADR-006/015/017/021/028/029 for synthetic S11, ART-05/11.
Protected specification/architecture snapshots and earlier migrations stay unchanged.

ADR-031 subsequently adds passive supported-file text and contextual Files search
for these exact contribution and independent artifact contexts, preserving this
publication, attribution, lifetime and browser projection contract.

## Publication identity and custody

`attachment_set: {version: contribution-attachments-v1, files: [...]}` declares
the complete immutable set of an opening/comment revision, independently of the
Markdown version. Text remains nonempty. Members use the existing bounded path
and upload/exact-context vocabulary. Absence retains legacy digest semantics;
an explicit empty list is a reviewed removal. New legacy edits of attachment-aware
bases fail before publication. Committed outcomes and shape-independent refused
attempts resolve first. Correction preserves attempted supported fields and handles;
only a legacy draft adopts its explicitly inspected base's attachment declaration.

Uploads add destination kinds `opening` (area), `reply` (actual parent contribution),
and `contribution` (edit target). They cannot be substituted for `area`/`artifact`
handles. A preparation needs no placeholder published resource. Current actor,
destination and edit authority apply at admission, transfer/finalization association
and publication. Reply parents follow the existing strict new-reply policy; their
ancestors are not ownership. Private handles remain uploader-owned even for admins.

Contribution sets reference their contribution and owning discussion. Existing
`file_contexts` gain an exclusive contribution owner alternative; old artifact IDs,
rows and routes retain their meaning. All contexts reference one verified native
upload version. Same-contribution historical reuse is explicit; no hash/raw-key
lookup or general cross-publication reuse is introduced. Native IO remains outside
SQL transactions; existing length/digest validation, deadlines and admission apply.

## Independent promotion

`attachment.promote` selects contribution/revision/context, title and canonical
area. Its dedicated immutable semantic version binds all fields to participant,
kind and key. Current source read and destination publication rights are sufficient;
source editing/ownership is unnecessary. The ordinary artifact, creator editor,
initial file-only revision, exact file context, provenance, event/intents and outcome
commit together. No source revision, comment, editor or extra notification is made.

Provenance retains the source discussion/contribution/revision/context, original
contributor, revision publisher, uploader and promoter; none asserts authorship of
the bytes. Generated source metadata is separately authorized and withheld when
the source is unavailable. The new context uses the same native version, without
depending on a source URL. Source suppression/omission cannot remove this independent
artifact; artifact suppression applies independently. Its later same-artifact reuse
checks the artifact's rights, never the historical source's current visibility.

The browser's progressive attribution action opens a reloadable exact-revision
view. Only its revision and provenance queries share the audited projection host;
ordinary resource views and opaque artifact controls retain whole-view withdrawal.
An unavailable source still revokes older same-owner projections. The current
provenance response may render its own redacted fields and request a fresh artifact
read, but never restore the old body or file controls. Those return only from the
new authorized revision and file reads. Late responses, another denial, navigation
or identity replacement retain their fences. This uses ADR-027's response-owned
lease rule; it does not reinterpret unavailable provenance as positive authority
for another response. Any future optional projection must be isolated and audited
before adopting this host.

The full lock plan is attempt → sorted actor/credential guards → file custody15 →
shared structure1 → sorted source/destination/owner resources → selected revisions
→ new publication/provenance → common clock tail. No newly contested domain guard
or object IO follows the clock. Suppression/moves use the existing exclusive
structure guard. A source suppression committed first denies new promotion; a
promotion committed first remains independently governed. A matching committed
replay resolves the artifact before new-source checks; mutation replay still checks
current destination action rights, while read-only status needs result eligibility.

## Limits, lifetime and clients

ADR-029's physical reservations, upload identities, transfer/path/package limits
apply across all destination kinds together. Retained contexts preserve reservations
and exact versions regardless of current visibility. Additional logical accounting
under custody15 caps file-aware publications at 2048/actor and 8192/community,
and contexts at 8192/actor and 65536/community, including artifact reuse and promotion.
At capacity new file-aware publications stop; exact replay/status stays available.
These finite synthetic caps are not retention/erasure approval. Existing rows are
preserved additively even if an installation already exceeds a new limit.

Exact attachment listing/download uses contribution/revision/context and owning
discussion authorization, with the same bounded passive HTTPS handling and final
post-storage authorization as artifacts. No file read marks contents read. Promotion
confirmation identifies the exact source, destination/title and independent lifetime.
Upload and promotion metadata enter existing owner-scoped durable intent before
dispatch; bytes/secrets/capabilities do not. Several retained operations remain
individually identified by action and target. Status failure never settles a write.

The separate envelope preserves legacy/artifact meanings without changing Markdown.
Shared contexts preserve native lifetime in one place instead of maintaining a
second cleanup system. Reconsider these choices for new owner kinds, measured capacity
requirements, approved production retention, or general cross-publication reuse.
No preview/extraction, summary attachments, batch promotion, narrower moderation,
published deletion, deployment or existing development-data migration is included.
