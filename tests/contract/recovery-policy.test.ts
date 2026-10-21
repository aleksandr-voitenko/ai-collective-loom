import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { participantError, registerParticipation, type ParticipationServices } from '../../src/server/http/participation.js';
import { participationRecoveryPolicies, participationRecoveryPolicy } from '../../src/server/http/recovery-policy.js';
import { PublicationError } from '../../src/server/modules/publication/errors.js';
import { RevisionUnavailableError } from '../../src/server/modules/participation/retrieval.js';
import { SummaryError } from '../../src/server/modules/participation/summary-context.js';
import { FileError } from '../../src/server/modules/participation/file-storage.js';

async function injectedApplication(t: TestContext, failure: () => Error | undefined) {
  const app = Fastify({ logger: false, genReqId: () => 'recovery-policy-test',
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false, allErrors: false } } });
  const routes = new Set<string>();
  t.after(() => app.close());
  app.addHook('onRoute', route => {
    for (const method of [route.method].flat()) routes.add(method + ' ' + route.url);
  });
  app.addHook('onRequest', async () => { const error = failure(); if (error) throw error; });
  await registerParticipation(app, {
    database: { transaction: async () => { throw new Error('Failure injection must not execute SQL.'); } },
    authentication: { policy: { origin: 'https://loom.test' } },
    administration: {},
  } as unknown as ParticipationServices);
  await app.ready();
  return { app, routes };
}

test('routine Updates server failures retry retrieval without claiming an uncertain mutation', async t => {
  const { app } = await injectedApplication(t, () => new PublicationError('service_unavailable'));
  for (const suffix of ['query', 'members', 'reasons', 'selection']) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/me/routine-updates/' + suffix });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { error: {
      code: 'service_unavailable',
      message: new PublicationError('service_unavailable').message,
      request_id: 'recovery-policy-test',
      recovery: { action: 'retry_same_request' },
    } }, suffix);
  }
});

test('every registered participation route has a recovery policy and 500/503 reads differ from mutations', async t => {
  let failure: Error = new Error('Internal diagnostic must not leak.');
  const { app, routes } = await injectedApplication(t, () => failure);
  assert.deepEqual([...participationRecoveryPolicies.keys()].sort(),
    [...routes].filter(route => !route.startsWith('HEAD ')).sort(),
    'New and removed routes require an explicit recovery-policy review.');

  // This expectation is independent of the server catalogue. Status reads do
  // not repeat the command, while preparation/cleanup/ceremonies change state.
  const mutations = new Set([
    'admin/moderation/state', 'admin/notifications/reconcile', 'admin/notifications/retry',
    'admin/search/rebuild', 'admin/search/retry', 'artifacts', 'community/settings',
    'community/setup', 'discussions', 'editors', 'file-uploads', 'file-uploads/:id/bytes',
    'file-uploads/:id/finalize', 'file-uploads/cleanup', 'identity/accounts', 'identity/credentials',
    'identity/logout', 'identity/register/finish', 'identity/register/start', 'identity/rename',
    'identity/revoke', 'identity/signin/finish', 'identity/signin/start', 'identity/state',
    'me/attention/dismissals/state', 'me/attention/mutes/state', 'me/attention/private/dismissals/state',
    'me/attention/private/mutes/state', 'me/following/private/state', 'me/following/state',
    'me/reading/state', 'me/saved-items/state', 'organization/changes', 'replies', 'revisions',
    'summaries', 'summaries/editors', 'summary-preparations', 'summary-preparations/cleanup',
    'summary-revisions',
  ].map(path => 'POST /api/v1/' + path));
  for (const route of mutations) assert.ok(routes.has(route), route);
  for (const [error, status, code, message] of [
    [new Error('Internal diagnostic must not leak.'), 500, 'internal_error', 'The request could not be completed.'],
    [new PublicationError('service_unavailable'), 503, 'service_unavailable', new PublicationError('service_unavailable').message],
    [new PublicationError('retryable'), 503, 'retryable', new PublicationError('retryable').message],
  ] as const) {
    failure = error;
    for (const route of routes) {
      const separator = route.indexOf(' '), method = route.slice(0, separator) as 'GET' | 'HEAD' | 'POST';
      const template = route.slice(separator + 1);
      const response = await app.inject({ method, url: template.replace(/:\w+/g, '12345678-abcd-1234-abcd-123456789abc') });
      assert.equal(response.statusCode, status, route);
      if (method === 'HEAD') {
        assert.equal(response.body, '');
        assert.equal(participationRecoveryPolicy(method, template), participationRecoveryPolicy('GET', template));
      } else {
        const mutation = mutations.has(route);
        assert.deepEqual(response.json(), { error: {
          code, message, request_id: 'recovery-policy-test',
          recovery: { action: mutation ? 'reconcile_operation' : 'retry_same_request' },
          ...(mutation ? { operation_outcome: 'unknown' } : {}),
        } }, route);
      }
    }
  }
});

