import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/organization.js';
import {
  PageInput,
  ParticipationError,
  UUID,
  closed,
  limits,
} from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { TopicOrganization } from '../modules/participation/organization.js';
import type { PageOptions } from '../modules/participation/retrieval.js';

export function registerOrganization(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const service = new TopicOrganization(database),
    empty = Type.Object({}, closed),
    params = Type.Object({ id: UUID }, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  app.post(
    '/api/v1/organization/changes',
    {
      bodyLimit: limits.requestBytes,
      schema: {
        operationId: 'changeOrganization',
        body: C.OrganizationInput,
        querystring: empty,
        response: { ...errors, 200: C.OrganizationCommitted },
      },
    },
    async (request) => service.change(await actor(request), request.body),
  );
  app.post(
    '/api/v1/organization/status',
    {
      schema: {
        operationId: 'reconcileOrganization',
        body: C.OrganizationStatusInput,
        querystring: empty,
        response: { ...errors, 200: C.OrganizationReconciled },
      },
    },
    async (request) => service.status(await actor(request), request.body),
  );
  for (const kind of ['children', 'destinations'] as const)
    app.get(
      '/api/v1/organization/' + kind,
      {
        schema: {
          operationId: 'listOrganization_' + kind,
          querystring: kind === 'children' ? C.OrganizationPageInput : PageInput,
          response: { ...errors, 200: C.OrganizationPage },
        },
      },
      async (request) =>
        service.list(
          await actor(request),
          kind,
          request.query as PageOptions & { parent_id?: string },
        ),
    );
  app.get(
    '/api/v1/organization/resources/:id',
    {
      schema: {
        operationId: 'getOrganizationResource',
        params,
        querystring: empty,
        response: { ...errors, 200: C.OrganizationResource },
      },
    },
    async (request) =>
      service.resource(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
  app.get(
    '/api/v1/areas/:id/proposal-route',
    {
      schema: {
        operationId: 'getProposalRoute',
        params,
        querystring: empty,
        response: { ...errors, 200: C.ProposalRoute },
      },
    },
    async (request) =>
      service.proposal(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
  app.get(
    '/api/v1/areas/:id/metadata-history',
    {
      schema: {
        operationId: 'getAreaMetadataHistory',
        params,
        querystring: PageInput,
        response: { ...errors, 200: C.MetadataHistory },
      },
    },
    async (request) =>
      service.history(
        await actor(request),
        (request.params as { id: string }).id.toLowerCase(),
        request.query as PageOptions,
      ),
  );
  app.get(
    '/api/v1/organization/audit',
    {
      schema: {
        operationId: 'getOrganizationAudit',
        querystring: PageInput,
        response: { ...errors, 200: C.OrganizationAudit },
      },
    },
    async (request) => service.audit(await actor(request), request.query as PageOptions),
  );
}
