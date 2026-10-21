import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/moderation.js';
import { ParticipationError, UUID, closed } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../modules/publication/publication.js';
import { SharedModeration } from '../modules/participation/moderation.js';

export function registerModeration(app:FastifyInstance,database:Transactions,actor:(request:FastifyRequest)=>Promise<ActorContext>) {
  const service=new SharedModeration(database),empty=Type.Object({},closed),base='/api/v1/admin/moderation';
  const errors=Object.fromEntries([400,401,403,404,409,413,429,500,503].map(code=>[code,ParticipationError]));
  app.post(base+'/state',{bodyLimit:C.moderationLimits.requestBytes,schema:{operationId:'setSuppression',body:C.ModerationInput,querystring:empty,response:{...errors,200:C.ModerationResult}}},
    async request=>service.change(await actor(request),request.body));
  app.post(base+'/status',{bodyLimit:C.moderationLimits.requestBytes,schema:{operationId:'reconcileSuppression',body:C.ModerationStatusInput,querystring:empty,response:{...errors,200:C.ModerationStatus}}},
    async request=>service.status(await actor(request),request.body));
  app.get(base+'/resources/:id',{schema:{operationId:'inspectSuppression',params:Type.Object({id:UUID},closed),querystring:empty,response:{...errors,200:C.ModerationResource}}},
    async request=>service.resource(await actor(request),(request.params as {id:string}).id));
  for(const collection of ['targets','audit'] as const)
    app.get(base+'/'+collection,{schema:{operationId:'listModeration_'+collection,querystring:C.ModerationPageInput,response:{...errors,200:collection==='targets'?C.ModerationPage:C.ModerationAudit}}},
      async request=>service.list(await actor(request),collection,request.query as {limit?:string;cursor?:string}));
}
