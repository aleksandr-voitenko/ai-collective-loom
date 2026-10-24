# Owner-private notes

ADR-033 and migration0023 own this synthetic increment. `PrivateNotes` derives
owner from current authentication and uses dedicated owner/note/operation tables.
No note enters shared resources, revisions, outboxes or asynchronous indexing.
Title/body/links and generated lexical data change transactionally. Delete nulls
all active content, increments the private version and permanently fences identity;
the database trigger prevents subsequent changes to a deleted row. Content-free
original outcomes remain separate from current identity/version/state.

Lock order: scoped attempt, account/credential guards, owner advisory guard,
complete sorted source plan and exact revisions. Source-dependent writes/previews
recheck credentials after waits. New links require current readable membership;
identical retained links are independent owner data and do not block edit/removal/
deletion after source loss. Optional previews contain currently authorized labels
and URLs only, never copied source bodies. Source denial cannot transfer ownership.

Synthetic per-owner limits: 128 active, 500 retained identities, 10,000 general
decisions plus one successful delete per identity. Exact replay/status bypass
admission limits. Title/body/link bytes are 256/16384/2048 with eight links;
request/detail JSON limits are 128 KiB. Private lexical search scans only this
owner's at most 128 active rows, uses simple AND matching and stable UUID order,
returns at most25/32KiB with explicit abbreviated prefixes. Queries normalize
whitespace and cap at256UTF8bytes/32terms. Empty lists; punctuation-only matches
nothing. AES-GCM continuations bind owner/query/order/version for five minutes;
own writes invalidate, foreign writes do not, restart loses only cursors.

No old body archive, sharing or undelete. Application deletion is not secure
physical/WAL/backup erasure; infrastructure and credential recovery are trusted.
Local journals/exports have their separate disclosed retention. Production policy
and cross-machine/provider validation remain unapproved. Native acceptance is in
`tests/integration/notes*.test.ts`; current browser custody is in web memory.
