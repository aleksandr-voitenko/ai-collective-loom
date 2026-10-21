import type { FastifyInstance,FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/search.js';
import { closed,UUID,ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { TextSearch } from '../modules/search/search.js';

export function registerSearch(app:FastifyInstance,database:Transactions,actor:(request:FastifyRequest)=>Promise<ActorContext>){
  const search=new TextSearch(database),empty=Type.Object({},closed);
  const errors=Object.fromEntries([400,401,403,404,409,413,415,429,500,503].map(code=>[code,ParticipationError]));
  app.get('/api/v1/search',{schema:{operationId:'searchCurrentSharedText',querystring:C.SearchInput,response:{...errors,200:C.SearchPage}}},
    async request=>search.search(await actor(request),request.query as C.SearchOptions));
  app.get('/api/v1/search/status',{schema:{operationId:'getSharedTextIndexingStatus',querystring:empty,response:{...errors,200:C.SearchStatus}}},
    async request=>search.status(await actor(request)));
  app.get('/api/v1/search/authors',{schema:{operationId:'listCurrentSearchAuthors',querystring:C.SearchAuthorsInput,response:{...errors,200:C.SearchAuthorsPage}}},
    async request=>search.authors(await actor(request),request.query as C.SearchAuthorsOptions));
  app.get('/api/v1/admin/search/health',{schema:{operationId:'getAdministratorSearchHealth',querystring:empty,response:{...errors,200:C.SearchHealth}}},
    async request=>search.health(await actor(request)));
  app.get('/api/v1/admin/search/failures',{schema:{operationId:'inspectFailedSearchJobs',querystring:Type.Object({after:Type.Optional(UUID)},closed),response:{...errors,200:C.FailedSearchJobs}}},
    async request=>search.failures(await actor(request),(request.query as {after?:string}).after));
  app.post('/api/v1/admin/search/retry',{bodyLimit:4096,schema:{operationId:'retryFailedSearchJob',querystring:empty,
    body:Type.Object({id:UUID,claim_generation:Type.Integer({minimum:0})},closed),response:{...errors,200:Type.Object({accepted:Type.Literal(true)},closed)}}},
    async request=>{const input=request.body as {id:string;claim_generation:number};return search.retry(await actor(request),input.id,input.claim_generation);});
  app.post('/api/v1/admin/search/rebuild',{bodyLimit:4096,schema:{operationId:'rebuildSharedTextIndex',querystring:empty,
    body:Type.Object({expected_generation:Type.Integer({minimum:1})},closed),response:{...errors,200:Type.Object({generation:Type.Integer()},closed)}}},
    async request=>search.rebuild(await actor(request),(request.body as {expected_generation:number}).expected_generation));
}
