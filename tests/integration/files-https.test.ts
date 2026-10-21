import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {fixture} from '../helpers/references.js';
import {httpClient} from '../helpers/participation-http.js';
import {NativeSearchWorker} from '../../scripts/lib/native-search-worker.js';

test('independent HTTPS metadata, same-participant credential replacement, passive download and supported suppression preserve exact results',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),account=await f.admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'file_agent',kind:'agent',role:'participant'});
  assert.equal(account.status,200);
  const issue=async(replace:string|null)=>f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.body.participant_id,kind:'agent',purpose:null,label:'File journey',replace_credential_id:replace});
  const firstCredential=await issue(null);assert.equal(firstCredential.status,200);
  const credential=f.directory+'/file-credential',input=f.directory+'/metadata.json',journal=f.directory+'/upload.json',publication=f.directory+'/publication.json',bytesFile=f.directory+'/bytes';
  await writeFile(credential,firstCredential.body.secret,{mode:0o600});const bytes=Buffer.from('<svg onload="fetch(\'https://invalid.test\')">@synthetic_admin</svg>');await writeFile(bytesFile,bytes,{mode:0o600});
  const metadata={target:{kind:'area',resource_id:f.area},path:'nested/é #?%.svg',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex').toUpperCase(),media_type:'image/svg+xml'};
  await writeFile(input,JSON.stringify(metadata),{mode:0o600});
  const client=async(action:string,journalFile=journal,extras:string[]=[])=>{
    try{const r=await promisify(execFile)(process.execPath,['scripts/file-artifacts-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credential,'--journal',journalFile,'--action',action,...extras],{timeout:30000,maxBuffer:131072});return {code:0,body:JSON.parse(r.stdout)};}
    catch(error){const e=error as {code:number;stdout:string};assert.ok([1,75].includes(e.code));return {code:e.code,body:e.stdout?JSON.parse(e.stdout):undefined};}
  };
  const snapshot=async()=>{const result:Record<string,unknown>={};for(const table of ['resources','revisions','shared_activity','outbox_intents','community_clocks','saved_items','saved_operations','reading_states','reading_operations','following_targets','following_operations','notification_claims','personal_deliveries','participant_delivery_clocks','attention_mutes','attention_dismissals','summary_coverage_sets','summary_coverage_members']){
    result[table]=(await f.observer.query(`SELECT row_to_json(t)::text AS value FROM loom.${table} t ORDER BY row_to_json(t)::text`)).rows;
  }return result;};
  const before=await snapshot();
  await client('prepare',journal,['--kind','file.upload','--input',input]);const original=await readFile(journal,'utf8');
  assert.equal((await client('lose-response',journal,['--bytes',bytesFile])).code,75);
  const replacement=await issue(firstCredential.body.credential_id);assert.equal(replacement.status,200);await writeFile(credential,replacement.body.secret,{mode:0o600});
  await f.restart();const prepared=(await client('status')).body;assert.equal(prepared.state,'prepared');assert.equal(await readFile(journal,'utf8'),original);
  assert.deepEqual(await snapshot(),before);
  await writeFile(input,JSON.stringify({area_id:f.area,title:'Searchable file package',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,
    file_set:{version:'artifact-files-v1',files:[{path:metadata.path,source:{upload_id:prepared.upload_id}}]}}));
  await client('prepare',publication,['--kind','artifact.create','--input',input]);const exact=await readFile(publication,'utf8');
  assert.equal((await client('lose-response',publication)).code,75);await f.restart();
  const committed=(await client('status',publication)).body;assert.equal(committed.publication_state,'committed');assert.equal(await readFile(publication,'utf8'),exact);
  const replay=(await client('send',publication)).body;assert.equal(replay.revision_id,committed.revision_id);
  const agent=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),replacement.body.secret);
  const manifest=(await agent.call(`/api/v1/artifacts/${committed.resource_id}/revisions/${committed.revision_id}/files?prefix=nested`)).body;
  const item=manifest.items[0],output=f.directory+'/download';const afterPublish=await snapshot();
  const downloaded=await client('download',publication,['--artifact',committed.resource_id,'--revision',committed.revision_id,'--file-id',item.file_id,'--output',output]);
  assert.equal(downloaded.body.sha256,metadata.sha256.toLowerCase());assert.deepEqual(await readFile(output),bytes);assert.deepEqual(await snapshot(),afterPublish);
  const response=await agent.call(item.download_url);assert.equal(response.status,200);assert.match(String(response.headers['content-disposition']),/^attachment/);
  assert.equal(response.headers['content-type'],'application/octet-stream');assert.match(String(response.headers['content-security-policy']),/sandbox/);
  // Supported whole-artifact lifecycle cannot clear a pre-existing exact restriction.
  const suppress=async(value:boolean)=>{const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+committed.resource_id)).body;
    const r=await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:value,expected_version:state.version});assert.equal(r.status,200);};
  await suppress(true);assert.equal((await agent.call(item.download_url)).status,404);
  assert.equal((await agent.call(`/api/v1/artifacts/${committed.resource_id}/revisions/${committed.revision_id}/files`)).status,404);
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[committed.revision_id]);await suppress(false);
  assert.equal((await agent.call(item.download_url)).status,404);
  await f.observer.query("UPDATE loom.revisions SET availability='available' WHERE id=$1",[committed.revision_id]);assert.equal((await agent.call(item.download_url)).status,200);
  const search=new NativeSearchWorker(f.configuration),notifications=new NativeSearchWorker(f.configuration,'notifications');
  t.after(()=>search.stop());t.after(()=>notifications.stop());await search.start();await notifications.start();
  const deadline=Date.now()+15000;let found=false;
  while(Date.now()<deadline){const result=await agent.call('/api/v1/search?q=Searchable');if(result.body.items?.some((v:any)=>v.source_resource_id===committed.resource_id)){found=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(found,'File-only artifact title is searchable');
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity WHERE resource_id=$1',[committed.resource_id])).rows[0].n,1);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.revision_mentions WHERE revision_id=$1',[committed.revision_id])).rows[0].n,0);
  // A direct client must distinguish a durable expiry refusal from absent or
  // unknown outcome, while retaining the exact journal for deliberate correction.
  const uploadJournal=f.directory+'/expired-upload.json',expiredJournal=f.directory+'/expired-publication.json';
  await writeFile(input,JSON.stringify({...metadata,path:'expired.svg'}));
  await client('prepare',uploadJournal,['--kind','file.upload','--input',input]);
  const expiring=(await client('send',uploadJournal,['--bytes',bytesFile])).body;
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expiring.upload_id]);
  await writeFile(input,JSON.stringify({area_id:f.area,title:'Expired package',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,
    file_set:{version:'artifact-files-v1',files:[{path:'expired.svg',source:{upload_id:expiring.upload_id}}]}}));
  await client('prepare',expiredJournal,['--kind','artifact.create','--input',input]);const expiredBytes=await readFile(expiredJournal,'utf8');
  assert.deepEqual((await client('status',expiredJournal)).body,{operation_state:'not_recorded'});
  const refusal=await client('send',expiredJournal);
  assert.deepEqual(refusal,{code:1,body:{error:{code:'file_expired',operation_outcome:'rejected'}}});
  assert.deepEqual(await client('status',expiredJournal),refusal);assert.equal(await readFile(expiredJournal,'utf8'),expiredBytes);
  assert.equal((await f.observer.query('SELECT 1 FROM loom.idempotency_records WHERE idempotency_key=$1',[JSON.parse(expiredBytes).body.idempotency_key])).rowCount,0);
});