test('revision-only hints remain restricted to guarded resource reads and error types', async t => {
  let failure: Error = new RevisionUnavailableError();
  const { app, routes } = await injectedApplication(t, () => failure);
  const guarded = new Set(['GET /api/v1/resources/:id', 'GET /api/v1/resources/:id/revisions/:revision']);
  for (const error of [new RevisionUnavailableError(), new PublicationError('unavailable')]) {
    failure = error;
    for (const route of routes) {
      if (route.startsWith('HEAD ')) continue;
      const separator = route.indexOf(' '), method = route.slice(0, separator) as 'GET' | 'POST';
      const response = await app.inject({ method,
        url: route.slice(separator + 1).replace(/:\w+/g, '12345678-abcd-1234-abcd-123456789abc') });
      assert.equal(response.statusCode, 404, route);
      assert.deepEqual(response.json(), { error: {
        code: 'unavailable', message: error.message, request_id: 'recovery-policy-test',
        recovery: { action: 'correct_request' },
        ...(error instanceof RevisionUnavailableError && guarded.has(route) ? { unavailable_scope: 'revision' } : {}),
      } }, route);
    }
  }
});

test('non-server refusals retain correction, authority and definitive original-outcome semantics', async t => {
  let failure: Error | undefined;
  const { app } = await injectedApplication(t, () => failure);
  for (const [error, status, action] of [
    [new PublicationError('invalid_actor'), 401, 'reauthenticate_or_request_authority'],
    [new PublicationError('forbidden'), 403, 'reauthenticate_or_request_authority'],
    [new PublicationError('idempotency_conflict'), 409, 'reconcile_operation'],
    [new SummaryError('summary_preparation_expired', true), 409, 'retain_draft_and_reconcile'],
    [new FileError('file_expired', true), 409, 'retain_draft_and_reconcile'],
  ] as const) {
    failure = error;
    for (const path of ['revisions', 'operations/status', 'me/reading/status']) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/' + path });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { error: {
        code: error.code, message: error.message, request_id: 'recovery-policy-test',
        recovery: { action },
        ...((error instanceof SummaryError || error instanceof FileError) ? { operation_outcome: 'rejected' } : {}),
      } }, path);
    }
  }
  failure = undefined;
  for (const path of ['me/routine-updates/query', 'me/reading/state']) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/' + path, payload: { unsupported: true } });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: {
      code: 'invalid_request', message: 'The request does not match the documented contract.',
      request_id: 'recovery-policy-test', recovery: { action: 'correct_request' },
    } });
  }
});

test('unclassified templates and methods keep conservative fallback recovery', async t => {
  const app = Fastify({ logger: false, genReqId: () => 'recovery-policy-test' });
  t.after(() => app.close());
  app.setErrorHandler(participantError);
  for (const [method, url] of [['POST', '/api/v1/me/updates/unclassified'], ['PUT', '/api/v1/me/updates/query']] as const) {
    assert.equal(participationRecoveryPolicy(method, url), undefined);
    app.route({ method, url, handler: async () => { throw new Error('Synthetic failure.'); } });
  }
  for (const [method, url] of [['POST', '/api/v1/me/updates/unclassified'], ['PUT', '/api/v1/me/updates/query']] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: {
      code: 'internal_error', message: 'The request could not be completed.', request_id: 'recovery-policy-test',
      recovery: { action: 'reconcile_operation' },
      ...(method === 'POST' ? { operation_outcome: 'unknown' } : {}),
    } });
  }
});
