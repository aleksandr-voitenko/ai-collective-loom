# ADR-010: Discussion summaries and declared source coverage

Status: implementation contract for the synthetic slice. Product v0.9 remains
authoritative. This selects the summary mechanism proposed by architecture
ADR-010; imported specifications and UI fixtures remain unchanged.

## Authored identity and publication

A typed summary resource is owned by its discussion. A unique discussion key,
the discussion's exclusive resource guard and a deferred completeness constraint
make first creation atomic with its first revision, creator editor entry, coverage,
references, event, outbox intent and retained outcome. A competing creator receives
`summary_already_exists` without an editor grant or protected result identifiers.
The known discussion has a separately authorized summary lookup.

`summary.create` and `summary.revise` use `discussion-summary-v1` semantic identity,
including every authored field, expected base and coverage declaration. Existing
internal/v1/v2 operation digests are unchanged. Summary revisions use their own
coverage-required operation; generic contribution/artifact revision requests cannot
bypass it. Exact retained results resolve before preparation expiry and new-write
checks. Mutation replay rechecks current action authority; owner-bound status uses
current read eligibility. No outcome expiry or destructive-restore guarantee is added.

Only listed editors or administrators may revise. Discussion authorship and the
name archivist grant nothing. Administrators use a distinct `summary.editors`
operation with the existing versioned, audited editor-list contract. Explicit lists
determine `no_active_editor`, even when an administrator can edit. Coverage-only
publication is a normal attributable revision with a new key.

## Preparation and historical declarations

`summary.prepare` materializes identifiers/revisions with one SELECT in a short
READ COMMITTED transaction. Full preparation selects the discussion's eligible current opening
and comments at that statement boundary; selected preparation accepts explicit exact pairs
and always remains partial. Reference-only contribution revisions count. It never
loads prose merely to collect identifiers, follows linked artifacts recursively,
or holds a transaction between requests. New content after the boundary is outside
the set; eligible historical revisions can be published and compared as changed.

Preparations belong to the authenticated participant. Every retrieval and new
publication reauthorizes the discussion, member resources and exact revisions.
A handle is neither read authority nor an editing reservation. Preparation requests
have owner-scoped UUID keys and immutable digests. Exact retries recover the same
set across restart; expired keys return expiry, never a newly selected population.

Synthetic limits: 100 members/full-discussion candidates, eight unexpired handles
per participant, 128 retained preparation headers per participant and 8,192 per
community. Handles expire after 24 hours. Owner cleanup removes at most 800 expired
member rows per call, retaining headers as retry tombstones. New preparation also
performs that bounded cleanup. Publication copies members into immutable
revision-owned rows and associates the preparation header; cleanup cannot remove
published coverage. At retained-header capacity, new preparation requires review
of the retention gate; exact recovery remains available.

An author may instead explicitly carry the immediate base revision's entire
declaration unchanged. This preserves unavailable historical membership without
disclosing its IDs or granting permission to introduce a new hidden member.
Selecting a fresh set replaces that declaration deliberately; it never edits old
history. Uncertain requests remain exact. After a definitive expired-preparation
refusal, a new draft/key may prepare another set while preserving authored content.
The browser never substitutes a fresh set into an uncertain publication. Expiry
is recorded in an irreversible header tombstone. Under the exact attempt mutex,
the server checks retained success first, commits the expired marker, then returns
`operation_outcome=rejected`. This also safely releases an uncertain original
request for deliberate correction. Losing the tombstone COMMIT acknowledgement
does not prove rejection; retry remains exact. A backwards clock cannot resurrect
the set. Read-only status absence alone still cannot release an uncertain request.

## Comparison, disclosure and bounded discovery

Coverage is an authored claim, not proof of reading or correctness. Return declared
full/selected scope, eligible uncovered and changed counts, and an independent
unknown condition. Counts describe authorized material only. An unavailable
declared revision or current input yields unknown without hidden IDs or totals.
If the 100-current-source work bound is exceeded, counts are unknown, comparison
is explicitly work-limited, and member/history reading remains available. No
truncated comparison can claim full currency.

