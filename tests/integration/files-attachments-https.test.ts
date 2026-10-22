import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fixture} from '../helpers/references.js';
import {httpClient} from '../helpers/participation-http.js';

test('standalone HTTPS attachment and promotion journals survive lost acknowledgements, source suppression and promoter credential replacement',async t=>{
  const f=await fixture(t,{files:true});
  async function agent(nickname:string){
    const account=await f.admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname,kind:'agent',role:'participant'});assert.equal(account.status,200);
    const issue=async(replace:string|null)=>f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.body.participant_id,kind:'agent',purpose:null,label:'Attachment direct fixture',replace_credential_id:replace});
    const issued=await issue(null);assert.equal(issued.status,200);const credential=f.directory+'/'+nickname+'-credential';await writeFile(credential,issued.body.secret,{mode:0o600});
    return {id:account.body.participant_id,credential,issued:issued.body,issue};
  }
  const alice=await agent('direct_alice'),bob=await agent('direct_bob'),bytes=Buffer.from([0,255,13,10,60,115,99,114,105,112,116,62]);
  const bytesPath=f.directory+'/bytes';await writeFile(bytesPath,bytes,{mode:0o600});
  const call=async(actor:typeof alice,action:string,journal:string,extras:string[]=[])=>{
    try{const result=await promisify(execFile)(process.execPath,['scripts/file-artifacts-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',actor.credential,'--action',action,'--journal',journal,...extras],{timeout:30000,maxBuffer:131072});return {code:0,body:JSON.parse(result.stdout)};}
    catch(error){const e=error as {code:number;stdout:string};assert.ok([1,75].includes(e.code));return {code:e.code,body:e.stdout?JSON.parse(e.stdout):undefined};}
  };
  const retain=async(actor:typeof alice,name:string,kind:string,body:unknown)=>{const input=f.directory+'/'+name+'-input',journal=f.directory+'/'+name+'-journal';await writeFile(input,JSON.stringify(body),{mode:0o600});assert.equal((await call(actor,'prepare',journal,['--kind',kind,'--input',input])).code,0);return journal;};
  const upload=await retain(alice,'upload','file.upload',{target:{kind:'opening',resource_id:f.area},path:'draft/original.bin',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'application/octet-stream'});
  assert.equal((await call(alice,'lose-response',upload,['--bytes',bytesPath])).code,75);
  await f.restart();const prepared=(await call(alice,'status',upload)).body;assert.equal(prepared.state,'prepared');
  const publication=await retain(alice,'opening','discussion.create',{area_id:f.area,title:'Direct opening',content:{format:'loom-markdown-v1',text:'Exact direct contribution',mentions:[]},attachment_set:{version:'contribution-attachments-v1',files:[{path:'draft/original.bin',source:{upload_id:prepared.upload_id}}]}});
  const publicationBytes=await readFile(publication,'utf8');assert.equal((await call(alice,'lose-response',publication)).code,75);
  const source=(await call(alice,'status',publication)).body;
  const manifest=(await f.admin.call(`/api/v1/contributions/${source.resource_id}/revisions/${source.revision_id}/attachments?prefix=draft`)).body;
  const file=manifest.items[0],output=f.directory+'/source-download';
  assert.equal((await call(bob,'download',publication,['--contribution',source.resource_id,'--revision',source.revision_id,'--file-id',file.file_id,'--output',output])).code,0);assert.deepEqual(await readFile(output),bytes);
  const promotion=await retain(bob,'promotion','attachment.promote',{source:{contribution_id:source.resource_id,revision_id:source.revision_id,file_id:file.file_id},area_id:f.other,title:'Promoted exact native bytes'});
  const exact=await readFile(promotion,'utf8');assert.equal((await call(bob,'lose-response',promotion)).code,75);
  const lifecycle=(await f.admin.call('/api/v1/admin/moderation/resources/'+manifest.discussion_id)).body;
  assert.equal((await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:lifecycle.target,suppressed:true,expected_version:lifecycle.version})).status,200);
  const replacement=await bob.issue(bob.issued.credential_id);assert.equal(replacement.status,200);await writeFile(bob.credential,replacement.body.secret,{mode:0o600});await f.restart();
  const recovered=(await call(bob,'status',promotion)).body;assert.equal(recovered.publication_state,'committed');
  const replay=(await call(bob,'send',promotion)).body;assert.equal(replay.revision_id,recovered.revision_id);assert.equal(await readFile(promotion,'utf8'),exact);assert.equal(await readFile(publication,'utf8'),publicationBytes);
  const resultManifest=(await f.admin.call(`/api/v1/artifacts/${recovered.resource_id}/revisions/${recovered.revision_id}/files?prefix=draft`)).body;
  const promotedOutput=f.directory+'/promoted-download';assert.equal((await call(bob,'download',promotion,['--artifact',recovered.resource_id,'--revision',recovered.revision_id,'--file-id',resultManifest.items[0].file_id,'--output',promotedOutput])).code,0);assert.deepEqual(await readFile(promotedOutput),bytes);
  const client=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),replacement.body.secret);
  const original=JSON.parse(exact).body;
  for(const changed of [{title:'Different'},{area_id:f.area},{source:{...original.source,revision_id:randomUUID()}},{source:{...original.source,file_id:randomUUID()}}]){
    const denied=await client.call('/api/v1/attachment-promotions',{...original,...changed});assert.equal(denied.status,409);assert.equal(denied.body.error.code,'idempotency_conflict');
  }
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind=$2',[bob.id,'attachment.promote'])).rows[0].n,1);
  assert.equal((await client.call(file.download_url)).status,404);
});
