import { Type, type Static } from '@sinclair/typebox';
import { UUID, closed, ReferenceTarget } from './participation.js';
export const noteContract = 'owner-notes-1';
export const noteLimits = Object.freeze({
  active: 128,
  identities: 500,
  decisions: 10000,
  titleBytes: 256,
  bodyBytes: 16384,
  links: 8,
  linkBytes: 2048,
  requestBytes: 131072,
  detailBytes: 131072,
  pageBytes: 32768,
  page: 25,
  queryBytes: 256,
  queryTerms: 32,
});
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });
export const NoteLinks = Type.Array(ReferenceTarget, { maxItems: noteLimits.links });
export const NoteFields = {
  title: Type.String({ maxLength: noteLimits.titleBytes }),
  body: Type.String({ minLength: 1, maxLength: noteLimits.bodyBytes }),
  links: NoteLinks,
};
export const NoteCreate = Type.Object(
  { idempotency_key: UUID, note_id: UUID, ...NoteFields },
  closed,
);
export const NoteUpdate = Type.Object(
  { ...NoteCreate.properties, expected_version: version },
  closed,
);
export const NoteDelete = Type.Object(
  { idempotency_key: UUID, note_id: UUID, expected_version: version },
  closed,
);
export const NoteAction = Type.Union(['create', 'update', 'delete'].map((k) => Type.Literal(k)));
export type NoteActionValue = 'create' | 'update' | 'delete';
export const noteCommands = { create: NoteCreate, update: NoteUpdate, delete: NoteDelete };
export const NoteStatusInput = Type.Object({ action: NoteAction, idempotency_key: UUID }, closed);
export const NoteIdentity = Type.Object(
  {
    note_id: UUID,
    version,
    state: Type.Union([Type.Literal('active'), Type.Literal('deleted')]),
    deleted_at: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export const NoteDeleted = Type.Object(
  { note_id: UUID, version, state: Type.Literal('deleted'), deleted_at: Type.String() },
  closed,
);
export const NoteActive = Type.Object(
  {
    note_id: UUID,
    version,
    state: Type.Literal('active'),
    ...NoteFields,
    created_at: Type.String(),
    updated_at: Type.String(),
  },
  closed,
);
export const NoteDetail = Type.Union([NoteActive, NoteDeleted]);
export const NoteResult = Type.Object(
  {
    operation_state: Type.Union([Type.Literal('applied'), Type.Literal('version_conflict')]),
    operation_id: UUID,
    action: NoteAction,
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    outcome: Type.Object(
      {
        note_id: UUID,
        expected_version: Type.Integer({ minimum: 0 }),
        result_version: version,
        decided_at: Type.String(),
      },
      closed,
    ),
    current: NoteIdentity,
  },
  closed,
);
export const NoteStatus = Type.Union([
  NoteResult,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export const NoteQuery = Type.Object(
  {
    query: Type.String({ maxLength: 256 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    max_response_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 32768 })),
    cursor: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  closed,
);
export const NoteListItem = Type.Object(
  {
    note_id: UUID,
    version,
    title: Type.String(),
    excerpt: Type.String(),
    excerpt_abbreviated: Type.Boolean(),
    links: NoteLinks,
    updated_at: Type.String(),
  },
  closed,
);
export const NotePage = Type.Object(
  {
    items: Type.Array(NoteListItem, { maxItems: 25 }),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
    collection_version: Type.Integer({ minimum: 0 }),
    scope: Type.Literal('own_current_notes'),
    ordering: Type.Literal('note_id_ascending'),
    matching: Type.Literal('simple_lexical_and'),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export const NoteSources = Type.Object(
  {
    note_id: UUID,
    version,
    items: Type.Array(
      Type.Object(
        {
          target: ReferenceTarget,
          source: Type.Union([
            Type.Object({ state: Type.Literal('unavailable') }, closed),
            Type.Object(
              {
                state: Type.Literal('available'),
                title: Type.Union([Type.String(), Type.Null()]),
                url: Type.String(),
              },
              closed,
            ),
          ]),
        },
        closed,
      ),
      { maxItems: 8 },
    ),
  },
  closed,
);
export type NoteCreateInput = Static<typeof NoteCreate>;
export type NoteUpdateInput = Static<typeof NoteUpdate>;
export type NoteDeleteInput = Static<typeof NoteDelete>;
export type NoteDetailView = Static<typeof NoteDetail>;
export type NoteActiveView = Static<typeof NoteActive>;
export type NoteDeletedView = Static<typeof NoteDeleted>;
export type NoteIdentityView = Static<typeof NoteIdentity>;
export type NoteResultView = Static<typeof NoteResult>;
export type NoteStatusView = Static<typeof NoteStatus>;
export type NotePageView = Static<typeof NotePage>;
export type NoteQueryInput = Static<typeof NoteQuery>;
export type NoteSourcesView = Static<typeof NoteSources>;
