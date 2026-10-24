import { Type, type Static } from '@sinclair/typebox';
import { UUID, NullableId, Title, Participant, PageInput, closed } from './participation.js';

export const organizationLimits = Object.freeze({
  areaDepth: 12,
  areas: 500,
  subtree: 500,
  decisions: 10000,
  descriptionBytes: 2048,
});
export const OrganizationKind = Type.Union(
  [
    'area.create',
    'area.edit',
    'area.move',
    'discussion.move',
    'artifact.move',
    'area.open',
    'area.close',
    'discussion.open',
    'discussion.close',
  ].map((k) => Type.Literal(k)),
);
const version = Type.Integer({ minimum: 0, maximum: 2147483646 });
const base = { idempotency_key: UUID, expected_hierarchy_version: version };
const target = { ...base, resource_id: UUID, expected_version: version };
const metadata = {
  title: Title,
  description: Type.String({ maxLength: organizationLimits.descriptionBytes }),
};
export const OrganizationInput = Type.Union([
  Type.Object(
    { ...base, kind: Type.Literal('area.create'), parent_id: NullableId, ...metadata },
    closed,
  ),
  Type.Object({ ...target, kind: Type.Literal('area.edit'), ...metadata }, closed),
  Type.Object({ ...target, kind: Type.Literal('area.move'), parent_id: NullableId }, closed),
  ...(['discussion.move', 'artifact.move'] as const).map((kind) =>
    Type.Object({ ...target, kind: Type.Literal(kind), parent_id: UUID }, closed),
  ),
  ...(['area.open', 'area.close', 'discussion.open', 'discussion.close'] as const).map((kind) =>
    Type.Object({ ...target, kind: Type.Literal(kind) }, closed),
  ),
]);
export type OrganizationCommand = Static<typeof OrganizationInput>;
export const OrganizationStatusInput = Type.Object(
  { kind: OrganizationKind, idempotency_key: UUID },
  closed,
);
export const PathPart = Type.Object({ id: UUID, title: Title }, closed);
export const OrganizationResource = Type.Object(
  {
    resource_id: UUID,
    kind: Type.Union(['area', 'discussion', 'artifact'].map((k) => Type.Literal(k))),
    parent_id: NullableId,
    version,
    hierarchy_version: version,
    title: Title,
    description: Type.Union([Type.String(), Type.Null()]),
    metadata_version: Type.Union([version, Type.Null()]),
    local_open: Type.Boolean(),
    publication_open: Type.Boolean(),
    can_organize: Type.Boolean(),
    ancestors: Type.Array(PathPart, { maxItems: organizationLimits.areaDepth }),
    contacts_url: Type.Literal('/api/v1/contacts'),
    proposal_route_url: Type.String(),
  },
  closed,
);
export type OrganizationResourceView = Static<typeof OrganizationResource>;
const original = Type.Object(
  {
    resource_id: UUID,
    parent_id: NullableId,
    version,
    hierarchy_version: version,
    local_open: Type.Boolean(),
  },
  closed,
);
export const OrganizationCommitted = Type.Object(
  {
    operation_state: Type.Literal('committed'),
    operation_id: UUID,
    kind: OrganizationKind,
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    outcome: original,
    current: OrganizationResource,
  },
  closed,
);
export const OrganizationReconciled = Type.Union([
  OrganizationCommitted,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export type OrganizationResult = Static<typeof OrganizationCommitted>;
export const OrganizationPage = Type.Object(
  {
    items: Type.Array(OrganizationResource, { maxItems: 25 }),
    hierarchy_version: version,
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
    work_budget_reached: Type.Boolean(),
    scope: Type.String(),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export type OrganizationPageView = Static<typeof OrganizationPage>;
export const OrganizationPageInput = Type.Object(
  { ...PageInput.properties, parent_id: Type.Optional(UUID) },
  closed,
);
export const ProposalRoute = Type.Object(
  {
    affected_area_id: UUID,
    settings_version: version,
    state: Type.Union([
      Type.Literal('ready'),
      Type.Literal('unavailable'),
      Type.Literal('setup_incomplete'),
    ]),
    unavailable_reason: Type.Optional(Type.Literal('publication_closed')),
    destination: Type.Union([OrganizationResource, Type.Null()]),
    contacts: Type.Array(Participant, { maxItems: 25 }),
    contacts_url: Type.Literal('/api/v1/contacts'),
  },
  closed,
);
export type ProposalRouteView = Static<typeof ProposalRoute>;
export const MetadataRevision = Type.Object(
  {
    id: UUID,
    version,
    title: Title,
    description: Type.String(),
    publisher: Type.Union([Participant, Type.Null()]),
    baseline: Type.Boolean(),
    recorded_at: Type.String(),
  },
  closed,
);
export const MetadataHistory = Type.Object(
  {
    items: Type.Array(MetadataRevision, { maxItems: 25 }),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
  },
  closed,
);
export const OrganizationAudit = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          operation_id: UUID,
          kind: OrganizationKind,
          actor_id: UUID,
          resource_id: UUID,
          result_version: version,
          hierarchy_version: version,
          recorded_at: Type.String(),
        },
        closed,
      ),
      { maxItems: 25 },
    ),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
  },
  closed,
);
