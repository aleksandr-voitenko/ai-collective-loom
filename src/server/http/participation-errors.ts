import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Static } from '@sinclair/typebox';
import type { ParticipationError } from '../../contracts/participation.js';
import { RetrievalError, RevisionUnavailableError } from '../modules/participation/retrieval.js';
import {
  participationRecoveryPolicy,
  type ParticipationRecoveryPolicy,
} from './recovery-policy.js';
import { ThrottledError } from '../modules/rates/accounting.js';
import { FileError } from '../modules/participation/file-storage.js';
import { PublicationClosedError, PublicationError } from '../modules/publication/errors.js';
import { IdentityError } from '../modules/identity/errors.js';
import { classifyError } from './errors.js';
import { AttentionError } from '../modules/attention/controls.js';
import { ReadingLimitError } from '../modules/participation/reading.js';
import { SavedItemsError } from '../modules/participation/saved-items.js';
import { NoteError } from '../modules/notes/notes.js';
import { ReservationError } from '../modules/reservations/reservations.js';
import { ModerationError } from '../modules/participation/moderation.js';
import { OrganizationError } from '../modules/participation/organization-context.js';
import { NotificationError } from '../modules/notifications/retrieval.js';
import { FollowingError } from '../modules/following/context.js';
import { UpdatesError } from '../modules/updates/errors.js';
import { SearchError } from '../modules/search/search.js';
import { ReferenceError } from '../modules/participation/references.js';
import { SummaryError } from '../modules/participation/summary-context.js';

type FailurePolicy = { status: number; action: string };
type ClassifiedError = FailurePolicy & {
  code: string;
  message: string;
  current: string | null | undefined;
  minimum: number | undefined;
};
type RequestContext = {
  id: string;
  method: string;
  policy: ParticipationRecoveryPolicy | undefined;
};

// Explicit entries keep new stream failures from silently inheriting a retry or
// resynchronization instruction. Family-specific distinctions are wire contracts.
const updatesFailures: Record<UpdatesError['code'], FailurePolicy> = {
  updates_attention_refresh_required: { status: 409, action: 'refresh_attention_selection' },
  updates_attention_preparing: { status: 409, action: 'refresh_attention_selection' },
  updates_token_invalid: { status: 409, action: 'correct_request' },
  updates_descriptor_expired: { status: 410, action: 'renew_traversal' },
  updates_state_unavailable: { status: 410, action: 'resynchronize_retained_content' },
  updates_visibility_replay_required: { status: 409, action: 'replay_retained_history' },
  updates_shared_history_gap: { status: 410, action: 'resynchronize_retained_content' },
  updates_personal_history_gap: { status: 410, action: 'resynchronize_retained_content' },
  updates_epoch_changed: { status: 409, action: 'deployment_recovery_required' },
  updates_definition_changed: { status: 409, action: 'start_retained_history' },
  updates_capacity: { status: 429, action: 'review_synthetic_limit' },
  updates_work_limit: { status: 429, action: 'retry_same_request' },
  updates_view_changed: { status: 409, action: 'retry_same_request' },
};
const followingFailures: Record<FollowingError['code'], FailurePolicy> = {
  following_limit_reached: { status: 429, action: 'retry_same_request' },
  following_collection_changed: { status: 409, action: 'replay_view' },
  shared_token_invalid: { status: 409, action: 'retry_same_request' },
  shared_descriptor_expired: { status: 410, action: 'renew_traversal' },
  shared_visibility_replay_required: { status: 409, action: 'replay_retained_history' },
  shared_history_gap: { status: 410, action: 'resynchronize_retained_content' },
  shared_epoch_changed: { status: 409, action: 'deployment_recovery_required' },
  shared_definition_changed: { status: 409, action: 'start_retained_history' },
  shared_view_changed: { status: 409, action: 'retry_same_request' },
  shared_work_limit: { status: 429, action: 'retry_same_request' },
};
const notificationFailures: Record<NotificationError['code'], FailurePolicy> = {
  notification_token_invalid: { status: 409, action: 'correct_request' },
  notification_descriptor_expired: { status: 410, action: 'renew_traversal' },
  visibility_replay_required: { status: 409, action: 'replay_retained_history' },
  notification_history_gap: { status: 410, action: 'resynchronize_retained_history' },
  notification_epoch_changed: { status: 409, action: 'deployment_recovery_required' },
  notification_work_limit: { status: 429, action: 'retry_same_request' },
  notification_view_changed: { status: 409, action: 'retry_same_request' },
};

