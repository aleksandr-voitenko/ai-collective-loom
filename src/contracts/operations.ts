import { Type, type Static } from '@sinclair/typebox';
import { closed, UUID } from './participation.js';
import { SearchHealth, SearchStatus } from './search.js';
import { NotificationHealth } from './notifications.js';
import { FileSearchStatus } from './file-text.js';

export const operationalLimits = {
  records: 1024,
  windowHours: 24,
  captureIntervalMs: 100,
  items: 25,
  bytes: 32768,
} as const;
export const outcomeCodes = [
  'revision_conflict',
  'idempotency_conflict',
  'forbidden',
  'invalid_actor',
  'unauthenticated',
  'invalid_proof',
  'file_storage_unavailable',
  'file_mismatch',
  'file_size_limit',
  'file_unfinished_capacity',
  'file_reserved_capacity',
  'file_capacity',
  'notification_history_gap',
  'notification_epoch_changed',
  'notification_descriptor_expired',
  'visibility_replay_required',
  'notification_work_limit',
  'shared_history_gap',
  'shared_epoch_changed',
  'shared_descriptor_expired',
  'shared_visibility_replay_required',
  'shared_work_limit',
  'updates_shared_history_gap',
  'updates_personal_history_gap',
  'updates_epoch_changed',
  'updates_state_unavailable',
  'updates_descriptor_expired',
  'updates_visibility_replay_required',
  'updates_work_limit',
  'updates_capacity',
] as const;
export const operationFamilies = [
  'publication',
  'uploads',
  'shared_recovery',
  'personal_recovery',
  'combined_recovery',
  'administration',
  'participation',
  'identity',
] as const;
export type OutcomeCode = (typeof outcomeCodes)[number];
export type OperationFamily = (typeof operationFamilies)[number];
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const nullable = <T extends import('@sinclair/typebox').TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const time = Type.String({ maxLength: 40 });
export const WorkerObservation = Type.Object(
  {
    heartbeat_at: nullable(time),
    state: literals(['unknown', 'prior_runtime', 'recent', 'stale']),
    threshold_seconds: Type.Integer(),
  },
  closed,
);
const source = <T extends import('@sinclair/typebox').TSchema>(value: T) =>
  Type.Object(
    {
      state: literals(['observed', 'unavailable', 'not_configured']),
      observed_at: time,
      value: nullable(value),
    },
    closed,
  );
const jobs = Type.Object(
  Object.fromEntries(
    ['pending', 'running', 'complete', 'partial', 'unsupported', 'failed'].map((k) => [
      k,
      Type.Integer({ minimum: 0 }),
    ]),
  ),
  closed,
);
export const OperationalHealth = Type.Object(
  {
    observed_at: time,
    readiness: Type.Literal('independent_public_readiness'),
    storage_reachability: Type.Literal('unverified'),
    authored: source(
      Type.Object(
        { health: SearchHealth, coverage: SearchStatus, worker: WorkerObservation },
        closed,
      ),
    ),
    files: source(
      Type.Object(
        {
          generation: Type.Integer(),
          worker: WorkerObservation,
          coverage: FileSearchStatus,
          capacity_limited: Type.Boolean(),
          discovery_missing: Type.Boolean(),
          jobs,
          retained_bytes: Type.Integer(),
          reserved_bytes: Type.Integer(),
        },
        closed,
      ),
    ),
    activity: source(
      Type.Object({ health: NotificationHealth, worker: WorkerObservation }, closed),
    ),
    uploads: source(
      Type.Object(
        {
          retained_uploads: Type.Integer(),
          unfinished_uploads: Type.Integer(),
          quarantined_uploads: Type.Integer(),
          expired_reserved_uploads: Type.Integer(),
          reserved_bytes: Type.Integer(),
        },
        closed,
      ),
    ),
  },
  closed,
);
export type OperationalHealthView = Static<typeof OperationalHealth>;
export const OutcomeQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,14}$' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    max_bytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 32768 })),
  },
  closed,
);
export type OutcomeOptions = Static<typeof OutcomeQuery>;
export const OutcomeRecord = Type.Object(
  {
    position: Type.String({ pattern: '^[1-9][0-9]{0,14}$' }),
    request_id: UUID,
    observed_at: time,
    family: literals(operationFamilies),
    code: literals(outcomeCodes),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
  },
  closed,
);
export type OutcomeRecordView = Static<typeof OutcomeRecord>;
export const OutcomePage = Type.Object(
  {
    items: Type.Array(OutcomeRecord, { maxItems: 25 }),
    next_cursor: nullable(Type.String({ maxLength: 15 })),
    complete: Type.Boolean(),
    observed_at: time,
    window_start: time,
    oldest_retained_at: nullable(time),
    coverage: Type.Literal('incomplete_sample'),
    consistency: Type.Literal('live_retained_window'),
    process_dropped: Type.Integer({ minimum: 0 }),
    process_collection_failed: Type.Boolean(),
    max_records: Type.Literal(1024),
    max_response_bytes: Type.Integer(),
  },
  closed,
);
export type OutcomePageView = Static<typeof OutcomePage>;

export const failureCodes = [
  'unsupported_event',
  'unsupported_source',
  'source_limit',
  'lease_expired',
  'processing_failed',
  'missing_predecessor',
  'malformed_source',
  'delivery_limit',
  'historical_reply_eligibility_unknown',
  'storage',
  'byte_mismatch',
  'processing',
  'derived_capacity',
  'unknown',
] as const;
export const OperationalFailures = Type.Object(
  {
    items: Type.Array(Type.Object({ id: UUID, code: literals(failureCodes) }, closed), {
      maxItems: 25,
    }),
    next_cursor: nullable(UUID),
    complete: Type.Boolean(),
    observed_at: time,
    consistency: Type.Literal('live_jobs_refresh_after_changes'),
  },
  closed,
);
export type OperationalFailuresView = Static<typeof OperationalFailures>;
export const FailureQuery = Type.Object(
  { cursor: Type.Optional(UUID), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) },
  closed,
);
