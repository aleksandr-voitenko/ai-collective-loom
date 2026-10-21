import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { closed, UUID, ParticipationError } from '../../contracts/participation.js';
import * as C from '../../contracts/notifications.js';
import { PersonalNotifications } from '../modules/notifications/retrieval.js';
import { NotificationAdministration } from '../modules/notifications/administration.js';
import type { Transactions } from '../db/postgres.js';
import type { ActorContext } from '../modules/publication/actor.js';

export function registerNotifications(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const reads = new PersonalNotifications(database),
    admin = new NotificationAdministration(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 410, 413, 415, 429, 500, 503].map((code) => [
      code,
      ParticipationError,
    ]),
  );
  // POST carries bounded private retrieval tokens outside URLs/logs. It neither
  // consumes a signal nor acknowledges reading or changes a publication.
  app.post(
    '/api/v1/me/notifications/query',
    {
      bodyLimit: 8192,
      schema: {
        operationId: 'retrievePersonalDirectAttention',
        querystring: empty,
        body: C.NotificationQuery,
        response: { ...errors, 200: C.NotificationPage },
      },
    },
    async (request) => reads.query(await actor(request), request.body as C.NotificationOptions),
  );
  app.get(
    '/api/v1/me/notifications/:id',
    {
      schema: {
        operationId: 'getPersonalDirectAttentionDetail',
        querystring: empty,
        params: Type.Object({ id: UUID }, closed),
        response: { ...errors, 200: C.NotificationItem },
      },
    },
    async (request) => reads.detail(await actor(request), (request.params as { id: string }).id),
  );
  app.get(
    '/api/v1/admin/notifications/health',
    {
      schema: {
        operationId: 'getNotificationConsumerHealth',
        querystring: empty,
        response: { ...errors, 200: C.NotificationHealth },
      },
    },
    async (request) => admin.health(await actor(request)),
  );
  app.get(
    '/api/v1/admin/notifications/failures',
    {
      schema: {
        operationId: 'inspectNotificationRepairConditions',
        querystring: Type.Object({ after: Type.Optional(UUID) }, closed),
        response: { ...errors, 200: C.NotificationFailures },
      },
    },
    async (request) =>
      admin.failures(await actor(request), (request.query as { after?: string }).after),
  );
  app.post(
    '/api/v1/admin/notifications/retry',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'retryNotificationJob',
        querystring: empty,
        body: Type.Object({ id: UUID, claim_generation: Type.Integer({ minimum: 0 }) }, closed),
        response: { ...errors, 200: Type.Object({ accepted: Type.Literal(true) }, closed) },
      },
    },
    async (request) => {
      const input = request.body as { id: string; claim_generation: number };
      return admin.retry(await actor(request), input.id, input.claim_generation);
    },
  );
  app.post(
    '/api/v1/admin/notifications/reconcile',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'reconcileNotificationDiscovery',
        querystring: empty,
        body: Type.Object({ expected_generation: Type.Integer({ minimum: 1 }) }, closed),
        response: { ...errors, 200: Type.Object({ discovery_generation: Type.Integer() }, closed) },
      },
    },
    async (request) =>
      admin.reconcile(
        await actor(request),
        (request.body as { expected_generation: number }).expected_generation,
      ),
  );
}
