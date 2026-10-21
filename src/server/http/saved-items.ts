import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/saved-items.js';
import { closed, ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import type { PageOptions } from '../modules/participation/retrieval.js';
import { SavedItems } from '../modules/participation/saved-items.js';

export function registerSavedItems(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const saved = new SavedItems(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  app.get(
    '/api/v1/me/saved-items',
    {
      schema: {
        operationId: 'listOwnSavedItems',
        querystring: C.SavedPageInput,
        response: { ...errors, 200: C.SavedPage },
      },
    },
    async (request) => saved.list(await actor(request), request.query as PageOptions),
  );
  app.post(
    '/api/v1/me/saved-items/lookup',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'lookupOwnSavedTarget',
        querystring: empty,
        body: C.SavedTarget,
        response: { ...errors, 200: C.SavedItem },
      },
    },
    async (request) => saved.lookup(await actor(request), request.body),
  );
  app.post(
    '/api/v1/me/saved-items/state',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'setOwnSavedState',
        querystring: empty,
        body: C.SavedUpdate,
        response: { ...errors, 200: C.SavedResult },
      },
    },
    async (request) => saved.update(await actor(request), request.body),
  );
  app.post(
    '/api/v1/me/saved-items/status',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'reconcileOwnSavedState',
        querystring: empty,
        body: C.SavedStatusInput,
        response: { ...errors, 200: C.SavedStatus },
      },
    },
    async (request) =>
      saved.reconcile(
        await actor(request),
        (request.body as { idempotency_key: string }).idempotency_key,
      ),
  );
}