function classifyParticipationError(error: unknown, requestId: string): ClassifiedError {
  let code: string,
    message: string,
    status: number,
    action = 'correct_request',
    current: string | null | undefined,
    minimum: number | undefined;
  if (error instanceof PublicationError) {
    code = error.code;
    message = error.message;
    current = error.current_revision_id;
    status = {
      temporarily_throttled: 429,
      file_policy_conflict: 409,
      file_policy_capacity: 409,
      rate_policy_conflict: 409,
      rate_policy_capacity: 429,
      invalid_input: 400,
      reference_format_required: 409,
      change_format_required: 409,
      file_reference_format_required: 409,
      file_format_required: 409,
      invalid_actor: 401,
      unavailable: 404,
      forbidden: 403,
      revision_conflict: 409,
      idempotency_conflict: 409,
      retryable: 503,
      service_unavailable: 503,
    }[error.code];
  } else if (error instanceof FileError) {
    code = error.code;
    message = error.message;
    status = code === 'file_storage_unavailable' ? 503 : code === 'file_capacity' ? 429 : 409;
    action = ['file_size_limit', 'file_unfinished_capacity', 'file_reserved_capacity'].includes(
      code,
    )
      ? 'retain_draft_and_inspect_file_limits'
      : code === 'file_expired'
        ? 'retain_draft_and_reconcile'
        : code === 'file_mismatch'
          ? 'reselect_original_bytes'
          : 'retry_same_request';
  } else if (error instanceof IdentityError) {
    code = error.code;
    message = error.message;
    status = error.status;
  } else if (error instanceof SummaryError) {
    code = error.code;
    message = error.message;
    status = code === 'summary_source_limit' || code === 'summary_preparation_limit' ? 429 : 409;
    action =
      code === 'summary_changed'
        ? 'replay_view'
        : code === 'summary_already_exists'
          ? 'inspect_discussion_summary'
          : code === 'summary_preparation_expired'
            ? 'retain_draft_and_reconcile'
            : 'review_declaration';
  } else if (error instanceof UpdatesError) {
    code = error.code;
    message = error.message;
    ({ status, action } = updatesFailures[error.code]);
  } else if (error instanceof FollowingError) {
    code = error.code;
    message = error.message;
    ({ status, action } = followingFailures[error.code]);
  } else if (error instanceof NotificationError) {
    code = error.code;
    message = error.message;
    ({ status, action } = notificationFailures[error.code]);
  } else if (error instanceof ReferenceError) {
    code = error.code;
    message = error.message;
    status = code === 'references_changed' ? 409 : 429;
    action = code === 'references_changed' ? 'replay_view' : 'review_synthetic_limit';
  } else if (error instanceof SearchError) {
    code = error.code;
    message = error.message;
    status = code === 'search_changed' ? 409 : code === 'search_work_limit' ? 429 : 400;
    action =
      code === 'search_changed'
        ? 'replay_view'
        : code === 'search_work_limit'
          ? 'review_synthetic_limit'
          : 'correct_request';
  } else if (error instanceof NoteError) {
    code = error.code;
    message = error.message;
    status = code === 'note_limit' ? 429 : 409;
    action = code === 'note_collection_changed' ? 'replay_view' : 'review_current_note';
  } else if (error instanceof ReservationError) {
    code = error.code;
    message = error.message;
    status = code === 'editing_intent_limit' ? 429 : code === 'editing_intent_closed' ? 403 : 409;
    action = code === 'editing_intent_limit' ? 'review_synthetic_limit' : 'refresh_and_review';
  } else if (error instanceof ModerationError) {
    code = error.code;
    message = error.message;
    status = code === 'moderation_limit' ? 429 : code === 'moderation_conflict' ? 409 : 400;
    action =
      code === 'moderation_conflict'
        ? 'refresh_and_review'
        : code === 'moderation_limit'
          ? 'review_synthetic_limit'
          : 'correct_request';
  } else if (error instanceof OrganizationError) {
    code = error.code;
    message = error.message;
    status = code === 'organization_limit' ? 429 : 409;
    action = code === 'organization_limit' ? 'review_synthetic_limit' : 'refresh_and_review';
  } else if (error instanceof AttentionError) {
    code = error.code;
    message = error.message;
    status =
      code === 'attention_selection_expired'
        ? 410
        : code === 'attention_collection_changed'
          ? 409
          : 429;
    action =
      code === 'attention_selection_expired'
        ? 'reconcile_operation'
        : code === 'attention_collection_changed'
          ? 'refresh_collection'
          : code === 'attention_work_limit'
            ? 'retry_same_request'
            : 'review_synthetic_limit';
  } else if (error instanceof ReadingLimitError) {
    code = error.code;
    message = error.message;
    status = 429;
    action = 'review_synthetic_limit';
  } else if (error instanceof SavedItemsError) {
    code = error.code;
    message = error.message;
    status = code === 'saved_collection_changed' ? 409 : 429;
    action = code === 'saved_collection_changed' ? 'replay_view' : 'review_synthetic_limit';
  } else if (error instanceof RetrievalError) {
    code = error.code;
    message =
      code === 'invalid_cursor'
        ? 'This continuation is unavailable. Start this view again.'
        : 'The requested response budget cannot hold this representation.';
    status = 400;
    minimum = error.minimum_response_bytes;
  } else {
    const failure = classifyError(error, requestId);
    code = failure.body.error.code;
    message = failure.body.error.message;
    status = failure.status;
  }
  return { code, message, status, action, current, minimum };
}

