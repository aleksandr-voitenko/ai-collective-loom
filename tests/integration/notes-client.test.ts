import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/moderation.js';
test('independent HTTPS client retains exact text, links and commands through client/API restart, credential replacement, conflicts and terminal deletion',{timeout:120000},async t=>{
 const f=await fixture(t),p=await f.participant('direct_notes'),a=await f.artifact(),credential=f.directory+'/credential',input=f.directory+'/input',journal=f.directory+'/create';
 async function issue(replace:string){const r=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:p.id,kind:'agent',purpose:null,label:'Direct notes',replace_credential_id:replace});assert.equal(r.status,200);await writeFile(credential,r.body.secret,{mode:0o600});return r.body.credential_id as string;}
 let credentialId=await issue(p.credential);
 const run=async(action:string,file=journal,extra:string[]=[])=>{const r=await promisify(execFile)(process.execPath,['scripts/private-notes-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credential,'--journal',file,'--action',action,...extra]);assert.ok(!r.stdout.includes('DIRECT_PRIVATE_CANARY'));return JSON.parse(r.stdout);};
 const fields={title:'DIRECT_PRIVATE_CANARY title',body:'DIRECT_PRIVATE_CANARY\r\n<script>literal</script> Ω @someone **text**',links:[{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]};
 await writeFile(input,JSON.stringify(fields));const prepared=await run('prepare',journal,['--kind','create','--input',input]),id=prepared.note_id,raw=await readFile(journal,'utf8');assert.equal((await stat(journal)).mode&0o777,0o600);assert.ok(!raw.includes((await readFile(credential,'utf8')).trim()));
 assert.equal((await run('status')).operation_state,'not_recorded');await assert.rejects(run('lose-response'),e=>(e as {code:number}).code===75);await f.restart();
 const created=await run('status');credentialId=await issue(credentialId);assert.deepEqual((await run('retry')).outcome,created.outcome);
 const output=f.directory+'/private-detail';await run('read',journal,['--note',id,'--output',output]);const detail=JSON.parse(await readFile(output,'utf8'));for(const k of ['title','body','links'] as const)assert.deepEqual(detail[k],fields[k]);
 const update=f.directory+'/update',loser=f.directory+'/conflict',query=f.directory+'/query';await writeFile(input,JSON.stringify({...fields,note_id:id,expected_version:1,body:'DIRECT_PRIVATE_CANARY changed'}));await run('prepare',update,['--kind','update','--input',input]);
 await writeFile(input,JSON.stringify({...fields,note_id:id,expected_version:1,body:'DIRECT_PRIVATE_CANARY losing draft',links:[]}));await run('prepare',loser,['--kind','update','--input',input]);const losingBytes=await readFile(loser,'utf8');
 await assert.rejects(run('lose-response',update));const updated=await run('status',update);assert.equal((await run('send',loser)).operation_state,'version_conflict');assert.equal(await readFile(loser,'utf8'),losingBytes);
 await writeFile(query,JSON.stringify({query:'changed'}));await run('query',journal,['--input',query,'--output',f.directory+'/results']);assert.equal(JSON.parse(await readFile(f.directory+'/results','utf8')).items[0].note_id,id);
 const corrected=f.directory+'/corrected';await writeFile(input,JSON.stringify({...fields,note_id:id,expected_version:2,body:'Explicit corrected text',links:[]}));await run('prepare',corrected,['--kind','update','--input',input]);assert.equal((await run('send',corrected)).current.version,3);
 assert.deepEqual((await run('retry',update)).outcome,updated.outcome);assert.equal((await run('retry',update)).current.version,3);
 const unknown=f.directory+'/unknown';await writeFile(input,JSON.stringify({...fields,note_id:id,expected_version:3,body:'Unknown older save'}));await run('prepare',unknown,['--kind','update','--input',input]);assert.equal((await run('status',unknown)).operation_state,'not_recorded');
 const deletion=f.directory+'/delete';await writeFile(input,JSON.stringify({note_id:id,expected_version:3}));await run('prepare',deletion,['--kind','delete','--input',input]);await assert.rejects(run('lose-response',deletion));await f.restart();assert.equal((await run('retry',deletion)).current.state,'deleted');
 assert.equal((await run('retry',update)).current.state,'deleted');assert.equal((await run('retry')).current.state,'deleted');await assert.rejects(run('send',unknown));assert.equal((await run('status',unknown)).operation_state,'not_recorded');assert.equal(await readFile(journal,'utf8'),raw);
 await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:p.id,credential_id:credentialId});await assert.rejects(run('status'));assert.equal(await readFile(journal,'utf8'),raw);
});
test('killed notes HTTPS process keeps durable request after COMMIT; restart resolves original outcome without body archive',{timeout:90000},async t=>{
 let hold=false,committed!:()=>void,release!:()=>void;const persisted=new Promise<void>(r=>committed=r),gate=new Promise<void>(r=>release=r);
 const f=await fixture(t,{transactionWrapper:db=>({transaction:async work=>{let wrote=false;const result=await db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{const r=await tx.query<Row>(sql,v);if(sql.startsWith('INSERT INTO loom.note_operations'))wrote=true;return r;}}));if(hold&&wrote){hold=false;committed();await gate;}return result;}})});
 const p=await f.participant('note_crash'),credential=f.directory+'/credential',input=f.directory+'/input',journal=f.directory+'/journal';const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:p.id,kind:'agent',purpose:null,label:'Crash',replace_credential_id:p.credential});await writeFile(credential,issued.body.secret,{mode:0o600});await writeFile(input,JSON.stringify({title:'',body:'CRASH_PRIVATE_CANARY',links:[]}));
 const args=['scripts/private-notes-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credential,'--journal',journal];await promisify(execFile)(process.execPath,[...args,'--action','prepare','--kind','create','--input',input]);const raw=await readFile(journal,'utf8');
 hold=true;const child=spawn(process.execPath,[...args,'--action','send'],{stdio:'ignore'}),exited=once(child,'exit');t.after(()=>{release();if(child.exitCode===null)child.kill('SIGKILL');});await persisted;child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');release();await f.restart();
 const result=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--action','status'])).stdout);assert.equal(result.operation_state,'applied');assert.ok(!JSON.stringify(result).includes('CRASH_PRIVATE_CANARY'));assert.equal(await readFile(journal,'utf8'),raw);
 assert.deepEqual(JSON.parse((await promisify(execFile)(process.execPath,[...args,'--action','retry'])).stdout).outcome,result.outcome);
});
