import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {httpClient} from './participation-http.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';
import type {fixture} from './references.js';
export type FileFixture=Awaited<ReturnType<typeof fixture>>;
export async function prepareText(client:ReturnType<typeof httpClient>,target:{kind:string;resource_id:string},path='chapter.txt',bytes=Buffer.from('quartzneedle file content'),media_type='text/plain'){
  const result=await client.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target,path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type});assert.equal(result.status,201,JSON.stringify(result.body));
  const id=result.body.upload_id;
  assert.equal((await client.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes})).status,200);
  assert.equal((await client.call(`/api/v1/file-uploads/${id}/finalize`,{})).status,200);
  return {path,source:{upload_id:id as string}};
}
export async function packageText(f:FileFixture,client=f.admin,path='chapter.txt',bytes=Buffer.from('quartzneedle file content')){
  const member=await prepareText(client,{kind:'area',resource_id:f.area},path,bytes);
  const input={idempotency_key:randomUUID(),area_id:f.area,title:'Exact package',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}};
  const result=await client.call('/api/v1/artifacts',input);assert.equal(result.status,201,JSON.stringify(result.body));
  const page=await client.call(`/api/v1/artifacts/${result.body.resource_id}/revisions/${result.body.revision_id}/files`);
  const file=page.body.items[0];return {...result.body,file,base:file.download_url.slice(0,-'/download'.length),input};
}
export async function drainFiles(f:FileFixture){
  const worker=new FileTextWorker(f.database,f.fileFixture!.storage);
  const contexts=(await f.observer.query('SELECT count(*)::int AS n FROM loom.file_contexts')).rows[0].n;
  for(let i=0;i<Math.ceil(contexts/2)+26;i++){
    await worker.discover();
    for(const claim of await worker.claim())assert.equal(await worker.finalize(claim,await worker.prepare(claim)),true);
    const n=(await f.observer.query("SELECT count(*)::int AS n FROM loom.file_contexts f LEFT JOIN loom.file_text_jobs j ON j.file_id=f.id WHERE j.file_id IS NULL OR j.generation<>(SELECT generation FROM loom.file_text_state WHERE id=1) OR j.state IN ('queued','running')")).rows[0].n;
    if(!n)return worker;
  }
  throw new Error('Expected bounded file work did not drain.');
}
export async function suppressFileOwner(f:FileFixture,id:string,suppressed=true){
  const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+id)).body;
  const result=await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed,expected_version:state.version});assert.equal(result.status,200,JSON.stringify(result.body));
}
export async function sourceSnapshot(f:FileFixture){
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' AND tablename NOT LIKE 'file_text_%' AND tablename <> 'participation_rate_windows' ORDER BY tablename")).rows;
  const result:Record<string,unknown>={};
  for(const {tablename} of tables)result[tablename]=(await f.observer.query(`SELECT row_to_json(t)::text AS row FROM loom."${tablename}" t ORDER BY 1`)).rows;
  return result;
}
