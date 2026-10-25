# ADR-022: Authored revision notes and ordinary change accounts

Status: implementation contract for the synthetic participation increment.
Product v0.9 KNW-05 fixes ownership; these are representation and mechanism choices.
The task brief is the supplied “Authored change notes and change accounts” request.
Imported specifications/UI, applied migrations, production gates and existing data
remain unchanged. Relevant history: LC-20261016-B8DO, LC-20261016-V9U4,
LC-20261016-UA6O, LC-20261015-94TS and LC-20261014-S0JX.

## Publication and compatibility

`loom-markdown-v3` retains the main text/mentions/references representation. Its
publication request also requires explicit nullable `change_note` and
`change_account` fields. The note is a bounded v2 authored document; the account
is `{revisions:[{kind,resource_id,revision_id}]}` or an explicit whole immediate-base
`{carry_forward_revision_id}`. Null deliberately omits the note or removes the
account classification from the new revision. V1/v2 requests accept neither field;
their canonical payloads and digests are unchanged. New requests use
`participation-text-v3`, or `discussion-summary-v2` for summary operations. All
accepted fields enter the digest. Editing a v3 base requires v3 or v4, including nulls;
older clients receive `change_format_required` rather than stripping declarations.

A note describes exactly its newly published owning revision, bound by the server.
It makes no base-to-new interval claim. Only artifacts (including initial overview)
and summaries accept notes. An ordinary opening/comment may declare 1–16 exact
contribution, artifact or summary revisions. A discussion container has no revision.
The selected set never implies intervening revisions, currency, reading or approval.
Coverage alone creates no typed assertion; separately authored references retain
their own meaning. Summary source coverage remains a different required declaration.

The note has no public identity, event, mutation or editor list. Its publisher and
policy are the owning revision's. Accounts use ordinary contribution authority;
target reading is required for new members, target editing is neither required
nor granted. A committed exact retry returns its original outcome before new-write
checks, without applying fields to a later revision.

## Immutable storage and ordering

Migration 0011 adds revision-owned note and account-set/member rows. Existing mention
and reference rows gain a `source_field` namespace (`main` or `change_note`). The
main namespace keeps continuing-resource identity and existing assertion carry/
withdrawal attribution. Note mentions belong to the owning exact revision. Note
references are newly asserted by that revision, even if a later note reuses the
same token or reference UUID. Main/note token and assertion IDs cannot collide.
No historical claims are inferred and no notification/delivery tables are added.

The publication transaction takes attempt, sorted participants/current credentials,
optional preparation/configuration, structure, complete sorted resource/owner,
and exact-revision guards before fixed inserts and the existing clock tail. Notes,
entities, references, change coverage, summary coverage, pointer, ordinary event,
intent and outcome share COMMIT. No new target locks follow the clock.

An identical immediate-base member may be retained without reauthorization. Whole
base carry preserves hidden membership without exposing its IDs; explicit replacement
or null deliberately removes prior members. New members require current eligibility.
No target update/move retargets a retained member. Independently authored account
prose survives target suppression; generated metadata does not. All note reads,
history, search and recovery obey owner and exact-revision restrictions.

## Retrieval, search and bounds

Generic exact bodies expose note/account presence and authorized exact-field URLs,
not expanded note text or raw change membership. The separate note body uses the
same safe renderer and independent participant resolution. Coverage returns eligible
exact metadata plus a qualified `unknown` flag, without hidden IDs, titles or counts.
Absence is explicit. No old note substitutes for an unavailable current note.

Discovery queries the authoritative note/member tables, with exact-revision scope
or an explicitly labelled resource aggregation of described exact revisions. Current
source membership is default; history is explicit. Ordering is source revision UUID, field, then described revision UUID. Each page reauthorizes in one REPEATABLE READ transaction with sorted
guards. Candidate scan 100, returned items 25, owner walk 32, total guards 3,840,
statement timeout 2.5 seconds; empty pages can continue. Encrypted five-minute,
2 KiB cursors bind caller, scope, history and source/visibility/organization boundary.
Only page size/byte budget may change. No totals, graph engine or activity feed.

Note text plus rationales: 4,096 UTF-8 bytes; main plus note plus all rationales:
16,384 bytes. Combined mentions/references: 16 each; each field uses at most 4,096
parser tokens and combined parsing is capped at 4,096. Complete JSON remains
4–128 KiB, with note bodies on an independent exact-field route. JSON escaping and
Unicode are measured at the final envelope, never silently truncated. Main text
limits are not enlarged. These are synthetic choices, not production capacity.

Search keeps one current document per owning resource, with separate note text and
field vectors plus explicit account classification. Matches identify main/note
fields and the exact source revision. Target metadata/rationales are not indexed.
Worker discovery/status/rebuild accept v3 together. Historical notes stay exactly
retrievable but are outside default current-only indexing. Indexing never changes
source claims, events or provenance.

## Browser and verification

New resource-revision drafts start with no note. Reload and retry restore the exact
attempt's authored note. Starting another revision fetches current authorized main
content, carries only existing account/summary declarations, saves a new key/base,
and then retires the completed record. Failed fetch/save retains the old record.
Corrections preserve attempted notes and reference edits, including v2→v3 upgrades.
For v2/v3 bases, only v1 drafts adopt comparison-base references, because v1
cannot represent them. ADR-036 adds explicit adoption of file declarations that
v2/v3 drafts cannot represent when correcting against a v4 base.
Newly supported metadata is adopted only at explicit new-draft creation.
An obsolete account carry remains saved until the author explicitly chooses the
comparison revision's declaration, replacement or removal. Its exact source read
checks declaration presence without exposing hidden members. Uncertain requests never upgrade.
Picker/preparation callbacks attach only to the latest owned draft and typing.

Verify the supplied acceptance cases with disposable PostgreSQL/HTTPS, paired browser
and direct clients, durable row assertions, deterministic locks/failures, populated
upgrade and old uncertain replay. Run the new suite, existing PostgreSQL suites,
`npm run check`, full normal browser suite and browser diagnostics; retain failures.
Record results separately. Notification delivery, Updates, files, private notes,
reservations, full moderation UI, deployment and provider/cross-machine trials stay
open. Reconsider these mechanisms for larger workloads, mixed-release browser tabs,
new target kinds or multiple API processes, preserving exact ownership and replay.

## Exact file reference extension

[ADR-036](036-exact-file-references.md) adds explicit v4 recorded references to
exact published artifact files and contribution attachments, including revision
notes. It preserves this contract’s independent contextual custody, authorization
and legacy replay semantics; file-reference discovery needs no extraction worker.
