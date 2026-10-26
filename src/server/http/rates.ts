import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ParticipationError, closed } from '../../contracts/participation.js';
import * as C from '../../contracts/rates.js';
import type { Transactions } from '../db/postgres.js';
import type { ActorContext } from '../modules/publication/actor.js';
import { ParticipationRatePolicy } from '../modules/rates/policy.js';

export function registerRates(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const policy = new ParticipationRatePolicy(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 409, 413, 415, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  app.get(
    '/api/v1/admin/participation-rates',
    {
      schema: {
        operationId: 'inspectParticipationRates',
        querystring: empty,
        response: { ...errors, 200: C.RatePolicy },
      },
    },
    async (request) => policy.inspect(await actor(request)),
  );
  for (const [suffix, input, output, action] of [
    ['state', C.RatePolicyInput, C.RateDecision, policy.update.bind(policy)],
    ['status', C.RateStatusInput, C.RateStatus, policy.status.bind(policy)],
    ['audit', C.RateAuditInput, C.RateAudit, policy.audit.bind(policy)],
  ] as const)
    app.post(
      '/api/v1/admin/participation-rates/' + suffix,
      {
        bodyLimit: 4096,
        schema: {
          operationId: 'participationRates_' + suffix,
          body: input,
          querystring: empty,
          response: { ...errors, 200: output },
        },
      },
      async (request) => action(await actor(request), request.body),
    );
}
