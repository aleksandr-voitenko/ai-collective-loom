# ADR-029: Bounded synthetic artifact files

Status: implementation contract, 21 October 2026. This is the file-artifact slice
of ART-01–04/09–10, not attachment promotion, extraction or production approval.
Product and architecture snapshots and existing migration bytes stay unchanged.

## Custody and transport

Use the pinned local SeaweedFS with private, versioned staging and final buckets.
The application uses the S3 SDK with explicit credentials and no automatic write
retry. Fail closed without native versioning. No filesystem fallback exists.
Authenticated HTTPS single-part transfers go through Loom. This intentionally
avoids exposing the local HTTP S3 endpoint or introducing a browser storage origin,
CORS policy and signed upload capabilities. Participants receive neither storage
keys nor credentials. Reconsider direct signed transfers when a separately trusted
HTTPS storage origin and provider-specific quota/grant tests are available.

An owner creates an immutable upload intent naming the destination area or artifact,
length, SHA-256 and declared media type. The session UUID is its preparation identity.
Upload and finalize are explicit actions on that identity. Byte retries must match
length and SHA-256. The server verifies stored staging bytes, fixes its native
version, then writes validated bytes to a server-only final key and records that
exact native version. Conditional creation and bounded version reconciliation
resolve lost storage acknowledgements; never choose an unverified latest version.
Finalization and transfer run outside SQL transactions and publication guards.
Private status reveals only the owner's intent and custody state, never source text.

Synthetic limits: 4 MiB/file, 16 entries/revision, 32 MiB/revision, 16 KiB manifest,
512 UTF-8 bytes/path, eight path segments, four concurrent transfers per process,
four unfinished uploads/owner, 128 retained upload identities/owner and 4096/global.
Reserve twice declared bytes for staging plus final: 64 MiB/owner and 256 MiB/global.
Serialize admission/accounting under a dedicated file custody guard before structure.
Retries and status do not consume another identity. Metadata tombstones do not expire.
Upload admission lasts one hour; prepared handles last 24 hours from creation.
Storage operations have a 15-second deadline. An uncertain storage operation retains
its reservation until explicit reconciliation or bounded cleanup proves removal.
Uploads and downloads share four HTTP admissions, held until response completion
or disconnection with a 15-second absolute deadline. Four storage admissions cover
incoming buffers before their first database wait, native IO, and verified buffers
awaiting final database association/authorization. Slow or disconnected clients
cannot create an unbounded queue of retained file buffers.

## Publication and paths

`artifact-files-v1` is an explicit publication envelope with a complete `files` list.
It is independent of authored Markdown versions. Empty main text is supported only
by a file-aware artifact publication with a nonempty manifest; no dummy prose.
Each member names either an owner-bound prepared upload or an exact prior file
context of this same artifact. Reuse rechecks source revision eligibility and
editing authority and creates a new revision-owned context. No global hash lookup.
Legacy outcomes/digests keep their meanings. New legacy writes cannot strip a
file-aware base; committed legacy retries resolve first.

Normalize paths to NFC, then require relative POSIX segments: no absolute/drive/UNC,
backslash, empty/dot/parent segment, control character or symlink declaration.
Reject normalized duplicates, file/directory prefix collisions and ASCII-case
aliases. Non-ASCII case is significant; this is explicitly not universal Unicode
case folding or a promise of case-insensitive export portability. Paths are JSON
values/query parameters encoded once by URLSearchParams and decoded once by HTTP.
Contextual UUID download routes avoid interpreting a path as a storage locator.
All syntactically valid declared media types are passive bytes, never sniffed.

Attempt → participants/current credentials → file custody → structure → full sorted
resource plan → revisions → immutable file set/contexts → common publication tail.
The manifest, revision, references, pointer, ordinary event, intents and outcome
commit atomically. No network or parser runs under publication locks. Cleanup takes
the same custody guard before claiming expired, unassociated objects, so publication
either secures permanent association or refuses a cleaning/expired member.

## Reads and lifetime

Exact manifest reads authorize artifact, revision and context on every page. Pages
contain immediate child folders/files, at most 25 items, 4–128 KiB serialized JSON,
and preserve the next position when a candidate does not fit. No file bodies or
hidden totals. Download retrieves only the recorded native version and checks its
length/digest. Missing versions fail explicitly; no fallback. Declared manifests
do not certify current byte health.

Downloads use attachment/octet-stream, no-store, nosniff and sandbox headers.
Authorization is checked at request start and again after storage retrieval, before
response delivery. Already delivered bytes and an in-flight response cannot be
recalled. There are no durable or replayed download grants. File inspection does not
mark file contents read; only nonempty main text uses existing presentation rules.
Search indexes title and authored text, never file names or file contents.

Cleanup is explicit, bounded and restartable: claim at most eight expired sessions,
reconcile exact versions and delete only versions belonging to their recorded keys.
Wait beyond the transfer lease/deadline before cleanup. Published final versions
have no staging TTL and are never selected for deletion; retained outcomes and
upload tombstones survive. Uncertain/over-budget version histories remain quarantined
and reserved until explicit bounded reconciliation succeeds. No development bucket
sweep, published erasure, retention policy or disaster recovery is authorized.

## Client custody and acceptance

Keep exact upload metadata and publication JSON in the existing bounded owner journal
before dispatch. Never persist File bytes, credentials or storage capabilities. Reload requires
explicit byte reselection if transfer has not completed; compare SHA-256 and length
before sending. Prepared files and uncertain publications recover without reupload.
Label recovery by action, destination and path. Correction preserves attempted
manifest additions/removals/renames and handles, text, references and note. Only an
explicit correction after definitive rejection creates a new publication identity.
Editable drafts retain incomplete paths, including an empty path during editing;
strict path validation applies before publication dispatch. Already-dispatched
metadata remains immutable and strict. A partial draft must not block recovery of
other retained operations.
An explicit first metadata-admission refusal can be removed from the browser
journal by the owner. Refusal after an uncertain attempt or after metadata admission
does not erase custody or settle earlier uncertainty; keep the original identity.
The independent HTTPS client emits only recognized error codes and outcome markers
on refusal, exits with status 1 and leaves its journal unchanged. In particular,
recorded expiry refusal remains distinguishable from an unknown publication result.

Verify native exact snapshots, overwrite/copy uncertainty, atomic refusal, authority
and cleanup orderings, populated upgrade, restart/recreation, bounded quotas and
pages, passive handling and private-state independence. Exercise real HTTPS with
replacement credentials, production Chromium and mounted StrictMode. Register new
native tests in the normal coverage/CI path without changing gates or baselines.
Record actual execution separately; this ADR is a contract, not passing evidence.
