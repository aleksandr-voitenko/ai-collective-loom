import type { FastifyInstance,FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import * as C from '../../contracts/attention.js';
import * as P from '../../contracts/private-controls.js';
import * as R from '../../contracts/routine-updates.js';
import * as U from '../../contracts/updates.js';
import { FollowTarget } from '../../contracts/following.js';
import { closed,ParticipationError } from '../../contracts/participation.js';
import type { ActorContext } from '../modules/publication/actor.js';
import type { Transactions } from '../modules/publication/publication.js';
import { AttentionControls } from '../modules/attention/controls.js';
import { CombinedUpdates } from '../modules/updates/retrieval.js';

export function registerAttention(app:FastifyInstance,database:Transactions,actor:(request:FastifyRequest)=>Promise<ActorContext>){
  const service=new AttentionControls(database),privateService=new AttentionControls(database,'private'),routine=new CombinedUpdates(database,true),empty=Type.Object({},closed);
  const errors=Object.fromEntries([400,401,403,404,409,410,413,415,429,500,503].map(code=>[code,ParticipationError]));
  const routes=[
    ['attention/previews',P.PreviewQuery,P.PreviewPage,'readControlPreviews',service.previews.bind(service)],
    ['attention/private/mutes/lookup',FollowTarget,P.MuteItem,'lookupPrivateMute',privateService.lookupMute.bind(privateService)],
    ['attention/private/mutes/state',C.MuteUpdate,P.AttentionResult,'setPrivateMute',privateService.setMute.bind(privateService)],
    ['attention/private/dismissals/lookup',C.DismissLookup,P.DismissPage,'lookupPrivateDismissals',privateService.lookupDismissals.bind(privateService)],
    ['attention/private/dismissals/state',C.DismissUpdate,P.AttentionResult,'setPrivateDismissals',privateService.setDismissals.bind(privateService)],
    ['attention/private/status',C.AttentionStatusInput,P.AttentionStatus,'reconcilePrivateAttention',privateService.status.bind(privateService)],
    ['attention/private/list',C.AttentionListInput,P.AttentionList,'listPrivateAttention',privateService.list.bind(privateService)],
    ['attention/mutes/lookup',FollowTarget,C.MuteItem,'lookupOwnMute',service.lookupMute.bind(service)],
    ['attention/mutes/state',C.MuteUpdate,C.AttentionResult,'setOwnMute',service.setMute.bind(service)],
    ['attention/dismissals/lookup',C.DismissLookup,C.DismissPage,'lookupOwnDismissals',service.lookupDismissals.bind(service)],
    ['attention/dismissals/state',C.DismissUpdate,C.AttentionResult,'setOwnDismissals',service.setDismissals.bind(service)],
    ['attention/status',C.AttentionStatusInput,C.AttentionStatus,'reconcileOwnAttention',service.status.bind(service)],
    ['attention/list',C.AttentionListInput,C.AttentionList,'listOwnAttention',service.list.bind(service)],
  ] as const;
  for(const [suffix,input,output,operationId,run] of routes)app.post('/api/v1/me/'+suffix,{bodyLimit:C.attentionLimits.requestBytes,
    onRequest:async(_request,reply)=>{reply.header('Cache-Control','private, no-store');},
    schema:{operationId,querystring:empty,body:input,response:{...errors,200:output}}},async request=>run(await actor(request),request.body));
  app.post('/api/v1/me/routine-updates/query',{bodyLimit:32768,onRequest:async(_request,reply)=>{reply.header('Cache-Control','private, no-store');},schema:{operationId:'retrieveRoutineUpdates',querystring:empty,body:R.RoutineQuery,response:{...errors,200:R.RoutinePage}}},async request=>routine.query(await actor(request),request.body as R.RoutineOptions));
  app.post('/api/v1/me/routine-updates/members',{bodyLimit:32768,onRequest:async(_request,reply)=>{reply.header('Cache-Control','private, no-store');},schema:{operationId:'retrieveRoutineMembers',querystring:empty,body:U.UpdatesMembersQuery,response:{...errors,200:R.RoutineMembersPage}}},async request=>routine.members(await actor(request),request.body as U.UpdatesMembersOptions));
  app.post('/api/v1/me/routine-updates/reasons',{bodyLimit:32768,onRequest:async(_request,reply)=>{reply.header('Cache-Control','private, no-store');},schema:{operationId:'retrieveRoutineReasons',querystring:empty,body:U.UpdatesReasonsQuery,response:{...errors,200:U.UpdatesReasonsPage}}},async request=>routine.reasons(await actor(request),request.body as U.UpdatesReasonsOptions));
  app.post('/api/v1/me/routine-updates/selection',{bodyLimit:32768,onRequest:async(_request,reply)=>{reply.header('Cache-Control','private, no-store');},schema:{operationId:'prepareAttentionSelection',querystring:empty,body:C.AttentionSelectionQuery,response:{...errors,200:C.AttentionSelection}}},async request=>routine.selection(await actor(request),request.body as C.AttentionSelectionOptions));
}
