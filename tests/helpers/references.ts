import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { syntheticServer } from './participation-server.js';
import { workloadRates } from './rates.js';
import { httpClient } from './participation-http.js';
import type { ReferenceValue, ReferenceTargetValue } from '../../src/contracts/participation.js';

export const plain = (text:string) => ({format:'loom-markdown-v1' as const,text,mentions:[]});
export const authored = (text:string,references:ReferenceValue[]=[]) => ({format:'loom-markdown-v2' as const,text,mentions:[],references});
export const reference = (target:ReferenceTargetValue,relationship:ReferenceValue['relationship']=null,rationale:string|null=null):ReferenceValue =>
  ({reference_id:randomUUID(),target,relationship,rationale});
export const incoming = (target:ReferenceTargetValue,options:Record<string,string>={}) => '/api/v1/references/incoming?'+new URLSearchParams({...target,...options});
export const outgoing = (source:{resource_id:string;revision_id:string},options:Record<string,string>={}) =>
  `/api/v1/resources/${source.resource_id}/revisions/${source.revision_id}/references?`+new URLSearchParams(options);
export async function fixture(t:TestContext,options:Parameters<typeof syntheticServer>[0]&{rateLimits?:'defaults'|'workload'}={}) {
  const server=await syntheticServer(options);t.after(server.close);
  const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert);
  await admin.enroll(server.ticket);
  if(options.rateLimits!=='defaults')await workloadRates(server,admin);
  const setup=await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Reference tests',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:plain('Overview')});
  assert.equal(setup.status,201,JSON.stringify(setup.body));
  const areas=(await admin.call('/api/v1/areas')).body.items,area=areas.find((r:any)=>r.title==='General').id as string,other=areas.find((r:any)=>r.title==='Proposals').id as string;
  async function participant(nickname:string,kind:'human'|'agent'='agent'){
    const account=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname,kind,role:'participant'});assert.equal(account.status,200);
    const issued=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.body.participant_id,kind:kind==='human'?'enrollment':'agent',purpose:kind==='human'?'enroll':null,label:'Reference fixture',replace_credential_id:null});assert.equal(issued.status,200);
    const client=httpClient(server.origin,cert,kind==='agent'?issued.body.secret:undefined);
    if(kind==='human')await client.enroll(issued.body.secret);
    return {client,id:account.body.participant_id as string,credential:issued.body.credential_id as string};
  }
  async function artifact(client=admin,text='Reference source',refs?:ReferenceValue[]){
    const result=await client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:text,content:refs?authored(text,refs):plain(text)});
    assert.equal(result.status,201,JSON.stringify(result.body));return result.body as {resource_id:string;revision_id:string;operation_id:string};
  }
  async function revise(client:typeof admin,source:{resource_id:string;revision_id:string},text:string,refs:ReferenceValue[]){
    const result=await client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:text,content:authored(text,refs)});
    assert.equal(result.status,201,JSON.stringify(result.body));return result.body as typeof source;
  }
  async function move(id:string,parent:string,kind='artifact.move'){
    const state=(await admin.call('/api/v1/organization/resources/'+id)).body;
    const result=await admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind,resource_id:id,parent_id:parent,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version});
    assert.equal(result.status,200,JSON.stringify(result.body));
  }
  return {...server,admin,area,other,participant,artifact,revise,move};
}
