import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID } from '../../../contracts/participation.js';
import {
  AttentionInput,
  AttentionListInput,
  Version,
  attentionLimits,
} from '../../../contracts/attention.js';

export const DismissalSelectionPayload = Type.Object(
  {
    purpose: Type.Literal('dismissal-selection-1'),
    owner: UUID,
    instance: UUID,
    policy: Version,
    meaning: Type.Object(
      {
        view: UUID,
        group: UUID,
        selection: Type.Union([
          Type.Literal('highlights'),
          Type.Literal('complete'),
          Type.Literal('direct'),
        ]),
      },
      closed,
    ),
    expires: Type.Number(),
    inputs: Type.Array(Type.Object({ ...AttentionInput.properties, version: Version }, closed), {
      minItems: 1,
      maxItems: attentionLimits.batch,
    }),
  },
  closed,
);
export type DismissalSelectionValue = Static<typeof DismissalSelectionPayload>;
export const AttentionListPayload = Type.Object(
  {
    purpose: Type.Literal('attention-list-1'),
    owner: UUID,
    collection: AttentionListInput.properties.collection,
    version: Version,
    after: Type.String(),
  },
  closed,
);
export type AttentionListValue = Static<typeof AttentionListPayload>;
