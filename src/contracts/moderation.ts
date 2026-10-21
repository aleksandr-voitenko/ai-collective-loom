import { Type, type Static } from '@sinclair/typebox';
import { UUID, NullableId, closed } from './participation.js';

export const moderationContract = 'moderation-state-1';
export const moderationLimits = Object.freeze({
  requestBytes: 4096,
  responseBytes: 32768,
  items: 25,
  scan: 100,
  decisions: 10000,
});
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });
export const ModerationKind = Type.Union(
  (['discussion', 'comment', 'summary', 'artifact'] as const).map((k) => Type.Literal(k)),
);
export const ModerationTarget = Type.Object({ kind: ModerationKind, resource_id: UUID }, closed);
export const ModerationInput = Type.Object(
  {
    idempotency_key: UUID,
    target: ModerationTarget,
    suppressed: Type.Boolean(),
    expected_version: Type.Integer({ minimum: 1, maximum: 2147483646 }),
  },
  closed,
);
export type ModerationCommand = Static<typeof ModerationInput>;
export type ModerationTargetView = Static<typeof ModerationTarget>;
export const ModerationStatusInput = Type.Object({ idempotency_key: UUID }, closed);
export const ModerationResource = Type.Object(
  {
    target: ModerationTarget,
    local_state: Type.Union(
      (['active', 'suppressed', 'removed'] as const).map((s) => Type.Literal(s)),
    ),
    version,
    owner_id: NullableId,
    ordinary_read_available: Type.Boolean(),
  },
  closed,
);
export type ModerationResourceView = Static<typeof ModerationResource>;
export const ModerationOutcome = Type.Object(
  { target: ModerationTarget, suppressed: Type.Boolean(), version },
  closed,
);
export const ModerationResult = Type.Object(
  {
    operation_state: Type.Literal('recorded'),
    operation_id: UUID,
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    outcome: ModerationOutcome,
    current: ModerationResource,
  },
  closed,
);
export const ModerationStatus = Type.Union([
  ModerationResult,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export type ModerationResultView = Static<typeof ModerationResult>;
export type ModerationStatusView = Static<typeof ModerationStatus>;
export const ModerationPageInput = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 2048 })),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|1[0-9]|2[0-5])$' })),
  },
  closed,
);
const page = {
  next_cursor: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  complete: Type.Boolean(),
};
export const ModerationPage = Type.Object(
  { ...page, items: Type.Array(ModerationResource, { maxItems: 25 }) },
  closed,
);
export type ModerationPageView = Static<typeof ModerationPage>;
export const ModerationAudit = Type.Object(
  {
    ...page,
    items: Type.Array(
      Type.Object(
        {
          operation_id: UUID,
          actor_id: UUID,
          target: ModerationTarget,
          suppressed: Type.Boolean(),
          version,
          recorded_at: Type.String(),
        },
        closed,
      ),
      { maxItems: 25 },
    ),
  },
  closed,
);
export type ModerationAuditView = Static<typeof ModerationAudit>;
