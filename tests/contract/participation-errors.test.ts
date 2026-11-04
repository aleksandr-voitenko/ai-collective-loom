import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import {
  registerParticipation,
  type ParticipationServices,
} from '../../src/server/http/participation.js';
import { RetrievalError } from '../../src/server/modules/participation/retrieval.js';
import { ThrottledError } from '../../src/server/modules/rates/accounting.js';
import { FileError } from '../../src/server/modules/participation/file-storage.js';
import {
  PublicationClosedError,
  PublicationError,
} from '../../src/server/modules/publication/errors.js';
import { IdentityError } from '../../src/server/modules/identity/errors.js';
import { AttentionError } from '../../src/server/modules/attention/controls.js';
import { ReadingLimitError } from '../../src/server/modules/participation/reading.js';
import { SavedItemsError } from '../../src/server/modules/participation/saved-items.js';
import { NoteError } from '../../src/server/modules/notes/notes.js';
import { ReservationError } from '../../src/server/modules/reservations/reservations.js';
import { ModerationError } from '../../src/server/modules/participation/moderation.js';
import { OrganizationError } from '../../src/server/modules/participation/organization-context.js';
import { NotificationError } from '../../src/server/modules/notifications/retrieval.js';
import { FollowingError } from '../../src/server/modules/following/context.js';
import { UpdatesError } from '../../src/server/modules/updates/errors.js';
import { SearchError } from '../../src/server/modules/search/search.js';
import { ReferenceError } from '../../src/server/modules/participation/references.js';
import { SummaryError } from '../../src/server/modules/participation/summary-context.js';

type Expected = readonly [status: number, action: string];

// Independent wire expectations, exercised through registered response schemas.
// Adding a domain code requires a deliberate expected-response decision here.
async function domainResponses<Code extends string>(
  t: TestContext,
  ErrorType: new (code: Code) => Error & { code: Code },
  expectations: Record<Code, Expected>,
) {
  let failure: Error;
  const app = await injectedApplication(t, () => failure);
  for (const code of Object.keys(expectations) as Code[]) {
    const [status, action] = expectations[code];
    const error = new ErrorType(code);
    failure = error;
    for (const retrieval of [false, true]) {
      const response = await app.inject({
        method: 'POST',
        url: retrieval ? '/api/v1/operations/status' : '/api/v1/revisions',
      });
      assert.equal(response.statusCode, status, code);
      assert.equal(response.headers['retry-after'], undefined, code);
      assert.deepEqual(
        response.json(),
        {
          error: {
            code,
            message: error.message,
            request_id: 'error-mapping-test',
            recovery: {
              action:
                status >= 500 ? (retrieval ? 'retry_same_request' : 'reconcile_operation') : action,
            },
            ...(status >= 500 && !retrieval ? { operation_outcome: 'unknown' } : {}),
          },
        },
        `${code}: ${retrieval ? 'status read' : 'mutation'}`,
      );
    }
  }
}

async function injectedApplication(t: TestContext, failure: () => Error) {
  const app = Fastify({ logger: false, genReqId: () => 'error-mapping-test' });
  t.after(() => app.close());
  app.addHook('onRequest', async () => {
    throw failure();
  });
  await registerParticipation(app, {
    database: {
      transaction: async () => {
        throw new Error('Error mapping must not execute SQL.');
      },
    },
    authentication: { policy: { origin: 'https://loom.test' } },
    administration: {},
  } as unknown as ParticipationServices);
  await app.ready();
  return app;
}

test('PublicationError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, PublicationError, {
    temporarily_throttled: [429, 'correct_request'],
    file_policy_conflict: [409, 'correct_request'],
    file_policy_capacity: [409, 'correct_request'],
    rate_policy_conflict: [409, 'correct_request'],
    rate_policy_capacity: [429, 'correct_request'],
    invalid_input: [400, 'correct_request'],
    invalid_actor: [401, 'reauthenticate_or_request_authority'],
    unavailable: [404, 'correct_request'],
    forbidden: [403, 'reauthenticate_or_request_authority'],
    revision_conflict: [409, 'compare_and_resubmit'],
    idempotency_conflict: [409, 'reconcile_operation'],
    retryable: [503, 'reconcile_operation'],
    service_unavailable: [503, 'reconcile_operation'],
    reference_format_required: [409, 'correct_request'],
    change_format_required: [409, 'correct_request'],
    file_format_required: [409, 'correct_request'],
    file_reference_format_required: [409, 'correct_request'],
  }));

