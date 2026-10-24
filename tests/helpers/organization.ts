import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import type {TestContext} from 'node:test';
import {fixture as existing} from './moderation.js';
import * as C from '../../src/contracts/organization.js';
export const organization='/api/v1/organization';
export async function fixture(t:TestContext,options:Parameters<typeof existing>[1]={}){
  const f=await existing(t,options);
  async function organizationState(id:string,client=f.admin):Promise<C.OrganizationResourceView>{
    const r=await client.call(organization+'/resources/'+id);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.OrganizationResource,r.body));return r.body;
  }
  async function organizationCommand(id:string,kind:C.OrganizationCommand['kind']='discussion.close',fields:Record<string,unknown>={}):Promise<C.OrganizationCommand>{
    const state=await organizationState(id);return {idempotency_key:randomUUID(),kind,resource_id:id,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version,...fields} as C.OrganizationCommand;
  }
  async function organize(body:C.OrganizationCommand,client=f.admin):Promise<C.OrganizationResult>{
    const r=await client.call(organization+'/changes',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.OrganizationCommitted,r.body));return r.body;
  }
  const closeDiscussion=async(id:string,closed=true)=>organize(await organizationCommand(id,closed?'discussion.close':'discussion.open'));
  return {...f,organizationState,organizationCommand,organize,closeDiscussion};
}
