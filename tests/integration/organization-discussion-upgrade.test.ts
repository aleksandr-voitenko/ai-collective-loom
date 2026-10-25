import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture,organization} from '../helpers/organization.js';
import {reservationSnapshot as snapshot} from '../helpers/reservations.js';
import {prepareText} from '../helpers/file-text.js';
import {createNote,accepted} from '../helpers/notes.js';

test('populated 0023 to 0024 upgrade preserves every old row, exact bytes, flags and retained organization/publication decisions',{timeout:120000},async t=>{
 const f=await fixture(t,{files:true,throughMigration:23}),d=await f.discussion(),c=await f.reply(d),s=await f.create(d.id);
 const member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'closure-baseline.txt');
 const body={idempotency_key:randomUUID(),area_id:f.area,title:'Retained file',content:{format:'loom-markdown-v3',text:'Retained prose',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}};
 const a=(await f.admin.call('/api/v1/artifacts',body)).body;
 const manifest=(await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${a.revision_id}/files`)).body;
 const bytes=(await f.admin.call(manifest.items[0].download_url)).body;assert.equal(bytes,'quartzneedle file content');
 const old=await f.organizationCommand(d.id,'discussion.move',{parent_id:f.other}),decision=await f.organize(old);
 await f.follow(f.admin,f.settings('discussion',d.id));
 await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:c.resource_id,revision_id:c.revision_id},saved:true,expected_version:0});
 for(const target of [d.opening,c,s,a])await accepted(f.admin,'create',createNote([{kind:target===s?'summary':target===a?'artifact':'contribution',resource_id:target.resource_id,revision_id:target.revision_id}]));
 await f.admin.call('/api/v1/editing-intent/announce',{idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Retained intent',scope:{kind:'whole'}});
 // Existing local flags may already be closed even though the old public command
 // family could only close areas. The upgrade must preserve those imported facts.
 await f.observer.query('UPDATE loom.resources SET publication_open=false WHERE id=$1',[d.id]);
 const before=await snapshot(f);await f.migrate(24);assert.deepEqual(await snapshot(f),before);await f.migrate(24);assert.deepEqual(await snapshot(f),before);
 assert.equal((await f.organizationState(d.id)).local_open,false);
 const replay=await f.organize(old);assert.deepEqual(replay.outcome,decision.outcome);assert.equal(replay.current.local_open,false);
 assert.equal((await f.admin.call('/api/v1/artifacts',body)).body.revision_id,a.revision_id);
 assert.deepEqual((await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${a.revision_id}/files`)).body,manifest);assert.equal((await f.admin.call(manifest.items[0].download_url)).body,bytes);
 assert.deepEqual(await snapshot(f),before,'Read/replay does not rewrite old records');
 await f.closeDiscussion(d.id,false);assert.equal((await f.organizationState(d.id)).publication_open,true);
});

test('standalone HTTPS close/open journals survive process/API restart and replacement credentials without replaying K1',{timeout:120000},async t=>{
 const f=await fixture(t),p=await f.participant('closure_client'),d=await f.discussion();
 await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:'active',role:'administrator'});
 const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:p.id,kind:'agent',purpose:null,label:'Closure client',replace_credential_id:p.credential});assert.equal(credential.status,200);
 const credentialFile=f.directory+'/organization-credential',journal=f.directory+'/closure-journal',inputFile=f.directory+'/closure-input';
 await writeFile(credentialFile,credential.body.secret,{mode:0o600});
 const input=await f.organizationCommand(d.id);await writeFile(inputFile,JSON.stringify(input));
 const exec=promisify(execFile),base=['scripts/organization-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credentialFile];
 const run=async(action:string,extra:string[]=[],file=journal)=>JSON.parse((await exec(process.execPath,[...base,'--journal',file,'--action',action,...extra])).stdout);
 await run('prepare',['--input',inputFile]);const raw=await readFile(journal,'utf8');assert.equal((await stat(journal)).mode&0o777,0o600);
 assert.equal((await run('status')).operation_state,'not_recorded');assert.equal((await f.organizationState(d.id)).local_open,true);
 await assert.rejects(run('lose-response'),(e:any)=>e.code===75);await f.restart();
 const original=await run('status');assert.equal(original.outcome.local_open,false);
 const reopenInput=f.directory+'/reopen-input',reopenJournal=f.directory+'/reopen-journal';
 await writeFile(reopenInput,JSON.stringify(await f.organizationCommand(d.id,'discussion.open')));
 await run('prepare',['--input',reopenInput],reopenJournal);const reopenRaw=await readFile(reopenJournal,'utf8');
 assert.equal((await run('send',[],reopenJournal)).current.local_open,true);
 const replacement=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:p.id,kind:'agent',purpose:null,label:'Replacement closure client',replace_credential_id:credential.body.credential_id});assert.equal(replacement.status,200);
 await assert.rejects(run('retry'));await writeFile(credentialFile,replacement.body.secret,{mode:0o600});
 const retry=await run('retry');assert.deepEqual(retry.outcome,original.outcome);assert.equal(retry.current.local_open,true);assert.equal(await readFile(journal,'utf8'),raw);assert.equal(await readFile(reopenJournal,'utf8'),reopenRaw);
 assert.equal((await run('inspect',['--resource',d.id])).local_open,true);
 await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:'active',role:'participant'});await assert.rejects(run('status'));
 assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.organization_operations WHERE idempotency_key=$1',[input.idempotency_key])).rows[0].n,1);
 assert.equal((await f.admin.call(organization+'/status',{kind:input.kind,idempotency_key:input.idempotency_key})).body.operation_state,'not_recorded','Recovery is participant-scoped');
});