test('FileError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, FileError, {
    file_storage_unavailable: [503, 'reconcile_operation'],
    file_size_limit: [409, 'retain_draft_and_inspect_file_limits'],
    file_reserved_capacity: [409, 'retain_draft_and_inspect_file_limits'],
    file_unfinished_capacity: [409, 'retain_draft_and_inspect_file_limits'],
    file_capacity: [429, 'retry_same_request'],
    file_not_prepared: [409, 'retry_same_request'],
    file_expired: [409, 'retain_draft_and_reconcile'],
    file_mismatch: [409, 'reselect_original_bytes'],
    file_busy: [409, 'retry_same_request'],
  }));

test('IdentityError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, IdentityError, {
    invalid_request: [400, 'correct_request'],
    invalid_cursor: [400, 'replay_view'],
    cursor_restart: [409, 'correct_request'],
    cursor_expired: [409, 'correct_request'],
    collection_changed: [409, 'correct_request'],
    page_budget_exceeded: [413, 'correct_request'],
    unauthenticated: [401, 'reauthenticate_or_request_authority'],
    forbidden: [403, 'reauthenticate_or_request_authority'],
    unavailable: [404, 'correct_request'],
    idempotency_conflict: [409, 'reconcile_operation'],
    nickname_conflict: [409, 'correct_request'],
    bootstrap_closed: [409, 'correct_request'],
    credential_limit: [409, 'correct_request'],
    last_administrator: [409, 'correct_request'],
    invalid_proof: [401, 'reauthenticate_or_request_authority'],
    rate_limited: [429, 'correct_request'],
    retryable: [503, 'reconcile_operation'],
    service_unavailable: [503, 'reconcile_operation'],
  }));

test('SummaryError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, SummaryError, {
    summary_already_exists: [409, 'inspect_discussion_summary'],
    summary_preparation_expired: [409, 'retain_draft_and_reconcile'],
    summary_preparation_limit: [429, 'review_declaration'],
    summary_source_limit: [429, 'review_declaration'],
    summary_changed: [409, 'replay_view'],
    summary_coverage_required: [409, 'review_declaration'],
  }));

test('UpdatesError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, UpdatesError, {
    updates_attention_refresh_required: [409, 'refresh_attention_selection'],
    updates_attention_preparing: [409, 'refresh_attention_selection'],
    updates_token_invalid: [409, 'correct_request'],
    updates_descriptor_expired: [410, 'renew_traversal'],
    updates_state_unavailable: [410, 'resynchronize_retained_content'],
    updates_visibility_replay_required: [409, 'replay_retained_history'],
    updates_shared_history_gap: [410, 'resynchronize_retained_content'],
    updates_personal_history_gap: [410, 'resynchronize_retained_content'],
    updates_epoch_changed: [409, 'deployment_recovery_required'],
    updates_definition_changed: [409, 'start_retained_history'],
    updates_capacity: [429, 'review_synthetic_limit'],
    updates_work_limit: [429, 'retry_same_request'],
    updates_view_changed: [409, 'retry_same_request'],
  }));

test('FollowingError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, FollowingError, {
    following_limit_reached: [429, 'retry_same_request'],
    following_collection_changed: [409, 'replay_view'],
    shared_token_invalid: [409, 'retry_same_request'],
    shared_descriptor_expired: [410, 'renew_traversal'],
    shared_visibility_replay_required: [409, 'replay_retained_history'],
    shared_history_gap: [410, 'resynchronize_retained_content'],
    shared_epoch_changed: [409, 'deployment_recovery_required'],
    shared_definition_changed: [409, 'start_retained_history'],
    shared_view_changed: [409, 'retry_same_request'],
    shared_work_limit: [429, 'retry_same_request'],
  }));

