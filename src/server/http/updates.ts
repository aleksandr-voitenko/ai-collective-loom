import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/updates.js';
import { closed, ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { CombinedUpdates } from '../modules/updates/retrieval.js';

export function registerUpdates(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const service = new CombinedUpdates(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 410, 413, 415, 429, 500, 503].map((code) => [
      code,
      ParticipationError,
    ]),
  );
  app.post(
    '/api/v1/me/updates/query',
    {
      bodyLimit: 32768,
      schema: {
        operationId: 'retrieveCombinedUpdates',
        querystring: empty,
        body: C.UpdatesQuery,
        response: { ...errors, 200: C.UpdatesPage },
      },
    },
    async (request) => service.query(await actor(request), request.body as C.UpdatesOptions),
  );
  app.post(
    '/api/v1/me/updates/members',
    {
      bodyLimit: 32768,
      schema: {
        operationId: 'retrieveBoundUpdateMembers',
        querystring: empty,
        body: C.UpdatesMembersQuery,
        response: { ...errors, 200: C.UpdatesMembersPage },
      },
    },
    async (request) =>
      service.members(await actor(request), request.body as C.UpdatesMembersOptions),
  );
  app.post(
    '/api/v1/me/updates/reasons',
    {
      bodyLimit: 32768,
      schema: {
        operationId: 'retrieveBoundUpdateReasons',
        querystring: empty,
        body: C.UpdatesReasonsQuery,
        response: { ...errors, 200: C.UpdatesReasonsPage },
      },
    },
    async (request) =>
      service.reasons(await actor(request), request.body as C.UpdatesReasonsOptions),
  );
}