function recoveryAction(error: unknown, failure: ClassifiedError, retrieval: boolean) {
  const { code, status, action } = failure;
  // Highest-precedence rules come first: transient throttling and server failures
  // must not inherit correction instructions from an underlying domain refusal.
  if (error instanceof ThrottledError) return 'wait_then_retry_same_request';
  if (status >= 500) return retrieval ? 'retry_same_request' : 'reconcile_operation';
  if (code === 'idempotency_conflict') return 'reconcile_operation';
  if (code === 'invalid_cursor') return 'replay_view';
  if (code === 'revision_conflict') return 'compare_and_resubmit';
  if (error instanceof PublicationClosedError) return 'retain_draft_and_reconcile';
  if (status === 401 || status === 403) return 'reauthenticate_or_request_authority';
  return action;
}

function serializeParticipationError(
  error: unknown,
  failure: ClassifiedError,
  request: RequestContext,
): Static<typeof ParticipationError> {
  const { code, message, status, current, minimum } = failure;
  const { policy } = request;
  const retrieval = policy === 'retrieval' || policy === 'revision-retrieval';
  const action = recoveryAction(error, failure, retrieval);
  // A server failure on a mutation remains uncertain even if the domain error
  // carries a definitive marker. Read/status failures add no unknown outcome and
  // preserve any existing definitive refusal.
  const outcome =
    status >= 500 && request.method === 'POST' && !retrieval
      ? 'unknown'
      : (error instanceof SummaryError || error instanceof FileError) && error.definitive
        ? 'rejected'
        : undefined;
  return {
    error: {
      code,
      message,
      request_id: request.id,
      recovery: { action },
      ...(error instanceof ThrottledError
        ? { retry_after_seconds: error.retryAfter, rate_category: error.category }
        : {}),
      ...(error instanceof PublicationClosedError
        ? { forbidden_reason: 'publication_closed' }
        : {}),
      ...(current !== undefined ? { current_revision_id: current } : {}),
      ...(error instanceof RevisionUnavailableError &&
      request.method === 'GET' &&
      policy === 'revision-retrieval'
        ? { unavailable_scope: 'revision' }
        : {}),
      ...(minimum ? { minimum_response_bytes: minimum } : {}),
      ...(outcome ? { operation_outcome: outcome } : {}),
    },
  };
}

export function participantError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const failure = classifyParticipationError(error, request.id);
  const body = serializeParticipationError(error, failure, {
    id: request.id,
    method: request.method,
    policy: participationRecoveryPolicy(request.method, request.routeOptions.url),
  });
  if (error instanceof ThrottledError) reply.header('retry-after', String(error.retryAfter));
  return reply.code(failure.status).send(body);
}
