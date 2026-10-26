import { FailureQuery, OperationalFailures } from '../../contracts/operations.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { closed, ParticipationError } from '../../contracts/participation.js';
import {
  OperationalHealth,
  OutcomeQuery,
  OutcomePage,
  type OutcomeOptions,
} from '../../contracts/operations.js';
import type { Transactions } from '../db/postgres.js';
import type { ActorContext } from '../modules/publication/actor.js';
import { OperationalCollector, operationFamily } from '../modules/operations/collector.js';
import { OperationalInspection } from '../modules/operations/inspection.js';

export function registerOperations(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
  storageConfigured: boolean,
) {
  const collector = new OperationalCollector(database, () =>
    app.log.warn(
      { event: 'operational_collection_incomplete' },
      'Operational observation collection is incomplete.',
    ),
  );
  const inspection = new OperationalInspection(database, collector, storageConfigured);
  app.addHook('preSerialization', async (request, reply, payload) => {
    // Inspect only the closed error code, never serialize/copy the payload into telemetry.
    const code =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object' &&
      'code' in payload.error
        ? payload.error.code
        : undefined;
    if (!(
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      payload.error &&
      typeof payload.error === 'object' &&
      'forbidden_reason' in payload.error
    ))
      collector.observe(
        request.id,
        operationFamily(request.routeOptions.url),
        code,
        reply.statusCode,
      );
    return payload;
  });
  app.addHook('onClose', async () => collector.close());
  const errors = Object.fromEntries(
    [400, 401, 403, 409, 413, 415, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  for (const subject of ['authored', 'files', 'activity'] as const)
    app.post(
      '/api/v1/admin/operational-health/' + subject + '/failures',
      {
        bodyLimit: 4096,
        schema: {
          operationId: 'inspectOperationalFailures' + subject,
          querystring: Type.Object({}, closed),
          body: FailureQuery,
          response: { ...errors, 200: OperationalFailures },
        },
      },
      async (request) =>
        inspection.failures(
          await actor(request),
          subject,
          (request.body as { cursor?: string }).cursor,
          (request.body as { limit?: number }).limit,
        ),
    );
  app.get(
    '/api/v1/admin/operational-health',
    {
      schema: {
        operationId: 'inspectOperationalHealth',
        querystring: Type.Object({}, closed),
        response: { ...errors, 200: OperationalHealth },
      },
    },
    async (request) => inspection.health(await actor(request)),
  );
  app.post(
    '/api/v1/admin/operational-health/outcomes',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'inspectOperationalRequestOutcomes',
        querystring: Type.Object({}, closed),
        body: OutcomeQuery,
        response: { ...errors, 200: OutcomePage },
      },
    },
    async (request) => inspection.outcomes(await actor(request), request.body as OutcomeOptions),
  );
}
