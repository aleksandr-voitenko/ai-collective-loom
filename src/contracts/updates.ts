import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID, Participant, ExactChangeTarget } from './participation.js';
import { SharedScope, BoundDefinition, SharedItem, FollowSource, SharedDetailInput } from './following.js';
import { NotificationReason, NotificationItem, NotificationProjection } from './notifications.js';

export const updatesContract = 'combined-updates-1';
export const updatesLimits = Object.freeze({ scan: 100, members: 2000, groupMembers: 500, groups: 256,
  ownerViews: 16, views: 128, steps: 1000, items: 25, previews: 2, routineHighlights: 3,
  tokenBytes: 16384, cursorSeconds: 86400, custodySeconds: 604800 });
const Token = Type.String({ minLength: 1, maxLength: updatesLimits.tokenBytes });
const NullableToken = Type.Union([Token, Type.Null()]);
export const UpdatesScope = Type.Union([SharedScope, Type.Object({ kind: Type.Literal('personal') }, closed)]);
export const UpdatesSelection = Type.Union((['highlights', 'complete', 'direct'] as const).map(v => Type.Literal(v)));
const Budget = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  max_response_bytes: Type.Optional(Type.Integer({ minimum: 4096, maximum: 131072 })) };
export const UpdatesQuery = Type.Object({ scope: Type.Optional(UpdatesScope), reason: Type.Optional(NotificationReason),
  selection: Type.Optional(UpdatesSelection), cursor: Type.Optional(Token), checkpoint: Type.Optional(Token),
  switch: Type.Optional(Type.Object({ token: Token, selection: UpdatesSelection }, closed)),
  recovery: Type.Optional(Type.Object({ token: Type.Optional(Token),
    action: Type.Union(['renew', 'replay', 'resynchronize'].map(v => Type.Literal(v))) }, closed)), ...Budget }, closed);
export type UpdatesOptions = Static<typeof UpdatesQuery>;
export const UpdatesMembersQuery = Type.Object({ cursor: Token, group_id: Type.Optional(UUID),
  direct_only: Type.Optional(Type.Boolean()), renew: Type.Optional(Type.Literal(true)), ...Budget }, closed);
export type UpdatesMembersOptions = Static<typeof UpdatesMembersQuery>;
export const UpdatesReasonsQuery = SharedDetailInput;
export type UpdatesReasonsOptions = Static<typeof UpdatesReasonsQuery>;
export const UpdatesReasonsPage = SharedItem;
export const UpdateMember = Type.Object({ source: SharedItem, shared_in_interval: Type.Boolean(),
  personal: Type.Union([NotificationItem, Type.Null()]) }, closed);
export type UpdateMemberView = Static<typeof UpdateMember>;
export const UpdateExplanation = Type.Object({ form: Type.Union([Type.Literal('revision_note'), Type.Literal('change_account')]),
  resource_id: UUID, revision_id: UUID, publisher: Participant, browser_url: Type.String(),
  explanation_url: Type.String(), coverage_url: Type.Union([Type.String(), Type.Null()]),
  included_revisions: Type.Array(ExactChangeTarget, { maxItems: 16 }),
  scope: Type.Union([Type.Literal('owning_revision_only'), Type.Literal('declared_exact_set')]),
  limitation: Type.Literal('author_claim; only_named_revisions; not_whole_interval_or_summary_currency') }, closed);
export type UpdateExplanationView = Static<typeof UpdateExplanation>;
const Counts = Type.Object({ certainty: Type.Union([Type.Literal('exact'),Type.Literal('known_sources_only')]), source_records: Type.Integer({ minimum: 1 }),
  shared_changes: Type.Integer({ minimum: 0 }), personal_signals: Type.Integer({ minimum: 0 }),
  reply_publications: Type.Integer({ minimum: 0 }), reply_revisions: Type.Integer({ minimum: 0 }),
  summary_changes: Type.Integer({ minimum: 0 }), artifact_changes: Type.Integer({ minimum: 0 }),
  opening_changes: Type.Integer({ minimum: 0 }), structural_changes: Type.Integer({ minimum: 0 }) }, closed);
export const UpdateGroup = Type.Object({ id: UUID,
  kind: Type.Union((['discussion', 'artifact', 'structural'] as const).map(v => Type.Literal(v))),
  current: FollowSource, context_url: Type.String(), counts: Counts,
  direct_sources: Type.Array(UpdateMember, { maxItems: 2 }), direct_sources_complete: Type.Boolean(),
  members_cursor: Token, direct_cursor: NullableToken,
  explanation: Type.Union([UpdateExplanation, Type.Null()]),
  omitted_detail: Type.Literal('remaining_member_metadata; full_bodies; summary_coverage_not_computed') }, closed);
export type UpdateGroupView = Static<typeof UpdateGroup>;
const Component = Type.Object({ contract: Type.String(), lower: Token, upper: Token,
  scan_complete: Type.Boolean(), coverage: Type.Union([Type.Literal('known'), Type.Literal('unknown')]),
  history: Type.Union([Type.Literal('retained'), Type.Literal('incomplete')]) }, closed);
export const UpdatesPage = Type.Object({ contract_version: Type.Literal(updatesContract),
  stage: Type.Union([Type.Literal('preparing'), Type.Literal('ready')]),
  items: Type.Array(UpdateGroup, { maxItems: 25 }),
  traversal: Type.Object({ id: UUID, scope: Type.Union((['following', 'explicit', 'personal'] as const).map(v => Type.Literal(v))),
    definitions: Type.Array(BoundDefinition, { maxItems: 64 }), reason: NotificationReason,
    selection: UpdatesSelection, settings_current: Type.Boolean(),
    grouping: Type.Literal('ownership; area_event'), order: Type.Literal('direct_first; frozen_recent_then_identity'),
    shared: Component, personal: Component, expires_at: Type.String() }, closed),
  page_cursor: Token, next_cursor: NullableToken, checkpoint: NullableToken, complete_cursor: NullableToken,
  direct_cursor: NullableToken, records_cursor: NullableToken, page_exhausted: Type.Boolean(),
  selection_exhausted: Type.Boolean(), grouped_interval_complete: Type.Boolean(),
  member_metadata_complete: Type.Literal(false), full_contents_fetched: Type.Literal(false),
  projection: NotificationProjection, work_budget_reached: Type.Boolean(),
  recovery: Type.Union(['none', 'renewed', 'visibility_replay', 'retained_resynchronization'].map(v => Type.Literal(v))),
  baseline_established: Type.Boolean(), inventory: Type.Array(Type.Object({ label: Type.String(), url: Type.String() }, closed), { maxItems: 3 }),
  limit: Type.Integer(), max_response_bytes: Type.Integer() }, closed);
export type UpdatesPageView = Static<typeof UpdatesPage>;
export const UpdatesMembersPage = Type.Object({ contract_version: Type.Literal(updatesContract), traversal_id: UUID,
  group_id: Type.Union([UUID, Type.Null()]), direct_only: Type.Boolean(), items: Type.Array(UpdateMember, { maxItems: 25 }),
  page_cursor: Token, next_cursor: NullableToken, complete: Type.Boolean(),
  full_contents_fetched: Type.Literal(false), limit: Type.Integer(), max_response_bytes: Type.Integer() }, closed);
export type UpdatesMembersPageView = Static<typeof UpdatesMembersPage>;
