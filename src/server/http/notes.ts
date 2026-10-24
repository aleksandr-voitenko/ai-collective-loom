import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/notes.js';
import { ParticipationError, UUID, closed } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { PrivateNotes } from '../modules/notes/notes.js';
export function registerNotes(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const service = new PrivateNotes(database),
    empty = Type.Object({}, closed),
    base = '/api/v1/me/notes';
  const privateResponse = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
  };
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  for (const action of ['create', 'update', 'delete'] as const)
    app.post(
      base + '/' + action,
      {
        onRequest: privateResponse,
        bodyLimit: C.noteLimits.requestBytes,
        schema: {
          operationId: 'privateNotes_' + action,
          body: C.noteCommands[action],
          querystring: empty,
          response: { ...errors, 200: C.NoteResult },
        },
      },
      async (request) => service.change(await actor(request), action, request.body),
    );
  app.post(
    base + '/status',
    {
      onRequest: privateResponse,
      bodyLimit: 4096,
      schema: {
        operationId: 'privateNotes_status',
        body: C.NoteStatusInput,
        querystring: empty,
        response: { ...errors, 200: C.NoteStatus },
      },
    },
    async (request) => service.status(await actor(request), request.body),
  );
  app.post(
    base + '/query',
    {
      onRequest: privateResponse,
      bodyLimit: 4096,
      schema: {
        operationId: 'privateNotes_query',
        body: C.NoteQuery,
        querystring: empty,
        response: { ...errors, 200: C.NotePage },
      },
    },
    async (request) => service.list(await actor(request), request.body),
  );
  for (const source of [false, true])
    app.get(
      base + '/:id' + (source ? '/sources' : ''),
      {
        onRequest: privateResponse,
        schema: {
          operationId: 'privateNotes_' + (source ? 'sources' : 'detail'),
          params: Type.Object({ id: UUID }, closed),
          querystring: empty,
          response: { ...errors, 200: source ? C.NoteSources : C.NoteDetail },
        },
      },
      async (request) =>
        source
          ? service.sources(await actor(request), (request.params as { id: string }).id)
          : service.read(await actor(request), (request.params as { id: string }).id),
    );
}
