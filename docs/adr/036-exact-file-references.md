# ADR-036: Recorded references to exact published files

Status: synthetic implementation contract extending ADR-021/022/029/030/031.
Imported product and architecture baselines remain unchanged.

## Identity and compatibility

A file target is exactly `{kind: "artifact" | "contribution", resource_id,
revision_id, file_id, path}`. The resource owns that published revision and the
contextual file ID is a member of that revision with exactly that normalized path.
Both ID and path are mandatory in authored declarations and incoming queries;
inconsistent combinations are refused. Existing file-path NFC validation, byte,
depth and segment limits apply without new case folding. UUIDs are lowercase in
canonical storage. A digest, upload handle, native key or external URL is not a target.
Sibling files, whole-revision references and identical bytes in independent
publications have separate identities. Rename, omission, replacement, movement and
promotion never retarget an old declaration. Native download requests still use
the stored exact version and fail if it is missing; there is no fallback.

`loom-markdown-v4` retains v3's explicit nullable `change_note`/`change_account`
fields and permits file targets in main references and revision-owned notes.
A file-aware note itself uses v4; a legacy v2 note remains accepted. Main and note
share the existing combined 16-reference, 16-mention, 16 KiB authored-byte and
4096-token limits; note bytes remain 4096 and rationale bytes 512.
New publication digests use `participation-text-v4`, or `discussion-summary-v3`
for summaries, including any existing file/attachment manifest. Old v1/v2/v3 and
manifest-envelope requests keep their original digests and optional-field meaning.
No old record is inferred, rewritten or rehashed.

An edit of a v4 base requires v4 even if its file list has since been emptied.
`file_reference_format_required` is a 409 with explicit correction guidance.
Previously committed retries resolve their original result before base/format
checks. An uncertain request never changes format, key, base or body automatically.
The browser saves complete declarations before dispatch in the existing journal.
After definitive rejection, explicit correction copies previously unrepresentable
base file declarations while preserving attempted supported references and prose.
This also applies when missing-manifest refusal precedes the v4 format refusal;
correction preserves both unsupported fields. V4 drafts keep deliberate withdrawals.
If a concurrent edit changed the same logical ID to a file, its base ID is retained
and the older attempted declaration is copied under a fresh ID, visibly for review.
A corrected v4 draft can temporarily retain up to 32 main declarations locally;
publishing remains disabled above 16 and the API's combined limit is unchanged.
All tabs must use the same release. Retained uncertain/committed records remain
limited to the accepted format's 16 declarations.

## Publication and authority

Migration 0026 adds nullable contextual file/path columns, exact membership checks
and field-local uniqueness including file ID. Legacy rows retain null file fields.
New or changed declarations require current owning-context read authorization and
prepared, published file membership. The complete existing resource lock plan is
collected before acquiring sorted source UPDATE/target SHARE guards; exact revision
checks follow, with the shared clock last. No storage/network call or new custody
guard occurs inside publication. An immutable published member already owns its
native retention; citation creates no new custody or retention promise.

The immediate-base unchanged-declaration exception retains unavailable targets.
Changing ID, scope, relationship or rationale requires normal validation. Main
assertion/carry/change/withdrawal history and revision-owned note attribution remain
field-local. A citation does not edit the target, add an editor, emit target events
or notifications, mark anything read, Save or Follow. No text/URL/path inference or
recursive summary coverage dependency is added. A promoted artifact's authorization
is independent of its original attachment; it never grants access to the source.
Source-authored declarations/rationale follow source availability. Resolved target
metadata, links, previews and bytes follow current target authority separately.

## Retrieval and browser

`GET /api/v1/references/target` accepts the complete target or, for supported
same-instance file-link resolution only, the four identity fields without path.
It authorizes the exact owner/revision before filling the recorded membership path.
The response has `scope: "file"`, the canonical target, exact owner representation,
`browser_url: /loom/file/{kind}/{resource}/{revision}/{file}` and owning context.
The browser also accepts exact download/text/status links; it parses their identity
locally and never fetches arbitrary URLs.

The existing Add reference control can list a selected exact revision's bounded
files/attachments, select a member and confirm publication/revision/path before
adding it. Selection never downloads or previews bytes. The existing file interface
exposes **Referenced by · file**, **Open exact publication** and owning context.
File-reference metadata is fetched independently of file-text processing/worker health.
Preview and original download retain separate current authorization and format rules.

Outgoing pages still select one exact source revision. Incoming queries supply all
five target fields, default to current sources, and support `history=all` and the
existing relationship filters. They never aggregate containing revision, siblings,
other revisions or other copies. Direct relational discovery uses no search worker.
Complete serialized JSON is bounded to 4–128 KiB, at most 25 returned items and
100 candidates; an empty scan can continue. Oversized first items return
`response_budget_too_small` without advancing. Five-minute encrypted cursors bind
the canonical selection/caller/order by SHA-256 plus existing visibility/source/
organization boundaries, keeping even maximum-length paths within 2 KiB cursors.
Expiry, scope mismatch, visibility restoration, changed source or API restart returns
`references_changed`; refresh explicitly. Temporary failure retains the last page
and exact attempted cursor, and explicit retry restores result-heading focus.

Existing response-policy routes apply: target denial withdraws the protected host;
`items[].target.state` distinguishes unavailable resolved metadata from authored
source text. Retrieval 5xx means retry that retrieval; it cannot settle an uncertain
publication. Route, account, selected target and authority generations fence late
responses. No new management screen, preview format, file editing, worker, graph
store, file-local discussion or private-note backlink is introduced.

## Independent client and evidence

`scripts/file-artifacts-client.mjs` uses HTTPS and private fsynced JSON, with no
server imports. `list-files` takes `--artifact` or `--contribution`, `--revision`,
optional `--prefix`/`--cursor`, and a fresh `--output`. `reference-target` adds
`--file-id` (optional `--path`); `referenced-by` requires `--path`, optionally
`--history`, `--relationship`, `--cursor`. Use its returned canonical target in a
v4 input, then `prepare`, `send`/`lose-response`, `status` and exact `send` retry.
Keep credentials in the private credential file, never in the input/journal/report.
`download` remains a separate exact-byte action.

Normal `references*.test.ts` discovery includes native contextual bytes/missing
version, HTTPS cookie/bearer publications, both note/main fields, complete incoming
sets, byte/work/cursor bounds, populated 0025→0026 old-column/replay preservation,
publication/suppression/credential race orderings and process-restarted independent
client recovery. Mounted production file routes test actual authorization withdrawal
and late responses; compiled `files.spec.ts` covers keyboard selection, narrow
layout, journal reload/correction/lost acknowledgement, exact navigation and paging.
Actual command results belong in task verification evidence, not this contract.
Reconsider this additive representation if separately editable file resources or
additional published contextual owner kinds become supported; neither exists here.