test('NotificationError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, NotificationError, {
    notification_token_invalid: [409, 'correct_request'],
    notification_descriptor_expired: [410, 'renew_traversal'],
    visibility_replay_required: [409, 'replay_retained_history'],
    notification_history_gap: [410, 'resynchronize_retained_history'],
    notification_epoch_changed: [409, 'deployment_recovery_required'],
    notification_work_limit: [429, 'retry_same_request'],
    notification_view_changed: [409, 'retry_same_request'],
  }));

test('ReferenceError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, ReferenceError, {
    references_changed: [409, 'replay_view'],
    reference_work_limit: [429, 'review_synthetic_limit'],
  }));

test('SearchError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, SearchError, {
    invalid_search: [400, 'correct_request'],
    search_work_limit: [429, 'review_synthetic_limit'],
    search_changed: [409, 'replay_view'],
  }));

test('NoteError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, NoteError, {
    note_limit: [429, 'review_current_note'],
    note_deleted: [409, 'review_current_note'],
    note_collection_changed: [409, 'replay_view'],
  }));

test('ReservationError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, ReservationError, {
    editing_intent_conflict: [409, 'refresh_and_review'],
    editing_intent_limit: [429, 'review_synthetic_limit'],
    editing_intent_closed: [403, 'reauthenticate_or_request_authority'],
  }));

test('ModerationError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, ModerationError, {
    moderation_conflict: [409, 'refresh_and_review'],
    moderation_limit: [429, 'review_synthetic_limit'],
    moderation_target_unsupported: [400, 'correct_request'],
  }));

test('OrganizationError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, OrganizationError, {
    organization_conflict: [409, 'refresh_and_review'],
    organization_limit: [429, 'review_synthetic_limit'],
    organization_cycle: [409, 'refresh_and_review'],
    proposal_route_changed: [409, 'refresh_and_review'],
  }));

test('AttentionError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, AttentionError, {
    attention_limit_reached: [429, 'review_synthetic_limit'],
    attention_collection_changed: [409, 'refresh_collection'],
    attention_selection_expired: [410, 'reconcile_operation'],
    attention_selection_too_large: [429, 'review_synthetic_limit'],
    attention_work_limit: [429, 'retry_same_request'],
  }));

test('SavedItemsError preserves complete mutation and retrieval responses', (t) =>
  domainResponses(t, SavedItemsError, {
    saved_limit_reached: [429, 'review_synthetic_limit'],
    saved_collection_changed: [409, 'replay_view'],
  }));

test('publication metadata keeps closure separate from general forbidden and preserves explicit null revisions', async (t) => {
  let failure: Error;
  const app = await injectedApplication(t, () => failure);
  for (const [error, status, action, fields] of [
    [
      new PublicationClosedError(),
      403,
      'retain_draft_and_reconcile',
      { forbidden_reason: 'publication_closed' },
    ],
    [new PublicationError('forbidden'), 403, 'reauthenticate_or_request_authority', {}],
    [
      new PublicationError('revision_conflict', null),
      409,
      'compare_and_resubmit',
      { current_revision_id: null },
    ],
    [
      new PublicationError('revision_conflict', '12345678-abcd-1234-abcd-123456789abc'),
      409,
      'compare_and_resubmit',
      { current_revision_id: '12345678-abcd-1234-abcd-123456789abc' },
    ],
    [new ReadingLimitError(), 429, 'review_synthetic_limit', {}],
  ] as const) {
    failure = error;
    const response = await app.inject({ method: 'POST', url: '/api/v1/revisions' });
    assert.equal(response.statusCode, status);
    assert.equal(response.headers['retry-after'], undefined);
    assert.deepEqual(response.json(), {
      error: {
        code: error.code,
        message: error.message,
        request_id: 'error-mapping-test',
        recovery: { action },
        ...fields,
      },
    });
  }
});

