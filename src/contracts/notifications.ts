import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID, Participant, Resource } from './participation.js';

export const notificationContract = 'personal-attention-1';
export const notificationReadLimits = Object.freeze({
  scan: 100,
  items: 25,
  defaultItems: 12,
  cursorBytes: 2048,
  cursorSeconds: 86400,
  statusSources: 25,
});
const nullableToken = Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]);
export const NotificationReason = Type.Union(
  (['all', 'mention', 'reply'] as const).map((v) => Type.Literal(v)),
);
export const NotificationQuery = Type.Object(
  {
    reason: Type.Optional(NotificationReason),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    checkpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    recovery: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
          action: Type.Union(['renew', 'replay', 'resynchronize'].map((v) => Type.Literal(v))),
        },
        closed,
      ),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    max_response_bytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: 131072 })),
  },
  closed,
);
export type NotificationOptions = Static<typeof NotificationQuery>;
export const NotificationProjection = Type.Object(
  {
    state: Type.Union(['complete', 'incomplete', 'unknown'].map((v) => Type.Literal(v))),
    coverage: Type.Literal('currently_eligible_supported_sources'),
  },
  closed,
);
export const NotificationItem = Type.Object(
  {
    delivery_id: UUID,
    signal_id: UUID,
    available_at: Type.String(),
    source_event_id: UUID,
    source: Resource,
    context_title: Type.String(),
    context_url: Type.String(),
    browser_url: Type.String(),
    detail_url: Type.String(),
    reasons: Type.Array(
      Type.Object(
        {
          kind: Type.Union(
            ['main_mention', 'direct_reply', 'note_mention'].map((v) => Type.Literal(v)),
          ),
          source_field: Type.Union(['main', 'reply', 'change_note'].map((v) => Type.Literal(v))),
          revision_id: UUID,
          full_content_url: Type.String(),
        },
        closed,
      ),
      { minItems: 1, maxItems: 3 },
    ),
    current: Type.Object(
      {
        state: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
        revision_id: Type.Optional(UUID),
        main_mention: Type.Union(['present', 'absent', 'unknown'].map((v) => Type.Literal(v))),
      },
      closed,
    ),
    parent: Type.Union([
      Type.Null(),
      Type.Object(
        {
          state: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
          resource_id: UUID,
          author: Type.Optional(Participant),
          title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          browser_url: Type.Optional(Type.String()),
        },
        closed,
      ),
    ]),
  },
  closed,
);
export type NotificationItemView = Static<typeof NotificationItem>;
export const NotificationPage = Type.Object(
  {
    contract_version: Type.Literal(notificationContract),
    items: Type.Array(NotificationItem, { maxItems: 25 }),
    traversal: Type.Object(
      {
        id: UUID,
        scope: Type.Literal('personal_direct_attention'),
        reason: NotificationReason,
        selection: Type.Literal('complete'),
        order: Type.Literal('availability_ascending'),
        expires_at: Type.String(),
        boundaries: Type.Literal('fixed_personal_availability_interval'),
      },
      closed,
    ),
    page_cursor: Type.String({ maxLength: 2048 }),
    next_cursor: nullableToken,
    checkpoint: nullableToken,
    interval_complete: Type.Boolean(),
    work_budget_reached: Type.Boolean(),
    projection: NotificationProjection,
    recovery: Type.Union(
      ['none', 'renewed', 'visibility_replay', 'retained_resynchronization'].map((v) =>
        Type.Literal(v),
      ),
    ),
    history: Type.Union([Type.Literal('retained'), Type.Literal('incomplete')]),
    omitted_detail: Type.Literal('full_bodies'),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export type NotificationPageView = Static<typeof NotificationPage>;
export const NotificationHealth = Type.Object(
  {
    worker_available: Type.Boolean(),
    scan_complete: Type.Boolean(),
    discovery_generation: Type.Integer(),
    event_discovery_caught_up: Type.Boolean(),
    capacity_limited: Type.Boolean(),
    jobs: Type.Object(
      {
        pending: Type.Integer(),
        running: Type.Integer(),
        succeeded: Type.Integer(),
        failed: Type.Integer(),
      },
      closed,
    ),
    historical_eligibility_gaps: Type.Integer(),
  },
  closed,
);
export const NotificationFailures = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          id: UUID,
          claim_generation: Type.Integer(),
          attempts: Type.Integer(),
          failure: Type.String(),
          resource_id: Type.Union([UUID, Type.Null()]),
          revision_id: Type.Union([UUID, Type.Null()]),
        },
        closed,
      ),
      { maxItems: 25 },
    ),
    next_after: Type.Union([UUID, Type.Null()]),
  },
  closed,
);
