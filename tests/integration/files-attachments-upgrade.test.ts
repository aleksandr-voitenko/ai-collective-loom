import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture} from '../helpers/updates.js';
import {plain} from '../helpers/references.js';

test('0020 preserves populated file custody, exact outcomes, refusals and private traversal semantics',async t=>{
  const f=await fixture(t,{files:true,throughMigration:19}),person=await f.participant('attachments_upgrade'),client=person.client;
  const bytes=Buffer.from('old exact native bytes'),digest=createHash('sha256').update(bytes).digest('hex');
  const uploads:any[]=[];
  for(const state of ['published','prepared','uncertain','expired']){
    const input={idempotency_key:randomUUID(),target:{kind:'area',resource_id:f.area},path:state+'.txt',size:bytes.length,sha256:digest,media_type:'text/plain'};
    const admitted=await client.call('/api/v1/file-uploads',input);assert.equal(admitted.status,201);
    const id=admitted.body.upload_id;if(state!=='uncertain')assert.equal((await client.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes})).status,200);
    else await f.fileFixture!.storage.put(id,false,bytes,{size:bytes.length,sha256:digest},AbortSignal.timeout(15000));
    if(state!=='uncertain')assert.equal((await client.call(`/api/v1/file-uploads/${id}/finalize`,{})).status,200);
    // Fixture-only interruption after a native staging write and before its database acknowledgement.
    else await f.observer.query("UPDATE loom.file_uploads SET state='uploading',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
    if(state==='expired')await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
    uploads.push({input,id,state});
  }
  const publication={idempotency_key:randomUUID(),area_id:f.area,title:'Old files',content:{format:'loom-markdown-v3',text:'Old file artifact description',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'old.txt',source:{upload_id:uploads[0].id}}]}};
  const old=(await client.call('/api/v1/artifacts',publication)).body;assert.ok(old.revision_id);
  const file=(await client.call(`/api/v1/artifacts/${old.resource_id}/revisions/${old.revision_id}/files`)).body.items[0];
  const refused={...publication,idempotency_key:randomUUID(),file_set:{version:'artifact-files-v1',files:[{path:'expired',source:{upload_id:uploads[3].id}}]}};
  assert.equal((await client.call('/api/v1/artifacts',refused)).body.error.code,'file_expired');
  const texts=[];
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3']){
    const input={idempotency_key:randomUUID(),area_id:f.area,title:format,content:{format,text:'Old opening',mentions:[],...(format==='loom-markdown-v1'?{}:{references:[]})},...(format==='loom-markdown-v3'?{change_note:null,change_account:null}:{})};
    const result=await client.call('/api/v1/discussions',input);assert.equal(result.status,201);texts.push({input,result:result.body});
  }
  await f.follow(client,f.settings('artifact',old.resource_id));
  assert.equal((await client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:old.resource_id,revision_id:old.revision_id},saved:true,expected_version:0})).status,200);
  assert.equal((await client.call('/api/v1/me/reading/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{resource_id:old.resource_id,revision_id:old.revision_id,read:true,expected_version:0}]})).status,200);
  const oldOpening=texts[0]!.result,discussion=(await client.call('/api/v1/resources/'+oldOpening.resource_id)).body.discussion_id;
  const notice=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:oldOpening.resource_id,content:{format:'loom-markdown-v1',text:'Retained personal [[mention:a]]',mentions:[{token:'a',participant_id:person.id}]}});assert.equal(notice.status,201);
  await f.drain();assert.ok((await f.page(client)).items.length>0,'Retain actual personal deliveries, not only an empty descriptor');
  const retained=[['/api/v1/shared-changes/query',await f.changes(client)],['/api/v1/me/notifications/query',await f.page(client)],['/api/v1/me/updates/query',await f.ready(client,{selection:'complete'})]] as const;
  const columns=(await f.observer.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='loom' ORDER BY table_name,ordinal_position")).rows;
  const tables=new Map<string,string[]>();for(const {table_name,column_name} of columns)tables.set(table_name,[...(tables.get(table_name)??[]),column_name]);
  const rows=async(table:string,columns:string[])=>JSON.stringify((await f.observer.query(`SELECT jsonb_build_array(${columns.map(c=>'"'+c+'"').join(',')}) AS row FROM loom."${table}" ORDER BY 1`)).rows);
  const before=new Map<string,string>();for(const [table,columns] of tables)before.set(table,await rows(table,columns));
  await f.migrate();await f.restart();
  for(const [table,columns] of tables)assert.equal(await rows(table,columns),before.get(table),table+' old column values changed');
  assert.equal((await client.call('/api/v1/artifacts',publication)).body.revision_id,old.revision_id);
  assert.equal((await client.call(file.download_url)).body,bytes.toString());
  for(const {input,result} of texts){assert.equal((await client.call('/api/v1/discussions',input)).body.revision_id,result.revision_id);assert.equal((await client.call(`/api/v1/resources/${result.resource_id}/revisions/${result.revision_id}`)).body.attachment_set,undefined);}
  assert.equal((await client.call('/api/v1/operations/status',{operation_kind:'artifact.create',idempotency_key:refused.idempotency_key})).body.error.code,'file_expired');
  const {file_set:_,...without}=refused;assert.equal((await client.call('/api/v1/artifacts',without)).body.error.code,'idempotency_conflict');
  const semantic=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,v)=>key.endsWith('_cursor')||key==='checkpoint'?undefined:v));
  for(const [path,page] of retained){assert.ok(page.page_cursor);const replay=await client.call(path,{cursor:page.page_cursor});assert.equal(replay.status,200);for(const field of ['items','stage','selection','traversal','interval_complete','grouped_interval_complete','baseline_established'])if(field in page)assert.deepEqual(semantic(replay.body[field]),semantic((page as any)[field]),path+' '+field);}
  for(const [table,columns] of tables)assert.equal(await rows(table,columns),before.get(table),table+' changed during old reads/replays');
  for(const upload of uploads)assert.equal((await client.call('/api/v1/file-uploads',upload.input)).body.upload_id,upload.id);
  assert.equal((await client.call(`/api/v1/file-uploads/${uploads[1].id}/finalize`,{})).body.state,'prepared');
  assert.equal((await client.call(`/api/v1/file-uploads/${uploads[2].id}/bytes`,undefined,{bytes})).body.state,'staged');
  assert.equal((await client.call(`/api/v1/file-uploads/${uploads[2].id}/finalize`,{})).body.state,'prepared');
  const fresh=await client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'New envelope',content:plain('Post-upgrade contribution'),attachment_set:{version:'contribution-attachments-v1',files:[]}});assert.equal(fresh.status,201);
});
