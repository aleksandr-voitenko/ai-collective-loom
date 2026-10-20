import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { TestContext } from 'node:test';
import { fixture as updates } from './updates.js';
import * as C from '../../src/contracts/attention.js';
import * as R from '../../src/contracts/routine-updates.js';
import type { UpdatesMembersOptions } from '../../src/contracts/updates.js';

export async function fixture(t:TestContext,options:Parameters<typeof updates>[1]={}){
  const f=await updates(t,options),endpoint='/api/v1/me/attention';
  async function mute(client:typeof f.admin,kind:'area'|'discussion'|'artifact',id:string,muted=true,expected_version=0,descendants=false,key=randomUUID()){
    const body={target:{kind,resource_id:id},include_descendants:descendants,muted,expected_version,idempotency_key:key};
    const r=await client.call(endpoint+'/mutes/state',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.MuteResult,r.body));return {body,result:r.body as C.MuteResultView};
  }
  async function dismiss(client:typeof f.admin,body:C.DismissUpdateInput){
    const r=await client.call(endpoint+'/dismissals/state',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.DismissResult,r.body));return r.body as C.DismissResultView;
  }
  async function routine(client:typeof f.admin,body:R.RoutineOptions={}){
    const r=await client.call('/api/v1/me/routine-updates/query',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(R.RoutinePage,r.body),JSON.stringify([...Value.Errors(R.RoutinePage,r.body)]));return r.body as R.RoutinePageView;
  }
  async function readyRoutine(client:typeof f.admin,body:R.RoutineOptions={}){
    let page=await routine(client,body),steps=0;
    while(page.stage==='preparing'){assert.ok(++steps<100);assert.ok(page.next_cursor);page=await routine(client,{cursor:page.next_cursor,limit:body.limit??12});}return page;
  }
  async function routineMembers(client:typeof f.admin,body:UpdatesMembersOptions){
    const r=await client.call('/api/v1/me/routine-updates/members',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(R.RoutineMembersPage,r.body));return r.body as R.RoutineMembersPageView;
  }
  async function allRoutineMembers(client:typeof f.admin,cursor:string){
    let page=await routineMembers(client,{cursor,limit:5}),steps=0;const items=[...page.items];
    while(page.next_cursor){assert.ok(++steps<500);page=await routineMembers(client,{cursor:page.next_cursor,limit:5});items.push(...page.items);}return items;
  }
  async function selection(client:typeof f.admin,cursor:string,group_id:string){
    const r=await client.call('/api/v1/me/routine-updates/selection',{cursor,group_id});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.AttentionSelection,r.body));return r.body as C.AttentionSelectionView;
  }
  const fromSelection=(s:C.AttentionSelectionView):C.DismissUpdateInput=>({idempotency_key:randomUUID(),selection:s.selection,inputs:s.inputs.map(({kind,id,version})=>({kind,id,dismissed:true,expected_version:version}))});
  return {...f,endpoint,mute,dismiss,routine,readyRoutine,routineMembers,allRoutineMembers,selection,fromSelection};
}
