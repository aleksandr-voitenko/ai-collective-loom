import { Type, type Static } from '@sinclair/typebox';
import {
  UUID,
  closed,
  discussionObservationTag,
  discussionObservationTags,
} from './participation.js';

export const topicFreshnessContract = 'topic-discussion-freshness-1';
export const topicFreshnessLimits = Object.freeze({
  events: 32,
  visibility: 32,
  displayed: 32,
  tokenBytes: 512,
  responseBytes: 4096,
});

const cursor = Type.String({
  pattern: '^[A-Za-z0-9_-]+$',
  maxLength: topicFreshnessLimits.tokenBytes,
});
const displayed = Type.Object({ resource_id: UUID, revision_id: UUID }, closed);
export const TopicFreshnessInput = Type.Union([
  Type.Object({ action: Type.Literal('baseline') }, closed),
  Type.Object({ action: Type.Literal('check'), cursor }, closed),
  Type.Object(
    {
      action: Type.Literal('audit'),
      displayed: Type.Array(displayed, { maxItems: topicFreshnessLimits.displayed }),
    },
    closed,
  ),
]);
export type TopicFreshnessInputView = Static<typeof TopicFreshnessInput>;

export const TopicFreshness = Type.Object(
  {
    contract: Type.Literal(topicFreshnessContract),
    cursor,
    complete: Type.Boolean(),
    scanned: Type.Integer({ minimum: 0, maximum: topicFreshnessLimits.events }),
    visibility_scanned: Type.Integer({ minimum: 0, maximum: topicFreshnessLimits.visibility }),
    change: Type.Union([
      Type.Literal('none'),
      Type.Literal('new_discussions'),
      Type.Literal('updated'),
    ]),
    withdrawn_tags: Type.Array(discussionObservationTag, {
      maxItems: topicFreshnessLimits.visibility,
    }),
  },
  closed,
);
export type TopicFreshnessView = Static<typeof TopicFreshness>;

export const TopicFreshnessAudit = Type.Object(
  {
    unavailable: Type.Array(
      Type.Integer({ minimum: 0, maximum: topicFreshnessLimits.displayed - 1 }),
      {
        maxItems: topicFreshnessLimits.displayed,
      },
    ),
    tags: Type.Array(Type.Union([discussionObservationTags, Type.Null()]), {
      maxItems: topicFreshnessLimits.displayed,
    }),
  },
  closed,
);
export type TopicFreshnessAuditView = Static<typeof TopicFreshnessAudit>;
export const TopicFreshnessResult = Type.Union([TopicFreshness, TopicFreshnessAudit]);
