import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/reservations.js';
import { ParticipationError, UUID, closed } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { EditingReservations } from '../modules/reservations/reservations.js';

export function registerReservations(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const service = new EditingReservations(database),
    empty = Type.Object({}, closed),
    base = '/api/v1/editing-intent';
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  for (const action of ['announce', 'renew', 'release'] as const)
    app.post(
      base + '/' + action,
      {
        bodyLimit: C.reservationLimits.requestBytes,
        schema: {
          operationId: 'editingIntent_' + action,
          body: { announce: C.AnnounceIntent, renew: C.RenewIntent, release: C.ReleaseIntent }[
            action
          ],
          querystring: empty,
          response: { ...errors, 200: C.IntentResult },
        },
      },
      async (request) => service.change(await actor(request), action, request.body),
    );
  app.post(
    base + '/status',
    {
      bodyLimit: C.reservationLimits.requestBytes,
      schema: {
        operationId: 'editingIntent_status',
        body: C.IntentStatusInput,
        querystring: empty,
        response: { ...errors, 200: C.IntentStatus },
      },
    },
    async (request) => service.status(await actor(request), request.body),
  );
  app.get(
    base + '/resources/:id',
    {
      schema: {
        operationId: 'editingIntent_inspect',
        params: Type.Object({ id: UUID }, closed),
        querystring: C.IntentPageInput,
        response: { ...errors, 200: C.IntentPage },
      },
    },
    async (request) =>
      service.list(
        await actor(request),
        (request.params as { id: string }).id,
        request.query as { limit?: string; cursor?: string },
      ),
  );
}
