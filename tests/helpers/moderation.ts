import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {TestContext} from 'node:test';
import {Value} from '@sinclair/typebox/value';
import {fixture as attention} from './attention.js';
import * as C from '../../src/contracts/moderation.js';
export const moderation='/api/v1/admin/moderation';
export async function fixture(t:TestContext,options:Parameters<typeof attention>[1]={}){
  const f=await attention(t,options);
  const inspect=async(id:string,client=f.admin)=>{
    const r=await client.call(moderation+'/resources/'+id);assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(Value.Check(C.ModerationResource,r.body));return r.body as C.ModerationResourceView;
  };
  const command=async(id:string,suppressed=true,client=f.admin):Promise<C.ModerationCommand>=>{
    const current=await inspect(id,client);return {idempotency_key:randomUUID(),target:current.target,suppressed,expected_version:current.version};
  };
  const apply=async(body:C.ModerationCommand,client=f.admin)=>{
    const r=await client.call(moderation+'/state',body);assert.equal(r.status,200,JSON.stringify(r.body));
    assert.ok(Value.Check(C.ModerationResult,r.body));return r.body as C.ModerationResultView;
  };
  const suppress=async(id:string,value=true,client=f.admin)=>apply(await command(id,value,client),client);
  return {...f,inspect,command,apply,suppress};
}
