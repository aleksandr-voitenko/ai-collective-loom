import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { TestContext } from 'node:test';
import { fixture as existing } from './notifications.js';
import * as C from '../../src/contracts/following.js';

export async function fixture(t:TestContext,options:Parameters<typeof existing>[1]={}){
  const f=await existing(t,options);
  const settings=(kind:C.FollowTargetView['kind'],id:string,descendants=false,preferences:C.FollowSettingsView['preferences']=[...C.eventPreferences]):C.FollowSettingsView=>
    ({target:{kind,resource_id:id},include_descendants:descendants,preferences});
  const follow=async(client:typeof f.admin,definition:C.FollowSettingsView,following=true,expected_version=0,key=randomUUID())=>{
    const body={...definition,following,expected_version,idempotency_key:key},r=await client.call('/api/v1/me/following/state',body);
    assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.FollowResult,r.body));return {body,result:r.body as C.FollowResultView};
  };
  const changes=async(client:typeof f.admin,options:C.SharedOptions={})=>{
    const r=await client.call('/api/v1/shared-changes/query',options);assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(Value.Check(C.SharedPage,r.body),JSON.stringify([...Value.Errors(C.SharedPage,r.body)]));return r.body as C.SharedPageView;
  };
  const allChanges=async(client:typeof f.admin,options:C.SharedOptions={})=>{
    let page=await changes(client,options);const items=[...page.items];let pages=1;
    while(page.next_cursor){assert.ok(pages++<200,'bounded fixture traversal');page=await changes(client,{cursor:page.next_cursor,limit:options.limit??25,max_response_bytes:options.max_response_bytes??131072});items.push(...page.items);}
    return {page,items};
  };
  const area=async(title:string,parent:string|null=null)=>{
    const state=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;
    const r=await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.create',parent_id:parent,title,description:'Synthetic scope',expected_hierarchy_version:state.hierarchy_version});
    assert.equal(r.status,200,JSON.stringify(r.body));return r.body.outcome.resource_id as string;
  };
  const event=async(revision:string)=>(await f.observer.query('SELECT id FROM loom.shared_activity WHERE revision_id=$1',[revision])).rows[0].id as string;
  return {...f,settings,follow,changes,allChanges,newArea:area,event};
}
