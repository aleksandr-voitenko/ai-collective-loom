import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/following.js';
import * as P from '../../contracts/private-controls.js';
import { closed, UUID, PageInput, ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import type { PageOptions } from '../modules/participation/retrieval.js';
import { Following } from '../modules/following/subscriptions.js';
import { SharedChanges } from '../modules/following/retrieval.js';

export function registerFollowing(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const following = new Following(database),
    shared = new SharedChanges(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 410, 413, 415, 429, 500, 503].map((code) => [
      code,
      ParticipationError,
    ]),
  );
  const privateFollowing = new Following(database, 'private');
  app.get(
    '/api/v1/me/following/private',
    {
      onRequest: async (_request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
      },
      schema: {
        operationId: 'listPrivateFollowing',
        querystring: PageInput,
        response: { ...errors, 200: P.FollowPage },
      },
    },
    async (request) => privateFollowing.list(await actor(request), request.query as PageOptions),
  );
  for (const [suffix, input, output, operationId, run] of [
    [
      'lookup',
      C.FollowTarget,
      P.FollowItem,
      'lookupPrivateFollowing',
      (actor: ActorContext, body: unknown) => privateFollowing.lookup(actor, body),
    ],
    [
      'state',
      C.FollowUpdate,
      P.FollowResult,
      'setPrivateFollowing',
      (actor: ActorContext, body: unknown) => privateFollowing.update(actor, body),
    ],
    [
      'status',
      Type.Object({ idempotency_key: UUID }, closed),
      P.FollowStatus,
      'reconcilePrivateFollowing',
      (actor: ActorContext, body: unknown) =>
        privateFollowing.reconcile(actor, (body as { idempotency_key: string }).idempotency_key),
    ],
  ] as const)
    app.post(
      '/api/v1/me/following/private/' + suffix,
      {
        bodyLimit: 4096,
        onRequest: async (_request, reply) => {
          reply.header('Cache-Control', 'private, no-store');
        },
        schema: {
          operationId,
          querystring: empty,
          body: input,
          response: { ...errors, 200: output },
        },
      },
      async (request) => run(await actor(request), request.body),
    );
  app.get(
    '/api/v1/me/following',
    {
      schema: {
        operationId: 'listOwnFollowing',
        querystring: PageInput,
        response: { ...errors, 200: C.FollowPage },
      },
    },
    async (request) => following.list(await actor(request), request.query as PageOptions),
  );
  app.post(
    '/api/v1/me/following/lookup',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'lookupOwnFollowing',
        querystring: empty,
        body: C.FollowTarget,
        response: { ...errors, 200: C.FollowItem },
      },
    },
    async (request) => following.lookup(await actor(request), request.body),
  );
  app.post(
    '/api/v1/me/following/state',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'setOwnFollowing',
        querystring: empty,
        body: C.FollowUpdate,
        response: { ...errors, 200: C.FollowResult },
      },
    },
    async (request) => following.update(await actor(request), request.body),
  );
  app.post(
    '/api/v1/me/following/status',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'reconcileOwnFollowing',
        querystring: empty,
        body: Type.Object({ idempotency_key: UUID }, closed),
        response: { ...errors, 200: C.FollowStatus },
      },
    },
    async (request) =>
      following.reconcile(
        await actor(request),
        (request.body as { idempotency_key: string }).idempotency_key,
      ),
  );
  app.post(
    '/api/v1/shared-changes/query',
    {
      bodyLimit: 32768,
      schema: {
        operationId: 'retrieveCompleteSharedChanges',
        querystring: empty,
        body: C.SharedQuery,
        response: { ...errors, 200: C.SharedPage },
      },
    },
    async (request) => shared.query(await actor(request), request.body as C.SharedOptions),
  );
  app.post(
    '/api/v1/shared-changes/detail',
    {
      bodyLimit: 32768,
      schema: {
        operationId: 'inspectSharedChangeReasons',
        querystring: empty,
        body: C.SharedDetailInput,
        response: { ...errors, 200: C.SharedItem },
      },
    },
    async (request) =>
      shared.detail(
        await actor(request),
        request.body as {
          cursor: string;
          event_id: string;
          reason_offset?: number;
          max_response_bytes?: number;
        },
      ),
  );
}
