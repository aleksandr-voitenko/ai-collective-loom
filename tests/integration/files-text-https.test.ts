import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fixture,plain} from '../helpers/references.js';
import {prepareText,drainFiles,suppressFileOwner,sourceSnapshot} from '../helpers/file-text.js';
import {httpClient} from '../helpers/participation-http.js';

test('independent HTTPS status, exact text pages and Files query survive API restart and legitimate credential replacement',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),account=(await f.admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'literal_client',kind:'agent',role:'participant'})).body;
  const issue=(replace:string|null)=>f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.participant_id,kind:'agent',purpose:null,label:'Literal direct client',replace_credential_id:replace});
  const issued=(await issue(null)).body,credential=f.directory+'/credential',input=f.directory+'/query.json',journal=f.directory+'/unchanged-journal';
  await writeFile(credential,issued.secret,{mode:0o600});await writeFile(input,JSON.stringify({q:'directneedle',limit:'1'}),{mode:0o600});await writeFile(journal,'private unrelated exact intent\n',{mode:0o600});
  const client=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),issued.secret);
  const bytes=Buffer.from('\ufeffdirectneedle <script>never()</script>\r\n'+'雪'.repeat(8000));
  const member=await prepareText(client,{kind:'opening',resource_id:f.area},'direct.md',bytes,'text/markdown');
  const source=(await client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Standalone source',content:plain('Opening'),attachment_set:{version:'contribution-attachments-v1',files:[member]}})).body;
  const file=(await client.call(`/api/v1/contributions/${source.resource_id}/revisions/${source.revision_id}/attachments`)).body.items[0];
  const promoted=(await client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:source.resource_id,revision_id:source.revision_id,file_id:file.file_id},area_id:f.other,title:'Independent direct copy'})).body;
  const artifactFile=(await client.call(`/api/v1/artifacts/${promoted.resource_id}/revisions/${promoted.revision_id}/files`)).body.items[0];
  let outputs=0;
  const call=async(action:string,extras:string[])=>{
    const output=f.directory+'/result-'+outputs++;
    try{const result=await promisify(execFile)(process.execPath,['scripts/file-artifacts-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credential,'--journal',journal,'--action',action,'--output',output,...extras],{timeout:30000,maxBuffer:131072});assert.ok(!result.stdout.includes('<script>'));return {code:0,body:JSON.parse(await readFile(output,'utf8')),receipt:JSON.parse(result.stdout)};}
    catch(error){const e=error as {code:number;stdout:string};assert.equal(e.code,1);await assert.rejects(readFile(output),{code:'ENOENT'});return {code:1,body:JSON.parse(e.stdout),receipt:null};}
  };
  const exact=['--contribution',source.resource_id,'--revision',source.revision_id,'--file-id',file.file_id];
  assert.equal((await call('text-status',exact)).body.processing,'not_discovered');await drainFiles(f);
  const before=await sourceSnapshot(f),page=(await call('text-preview',exact)).body;assert.equal(page.file_id,file.file_id);assert.ok(page.next_cursor);assert.match(page.text,/directneedle/);
  let text=page.text,next=page.next_cursor;while(next){const value=(await call('text-preview',[...exact,'--cursor',next])).body;text+=value.text;next=value.next_cursor;}assert.equal(text,bytes.toString());
  const results=(await call('files-search',['--input',input])).body;assert.equal(results.items.length,1);assert.ok(results.next_cursor);
  const successor=(await call('files-search',['--input',input,'--cursor',results.next_cursor])).body;assert.equal(successor.items.length,1);assert.notEqual(successor.items[0].file_id,results.items[0].file_id);
  assert.deepEqual(await sourceSnapshot(f),before);assert.equal(await readFile(journal,'utf8'),'private unrelated exact intent\n');
  const replacement=(await issue(issued.credential_id)).body;await writeFile(credential,replacement.secret,{mode:0o600});await f.restart();
  assert.equal((await call('text-status',exact)).body.processing,'complete');assert.equal((await call('text-preview',[...exact,'--cursor',page.next_cursor])).body.error.code,'search_changed','Restart requires an explicit new text traversal');
  assert.equal((await call('text-preview',exact)).body.text,page.text);
  const discussion=(await f.admin.call('/api/v1/resources/'+source.resource_id)).body.discussion_id;await suppressFileOwner(f,discussion);
  assert.equal((await call('text-status',exact)).body.error.code,'unavailable');assert.equal((await call('text-preview',exact)).code,1);
  const independent=['--artifact',promoted.resource_id,'--revision',promoted.revision_id,'--file-id',artifactFile.file_id];
  assert.equal((await call('text-preview',independent)).body.text,page.text);assert.equal((await call('files-search',['--input',input])).body.items[0].file_id,artifactFile.file_id);
  await suppressFileOwner(f,promoted.resource_id);assert.equal((await call('text-preview',independent)).code,1);
  assert.equal(await readFile(journal,'utf8'),'private unrelated exact intent\n');
});
