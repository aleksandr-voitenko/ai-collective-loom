import { Type, type Static } from '@sinclair/typebox';
import { UUID, closed } from './participation.js';

export const reservationContract = 'editing-intent-1';
export const reservationLimits = Object.freeze({
  requestBytes: 4096,
  responseBytes: 32768,
  purposeBytes: 512,
  scopeBytes: 256,
  perResource: 100,
  perOwner: 128,
  notices: 4096,
  decisions: 10000,
  activePerResource: 25,
  activePerOwner: 16,
  page: 25,
});
const version = Type.Integer({ minimum: 1, maximum: 2147483647 });
const duration = Type.Optional(Type.Integer({ minimum: 1, maximum: 120 }));
export const IntentScope = Type.Union([
  Type.Object({ kind: Type.Literal('whole') }, closed),
  Type.Object(
    { kind: Type.Literal('described'), description: Type.String({ minLength: 1, maxLength: 256 }) },
    closed,
  ),
]);
export const AnnounceIntent = Type.Object(
  {
    idempotency_key: UUID,
    resource_id: UUID,
    base_revision_id: UUID,
    purpose: Type.String({ minLength: 1, maxLength: 512 }),
    scope: IntentScope,
    duration_minutes: duration,
  },
  closed,
);
export const RenewIntent = Type.Object(
  { idempotency_key: UUID, notice_id: UUID, expected_version: version, duration_minutes: duration },
  closed,
);
export const ReleaseIntent = Type.Object(
  { idempotency_key: UUID, notice_id: UUID, expected_version: version },
  closed,
);
export const IntentAction = Type.Union(
  ['announce', 'renew', 'release'].map((k) => Type.Literal(k)),
);
export type IntentActionValue = 'announce' | 'renew' | 'release';
export const IntentStatusInput = Type.Object(
  { action: IntentAction, idempotency_key: UUID },
  closed,
);
export type AnnounceIntentInput = Static<typeof AnnounceIntent>;
export type RenewIntentInput = Static<typeof RenewIntent>;
export type ReleaseIntentInput = Static<typeof ReleaseIntent>;
export const IntentTemporal = Type.Object(
  {
    notice_id: UUID,
    version,
    expires_at: Type.String(),
    released_at: Type.Union([Type.String(), Type.Null()]),
    state: Type.Union(['active', 'expired', 'released'].map((k) => Type.Literal(k))),
  },
  closed,
);
export const IntentOutcome = Type.Object(
  {
    notice_id: UUID,
    version,
    accepted_at: Type.String(),
    expires_at: Type.String(),
    released_at: Type.Union([Type.String(), Type.Null()]),
  },
  closed,
);
export const IntentResult = Type.Object(
  {
    operation_state: Type.Literal('recorded'),
    operation_id: UUID,
    action: IntentAction,
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    outcome: IntentOutcome,
    current: IntentTemporal,
    observed_at: Type.String(),
  },
  closed,
);
export const IntentStatus = Type.Union([
  IntentResult,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export type IntentResultView = Static<typeof IntentResult>;
export type IntentStatusView = Static<typeof IntentStatus>;
export const EditingNotice = Type.Object(
  {
    ...IntentTemporal.properties,
    resource_id: UUID,
    base_revision_id: UUID,
    participant_id: UUID,
    participant_nickname: Type.String(),
    purpose: Type.String(),
    scope: IntentScope,
    older_base: Type.Boolean(),
    owner_may_edit: Type.Boolean(),
  },
  closed,
);
export const IntentPageInput = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|1[0-9]|2[0-5])$' })),
    cursor: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  closed,
);
export const IntentPage = Type.Object(
  {
    items: Type.Array(EditingNotice, { maxItems: 25 }),
    observed_at: Type.String(),
    complete: Type.Boolean(),
    next_cursor: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  },
  closed,
);
export type IntentPageView = Static<typeof IntentPage>;
