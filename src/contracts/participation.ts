import { Type, type Static } from "@sinclair/typebox";

export const contractVersion = "participation-1";
export const limits = Object.freeze({
  textBytes: 16384,
  mentions: 16,
  parserTokens: 4096,
  pageItems: 25,
  scanItems: 100,
  minResponseBytes: 4096,
  responseBytes: 131072,
  requestBytes: 131072,
});
export const closed = { additionalProperties: false };
export const UUID = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
export const NullableId = Type.Union([UUID, Type.Null()]);
export const Title = Type.String({ minLength: 1, maxLength: 160 });
export const Content = Type.Object(
  {
    format: Type.Literal("loom-markdown-v1"),
    text: Type.String({ minLength: 1, maxLength: limits.textBytes }),
    mentions: Type.Array(
      Type.Object(
        {
          token: Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" }),
          participant_id: UUID,
        },
        closed,
      ),
      { maxItems: limits.mentions },
    ),
  },
  closed,
);
export type AuthoredContent = Static<typeof Content>;
const attempt = { idempotency_key: UUID };
export const DiscussionInput = Type.Object(
  { ...attempt, area_id: UUID, title: Title, content: Content },
  closed,
);
export const ReplyInput = Type.Object(
  { ...attempt, discussion_id: UUID, parent_id: UUID, content: Content },
  closed,
);
export const ArtifactInput = Type.Object(
  { ...attempt, area_id: UUID, title: Title, content: Content },
  closed,
);
export const RevisionInput = Type.Object(
  {
    ...attempt,
    resource_id: UUID,
    expected_revision_id: UUID,
    title: Type.Union([Title, Type.Null()]),
    content: Content,
  },
  closed,
);
export const SetupInput = Type.Object(
  {
    ...attempt,
    community_name: Title,
    ordinary_area_name: Title,
    proposal_area_name: Title,
    overview: Content,
  },
  closed,
);
export const PublicationKind = Type.Union(
  [
    "discussion.create",
    "reply.create",
    "artifact.create",
    "revision.publish",
    "community.setup",
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
    limit: Type.Optional(Type.String({ pattern: "^(?:[1-9]|1[0-9]|2[0-5])$" })),
    max_response_bytes: Type.Optional(Type.String({ pattern: "^[0-9]{4,6}$" })),
  },
  closed,
);
export const BudgetInput = Type.Object(
  { max_response_bytes: PageInput.properties.max_response_bytes },
  closed,
);
export const Committed = Type.Object(
  {
    publication_state: Type.Literal("committed"),
    idempotency: Type.Union([
      Type.Literal("created"),
      Type.Literal("replayed"),
    ]),
    operation_id: UUID,
    resource_id: UUID,
    revision_id: UUID,
  },
  closed,
);
export const Reconciled = Type.Union([
  Committed,
  Type.Object({ operation_state: Type.Literal("not_recorded") }, closed),
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
  },
  closed,
);
export const UnavailableContribution = Type.Object(
  {
    resource_id: UUID,
    state: Type.Literal("unavailable"),
    discussion_id: UUID,
    parent_id: NullableId,
  },
  closed,
);
export const ContributionContext = Type.Union([
  Revision,
  UnavailableContribution,
]);
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
  { id: UUID, area: Area, opening: Resource },
  closed,
);
export const Page = Type.Object(
  {
    items: Type.Array(
      Type.Union([
        Resource,
        Area,
        Participant,
        Type.Object(
          { resource_id: UUID, state: Type.Literal("unavailable") },
          closed,
        ),
      ]),
      { maxItems: limits.pageItems },
    ),
    scope: Type.String(),
    representation: Type.Literal("metadata"),
    omitted_detail: Type.Literal("bodies"),
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
      Type.Literal("ready"),
      Type.Literal("setup_incomplete"),
      Type.Literal("unavailable"),
    ]),
    resource_id: Type.Optional(UUID),
    revision_id: Type.Optional(UUID),
  },
  closed,
);
export const Onboarding = Type.Object(
  {
    instance_id: UUID,
    contract_version: Type.Literal(contractVersion),
    guide_revision: Type.Literal("1"),
    profile: Type.Literal("synthetic"),
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
        ...Object.fromEntries(
          Object.keys(limits).map((key) => [key, Type.Integer()]),
        ),
      },
      closed,
    ),
    replay_retention: Type.Literal(
      "retained_without_automatic_expiry; destructive_restore_unsupported",
    ),
    derived_effects: Type.Literal("disabled"),
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
        minimum_response_bytes: Type.Optional(Type.Integer()),
        operation_outcome: Type.Optional(Type.Literal("unknown")),
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
