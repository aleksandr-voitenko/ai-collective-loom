import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import type { TestContext } from 'node:test';
import { fixture as following } from './following.js';
import * as C from '../../src/contracts/updates.js';
export async function fixture(t: TestContext, options: Parameters<typeof following>[1]={}) {
  const f=await following(t,options);
  async function updates(client: typeof f.admin, options: C.UpdatesOptions={}) {
    const r=await client.call('/api/v1/me/updates/query',options);
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(Value.Check(C.UpdatesPage,r.body),JSON.stringify([...Value.Errors(C.UpdatesPage,r.body)]));
    return r.body as C.UpdatesPageView;
  }
  async function ready(client: typeof f.admin, options: C.UpdatesOptions={}) {
    let page=await updates(client,options),steps=0;
    while(page.stage==='preparing'){
      assert.ok(page.next_cursor);assert.ok(++steps<100);assert.equal(page.checkpoint,null);
      page=await updates(client,{cursor:page.next_cursor,limit:options.limit??12,max_response_bytes:options.max_response_bytes??131072});
    }
    return page;
  }
  async function allGroups(client: typeof f.admin, options: C.UpdatesOptions={selection:'complete'}) {
    if(!options.cursor&&!options.checkpoint&&!options.switch&&!options.recovery)options={selection:'complete',...options};
    let page=await ready(client,options);const items=[...page.items];let steps=0;
    while(page.next_cursor){assert.ok(++steps<100);page=await ready(client,{cursor:page.next_cursor,limit:options.limit??12});items.push(...page.items);}
    return {page,items};
  }
  async function members(client: typeof f.admin, options: C.UpdatesMembersOptions) {
    const r=await client.call('/api/v1/me/updates/members',options);assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(Value.Check(C.UpdatesMembersPage,r.body),JSON.stringify([...Value.Errors(C.UpdatesMembersPage,r.body)]));
    return r.body as C.UpdatesMembersPageView;
  }
  async function allMembers(client: typeof f.admin, cursor: string, limit=5) {
    let page=await members(client,{cursor,limit});const items=[...page.items];let steps=0;
    while(page.next_cursor){assert.ok(++steps<500);page=await members(client,{cursor:page.next_cursor,limit});items.push(...page.items);}
    return {page,items};
  }
  return {...f,updates,ready,allGroups,members,allMembers};
}
