import { registerOperations } from './operations.js';
import { registerFilePolicy } from './file-policy.js';
import { registerRates } from './rates.js';
import { registerFiles } from './files.js';
import type { FileStorage } from '../modules/participation/file-storage.js';
import type { FastifyInstance } from 'fastify';
import { Type, type TSchema } from '@sinclair/typebox';
import * as C from '../../contracts/participation.js';
import type { IdentityAuthentication } from '../modules/identity/authentication.js';
import type { IdentityAdministration } from '../modules/identity/administration.js';
import { ParticipationPublications } from '../modules/participation/publications.js';
import { ParticipationRetrieval, type PageOptions } from '../modules/participation/retrieval.js';
import { ParticipationAdministration } from '../modules/participation/administration.js';
import type { Transactions } from '../db/postgres.js';
import { registerIdentityRoutes } from './identity.js';
import { participationGuide } from '../../contracts/guide.js';
import { registerSavedItems } from './saved-items.js';
import { registerAttention } from './attention.js';
import { registerReading } from './reading.js';
import { registerOrganization } from './organization.js';
import { registerModeration } from './moderation.js';
import { registerNotes } from './notes.js';
import { registerReservations } from './reservations.js';
import { registerSearch } from './search.js';
import { registerNotifications } from './notifications.js';
import { registerFollowing } from './following.js';
import { registerUpdates } from './updates.js';
import { registerReferences } from './references.js';
import { registerChanges } from './changes.js';
import { registerSummaries } from './summaries.js';
import { participantError } from './participation-errors.js';

