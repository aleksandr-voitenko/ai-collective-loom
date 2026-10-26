import { Type, type Static } from '@sinclair/typebox';
import { FileSet, AttachmentSet, FilePath } from './files.js';

export const contractVersion = 'participation-1';
export const guideRevision = '23';
export const limits = Object.freeze({
  textBytes: 16384,
  mentions: 16,
  references: 16,
  rationaleBytes: 512,
  noteBytes: 4096,
  changeMembers: 16,
  parserTokens: 4096,
  pageItems: 25,
  scanItems: 100,
  minResponseBytes: 4096,
  responseBytes: 131072,
  requestBytes: 131072,
});
export const closed = { additionalProperties: false };
export const UUID = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
export const NullableId = Type.Union([UUID, Type.Null()]);
export const Title = Type.String({ minLength: 1, maxLength: 160 });
export const LegacyReferenceTarget = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('discussion'),
      Type.Literal('contribution'),
      Type.Literal('artifact'),
      Type.Literal('summary'),
    ]),
    resource_id: UUID,
    revision_id: Type.Optional(UUID),
  },
  closed,
);
export const ReferenceTarget = Type.Object(
  {
    ...LegacyReferenceTarget.properties,
    file_id: Type.Optional(UUID),
    path: Type.Optional(FilePath),
  },
  {
    ...closed,
    description:
      'File declarations require artifact/contribution kind, exact revision, contextual file_id and matching canonical path. Only reference target lookup may resolve an omitted path.',
  },
);
export const Relationship = Type.Union([
  Type.Null(),
  Type.Literal('related_to'),
  Type.Literal('builds_on'),
  Type.Literal('contradicts'),
]);
export const ReferenceDeclaration = Type.Object(
  {
    reference_id: UUID,
    target: ReferenceTarget,
    relationship: Relationship,
    rationale: Type.Union([Type.Null(), Type.String({ maxLength: limits.rationaleBytes })]),
  },
  closed,
);
export type ReferenceTargetValue = Static<typeof ReferenceTarget>;
export type ReferenceValue = Static<typeof ReferenceDeclaration>;
// Older formats remain closed to file declarations, including on exact retries.
export const LegacyReferenceDeclaration = Type.Unsafe<ReferenceValue>(
  Type.Object({ ...ReferenceDeclaration.properties, target: LegacyReferenceTarget }, closed),
);
export const LegacyContent = Type.Object(
  {
    format: Type.Literal('loom-markdown-v1'),
    text: Type.String({ minLength: 1, maxLength: limits.textBytes }),
    mentions: Type.Array(
      Type.Object(
        {
          token: Type.String({ pattern: '^[a-z][a-z0-9_]{0,31}$' }),
          participant_id: UUID,
        },
        closed,
      ),
      { maxItems: limits.mentions },
    ),
  },
  closed,
);
export const ReferencedContent = Type.Object(
  {
    ...LegacyContent.properties,
    format: Type.Literal('loom-markdown-v2'),
    references: Type.Array(LegacyReferenceDeclaration, { maxItems: limits.references }),
  },
  closed,
);
export const ChangeContent = Type.Object(
  {
    ...ReferencedContent.properties,
    text: Type.String({ maxLength: limits.textBytes }),
    format: Type.Literal('loom-markdown-v3'),
  },
  {
    ...closed,
    description:
      'V3/v4 publication requests require explicit top-level change_note and change_account (null when absent). V1/v2 requests reject those fields. Combined authored fields retain the 16384 UTF-8 byte ceiling.',
  },
);
export const FileReferencedContent = Type.Object(
  {
    ...ChangeContent.properties,
    format: Type.Literal('loom-markdown-v4'),
    references: Type.Array(ReferenceDeclaration, { maxItems: limits.references }),
  },
  closed,
);
export const Content = Type.Union([
  LegacyContent,
  ReferencedContent,
  ChangeContent,
  FileReferencedContent,
]);
export type AuthoredContent = Static<typeof Content>;
export const ReferenceNote = Type.Union([
  Type.Object(
    {
      ...ReferencedContent.properties,
      text: Type.String({ minLength: 1, maxLength: limits.noteBytes }),
    },
    closed,
  ),
  Type.Object(
    {
      ...FileReferencedContent.properties,
      text: Type.String({ minLength: 1, maxLength: limits.noteBytes }),
    },
    closed,
  ),
]);
export type NoteContent = Static<typeof ReferenceNote>;
export const ExactChangeTarget = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('contribution'),
      Type.Literal('artifact'),
      Type.Literal('summary'),
    ]),
    resource_id: UUID,
    revision_id: UUID,
  },
  closed,
);
export type ExactChangeTargetValue = Static<typeof ExactChangeTarget>;
export const ChangeAccount = Type.Union([
  Type.Object(
    { revisions: Type.Array(ExactChangeTarget, { minItems: 1, maxItems: limits.changeMembers }) },
    closed,
  ),
  Type.Object({ carry_forward_revision_id: UUID }, closed),
]);
export type ChangeAccountValue = Static<typeof ChangeAccount>;
export const changeFields = {
  change_note: Type.Optional(Type.Union([ReferenceNote, Type.Null()])),
  change_account: Type.Optional(Type.Union([ChangeAccount, Type.Null()])),
};
const attempt = { idempotency_key: UUID };
export const DiscussionInput = Type.Object(
  {
    ...attempt,
    ...changeFields,
    area_id: UUID,
    title: Title,
    content: Content,
    attachment_set: Type.Optional(AttachmentSet),
    proposal_context: Type.Optional(
      Type.Object(
        {
          affected_area_id: Type.Optional(UUID),
          expected_settings_version: Type.Integer({ minimum: 0 }),
        },
        closed,
      ),
    ),
  },
  closed,
);
export const ReplyInput = Type.Object(
  {
    ...attempt,
    ...changeFields,
    discussion_id: UUID,
    parent_id: UUID,
    content: Content,
    attachment_set: Type.Optional(AttachmentSet),
  },
  closed,
);
export const ArtifactInput = Type.Object(
  {
    ...attempt,
    ...changeFields,
    area_id: UUID,
    title: Title,
    content: Content,
    file_set: Type.Optional(FileSet),
  },
  closed,
);
export const RevisionInput = Type.Object(
  {
    ...attempt,
    ...changeFields,
    resource_id: UUID,
    expected_revision_id: UUID,
    attachment_set: Type.Optional(AttachmentSet),
    file_set: Type.Optional(FileSet),
    title: Type.Union([Title, Type.Null()]),
    content: Content,
  },
  closed,
);
export const SetupInput = Type.Object(
  {
    ...attempt,
    ...changeFields,
    community_name: Title,
    ordinary_area_name: Title,
    proposal_area_name: Title,
    overview: Content,
  },
  closed,
);
export const PublicationKind = Type.Union(
  [
    'discussion.create',
    'reply.create',
    'artifact.create',
    'revision.publish',
    'community.setup',
    'attachment.promote',
  ].map((kind) => Type.Literal(kind)),
);
export const StatusInput = Type.Object(
  { operation_kind: PublicationKind, idempotency_key: UUID },
  closed,
);
export const SettingsInput = Type.Object(
  {
    ...attempt,
    expected_version: Type.Integer({ minimum: 0 }),
    community_name: Title,
    overview_id: NullableId,
    proposal_area_id: NullableId,
  },
  closed,
);
export const EditorsInput = Type.Object(
  {
    ...attempt,
    resource_id: UUID,
    expected_version: Type.Integer({ minimum: 0 }),
    participant_ids: Type.Array(UUID, { maxItems: 32, uniqueItems: true }),
  },
  closed,
);
export const PageInput = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 1024 })),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|1[0-9]|2[0-5])$' })),
    max_response_bytes: Type.Optional(Type.String({ pattern: '^[0-9]{4,6}$' })),
  },
  closed,
);
export const BudgetInput = Type.Object(
  { max_response_bytes: PageInput.properties.max_response_bytes },
  closed,
);
export const Committed = Type.Object(
  {
    publication_state: Type.Literal('committed'),
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    operation_id: UUID,
    resource_id: UUID,
    revision_id: UUID,
  },
  closed,
);
export const Reconciled = Type.Union([
  Committed,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export const Participant = Type.Object(
  { id: UUID, nickname: Type.String(), kind: Type.String() },
  closed,
);
export const Resource = Type.Object(
  {
    resource_id: UUID,
    kind: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
    revision_id: UUID,
    revision_number: Type.String(),
    author: Participant,
    publisher: Participant,
    created_at: Type.String(),
    area_id: UUID,
    area_title: Type.String(),
    discussion_id: NullableId,
    parent_id: NullableId,
    affected_area_id: Type.Optional(UUID),
    can_edit: Type.Boolean(),
    publication_open: Type.Boolean(),
    full_content_url: Type.String(),
  },
  closed,
);
export const Revision = Type.Object(
  {
    ...Resource.properties,
    content: Content,
    mentioned_participants: Type.Array(Participant, {
      maxItems: limits.mentions,
    }),
    current_revision_id: NullableId,
    provenance_url: Type.Optional(Type.String()),
    file_set: Type.Optional(
      Type.Object({ ...FileSet.properties, manifest_url: Type.String() }, closed),
    ),
    attachment_set: Type.Optional(
      Type.Object({ ...AttachmentSet.properties, manifest_url: Type.String() }, closed),
    ),
    change_note: Type.Optional(
      Type.Object(
        {
          state: Type.Union([Type.Literal('absent'), Type.Literal('available')]),
          full_content_url: Type.String(),
        },
        closed,
      ),
    ),
    change_account: Type.Optional(
      Type.Object(
        {
          state: Type.Union([Type.Literal('absent'), Type.Literal('declared')]),
          coverage_url: Type.String(),
        },
        closed,
      ),
    ),
  },
  closed,
);
export const UnavailableContribution = Type.Object(
  {
    resource_id: UUID,
    state: Type.Literal('unavailable'),
    discussion_id: UUID,
    parent_id: NullableId,
  },
  closed,
);
export const ContributionContext = Type.Union([Revision, UnavailableContribution]);
export type ContributionContextView = Static<typeof ContributionContext>;
export const Area = Type.Object(
  {
    id: UUID,
    title: Type.String(),
    description: Type.String(),
    publication_open: Type.Boolean(),
  },
  closed,
);
export const Discussion = Type.Object(
  {
    id: UUID,
    area: Area,
    opening: Resource,
    local_open: Type.Boolean(),
    publication_open: Type.Boolean(),
  },
  closed,
);
export const Page = Type.Object(
  {
    items: Type.Array(
      Type.Union([
        Resource,
        Area,
        Participant,
        Type.Object({ resource_id: UUID, state: Type.Literal('unavailable') }, closed),
      ]),
      { maxItems: limits.pageItems },
    ),
    scope: Type.String(),
    representation: Type.Literal('metadata'),
    omitted_detail: Type.Literal('bodies'),
    next_cursor: Type.Union([Type.String(), Type.Null()]),
    complete: Type.Boolean(),
    work_budget_reached: Type.Boolean(),
    limit: Type.Integer(),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
const Designation = Type.Object(
  {
    state: Type.Union([
      Type.Literal('ready'),
      Type.Literal('setup_incomplete'),
      Type.Literal('unavailable'),
    ]),
    resource_id: Type.Optional(UUID),
    revision_id: Type.Optional(UUID),
    unavailable_reason: Type.Optional(Type.Literal('publication_closed')),
  },
  closed,
);
export const Onboarding = Type.Object(
  {
    instance_id: UUID,
    contract_version: Type.Literal(contractVersion),
    guide_revision: Type.Literal(guideRevision),
    profile: Type.Literal('synthetic'),
    community_name: Type.String(),
    settings_version: Type.Integer(),
    overview: Designation,
    proposal_area: Designation,
    contacts: Type.Array(Participant, { maxItems: 25 }),
    contacts_url: Type.String(),
    guide_url: Type.String(),
    openapi_url: Type.String(),
    limits: Type.Object(
      {
        ...Object.fromEntries(Object.keys(limits).map((key) => [key, Type.Integer()])),
      },
      closed,
    ),
    replay_retention: Type.Literal(
      'retained_without_automatic_expiry; destructive_restore_unsupported',
    ),
    derived_effects: Type.Union([
      Type.Literal('search_and_personal_direct_attention; other_projections_disabled'),
      Type.Literal(
        'search_personal_direct_attention_and_supported_file_text; other_projections_disabled',
      ),
    ]),
    updates_contract: Type.Literal('combined-updates-1'),
    attention_contract: Type.Literal('attention-controls-1'),
    moderation_contract: Type.Literal('moderation-state-1'),
    moderation_url: Type.Literal('/api/v1/admin/moderation/targets'),
    attention_url: Type.Literal('/api/v1/me/attention/list'),
    routine_updates_contract: Type.Literal('combined-updates-2'),
    routine_updates_url: Type.Literal('/api/v1/me/routine-updates/query'),
    administration_contract: Type.Optional(Type.Literal('administration-pages-1')),
    administration_url: Type.Optional(Type.Literal('/api/v1/identity/accounts/query')),
    notes_contract: Type.Optional(Type.Literal('owner-notes-1')),
    notes_url: Type.Optional(Type.Literal('/api/v1/me/notes/query')),
    reading_contract: Type.Literal('reading-state-1'),
    reading_url: Type.Literal('/api/v1/me/reading/lookup'),
    updates_url: Type.Literal('/api/v1/me/updates/query'),
    notification_contract: Type.Literal('personal-attention-1'),
    notifications_url: Type.Literal('/api/v1/me/notifications/query'),
    following_contract: Type.Literal('following-1'),
    following_url: Type.Literal('/api/v1/me/following'),
    shared_changes_contract: Type.Literal('shared-changes-1'),
    shared_changes_url: Type.Literal('/api/v1/shared-changes/query'),
    file_text_contract: Type.Optional(Type.Literal('literal-utf8-v1')),
    file_search_url: Type.Optional(Type.Literal('/api/v1/search/files')),
  },
  closed,
);
export const ParticipationError = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        request_id: UUID,
        current_revision_id: Type.Optional(NullableId),
        unavailable_scope: Type.Optional(Type.Literal('revision')),
        forbidden_reason: Type.Optional(Type.Literal('publication_closed')),
        retry_after_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
        rate_category: Type.Optional(
          Type.Union([
            Type.Literal('ordinary_requests'),
            Type.Literal('new_publications'),
            Type.Literal('recovery_control'),
          ]),
        ),
        minimum_response_bytes: Type.Optional(Type.Integer()),
        operation_outcome: Type.Optional(
          Type.Union([Type.Literal('unknown'), Type.Literal('rejected')]),
        ),
        recovery: Type.Object({ action: Type.String() }, closed),
      },
      closed,
    ),
  },
  closed,
);
export type ResourceView = Static<typeof Resource>;
export type RevisionView = Static<typeof Revision>;
export type PageView = Static<typeof Page>;
export type OnboardingView = Static<typeof Onboarding>;
export type CommittedView = Static<typeof Committed>;
