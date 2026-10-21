import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID, Resource, PageInput } from './participation.js';

export const savedLimits = Object.freeze({
  targets: 500,
  operations: 10000,
  pageItems: 25,
  ownerResources: 32,
});
export const SavedTarget = Type.Union([
  Type.Object(
    {
      kind: Type.Union([
        Type.Literal('discussion'),
        Type.Literal('contribution'),
        Type.Literal('artifact'),
      ]),
      resource_id: UUID,
    },
    closed,
  ),
  Type.Object({ kind: Type.Literal('revision'), resource_id: UUID, revision_id: UUID }, closed),
]);
export type SavedTargetView = Static<typeof SavedTarget>;
export const SavedVersion = Type.Integer({ minimum: 0, maximum: 2147483646 });
export const SavedUpdate = Type.Object(
  {
    idempotency_key: UUID,
    target: SavedTarget,
    saved: Type.Boolean(),
    expected_version: SavedVersion,
  },
  closed,
);
export type SavedUpdateInput = Static<typeof SavedUpdate>;
export const SavedStatusInput = Type.Object({ idempotency_key: UUID }, closed);
export const SavedItem = Type.Object(
  {
    target: SavedTarget,
    saved: Type.Boolean(),
    version: SavedVersion,
    source: Type.Union([
      Type.Object(
        {
          state: Type.Literal('available'),
          resource: Resource,
          observed_revision_id: Type.Union([UUID, Type.Null()]),
        },
        closed,
      ),
      Type.Object({ state: Type.Literal('unavailable') }, closed),
    ]),
  },
  closed,
);
export type SavedItemView = Static<typeof SavedItem>;
// A terminal decision is separate from today's bookmark state. HTTP 200 is not
// an assertion that the requested state was applied: inspect operation_state.
export const SavedResult = Type.Object(
  {
    operation_state: Type.Union([Type.Literal('applied'), Type.Literal('version_conflict')]),
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    operation_id: UUID,
    outcome: Type.Object(
      {
        target: SavedTarget,
        saved: Type.Boolean(),
        expected_version: SavedVersion,
        result_version: SavedVersion,
      },
      closed,
    ),
    current: SavedItem,
  },
  closed,
);
export type SavedResultView = Static<typeof SavedResult>;
export const SavedStatus = Type.Union([
  SavedResult,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export type SavedStatusView = Static<typeof SavedStatus>;
export const SavedPageInput = PageInput;
export const SavedPage = Type.Object(
  {
    items: Type.Array(SavedItem, { maxItems: savedLimits.pageItems }),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
    collection_version: SavedVersion,
    ordering: Type.Literal('stable_target_id'),
    scope: Type.Literal('own_saved_items'),
    representation: Type.Literal('currently_authorized_metadata'),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export type SavedPageView = Static<typeof SavedPage>;
