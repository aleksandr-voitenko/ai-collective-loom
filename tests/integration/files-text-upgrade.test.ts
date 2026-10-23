import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/references.js';
import {prepareText,sourceSnapshot,drainFiles} from '../helpers/file-text.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';
import {SearchWorker} from '../../src/server/modules/search/worker.js';

test('0021 preserves populated source/native/attempt tables and authored traversal while bounded discovery catches later publications',{timeout:120000},async t=>{
  let stage='setup';try{
  const f=await fixture(t,{files:true,throughMigration:20});
  const member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'retained.txt');
  const publish=async(title:string,count:number)=>{
    const input={idempotency_key:randomUUID(),area_id:f.area,title,content:{format:'loom-markdown-v3',text:'Existing authored baseline',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:Array.from({length:count},(_,i)=>({...member,path:'file-'+i+'.txt'}))}};
    const result=await f.admin.call('/api/v1/artifacts',input);assert.equal(result.status,201,JSON.stringify(result.body));return {input,...result.body};
  };
  const first=await publish('Baseline one',16),second=await publish('Baseline two',16);
  const text=new SearchWorker(f.database);for(let i=0;i<5;i++)await text.tick();
  const authored=(await f.admin.call('/api/v1/search?q=baseline&limit=1')).body;assert.ok(authored.next_cursor);
  stage='migration';const before=await sourceSnapshot(f);await f.migrate();assert.deepEqual(await sourceSnapshot(f),before);
  const worker=new FileTextWorker(f.database,f.fileFixture!.storage);
  assert.equal(await worker.discover(),25);assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_jobs')).rows[0].n,25);
  stage='later publication';const later=await publish('Later current',1);
  assert.equal(await worker.discover(),8);assert.equal(await worker.discover(),0);
  stage='processing';const beforeProcessing=await sourceSnapshot(f);await drainFiles(f);assert.deepEqual(await sourceSnapshot(f),beforeProcessing);
  stage='file pages';const results=(await f.admin.call('/api/v1/search/files?q=quartzneedle&limit=25')).body;assert.equal(results.items.length,25);assert.ok(results.next_cursor);
  const next=(await f.admin.call('/api/v1/search/files?q=quartzneedle&limit=25&cursor='+encodeURIComponent(results.next_cursor))).body;assert.equal(next.items.length,8);
  assert.equal(new Set([...results.items,...next.items].map((r:any)=>r.file_id)).size,33);
  // Migration/derivative work did not change an existing authored traversal. A
  // later publication does change its original source boundary, as before.
  assert.equal((await f.admin.call('/api/v1/search?q=baseline&cursor='+encodeURIComponent(authored.next_cursor))).body.error.code,'search_changed');
  stage='old replay';assert.equal((await f.admin.call('/api/v1/artifacts',first.input)).body.revision_id,first.revision_id);
  assert.equal((await f.admin.call('/api/v1/artifacts',second.input)).body.revision_id,second.revision_id);
  const baseline=(await f.admin.call('/api/v1/search?q=baseline&limit=1')).body;
  stage='rebuild';await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:1});await drainFiles(f);
  assert.equal((await f.admin.call('/api/v1/search?q=baseline&cursor='+encodeURIComponent(baseline.next_cursor))).status,200,'Files rebuild does not invalidate authored search');
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n,33);
  assert.ok(later.revision_id);
  }catch(error){throw new Error('File upgrade stage: '+stage,{cause:error});}
});
