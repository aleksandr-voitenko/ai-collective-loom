import { Type, type Static } from '@sinclair/typebox';
import {
  closed,
  UUID,
  NullableId,
  ReferenceTarget,
  ReferenceDeclaration,
  Participant,
  Resource,
  PageInput,
} from './participation.js';

export const referenceLimits = Object.freeze({
  scan: 100,
  cursorBytes: 2048,
  cursorSeconds: 300,
  ownerResources: 32,
});
export const TargetInput = Type.Object({ ...ReferenceTarget.properties }, closed);
export const ReferencePageInput = Type.Object(
  {
    ...PageInput.properties,
    cursor: Type.Optional(Type.String({ maxLength: referenceLimits.cursorBytes })),
  },
  closed,
);
export const IncomingInput = Type.Object(
  {
    ...TargetInput.properties,
    ...ReferencePageInput.properties,
    history: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('all')])),
    relationship: Type.Optional(
      Type.Union(['untyped', 'related_to', 'builds_on', 'contradicts'].map((v) => Type.Literal(v))),
    ),
  },
  closed,
);
export const ResolvedTarget = Type.Object(
  {
    state: Type.Literal('available'),
    target: ReferenceTarget,
    scope: Type.Union([Type.Literal('resource'), Type.Literal('revision'), Type.Literal('file')]),
    representation: Resource,
    browser_url: Type.String(),
    context_url: Type.String(),
  },
  closed,
);
const Attribution = Type.Object(
  { participant: Participant, published_at: Type.String(), revision_id: NullableId },
  closed,
);
export const ReferenceEntry = Type.Object(
  {
    declaration: ReferenceDeclaration,
    source_field: Type.Union([Type.Literal('main'), Type.Literal('change_note')]),
    direction: Type.Literal('source_to_target'),
    source: Resource,
    source_browser_url: Type.String(),
    source_context_url: Type.String(),
    original_assertion: Attribution,
    last_assertion_change: Attribution,
    withdrawal: Type.Union([Attribution, Type.Null()]),
    membership: Type.Union(
      [
        'current',
        'carried_forward',
        'changed',
        'withdrawn',
        'current_unavailable',
        'historical_note',
      ].map((v) => Type.Literal(v)),
    ),
    target: Type.Union([
      ResolvedTarget,
      Type.Object({ state: Type.Literal('unavailable') }, closed),
    ]),
  },
  closed,
);
export const ReferencePage = Type.Object(
  {
    items: Type.Array(ReferenceEntry, { maxItems: 25 }),
    direction: Type.Union([Type.Literal('outgoing'), Type.Literal('incoming')]),
    scope: Type.Union([
      Type.Literal('source_revision'),
      Type.Literal('resource'),
      Type.Literal('revision'),
      Type.Literal('file'),
    ]),
    source_id: Type.Optional(UUID),
    source_revision_id: Type.Optional(UUID),
    target: Type.Optional(ReferenceTarget),
    history: Type.Union([
      Type.Literal('current'),
      Type.Literal('all'),
      Type.Literal('selected_revision'),
    ]),
    relationship: Type.Union([Type.Null(), Type.String()]),
    order: Type.Literal('source_revision_uuid_then_field_then_reference_uuid'),
    omitted_detail: Type.Literal('bodies; unrelated_target_scopes'),
    next_cursor: Type.Union([Type.String({ maxLength: referenceLimits.cursorBytes }), Type.Null()]),
    complete: Type.Boolean(),
    work_budget_reached: Type.Boolean(),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
    expires_at: Type.String(),
  },
  closed,
);
export type ResolvedTargetView = Static<typeof ResolvedTarget>;
export type ReferenceEntryView = Static<typeof ReferenceEntry>;
export type ReferencePageView = Static<typeof ReferencePage>;
export type IncomingOptions = Static<typeof IncomingInput>;
export type ReferencePageOptions = Static<typeof ReferencePageInput>;
