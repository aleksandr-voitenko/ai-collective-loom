import { Type, type Static } from '@sinclair/typebox';
import { fileLimits } from './files.js';
import { UUID, closed } from './participation.js';

// These are initial defaults and immutable safety ceilings, not transport settings.
export const filePolicyBounds = {
  max_file_bytes: { minimum: 1, maximum: fileLimits.fileBytes, default: fileLimits.fileBytes },
  max_unfinished_uploads: { minimum: 1, maximum: fileLimits.active, default: fileLimits.active },
  participant_reserved_bytes: {
    minimum: 1,
    maximum: fileLimits.ownerBytes,
    default: fileLimits.ownerBytes,
  },
  community_reserved_bytes: {
    minimum: 1,
    maximum: fileLimits.communityBytes,
    default: fileLimits.communityBytes,
  },
} as const;
export type FilePolicyField = keyof typeof filePolicyBounds;
export const FilePolicyLimits = Type.Object(
  {
    max_file_bytes: Type.Integer(filePolicyBounds.max_file_bytes),
    max_unfinished_uploads: Type.Integer(filePolicyBounds.max_unfinished_uploads),
    participant_reserved_bytes: Type.Integer(filePolicyBounds.participant_reserved_bytes),
    community_reserved_bytes: Type.Integer(filePolicyBounds.community_reserved_bytes),
  },
  closed,
);
export const FilePolicy = Type.Object(
  {
    ...FilePolicyLimits.properties,
    version: Type.Integer({ minimum: 1, maximum: 10001 }),
  },
  closed,
);
export type FilePolicyValue = Static<typeof FilePolicy>;
export const FilePolicyInput = Type.Object(
  {
    ...FilePolicyLimits.properties,
    idempotency_key: UUID,
    expected_version: Type.Integer({ minimum: 1, maximum: 10001 }),
  },
  closed,
);
export const FileStatusInput = Type.Object({ idempotency_key: UUID }, closed);
export const FileDecision = Type.Object(
  {
    operation_state: Type.Literal('committed'),
    idempotency: Type.Union([Type.Literal('created'), Type.Literal('replayed')]),
    operation_id: UUID,
    original: FilePolicy,
    current: FilePolicy,
  },
  closed,
);
export type FileDecisionValue = Static<typeof FileDecision>;
export const FileStatus = Type.Union([
  FileDecision,
  Type.Object({ operation_state: Type.Literal('not_recorded') }, closed),
]);
export const FileAuditInput = Type.Object(
  {
    before_version: Type.Optional(Type.Integer({ minimum: 2, maximum: 10002 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  },
  closed,
);
export const FileAudit = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          operation_id: UUID,
          actor_id: UUID,
          actor_credential_id: UUID,
          recorded_at: Type.String(),
          policy: FilePolicy,
        },
        closed,
      ),
      { maxItems: 25 },
    ),
    next_before_version: Type.Union([Type.Integer(), Type.Null()]),
  },
  closed,
);

export const FileOwnUsage = Type.Object(
  {
    reserved_bytes: Type.Integer({ minimum: 0 }),
    unfinished_uploads: Type.Integer({ minimum: 0 }),
    reserved_bytes_over_limit: Type.Boolean(),
    unfinished_uploads_over_limit: Type.Boolean(),
  },
  closed,
);
export const EffectiveFileLimits = Type.Object(
  {
    policy: FilePolicy,
    observed_at: Type.String(),
    own: FileOwnUsage,
  },
  closed,
);
export const AdministrativeFileLimits = Type.Object(
  {
    ...EffectiveFileLimits.properties,
    community: Type.Object(
      { reserved_bytes: Type.Integer({ minimum: 0 }), reserved_bytes_over_limit: Type.Boolean() },
      closed,
    ),
  },
  closed,
);
export type EffectiveFileLimitsValue = Static<typeof EffectiveFileLimits>;
export type AdministrativeFileLimitsValue = Static<typeof AdministrativeFileLimits>;
