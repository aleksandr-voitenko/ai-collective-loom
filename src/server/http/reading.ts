import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/reading.js';
import { closed, ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import { ReadingProgress } from '../modules/participation/reading.js';

export function registerReading(app: FastifyInstance, database: Transactions, actor: (request: FastifyRequest)=>Promise<ActorContext>) {
  const service=new ReadingProgress(database),empty=Type.Object({},closed);
  const errors=Object.fromEntries([400,401,403,404,409,413,415,429,500,503].map(code=>[code,ParticipationError]));
  for(const [suffix,input,output,operationId,run] of [
    ['lookup',C.ReadingLookup,C.ReadingPage,'lookupOwnReading',service.lookup.bind(service)],
    ['state',C.ReadingUpdate,C.ReadingResult,'setOwnReading',service.update.bind(service)],
    ['status',C.ReadingStatusInput,C.ReadingStatus,'reconcileOwnReading',service.reconcile.bind(service)],
  ] as const) app.post('/api/v1/me/reading/'+suffix,{bodyLimit:C.readingLimits.requestBytes,
    onRequest:async(_request,reply)=>{reply.header('Cache-Control','private, no-store');},
    schema:{operationId,querystring:empty,body:input,response:{...errors,200:output}}},async request=>run(await actor(request),request.body));
}
