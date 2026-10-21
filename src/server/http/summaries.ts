import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as S from '../../contracts/summaries.js';
import {
  UUID,
  closed,
  Committed,
  Reconciled,
  ParticipationError,
  EditorsInput,
} from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { ParticipationPublications } from '../modules/participation/publications.js';
import { ParticipationAdministration } from '../modules/participation/administration.js';
import { SummaryPreparation } from '../modules/participation/summary-preparation.js';
import { DiscussionSummaries } from '../modules/participation/summaries.js';

export function registerSummaries(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const publications = new ParticipationPublications(database),
    preparations = new SummaryPreparation(database),
    reads = new DiscussionSummaries(database),
    admin = new ParticipationAdministration(database);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  const params = Type.Object({ id: UUID }, closed),
    exact = Type.Object({ id: UUID, revision: UUID }, closed),
    empty = Type.Object({}, closed);
  for (const [path, kind, schema] of [
    ['summaries', 'summary.create', S.SummaryCreateInput],
    ['summary-revisions', 'summary.revise', S.SummaryRevisionInput],
  ] as const)
    app.post(
      '/api/v1/' + path,
      {
        schema: {
          operationId: kind.replace('.', '_'),
          body: schema,
          querystring: empty,
          response: { ...errors, 201: Committed },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await publications.publish(await actor(request), kind, request.body)),
    );
  app.post(
    '/api/v1/summaries/status',
    {
      schema: {
        operationId: 'summaryStatus',
        body: S.SummaryStatusInput,
        querystring: empty,
        response: { ...errors, 200: Reconciled },
      },
    },
    async (request) => {
      const body = request.body as { operation_kind: string; idempotency_key: string };
      return publications.reconcile(
        await actor(request),
        body.operation_kind,
        body.idempotency_key,
      );
    },
  );
  app.post(
    '/api/v1/summary-preparations',
    {
      schema: {
        operationId: 'prepareSummarySources',
        body: S.PrepareInput,
        querystring: empty,
        response: { ...errors, 200: S.Preparation },
      },
    },
    async (request) => preparations.prepare(await actor(request), request.body),
  );
  app.post(
    '/api/v1/summary-preparations/cleanup',
    {
      schema: {
        operationId: 'cleanupOwnSummaryPreparations',
        body: empty,
        querystring: empty,
        response: { ...errors, 200: Type.Object({ cleaned: Type.Literal(true) }, closed) },
      },
    },
    async (request) => preparations.cleanup(await actor(request)),
  );
  app.get(
    '/api/v1/summary-preparations/:id',
    {
      schema: {
        operationId: 'getSummaryPreparation',
        params,
        querystring: empty,
        response: { ...errors, 200: S.Preparation },
      },
    },
    async (request) =>
      reads.prepared(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
  app.get(
    '/api/v1/summary-preparations/:id/members',
    {
      schema: {
        operationId: 'getPreparedSummaryMembers',
        params,
        querystring: S.SummaryPageInput,
        response: { ...errors, 200: S.SourcePage },
      },
    },
    async (request) =>
      reads.members(
        await actor(request),
        { preparation: (request.params as { id: string }).id.toLowerCase() },
        request.query as S.SummaryPageOptions,
      ),
  );
  app.get(
    '/api/v1/discussions/:id/summary',
    {
      schema: {
        operationId: 'getDiscussionSummary',
        params,
        querystring: empty,
        response: { ...errors, 200: S.SummaryLookup },
      },
    },
    async (request) =>
      reads.lookup(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
  app.get(
    '/api/v1/discussions/:id/summary-sources',
    {
      schema: {
        operationId: 'listDiscussionSummarySources',
        params,
        querystring: S.SummaryPageInput,
        response: { ...errors, 200: S.SourcePage },
      },
    },
    async (request) =>
      reads.sources(
        await actor(request),
        { discussion: (request.params as { id: string }).id.toLowerCase() },
        request.query as S.SummaryPageOptions,
      ),
  );
  app.get(
    '/api/v1/summaries/:id/revisions/:revision/coverage',
    {
      schema: {
        operationId: 'getSummaryCoverage',
        params: exact,
        querystring: empty,
        response: { ...errors, 200: S.CoverageDetail },
      },
    },
    async (request) => {
      const p = request.params as { id: string; revision: string };
      return reads.coverage(await actor(request), p.id.toLowerCase(), p.revision.toLowerCase());
    },
  );
  for (const current of [false, true])
    app.get(
      '/api/v1/summaries/:id/revisions/:revision/' + (current ? 'sources' : 'members'),
      {
        schema: {
          operationId: current ? 'listSummaryCurrentSources' : 'listSummaryCoverageMembers',
          params: exact,
          querystring: S.SummaryPageInput,
          response: { ...errors, 200: S.SourcePage },
        },
      },
      async (request) => {
        const p = request.params as { id: string; revision: string },
          selection = { summary: p.id.toLowerCase(), revision: p.revision.toLowerCase() };
        return current
          ? reads.sources(
              await actor(request),
              { ...selection, current: true },
              request.query as S.SummaryPageOptions,
            )
          : reads.members(await actor(request), selection, request.query as S.SummaryPageOptions);
      },
    );
  app.get(
    '/api/v1/summaries/maintenance',
    {
      schema: {
        operationId: 'discoverSummaryMaintenance',
        querystring: S.MaintenanceInput,
        response: { ...errors, 200: S.MaintenancePage },
      },
    },
    async (request) =>
      reads.maintenance(await actor(request), request.query as S.MaintenanceOptions),
  );
  app.post(
    '/api/v1/summaries/editors',
    {
      schema: {
        operationId: 'changeSummaryEditors',
        body: EditorsInput,
        querystring: empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              operation_state: Type.Literal('committed'),
              operation_id: UUID,
              version: Type.Integer(),
            },
            closed,
          ),
        },
      },
    },
    async (request) => admin.change(await actor(request), 'summary.editors', request.body),
  );
}