test('retrieval messages and optional minimum budgets retain their wire meaning', async (t) => {
  let failure: Error;
  const app = await injectedApplication(t, () => failure);
  for (const code of ['invalid_cursor', 'response_budget_too_small'] as const) {
    for (const minimum of [undefined, 0, 2048]) {
      failure = new RetrievalError(code, minimum);
      const response = await app.inject('/api/v1/resources/12345678-abcd-1234-abcd-123456789abc');
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: {
          code,
          message:
            code === 'invalid_cursor'
              ? 'This continuation is unavailable. Start this view again.'
              : 'The requested response budget cannot hold this representation.',
          request_id: 'error-mapping-test',
          recovery: { action: code === 'invalid_cursor' ? 'replay_view' : 'correct_request' },
          ...(minimum ? { minimum_response_bytes: minimum } : {}),
        },
      });
    }
  }
});

test('definitive file and summary refusals survive reads while uncertain mutation 5xx wins', async (t) => {
  let failure: Error;
  const app = await injectedApplication(t, () => failure);
  for (const definitive of [false, true]) {
    for (const [error, status, action] of [
      [new FileError('file_storage_unavailable', definitive), 503, 'reconcile_operation'],
      [new FileError('file_expired', definitive), 409, 'retain_draft_and_reconcile'],
      [
        new SummaryError('summary_preparation_expired', definitive),
        409,
        'retain_draft_and_reconcile',
      ],
    ] as const) {
      failure = error;
      for (const retrieval of [false, true]) {
        const response = await app.inject({
          method: 'POST',
          url: retrieval ? '/api/v1/operations/status' : '/api/v1/revisions',
        });
        assert.equal(response.statusCode, status);
        const outcome =
          status >= 500 && !retrieval ? 'unknown' : definitive ? 'rejected' : undefined;
        assert.deepEqual(response.json(), {
          error: {
            code: error.code,
            message: error.message,
            request_id: 'error-mapping-test',
            recovery: { action: retrieval && status >= 500 ? 'retry_same_request' : action },
            ...(outcome ? { operation_outcome: outcome } : {}),
          },
        });
      }
    }
  }
});

test('throttling retains its complete retry metadata without claiming an operation outcome', async (t) => {
  let failure: Error;
  const app = await injectedApplication(t, () => failure);
  for (const category of ['ordinary_requests', 'new_publications', 'recovery_control'] as const) {
    for (const wait of [1, 60]) {
      const error = new ThrottledError(category, wait);
      failure = error;
      for (const url of ['/api/v1/revisions', '/api/v1/operations/status']) {
        const response = await app.inject({ method: 'POST', url });
        assert.equal(response.statusCode, 429);
        assert.equal(response.headers['retry-after'], String(wait));
        assert.deepEqual(response.json(), {
          error: {
            code: 'temporarily_throttled',
            message: error.message,
            request_id: 'error-mapping-test',
            recovery: { action: 'wait_then_retry_same_request' },
            retry_after_seconds: wait,
            rate_category: category,
          },
        });
      }
    }
  }
});

test('framework failures omit diagnostic details and keep safe status mapping', async (t) => {
  let failure: Error;
  const app = await injectedApplication(t, () => failure);
  for (const [statusCode, status, code, message] of [
    [400, 400, 'invalid_request', 'The request does not match the documented contract.'],
    [413, 413, 'request_too_large', 'The request body exceeds the allowed size.'],
    [415, 415, 'unsupported_media_type', 'Use the documented request content type.'],
    [503, 503, 'service_unavailable', 'The service is not ready.'],
    [418, 500, 'internal_error', 'The request could not be completed.'],
  ] as const) {
    failure = Object.assign(new Error('Private SQL and payload diagnostics must not leak.'), {
      statusCode,
    });
    const response = await app.inject({ method: 'POST', url: '/api/v1/revisions' });
    assert.equal(response.statusCode, status);
    assert.deepEqual(response.json(), {
      error: {
        code,
        message,
        request_id: 'error-mapping-test',
        recovery: { action: status >= 500 ? 'reconcile_operation' : 'correct_request' },
        ...(status >= 500 ? { operation_outcome: 'unknown' } : {}),
      },
    });
  }
});
