import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../src/contracts/attention.js';
import * as P from '../../src/contracts/private-controls.js';
import { fixture } from '../helpers/attention.js';

// Fixture-owned encryption is independent of the production token decoder and
// accepts any JSON value, including malformed roots that an object editor cannot.
function seal(value:unknown,key:Buffer){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('attention-controls-1'));
  const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
}
function open(token:string,key:Buffer):Record<string,unknown>{
  const bytes=Buffer.from(token,'base64url'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  cipher.setAAD(Buffer.from('attention-controls-1'));cipher.setAuthTag(bytes.subarray(12,28));
  const value:unknown=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
  return value as Record<string,unknown>;
}
async function snapshot(f:Awaited<ReturnType<typeof fixture>>,owner:string){
  const result:Record<string,unknown[]>={};
  for(const table of ['attention_owners','attention_mutes','attention_dismissals','attention_operations']){
    result[table]=(await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${table} t WHERE participant_id=$1 ORDER BY to_jsonb(t)::text`,[owner])).rows;
  }
  return result;
}

test('authenticated null selections are invalid input without changing private state',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_null_payload'),a=await f.artifact();
  const key=(await f.observer.query('SELECT selection_key FROM loom.attention_state')).rows[0].selection_key as Buffer;
  const before=await snapshot(f,r.id);
  const response=await r.client.call(f.endpoint+'/dismissals/state',{idempotency_key:randomUUID(),selection:seal(null,key),
    inputs:[{kind:'shared_event',id:await f.event(a.revision_id),dismissed:true,expected_version:0}]});
  assert.equal(response.status,400,JSON.stringify(response.body));
  assert.equal(response.body.error.code,'invalid_input');
  assert.deepEqual(await snapshot(f,r.id),before);
});

test('selection and list payload shape refusals preserve private state and error precedence',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_payload_shapes'),a=await f.artifact(),b=await f.artifact();
  await f.follow(r.client,f.settings('artifact',a.resource_id));
  const page=await f.readyRoutine(r.client),selection=await f.selection(r.client,page.page_cursor,page.items[0]!.id);
  const key=(await f.observer.query('SELECT selection_key FROM loom.attention_state')).rows[0].selection_key as Buffer;
  const selected=open(selection.selection,key),first=selection.inputs[0]!;
  const without=(value:Record<string,unknown>,field:string)=>{const result={...value};delete result[field];return result;};
  const selectedCases:[string,unknown,string?][]=[
    ['array',[]],['wrong purpose',{...selected,purpose:'attention-list-1'}],['extra field',{...selected,extra:true}],
    ['missing policy',without(selected,'policy')],['string policy',{...selected,policy:'0'}],['negative policy',{...selected,policy:-1}],
    ['oversized policy',{...selected,policy:2147483647}],['missing expiry',without(selected,'expires')],
    ['string expiry',{...selected,expires:'0'}],['null expiry',{...selected,expires:null}],
    ['missing meaning',without(selected,'meaning')],['invalid meaning',{...selected,meaning:{view:page.traversal.id,group:page.items[0]!.id,selection:'other'}}],
    ['missing meaning identity',{...selected,meaning:{group:page.items[0]!.id,selection:'highlights'}}],
    ['empty inputs',{...selected,inputs:[]}],['oversized inputs',{...selected,inputs:Array(101).fill({kind:first.kind,id:first.id,version:first.version})}],
    ['bad input version',{...selected,inputs:[{kind:first.kind,id:first.id,version:'0'}]}],
    ['missing input identity',{...selected,inputs:[{kind:first.kind,version:first.version}]}],
    ['input mismatch',{...selected,inputs:[{kind:first.kind,id:randomUUID(),version:first.version}]}],
    ['wrong owner and expired',{...selected,owner:randomUUID(),expires:0}],['wrong instance',{...selected,instance:randomUUID()}],
    ['malformed and expired',{...selected,policy:'0',expires:0}],['well-shaped expired',{...selected,expires:0},'attention_selection_expired'],
  ];
  const before=await snapshot(f,r.id);
  for(const suffix of ['', '/private'])for(const [label,payload,code='invalid_input'] of selectedCases){
    const body={...f.fromSelection(selection),selection:seal(payload,key)};
    const response=await r.client.call(f.endpoint+suffix+'/dismissals/state',body);
    assert.equal(response.body.error?.code,code,suffix+' '+label);
    assert.deepEqual(await snapshot(f,r.id),before,suffix+' '+label);
  }
  await f.mute(r.client,'artifact',a.resource_id);await f.mute(r.client,'artifact',b.resource_id);
  const list=await r.client.call(f.endpoint+'/list',{collection:'mutes',limit:1});assert.equal(list.status,200);assert.ok(list.body.next_cursor);
  const listed=open(list.body.next_cursor,key),listBefore=await snapshot(f,r.id);
  const listCases:[string,unknown,string?][]=[
    ['null',null],['array',[]],['wrong purpose',selected],['extra field',{...listed,extra:true}],
    ['missing version',without(listed,'version')],['string version',{...listed,version:'2'}],['negative version',{...listed,version:-1}],
    ['missing after',without(listed,'after')],['numeric after',{...listed,after:4}],
    ['wrong collection',{...listed,collection:'dismissals'}],['missing collection',without(listed,'collection')],
    ['wrong owner and stale',{...listed,owner:randomUUID(),version:0}],['correct stale',{...listed,version:0},'attention_collection_changed'],
  ];
  for(const suffix of ['', '/private'])for(const [label,payload,code='invalid_input'] of listCases){
    const response=await r.client.call(f.endpoint+suffix+'/list',{collection:'mutes',cursor:seal(payload,key)});
    assert.equal(response.body.error?.code,code,suffix+' '+label);
    assert.deepEqual(await snapshot(f,r.id),listBefore,suffix+' '+label);
  }
});

for(const projection of ['legacy','private'] as const)test(`${projection} issued tokens retain exact payloads, digests and replay without token key reads`,{timeout:90000},async t=>{
  let forbidKey=false,keyReads=0;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async(sql,values)=>{
    if(forbidKey&&sql.startsWith('SELECT selection_key')){keyReads++;throw new Error('Recorded replay must not open a token');}
    return tx.query(sql,values);
  }}))})});
  const r=await f.participant('attention_token_'+projection),a=await f.artifact(),b=await f.artifact();
  const endpoint=f.endpoint+(projection==='private'?'/private':'');
  await f.follow(r.client,f.settings('artifact',a.resource_id));await f.follow(r.client,f.settings('artifact',b.resource_id));
  const page=await f.readyRoutine(r.client,{selection:'complete'}),selection=await f.selection(r.client,page.page_cursor,page.items[0]!.id);
  const otherSelection=await f.selection(r.client,page.page_cursor,page.items[1]!.id);
  const key=(await f.observer.query('SELECT selection_key FROM loom.attention_state')).rows[0].selection_key as Buffer;
  const instance=(await f.observer.query('SELECT instance_id FROM loom.community_settings')).rows[0].instance_id as string;
  const payload=open(selection.selection,key);
  assert.deepEqual(payload,{purpose:'dismissal-selection-1',owner:r.id,instance,policy:selection.policy_version,
    meaning:{view:page.traversal.id,group:page.items[0]!.id,selection:'complete'},expires:Date.parse(selection.expires_at),
    inputs:selection.inputs.map(({kind,id,version})=>({kind,id,version}))});
  const body=f.fromSelection(selection),rawBody=JSON.stringify(body);
  const accepted=await r.client.call(endpoint+'/dismissals/state',body);
  assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.ok(Value.Check(projection==='private'?P.DismissResult:C.DismissResult,accepted.body));
  assert.equal(accepted.body.operation_state,'applied');
  assert.deepEqual(accepted.body.outcome,{inputs:body.inputs.map(v=>({...v,result_version:v.expected_version+1}))});
  const digest=createHash('sha256').update(JSON.stringify(['attention-controls-1','dismissal',body.selection,
    body.inputs.map(v=>[v.kind,v.id,v.dismissed,v.expected_version])])).digest('hex');
  assert.deepEqual((await f.observer.query('SELECT request_digest FROM loom.attention_operations WHERE participant_id=$1 AND idempotency_key=$2',[r.id,body.idempotency_key])).rows,[{request_digest:digest}]);
  // The second set's input versions remain current, but its captured policy is
  // stale. Both applied and conflict decisions must bypass opening on replay.
  const conflictBody=f.fromSelection(otherSelection),conflict=await r.client.call(endpoint+'/dismissals/state',conflictBody);
  assert.equal(conflict.status,200);assert.equal(conflict.body.operation_state,'version_conflict');
  assert.deepEqual(conflict.body.outcome,{inputs:conflictBody.inputs.map(v=>({...v,result_version:v.expected_version}))});
  const retained=await snapshot(f,r.id);forbidKey=true;
  for(const [request,result] of [[body,accepted],[conflictBody,conflict]] as const){
    const replay=await r.client.call(endpoint+'/dismissals/state',request);
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.deepEqual(replay.body,{...result.body,idempotency:'replayed',policy_version:conflict.body.policy_version});
  }
  const mismatch=await r.client.call(endpoint+'/dismissals/state',{...body,selection:seal(payload,key)});
  assert.equal(mismatch.body.error?.code,'idempotency_conflict');assert.equal(keyReads,0);
  assert.deepEqual(await snapshot(f,r.id),retained);assert.equal(JSON.stringify(body),rawBody);forbidKey=false;
  await f.mute(r.client,'artifact',a.resource_id);await f.mute(r.client,'artifact',b.resource_id);
  const first=await r.client.call(endpoint+'/list',{collection:'mutes',limit:1});assert.equal(first.status,200);
  assert.ok(Value.Check(projection==='private'?P.AttentionList:C.AttentionList,first.body));assert.ok(first.body.next_cursor);
  assert.deepEqual(open(first.body.next_cursor,key),{purpose:'attention-list-1',owner:r.id,collection:'mutes',version:first.body.policy_version,
    after:first.body.mutes[0]!.target.kind+':'+first.body.mutes[0]!.target.resource_id});
  const next=await r.client.call(endpoint+'/list',{collection:'mutes',limit:1,cursor:first.body.next_cursor});
  const all=await r.client.call(endpoint+'/list',{collection:'mutes'});
  assert.equal(next.status,200);assert.deepEqual({...next.body,mutes:[...first.body.mutes,...next.body.mutes]},all.body);
  // List formats are shared by legacy and private projections, with no instance
  // or expiry field added by payload checking.
  const sibling=await r.client.call(f.endpoint+(projection==='private'?'':'/private')+'/list',{collection:'mutes',limit:1,cursor:first.body.next_cursor});
  assert.equal(sibling.status,200);assert.deepEqual(sibling.body.mutes.map((v:{target:unknown})=>v.target),next.body.mutes.map((v:{target:unknown})=>v.target));
});
