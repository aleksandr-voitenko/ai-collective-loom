import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID } from './participation.js';

export const readingLimits = Object.freeze({ batch: 25, requestBytes: 16384, responseBytes: 32768,
  targets: 10000, operations: 50000, outcomeMembers: 100000, localOperations: 128, localBytes: 524288 });
export const ReadingVersion = Type.Integer({ minimum: 0, maximum: 2147483646 });
export const ReadingTarget = Type.Object({ resource_id: UUID, revision_id: UUID }, closed);
export type ReadingTargetView = Static<typeof ReadingTarget>;
export const ReadingCommand = Type.Object({ ...ReadingTarget.properties, read: Type.Boolean(), expected_version: ReadingVersion }, closed);
export const ReadingUpdate = Type.Object({
  idempotency_key: UUID, basis: Type.Union([Type.Literal('manual'), Type.Literal('presentation')]),
  episode_id: Type.Union([UUID, Type.Null()]),
  targets: Type.Array(ReadingCommand, { minItems: 1, maxItems: readingLimits.batch }),
}, closed);
export type ReadingUpdateInput = Static<typeof ReadingUpdate>;
export const ReadingLookup = Type.Object({ targets: Type.Array(ReadingTarget, { minItems: 1, maxItems: readingLimits.batch }) }, closed);
export const ReadingItem = Type.Object({ ...ReadingTarget.properties, read: Type.Boolean(), version: ReadingVersion,
  availability: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]) }, closed);
export type ReadingItemView = Static<typeof ReadingItem>;
export const ReadingPage = Type.Object({ items: Type.Array(ReadingItem, { maxItems: readingLimits.batch }),
  scope: Type.Literal('own_exact_revisions') }, closed);
export type ReadingPageView = Static<typeof ReadingPage>;
export const ReadingResult = Type.Object({
  operation_state: Type.Union([Type.Literal('applied'), Type.Literal('version_conflict')]),
  operation_id: UUID, idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
  outcome: Type.Object({ basis: ReadingUpdate.properties.basis, episode_id: ReadingUpdate.properties.episode_id,
    targets: Type.Array(Type.Object({ ...ReadingCommand.properties, result_version: ReadingVersion }, closed), { maxItems: readingLimits.batch }) }, closed),
  current: Type.Array(ReadingItem, { maxItems: readingLimits.batch }),
}, closed);
export type ReadingResultView = Static<typeof ReadingResult>;
export const ReadingStatusInput = Type.Object({ idempotency_key: UUID }, closed);
export const ReadingStatus = Type.Union([ReadingResult, Type.Object({ operation_state: Type.Literal('not_recorded') }, closed)]);
export type ReadingStatusView = Static<typeof ReadingStatus>;
