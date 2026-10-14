# ADR-011: Bounded authored text for participation-1

Status: implemented for the synthetic text participation slice. This selects a
minimal dialect for review, not the complete product reference/file/summary model.
The imported product v0.9 and architecture v0.3 remain unchanged.

## Choice and rationale

Use `{format: "loom-markdown-v1", text, mentions}` in every supported publication.
The browser and API use the same pinned markdown-it 15.0.2 CommonMark parser, with
raw HTML, images and linkification disabled, and a maximum nesting depth of 20.
Links must use HTTP or HTTPS. Raw HTML and uploaded/transcript-like text have no
executable meaning. The React renderer constructs an allowlisted element tree;
it never passes user text to `innerHTML`. Remote images, embeds, fetches and model
calls are absent. Ordered lists, headings, paragraphs, emphasis, links, quotes and
code remain useful without installing a rich-document or model subsystem.

Text is retained exactly: no whitespace, newline or Unicode normalization. Reject
NUL, unpaired surrogates, more than 16,384 UTF-8 bytes, or more than 4,096 parsed
tokens. Titles are nonblank, at most 160 characters and round-trip through UTF-8.
These are executable synthetic limits; production capacity is not approved.

`[[mention:m1]]` has entity meaning only with a matching declared
`{token:"m1", participant_id:"…"}`. At most 16 entities are accepted; each token
must occur once in ordinary prose, not a link label, quote or code. Participant
IDs must name active admitted participants. The browser picker inserts both parts;
removal removes the token and declaration. Raw `@nickname`, arbitrary URL text,
quoted/transcript text and file text never infer recipients. Display names are
resolved independently from retained IDs, so rename does not retarget history.
Explicitly converting text with the picker is an authored action.

Immutable revision-owned entity rows commit with the text through the shared
publication tail. Notifications remain disabled pending fenced worker output and
attention/delivery validation; accepting a mention does not promise delivery.

## Scope and alternatives

Plain text would avoid parser work but would not test the reviewed prose/entity
boundary or provide the prototype's basic authoring experience. A rich JSON AST
would introduce a larger editor/compatibility contract before this slice needs it.
The selected dialect is versioned so neither choice is imposed on future releases.

Ordinary HTTP(S) links, including exact Loom revision URLs, are retained as authored
links. They are not typed provenance, recorded backlinks, preserved remote bytes,
change coverage or notification entities. Unsupported reference, audience, file,
manifest and summary fields are rejected, never silently ignored. Add a versioned
representation and canonicalization decision before those operations are enabled.

The 128 KiB request/response cap can hold the worst JSON escaping of every accepted
16 KiB text plus its bounded metadata/entities. Lists explicitly omit bodies and
provide the exact revision URL; a smaller requested byte budget fails explicitly
with a measured minimum. See [ADR-016](016-bounded-participation-retrieval.md).

Review these choices when adding rich authoring, recorded references, new entity
types, files, or larger content. Existing retained representations and digests must
remain interpretable. Source: `src/contracts/authored.ts`, `AuthoredText.tsx`,
participation HTTP tests and authored-rendering tests; architecture §10.1.

The parser's primary reference is the
[markdown-it project](https://github.com/markdown-it/markdown-it).
