import { Type, type Static } from '@sinclair/typebox';
import { UUID, closed } from './participation.js';

export const freshnessContract = 'discussion-freshness-1';
export const freshnessLimits = Object.freeze({
  events: 32,
  parents: 16,
  displayed: 16,
  tokenBytes: 512,
});

const Displayed = Type.Object({ resource_id: UUID, revision_id: UUID }, closed);
export const FreshnessInput = Type.Union([
  Type.Object({ action: Type.Literal('baseline') }, closed),
  Type.Object(
    {
      action: Type.Literal('check'),
      cursor: Type.String({ minLength: 1, maxLength: freshnessLimits.tokenBytes }),
      parents: Type.Array(UUID, { maxItems: freshnessLimits.parents }),
      displayed: Type.Array(Displayed, { maxItems: freshnessLimits.displayed }),
    },
    closed,
  ),
]);
export type FreshnessInputView = Static<typeof FreshnessInput>;

const Event = Type.Object(
  {
    position: Type.String({ pattern: '^\\d{1,19}$' }),
    kind: Type.Union([
      Type.Literal('new_root'),
      Type.Literal('new_reply'),
      Type.Literal('revision'),
      Type.Literal('discussion'),
    ]),
    resource_id: Type.Optional(UUID),
    parent_id: Type.Optional(UUID),
    revision_id: Type.Optional(UUID),
    own: Type.Boolean(),
  },
  closed,
);
const DisplayedStatus = Type.Object(
  {
    resource_id: UUID,
    revision_id: UUID,
    state: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
    current_revision_id: Type.Union([UUID, Type.Null()]),
  },
  closed,
);
export const Freshness = Type.Object(
  {
    contract: Type.Literal(freshnessContract),
    cursor: Type.String({ minLength: 1, maxLength: freshnessLimits.tokenBytes }),
    complete: Type.Boolean(),
    scanned: Type.Integer({ minimum: 0, maximum: freshnessLimits.events }),
    events: Type.Array(Event, { maxItems: freshnessLimits.events }),
    displayed: Type.Array(DisplayedStatus, { maxItems: freshnessLimits.displayed }),
  },
  closed,
);
export type FreshnessView = Static<typeof Freshness>;
