import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/references.js';
import { UUID, closed, ParticipationError, type ReferenceTargetValue } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../modules/publication/publication.js';
import { RecordedReferences } from '../modules/participation/references.js';

export function registerReferences(app:FastifyInstance,database:Transactions,actor:(request:FastifyRequest)=>Promise<ActorContext>){
  const references=new RecordedReferences(database),errors=Object.fromEntries([400,401,403,404,409,429,500,503].map(code=>[code,ParticipationError]));
  app.get('/api/v1/references/target',{schema:{operationId:'resolveReferenceTarget',querystring:C.TargetInput,response:{...errors,200:C.ResolvedTarget}}},
    async request=>references.target(await actor(request),request.query as ReferenceTargetValue));
  app.get('/api/v1/references/incoming',{schema:{operationId:'listIncomingReferences',querystring:C.IncomingInput,response:{...errors,200:C.ReferencePage}}},
    async request=>references.incoming(await actor(request),request.query as C.IncomingOptions));
  app.get('/api/v1/resources/:id/revisions/:revision/references',{schema:{operationId:'listOutgoingReferences',
    params:Type.Object({id:UUID,revision:UUID},closed),querystring:C.ReferencePageInput,response:{...errors,200:C.ReferencePage}}},async request=>{
    const params=request.params as {id:string;revision:string};
    return references.outgoing(await actor(request),params.id.toLowerCase(),params.revision.toLowerCase(),request.query as C.ReferencePageOptions);
  });
}
