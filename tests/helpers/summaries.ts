import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { fixture as references,authored } from './references.js';
import type { ReferenceValue } from '../../src/contracts/participation.js';
import type { CoverageDeclarationValue,SourcePairValue } from '../../src/contracts/summaries.js';
export async function fixture(t:TestContext,options:Parameters<typeof references>[1]={}) {
  const f=await references(t,options);
  async function discussion(client=f.admin){const result=await client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Summary discussion',content:authored('Opening material')});
    assert.equal(result.status,201,JSON.stringify(result.body));const view=(await client.call('/api/v1/resources/'+result.body.resource_id)).body;
    return {id:view.discussion_id as string,opening:result.body as {resource_id:string;revision_id:string}};}
  async function reply(d:{id:string;opening:{resource_id:string}},text='Comment material',client=f.admin){const r=await client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:authored(text)});
    assert.equal(r.status,201,JSON.stringify(r.body));return r.body as {resource_id:string;revision_id:string};}
  async function prepare(discussion:string,client=f.admin,members?:SourcePairValue[]){const r=await client.call('/api/v1/summary-preparations',{
    idempotency_key:randomUUID(),discussion_id:discussion,...(members?{scope:'selected',members}:{scope:'full'})});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
  function createBody(discussion:string,preparation:string,refs:ReferenceValue[]=[]) {return {idempotency_key:randomUUID(),discussion_id:discussion,
    title:'Authored summary',content:authored('Independent synthesis',refs),coverage:{preparation_id:preparation}};}
  async function create(discussion:string,client=f.admin,refs:ReferenceValue[]=[]) {const p=await prepare(discussion,client),body=createBody(discussion,p.preparation_id,refs),r=await client.call('/api/v1/summaries',body);
    assert.equal(r.status,201,JSON.stringify(r.body));return {...r.body,body,preparation:p};}
  async function revise(s:{resource_id:string;revision_id:string},coverage:CoverageDeclarationValue,client=f.admin,refs:ReferenceValue[]=[]) {
    const body={idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:'Authored summary',content:authored('Independent synthesis',refs),coverage};
    const r=await client.call('/api/v1/summary-revisions',body);assert.equal(r.status,201,JSON.stringify(r.body));return {...r.body,body};}
  const coverage=(s:{resource_id:string;revision_id:string},client=f.admin)=>client.call(`/api/v1/summaries/${s.resource_id}/revisions/${s.revision_id}/coverage`);
  return {...f,discussion,reply,prepare,createBody,create,reviseSummary:revise,coverage};
}
