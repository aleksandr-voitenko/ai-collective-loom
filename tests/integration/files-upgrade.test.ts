import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,reference} from '../helpers/references.js';

test('0019 preserves populated old formats, replay identities, references, editors and private checkpoints',async t=>{
  const f=await fixture(t,{throughMigration:18}),person=await f.participant('file_upgrade'),sources=[];
  const target=await f.artifact(),ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},null,'Retain exact reference');
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3']){
    const input={idempotency_key:randomUUID(),area_id:f.area,title:format,content:{format,text:'Existing authored work',mentions:[],...(format==='loom-markdown-v1'?{}:{references:[ref]})},...(format==='loom-markdown-v3'?{change_note:{format:'loom-markdown-v2',text:'Existing note',mentions:[],references:[]},change_account:null}:{})};
    const result=await person.client.call('/api/v1/artifacts',input);assert.equal(result.status,201);sources.push({input,result:result.body});
  }
  const source=sources[2]!.result;
  assert.equal((await person.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:source.resource_id,revision_id:source.revision_id},saved:true,expected_version:0})).status,200);
  assert.equal((await person.client.call('/api/v1/me/reading/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{resource_id:source.resource_id,revision_id:source.revision_id,read:true,expected_version:0}]})).status,200);
  assert.equal((await person.client.call('/api/v1/me/following/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:source.resource_id},include_descendants:false,preferences:['artifact_revisions'],following:true,expected_version:0})).status,200);
  const checkpointResult=await person.client.call('/api/v1/shared-changes/query',{});assert.equal(checkpointResult.status,200);const checkpoint=checkpointResult.body;
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename")).rows.map(r=>r.tablename);
  // Migration 0026 adds only null target fields; actual values override defaults and all old columns remain compared.
  const digest=async(table:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT ${table==='revision_references'?"'{\"target_file_id\":null,\"target_path\":null}'::jsonb || ":''}to_jsonb(t) AS row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const table of tables)before.set(table,await digest(table));
  await f.migrate();for(const [table,value] of before)assert.equal(await digest(table),value,table+' changed during additive file migration');
  await f.restart();
  for(const {input,result} of sources){
    const replay=await person.client.call('/api/v1/artifacts',input);assert.equal(replay.status,201);assert.equal(replay.body.revision_id,result.revision_id);
    const read=await person.client.call(`/api/v1/resources/${result.resource_id}/revisions/${result.revision_id}`);assert.equal(read.status,200);assert.equal(read.body.file_set,undefined);
    const files=await person.client.call(`/api/v1/artifacts/${result.resource_id}/revisions/${result.revision_id}/files`);assert.deepEqual(files.body.items,[]);
  }
  assert.ok(checkpoint.page_cursor);{const replay=await person.client.call('/api/v1/shared-changes/query',{cursor:checkpoint.page_cursor});assert.equal(replay.status,200);assert.deepEqual(replay.body.items,checkpoint.items);}
  for(const [table,value] of before)assert.equal(await digest(table),value,table+' changed by exact old recovery and reads');
  for(const table of ['file_uploads','artifact_file_sets','file_contexts','file_publication_refusals'])assert.equal((await f.observer.query(`SELECT count(*)::int AS n FROM loom.${table}`)).rows[0].n,0);
});
