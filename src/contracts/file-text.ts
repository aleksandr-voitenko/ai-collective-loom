import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID, Participant, PageInput } from './participation.js';
import { SearchPage } from './search.js';

export const fileTextLimits = Object.freeze({
  outputBytes: 65536,
  responseBytes: 32768,
  pageCharacters: 4096,
  derivedBytes: 32 * 1024 * 1024,
  jobs: 65536,
  discovery: 25,
  concurrency: 2,
  leaseSeconds: 30,
  attempts: 3,
  cursorSeconds: 300,
});
export const textFormats: Readonly<Record<string, readonly string[]>> = Object.freeze({
  txt: [],
  md: ['text/markdown'],
  csv: ['text/csv'],
  json: ['application/json'],
  js: ['text/javascript', 'application/javascript'],
  ts: ['text/typescript', 'application/typescript'],
  py: ['text/x-python'],
  go: ['text/x-go'],
  rs: ['text/x-rust'],
  c: ['text/x-c'],
  h: ['text/x-c'],
});
/** A declaration selects only a candidate decoder, never an execution mode. */
export function supportedTextFormat(path: string, mediaType: string) {
  const name = path.split('/').at(-1)!,
    dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = name.slice(dot + 1).toLowerCase();
  const types = Object.hasOwn(textFormats, extension) ? textFormats[extension] : undefined;
  return Boolean(types && ['text/plain', 'application/octet-stream', ...types].includes(mediaType));
}
export const FileTextState = Type.Union(
  ['not_discovered', 'queued', 'running', 'complete', 'partial', 'unsupported', 'failed'].map((s) =>
    Type.Literal(s),
  ),
);
export const FileTextView = Type.Object(
  {
    resource_id: UUID,
    revision_id: UUID,
    file_id: UUID,
    owner_kind: Type.Union([Type.Literal('artifact'), Type.Literal('contribution')]),
    path: Type.String(),
    representation: Type.Literal('literal-utf8-v1'),
    processing: FileTextState,
    reason: Type.Union([Type.String(), Type.Null()]),
    worker: Type.Union(['unknown', 'online', 'offline'].map((s) => Type.Literal(s))),
    indexing: Type.Union(
      ['pending', 'indexed', 'not_supported', 'failed'].map((s) => Type.Literal(s)),
    ),
    retained_bytes: Type.Integer(),
    original_bytes: Type.Integer(),
    text: Type.Union([Type.String(), Type.Null()]),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    retained_text_complete: Type.Boolean(),
    source_complete: Type.Boolean(),
    download_url: Type.String(),
    context_url: Type.String(),
    browser_context_url: Type.String(),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export type FileTextValue = Static<typeof FileTextView>;
export const FileTextInput = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 2048 })),
    max_response_bytes: PageInput.properties.max_response_bytes,
  },
  closed,
);
export type FileTextOptions = Static<typeof FileTextInput>;
export const FileSearchInput = Type.Object(
  {
    q: Type.String({ minLength: 1, maxLength: 256 }),
    topic: Type.Optional(UUID),
    descendants: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    kind: Type.Optional(
      Type.Union(['discussion', 'comment', 'artifact', 'summary'].map((s) => Type.Literal(s))),
    ),
    author: Type.Optional(UUID),
    from: Type.Optional(Type.String({ maxLength: 30 })),
    before: Type.Optional(Type.String({ maxLength: 30 })),
    ...PageInput.properties,
    cursor: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  closed,
);
export type FileSearchOptions = Static<typeof FileSearchInput>;
export const FileSearchStatus = Type.Object(
  {
    worker: Type.Union(['unknown', 'online', 'offline'].map((s) => Type.Literal(s))),
    coverage: Type.Union([Type.Literal('retained_prefixes_ready'), Type.Literal('incomplete')]),
    population: Type.Literal('current_eligible_file_contexts'),
    qualification: Type.Literal('supported_utf8_prefixes_only'),
  },
  closed,
);
export type FileSearchStatusValue = Static<typeof FileSearchStatus>;
export const FileSearchResult = Type.Object(
  {
    file_id: UUID,
    source_resource_id: UUID,
    revision_id: UUID,
    owner_kind: Type.Union([Type.Literal('artifact'), Type.Literal('contribution')]),
    kind: Type.Union(['discussion', 'comment', 'artifact'].map((s) => Type.Literal(s))),
    path: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
    author: Participant,
    publisher: Participant,
    published_at: Type.String(),
    area_id: UUID,
    location: Type.Array(Type.Object({ id: UUID, title: Type.String() }, closed), { maxItems: 32 }),
    discussion_id: Type.Union([UUID, Type.Null()]),
    parent_id: Type.Union([UUID, Type.Null()]),
    matching_field: Type.Literal('file_contents'),
    excerpt: Type.String(),
    extraction: Type.Union([Type.Literal('complete'), Type.Literal('partial')]),
    indexing: Type.Literal('indexed'),
    preview_url: Type.String(),
    browser_url: Type.String(),
    download_url: Type.String(),
    context_url: Type.String(),
    browser_context_url: Type.String(),
  },
  closed,
);
export type FileSearchResultValue = Static<typeof FileSearchResult>;
export const FileSearchPage = Type.Object(
  {
    items: Type.Array(FileSearchResult, { maxItems: 25 }),
    query: Type.String(),
    scope: SearchPage.properties.scope,
    indexing: FileSearchStatus,
    ranking: Type.Literal('simple-file-contents-v1'),
    selection: Type.Literal('bounded_current_file_relevance'),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    window_exhausted: Type.Boolean(),
    selection_limited: Type.Boolean(),
    corpus_exhaustive: Type.Literal(false),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
    expires_at: Type.String(),
  },
  closed,
);
export type FileSearchPageValue = Static<typeof FileSearchPage>;
export const FileTextHealth = Type.Object(
  {
    generation: Type.Integer(),
    worker: FileSearchStatus.properties.worker,
    retained_bytes: Type.Integer(),
    reserved_bytes: Type.Integer(),
    items: Type.Array(
      Type.Object(
        {
          file_id: UUID,
          claim_generation: Type.Integer(),
          reason: Type.Union([Type.String(), Type.Null()]),
        },
        closed,
      ),
      { maxItems: 25 },
    ),
    next_after: Type.Union([UUID, Type.Null()]),
  },
  closed,
);
export type FileTextHealthValue = Static<typeof FileTextHealth>;