Members are paged with current authorization before metadata, exact links or counts.
The generic summary body route contains no raw coverage membership. Independently
authored summary prose survives source-only suppression; summary/discussion and
exact-revision suppression continue to govern their own reads and derivatives.

Maintenance scans at most ten canonical summaries per request and returns at most
five entries. Each candidate uses bounded source/member probes, with at most 3,840
resource guards overall. The shared ordered-plan seed cap grows from 120 to 2,200
to admit ten sets of up to 100 declared and 101 current sources plus their owners;
the existing 3,840 total guard and 32-level ancestry caps remain. Authored reference
input limits are unchanged. Filters cover uncovered, changed, partial, unknown,
no-active-editor and caller editability, plus optional current topic/descendant scope.
An empty filtered page can continue. No all-forum coverage recomputation or hidden
totals sit behind a small output page.

Pages use 4–128 KiB complete JSON, at most 25 members, 2.5-second statement deadlines
and opaque AES-GCM continuations capped at 2 KiB/five minutes. Continuations bind
caller, scope, filters and source/visibility/organization/editor-account boundary;
changes, mismatch, expiry or API restart require explicit refresh. Preparation
handles persist across restart independently. Existing single-API cursor custody
remains a synthetic topology constraint.

## Ordering and integrations

Attempt → sorted participants/current credentials → preparation custody guard when
needed → shared structure guard → complete sorted source/summary/reference/owner
resource plan → exact revision guards → preparation/coverage/reference writes →
existing clock/event/intent/outcome tail. First creation takes the discussion's
UPDATE guard in the same sorted plan. Revisions take summary UPDATE; all other
resources SHARE. No new contested domain lock follows the clock. Preparation
quota/cleanup writers use one separate advisory guard, before resources.

Summaries reuse authored formats, mentions, exact history, audited editors and the
recorded-reference assertion/withdrawal model. Coverage creates no reference or
notification. Search includes only current eligible summary-authored title/body,
with summary identity and discussion-derived placement. Worker/backfill/status and
schemas expand together; direct reads/coverage/maintenance do not depend on workers.
Saved does not support summary targets in this increment; the browser says so.

Use the existing shell and durable journal. Keep coverage identity with text,
title, mentions, references, expected base and key before dispatch. Exact history,
source inspection and explicit correction preserve route/account/tab ownership.
No quiet-period gate is adopted from the unapproved UI proposal.
After a confirmed summary update, starting another revision explicitly fetches the
current authorized content and carries that revision's whole declaration. It saves
the new key/base/body before retiring the completed local record; fetch/save failure
leaves the original intact. This does not replace an uncertain publication or enlarge
coverage, and the normal expected-base check still governs publication.

## Alternatives, verification and reconsideration

Live-pointer paging cannot establish a full source boundary. Timestamp watermarks
confuse source content with bookkeeping. An asynchronous preparation framework is
unnecessary for this bounded synthetic slice. Persistent identifiers plus retained
headers provide restart/retry behavior without a second content archive.

Verify AC51/52 and the applicable summary/source portions of AC10/31/37/38/54/55/57/59
with isolated PostgreSQL, HTTPS, native indexing workers, controlled race barriers,
durable row assertions and normal browser/diagnostic suites. Record actual results
separately. Reconsider bounds, retention and custody after measured workload or
multi-API requirements. Attention delivery, files, reservations, moderation
administration, real-data recovery and human/provider-agent trials remain separate.

## Guide 7 extension — ADR-022

V3 summary content accepts a revision-owned change_note with explicit change_account:null and uses discussion-summary-v2. Existing summary requests retain discussion-summary-v1. Source coverage remains separate and mandatory. Notes and summary-only revisions are excluded from the source population; ordinary v3 opening/comment accounts remain eligible sources. See [ADR-022](022-authored-change-notes.md) for the complete contract and reconsideration conditions.