export interface ParticipationServices {
  cookieNamespace?: string;
  installationMode?: 'synthetic-preview' | 'local-pilot' | 'staging';
  database: Transactions;
  fileStorage?: FileStorage;
  authentication: IdentityAuthentication;
  administration: IdentityAdministration;
}
export async function registerParticipation(app: FastifyInstance, services: ParticipationServices) {
  const actor = await registerIdentityRoutes(app, services);
  app.setErrorHandler(participantError);
  registerOperations(app, services.database, actor, !!services.fileStorage);
  registerRates(app, services.database, actor);
  registerFilePolicy(app, services.database, actor);
  registerFiles(app, services.database, actor, services.fileStorage);
  registerSavedItems(app, services.database, actor);
  registerReading(app, services.database, actor);
  registerAttention(app, services.database, actor);
  registerOrganization(app, services.database, actor);
  registerModeration(app, services.database, actor);
  registerReservations(app, services.database, actor);
  registerNotes(app, services.database, actor);
  registerSearch(app, services.database, actor);
  registerNotifications(app, services.database, actor);
  registerFollowing(app, services.database, actor);
  registerUpdates(app, services.database, actor);
  registerReferences(app, services.database, actor);
  registerChanges(app, services.database, actor);
  registerSummaries(app, services.database, actor);
  const publications = new ParticipationPublications(services.database),
    reads = new ParticipationRetrieval(services.database),
    admin = new ParticipationAdministration(services.database);
  const empty = Type.Object({}, C.closed),
    params = Type.Object({ id: C.UUID }, C.closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((code) => [code, C.ParticipationError]),
  );
  function command(path: string, kind: string, schema: TSchema) {
    app.post(
      '/api/v1/' + path,
      {
        bodyLimit: C.limits.requestBytes,
        schema: {
          operationId: kind.replaceAll('.', '_'),
          body: schema,
          querystring: empty,
          response: { ...errors, 201: C.Committed },
        },
      },
      async (request, reply) => {
        const result = await publications.publish(await actor(request), kind, request.body);
        return reply.code(201).send(result);
      },
    );
  }
  command('discussions', 'discussion.create', C.DiscussionInput);
  command('replies', 'reply.create', C.ReplyInput);
  command('artifacts', 'artifact.create', C.ArtifactInput);
  command('revisions', 'revision.publish', C.RevisionInput);
  command('community/setup', 'community.setup', C.SetupInput);
  app.post(
    '/api/v1/operations/status',
    {
      schema: {
        operationId: 'reconcilePublication',
        body: C.StatusInput,
        querystring: empty,
        response: { ...errors, 200: C.Reconciled },
      },
    },
    async (request) => {
      const input = request.body as {
        operation_kind: string;
        idempotency_key: string;
      };
      return publications.reconcile(
        await actor(request),
        input.operation_kind,
        input.idempotency_key,
      );
    },
  );
  app.get(
    '/api/v1/community',
    {
      schema: {
        operationId: 'getCommunity',
        querystring: empty,
        response: { ...errors, 200: C.Onboarding },
      },
    },
    async (request) => ({
      ...(await reads.onboarding(await actor(request))),
      installation_mode: services.installationMode ?? 'synthetic-preview',
    }),
  );
  app.get(
    '/api/v1/guide',
    {
      schema: {
        operationId: 'getParticipationGuide',
        querystring: empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              contract_version: Type.Literal(C.contractVersion),
              guide_revision: Type.Literal(C.guideRevision),
              text: Type.String(),
            },
            C.closed,
          ),
        },
      },
    },
    async (request) => {
      await actor(request);
      return participationGuide;
    },
  );
  app.get(
    '/api/v1/discussions/:id',
    {
      schema: {
        operationId: 'getDiscussion',
        params,
        querystring: empty,
        response: { ...errors, 200: C.Discussion },
      },
    },
    async (request) =>
      reads.discussion(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
  app.get(
    '/api/v1/areas/:id',
    {
      schema: {
        operationId: 'getArea',
        params,
        querystring: empty,
        response: { ...errors, 200: C.Area },
      },
    },
    async (request) =>
      reads.area(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
  app.get(
    '/api/v1/contributions/:id/context',
    {
      schema: {
        operationId: 'getContributionContext',
        params,
        querystring: C.BudgetInput,
        response: { ...errors, 200: C.ContributionContext },
      },
    },
    async (request) =>
      reads.contribution(
        await actor(request),
        (request.params as { id: string }).id.toLowerCase(),
        (request.query as PageOptions).max_response_bytes,
      ),
  );
  for (const exact of [false, true])
    app.get(
      '/api/v1/resources/:id' + (exact ? '/revisions/:revision' : ''),
      {
        schema: {
          operationId: exact ? 'getExactRevision' : 'getCurrentRevision',
          params: exact ? Type.Object({ id: C.UUID, revision: C.UUID }, C.closed) : params,
          querystring: C.BudgetInput,
          response: { ...errors, 200: C.Revision },
        },
      },
      async (request) => {
        const p = request.params as { id: string; revision?: string };
        return reads.detail(
          await actor(request),
          p.id.toLowerCase(),
          p.revision?.toLowerCase(),
          (request.query as PageOptions).max_response_bytes,
        );
      },
    );
  for (const [path, kind] of [
    ['areas', 'areas'],
    ['artifacts', 'artifacts'],
    ['participants', 'participants'],
    ['contacts', 'contacts'],
    ['areas/:id/discussions', 'discussions'],
    ['areas/:id/artifacts', 'artifacts'],
    ['contributions/:id/children', 'children'],
    ['contributions/:id/ancestors', 'ancestors'],
    ['resources/:id/history', 'revisions'],
  ] as const) {
    app.get(
      '/api/v1/' + path,
      {
        schema: {
          operationId: 'list_' + path.replaceAll(/[/:]/g, '_'),
          params: path.includes(':id') ? params : empty,
          querystring: C.PageInput,
          response: { ...errors, 200: C.Page },
        },
      },
      async (request) =>
        reads.list(
          await actor(request),
          kind,
          (request.params as { id?: string }).id?.toLowerCase() ?? 'all',
          request.query as PageOptions,
        ),
    );
  }
  const adminResult = Type.Object(
    {
      operation_state: Type.Literal('committed'),
      operation_id: C.UUID,
      version: Type.Integer(),
    },
    C.closed,
  );
  for (const [path, kind, schema] of [
    ['community/settings', 'community.settings', C.SettingsInput],
    ['editors', 'artifact.editors', C.EditorsInput],
  ] as const)
    app.post(
      '/api/v1/' + path,
      {
        schema: {
          operationId: kind.replaceAll('.', '_'),
          body: schema,
          querystring: empty,
          response: { ...errors, 200: adminResult },
        },
      },
      async (request) => admin.change(await actor(request), kind, request.body),
    );
  app.get(
    '/api/v1/resources/:id/editors',
    {
      schema: {
        operationId: 'getEditors',
        params,
        querystring: empty,
        response: {
          ...errors,
          200: Type.Object(
            {
              resource_id: C.UUID,
              version: Type.Integer(),
              can_manage: Type.Boolean(),
              editors: Type.Array(C.Participant, { maxItems: 32 }),
            },
            C.closed,
          ),
        },
      },
    },
    async (request) =>
      reads.editors(await actor(request), (request.params as { id: string }).id.toLowerCase()),
  );
}
