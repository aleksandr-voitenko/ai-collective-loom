import { Type, type Static } from '@sinclair/typebox';
import {
  closed,
  UUID,
  Resource,
  Participant,
  ReferencedContent,
  ExactChangeTarget,
  BudgetInput,
} from './participation.js';
import { ReferencePageInput } from './references.js';

export const ChangePageInput = ReferencePageInput;
export type ChangePageOptions = Static<typeof ChangePageInput>;
export const ChangeDiscoveryInput = Type.Object(
  {
    ...ReferencePageInput.properties,
    kind: ExactChangeTarget.properties.kind,
    resource_id: UUID,
    revision_id: Type.Optional(UUID),
    history: Type.Optional(Type.Union([Type.Literal('current'), Type.Literal('all')])),
    form: Type.Optional(
      Type.Union([Type.Literal('revision_note'), Type.Literal('change_account')]),
    ),
  },
  closed,
);
export type ChangeDiscoveryOptions = Static<typeof ChangeDiscoveryInput>;
export const NoteDetailInput = BudgetInput;
export const NoteDetail = Type.Object(
  {
    source: Resource,
    source_field: Type.Literal('change_note'),
    state: Type.Union([Type.Literal('absent'), Type.Literal('available')]),
    described_scope: Type.Literal('owning_revision_only; no_interval_claim'),
    content: Type.Union([ReferencedContent, Type.Null()]),
    mentioned_participants: Type.Array(Participant, { maxItems: 16 }),
  },
  closed,
);
export type NoteDetailView = Static<typeof NoteDetail>;
const page = {
  next_cursor: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  complete: Type.Boolean(),
  work_budget_reached: Type.Boolean(),
  limit: Type.Integer(),
  max_response_bytes: Type.Integer(),
  expires_at: Type.String(),
};
export const DescribedRevision = Type.Object(
  {
    target: ExactChangeTarget,
    representation: Resource,
    browser_url: Type.String(),
    context_url: Type.String(),
  },
  closed,
);
export const ChangeCoverage = Type.Object(
  {
    ...page,
    source: Resource,
    state: Type.Union([Type.Literal('absent'), Type.Literal('declared')]),
    described_scope: Type.Literal('exact_set; no_intermediate_revision_claim'),
    claim: Type.Literal('author_declared; not_read_correctness_approval_or_currency_proof'),
    items: Type.Array(DescribedRevision, { maxItems: 16 }),
    unknown: Type.Boolean(),
    omitted_detail: Type.Literal('bodies; unavailable_members'),
    order: Type.Literal('target_resource_uuid_then_revision_uuid'),
  },
  closed,
);
export type ChangeCoverageView = Static<typeof ChangeCoverage>;
export const ChangeEntry = Type.Object(
  {
    source: Resource,
    source_field: Type.Union([Type.Literal('main'), Type.Literal('change_note')]),
    form: Type.Union([Type.Literal('revision_note'), Type.Literal('change_account')]),
    membership: Type.Union([
      Type.Literal('current'),
      Type.Literal('historical'),
      Type.Literal('current_unavailable'),
    ]),
    described: ExactChangeTarget,
    described_scope: Type.Union([
      Type.Literal('owning_revision_only'),
      Type.Literal('member_of_exact_set'),
    ]),
    explanation_url: Type.String(),
    coverage_url: Type.Union([Type.String(), Type.Null()]),
    browser_url: Type.String(),
    context_url: Type.String(),
  },
  closed,
);
export type ChangeEntryView = Static<typeof ChangeEntry>;
export const ChangeDiscovery = Type.Object(
  {
    ...page,
    items: Type.Array(ChangeEntry, { maxItems: 25 }),
    scope: Type.Union([
      Type.Literal('exact_revision'),
      Type.Literal('resource_described_revisions'),
    ]),
    history: Type.Union([Type.Literal('current'), Type.Literal('all')]),
    form: Type.Union([Type.Literal('revision_note'), Type.Literal('change_account'), Type.Null()]),
    order: Type.Literal('source_revision_uuid_then_field_then_described_revision_uuid'),
    omitted_detail: Type.Literal(
      'bodies; full_account_sets; unavailable_sources_or_targets; other_target_resources',
    ),
  },
  closed,
);
export type ChangeDiscoveryView = Static<typeof ChangeDiscovery>;
