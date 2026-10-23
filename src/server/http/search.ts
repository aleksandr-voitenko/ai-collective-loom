import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/search.js';
import { closed, UUID, ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { TextSearch } from '../modules/search/search.js';
import { FileText } from '../modules/search/file-text.js';
import {
  FileSearchInput,
  FileSearchPage,
  FileSearchStatus,
  FileTextHealth,
  type FileSearchOptions,
} from '../../contracts/file-text.js';

export function registerSearch(
  app: FastifyInstance,
  database: Transactions,
  actor: (request: FastifyRequest) => Promise<ActorContext>,
) {
  const search = new TextSearch(database),
    empty = Type.Object({}, closed);
  const errors = Object.fromEntries(
    [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((code) => [code, ParticipationError]),
  );
  const files = new FileText(database);
  app.get(
    '/api/v1/search/files',
    {
      schema: {
        operationId: 'searchCurrentFileContents',
        querystring: FileSearchInput,
        response: { ...errors, 200: FileSearchPage },
      },
    },
    async (request) => files.search(await actor(request), request.query as FileSearchOptions),
  );
  app.get(
    '/api/v1/search/files/status',
    {
      schema: {
        operationId: 'getFileTextStatus',
        querystring: empty,
        response: { ...errors, 200: FileSearchStatus },
      },
    },
    async (request) => files.status(await actor(request)),
  );
  app.get(
    '/api/v1/admin/file-text/health',
    {
      schema: {
        operationId: 'getFileTextHealth',
        querystring: Type.Object({ after: Type.Optional(UUID) }, closed),
        response: { ...errors, 200: FileTextHealth },
      },
    },
    async (request) =>
      files.health(await actor(request), (request.query as { after?: string }).after),
  );
  app.post(
    '/api/v1/admin/file-text/retry',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'retryFileText',
        body: Type.Object(
          { file_id: UUID, claim_generation: Type.Integer({ minimum: 0 }) },
          closed,
        ),
        querystring: empty,
        response: { ...errors, 200: Type.Object({ accepted: Type.Literal(true) }, closed) },
      },
    },
    async (request) => {
      const p = request.body as { file_id: string; claim_generation: number };
      return files.retry(await actor(request), p.file_id, p.claim_generation);
    },
  );
  app.post(
    '/api/v1/admin/file-text/rebuild',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'rebuildFileText',
        body: Type.Object({ expected_generation: Type.Integer({ minimum: 1 }) }, closed),
        querystring: empty,
        response: { ...errors, 200: Type.Object({ generation: Type.Integer() }, closed) },
      },
    },
    async (request) =>
      files.rebuild(
        await actor(request),
        (request.body as { expected_generation: number }).expected_generation,
      ),
  );
  app.get(
    '/api/v1/search',
    {
      schema: {
        operationId: 'searchCurrentSharedText',
        querystring: C.SearchInput,
        response: { ...errors, 200: C.SearchPage },
      },
    },
    async (request) => search.search(await actor(request), request.query as C.SearchOptions),
  );
  app.get(
    '/api/v1/search/status',
    {
      schema: {
        operationId: 'getSharedTextIndexingStatus',
        querystring: empty,
        response: { ...errors, 200: C.SearchStatus },
      },
    },
    async (request) => search.status(await actor(request)),
  );
  app.get(
    '/api/v1/search/authors',
    {
      schema: {
        operationId: 'listCurrentSearchAuthors',
        querystring: C.SearchAuthorsInput,
        response: { ...errors, 200: C.SearchAuthorsPage },
      },
    },
    async (request) =>
      search.authors(await actor(request), request.query as C.SearchAuthorsOptions),
  );
  app.get(
    '/api/v1/admin/search/health',
    {
      schema: {
        operationId: 'getAdministratorSearchHealth',
        querystring: empty,
        response: { ...errors, 200: C.SearchHealth },
      },
    },
    async (request) => search.health(await actor(request)),
  );
  app.get(
    '/api/v1/admin/search/failures',
    {
      schema: {
        operationId: 'inspectFailedSearchJobs',
        querystring: Type.Object({ after: Type.Optional(UUID) }, closed),
        response: { ...errors, 200: C.FailedSearchJobs },
      },
    },
    async (request) =>
      search.failures(await actor(request), (request.query as { after?: string }).after),
  );
  app.post(
    '/api/v1/admin/search/retry',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'retryFailedSearchJob',
        querystring: empty,
        body: Type.Object({ id: UUID, claim_generation: Type.Integer({ minimum: 0 }) }, closed),
        response: { ...errors, 200: Type.Object({ accepted: Type.Literal(true) }, closed) },
      },
    },
    async (request) => {
      const input = request.body as { id: string; claim_generation: number };
      return search.retry(await actor(request), input.id, input.claim_generation);
    },
  );
  app.post(
    '/api/v1/admin/search/rebuild',
    {
      bodyLimit: 4096,
      schema: {
        operationId: 'rebuildSharedTextIndex',
        querystring: empty,
        body: Type.Object({ expected_generation: Type.Integer({ minimum: 1 }) }, closed),
        response: { ...errors, 200: Type.Object({ generation: Type.Integer() }, closed) },
      },
    },
    async (request) =>
      search.rebuild(
        await actor(request),
        (request.body as { expected_generation: number }).expected_generation,
      ),
  );
}
