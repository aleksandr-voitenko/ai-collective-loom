import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/changes.js';
import { UUID, closed, ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../modules/publication/publication.js';
import { ChangeNotes } from '../modules/participation/changes.js';

export function registerChanges(app:FastifyInstance,database:Transactions,actor:(request:FastifyRequest)=>Promise<ActorContext>){
  const changes=new ChangeNotes(database),errors=Object.fromEntries([400,401,403,404,409,429,500,503].map(code=>[code,ParticipationError]));
  const params=Type.Object({id:UUID,revision:UUID},closed);
  app.get('/api/v1/resources/:id/revisions/:revision/change-note',{schema:{operationId:'getRevisionChangeNote',params,querystring:C.NoteDetailInput,response:{...errors,200:C.NoteDetail}}},async request=>{
    const p=request.params as {id:string;revision:string};return changes.note(await actor(request),p.id.toLowerCase(),p.revision.toLowerCase(),(request.query as C.ChangePageOptions).max_response_bytes);
  });
  app.get('/api/v1/resources/:id/revisions/:revision/change-coverage',{schema:{operationId:'getChangeAccountCoverage',params,querystring:C.ChangePageInput,response:{...errors,200:C.ChangeCoverage}}},async request=>{
    const p=request.params as {id:string;revision:string};return changes.coverage(await actor(request),p.id.toLowerCase(),p.revision.toLowerCase(),request.query as C.ChangePageOptions);
  });
  app.get('/api/v1/changes',{schema:{operationId:'discoverChangeExplanations',querystring:C.ChangeDiscoveryInput,response:{...errors,200:C.ChangeDiscovery}}},
    async request=>changes.discover(await actor(request),request.query as C.ChangeDiscoveryOptions));
}
