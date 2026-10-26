import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ParticipationError, closed } from '../../contracts/participation.js';
import * as C from '../../contracts/file-policy.js';
import type { Transactions } from '../db/postgres.js';
import type { ActorContext } from '../modules/publication/actor.js';
import { FileAdmissionPolicy } from '../modules/participation/file-policy.js';

export function registerFilePolicy(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const policy = new FileAdmissionPolicy(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 409, 413, 415, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  app.get(
    '/api/v1/admin/file-limits',
    {
      schema: {
        operationId: 'inspectFileLimits',
        querystring: empty,
        response: { ...errors, 200: C.AdministrativeFileLimits },
      },
    },
    async (request) => policy.inspect(await actor(request), true),
  );
  app.get(
    '/api/v1/file-limits',
    {
      schema: {
        operationId: 'effectiveFileLimits',
        querystring: empty,
        response: { ...errors, 200: C.EffectiveFileLimits },
      },
    },
    async (request) => policy.inspect(await actor(request)),
  );
  for (const [suffix, input, output, action] of [
    ['state', C.FilePolicyInput, C.FileDecision, policy.update.bind(policy)],
    ['status', C.FileStatusInput, C.FileStatus, policy.status.bind(policy)],
    ['audit', C.FileAuditInput, C.FileAudit, policy.audit.bind(policy)],
  ] as const)
    app.post(
      '/api/v1/admin/file-limits/' + suffix,
      {
        bodyLimit: 4096,
        schema: {
          operationId: 'fileLimits_' + suffix,
          body: input,
          querystring: empty,
          response: { ...errors, 200: output },
        },
      },
      async (request) => action(await actor(request), request.body),
    );
}
