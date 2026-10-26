import { Type, type Static } from '@sinclair/typebox';
import { UUID, closed } from './participation.js';

export const rateBounds = {
  ordinary_requests: { minimum: 1, maximum: 6000, default: 120 },
  new_publications: { minimum: 1, maximum: 600, default: 20 },
  recovery_control: { minimum: 10, maximum: 1200, default: 60 },
} as const;
export type RateCategory = keyof typeof rateBounds;
export const RateLimits = Type.Object(
  {
    ordinary_requests: Type.Integer(rateBounds.ordinary_requests),
    new_publications: Type.Integer(rateBounds.new_publications),
    recovery_control: Type.Integer(rateBounds.recovery_control),
  },
  closed,
);
export const RatePolicy = Type.Object(
  {
    ...RateLimits.properties,
    version: Type.Integer({ minimum: 1, maximum: 10001 }),
    window_seconds: Type.Literal(60),
  },
  closed,
);
export type RatePolicyValue = Static<typeof RatePolicy>;
export const RatePolicyInput = Type.Object(
  {
    ...RateLimits.properties,
    idempotency_key: UUID,
    expected_version: Type.Integer({ minimum: 1, maximum: 10001 }),
  },
  closed,
);
export const RateStatusInput = Type.Object({ idempotency_key: UUID }, closed);
export const RateDecision = Type.Object(
  {
    operation_state: Type.Literal('committed'),
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    operation_id: UUID,
    original: RatePolicy,
    current: RatePolicy,
  },
  closed,
);
export type RateDecisionValue = Static<typeof RateDecision>;
export const RateStatus = Type.Union([
  RateDecision,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export const RateAuditInput = Type.Object(
  {
    before_version: Type.Optional(Type.Integer({ minimum: 2, maximum: 10002 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  },
  closed,
);
export const RateAudit = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          operation_id: UUID,
          actor_id: UUID,
          actor_credential_id: UUID,
          recorded_at: Type.String(),
          policy: RatePolicy,
        },
        closed,
      ),
      { maxItems: 25 },
    ),
    next_before_version: Type.Union([Type.Integer(), Type.Null()]),
  },
  closed,
);
