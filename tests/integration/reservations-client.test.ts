import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/moderation.js';
import {reservationSnapshot as sourceSnapshot} from '../helpers/reservations.js';
const base='/api/v1/editing-intent';
test('independent durable HTTPS client survives lost outcomes, process/API restart and credential replacement without rewriting request bytes',{timeout:120000},async t=>{
  const f=await fixture(t),p=await f.participant('direct_intent'),a=await f.artifact(p.client),credential=f.directory+'/intent-credential',input=f.directory+'/intent-input',journal=f.directory+'/announce-journal';
  async function issue(replace:string){const r=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:p.id,kind:'agent',purpose:null,label:'Direct intent',replace_credential_id:replace});assert.equal(r.status,200);await writeFile(credential,r.body.secret,{mode:0o600});return r.body.credential_id as string;}
  let credentialId=await issue(p.credential);
  const run=async(action:string,file=journal,extra:string[]=[])=>{
    const r=await promisify(execFile)(process.execPath,['scripts/editing-intent-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credential,'--journal',file,'--action',action,...extra]);return JSON.parse(r.stdout);
  };
  await writeFile(input,JSON.stringify({resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Independent client',scope:{kind:'whole'}}));
  await run('prepare',journal,['--kind','announce','--input',input]);const raw=await readFile(journal,'utf8');assert.equal((await stat(journal)).mode&0o777,0o600);
  assert.ok(!raw.includes((await readFile(credential,'utf8')).trim()));
  await assert.rejects(run('lose-response'),e=>(e as {code:number}).code===75);
  await f.restart();const first=await run('status');assert.equal(first.current.state,'active');
  credentialId=await issue(credentialId);assert.ok(credentialId);assert.deepEqual((await run('retry')).outcome,first.outcome);
  const renewJournal=f.directory+'/renew-journal';await writeFile(input,JSON.stringify({notice_id:first.current.notice_id,expected_version:first.current.version,duration_minutes:1}));
  await run('prepare',renewJournal,['--kind','renew','--input',input]);const renewRaw=await readFile(renewJournal,'utf8');await assert.rejects(run('lose-response',renewJournal));
  const renewed=await run('status',renewJournal),releaseJournal=f.directory+'/release-journal';
  await writeFile(input,JSON.stringify({notice_id:renewed.current.notice_id,expected_version:renewed.current.version}));await run('prepare',releaseJournal,['--kind','release','--input',input]);
  assert.equal((await run('send',releaseJournal)).current.state,'released');
  assert.equal((await run('retry',journal)).current.state,'released');assert.deepEqual((await run('retry',renewJournal)).outcome,renewed.outcome);
  const output=f.directory+'/notice-result';await run('inspect',journal,['--resource',a.resource_id,'--limit','1','--output',output]);assert.equal(JSON.parse(await readFile(output,'utf8')).items[0].purpose,'Independent client');
  assert.equal(await readFile(journal,'utf8'),raw);assert.equal(await readFile(renewJournal,'utf8'),renewRaw);
  const foreign=await f.participant('foreign_direct');const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:foreign.id,kind:'agent',purpose:null,label:'Other',replace_credential_id:foreign.credential});
  await writeFile(credential,issued.body.secret);await assert.rejects(run('retry'));assert.equal(await readFile(journal,'utf8'),raw);
});

test('reservation state, counters and immutable outcomes roll back atomically on insertion failure',{timeout:90000},async t=>{
  let fail=false;
  const f=await fixture(t,{transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,v);if(fail&&sql.startsWith('INSERT INTO loom.editing_intent_operations'))throw new Error('rollback');return result;
  }}))})});
  const a=await f.artifact(),body={idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Atomic intent',scope:{kind:'whole'}};
  const before=await sourceSnapshot(f);fail=true;assert.equal((await f.admin.call(base+'/announce',body)).status,503);assert.deepEqual(await sourceSnapshot(f),before);
  fail=false;assert.equal((await f.admin.call(base+'/announce',body)).status,200);
});


test('killed HTTPS client retains durable intent after the database commits without delivering its response',{timeout:90000},async t=>{
  let hold=false,committed!:()=>void,release!:()=>void;
  const persisted=new Promise<void>(resolve=>{committed=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(t,{transactionWrapper:db=>({transaction:async work=>{
    let wrote=false;
    const result=await db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{
      const r=await tx.query<Row>(sql,v);if(sql.startsWith('INSERT INTO loom.editing_intent_operations'))wrote=true;return r;
    }}));
    if(hold&&wrote){hold=false;committed();await gate;}return result;
  }})});
  const p=await f.participant('crash_client'),a=await f.artifact(p.client),credential=f.directory+'/crash-credential',input=f.directory+'/crash-input',journal=f.directory+'/crash-journal';
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:p.id,kind:'agent',purpose:null,label:'Crash test',replace_credential_id:p.credential});
  await writeFile(credential,issued.body.secret,{mode:0o600});await writeFile(input,JSON.stringify({resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Crash recovery',scope:{kind:'whole'}}));
  const args=['scripts/editing-intent-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',credential,'--journal',journal];
  await promisify(execFile)(process.execPath,[...args,'--action','prepare','--kind','announce','--input',input]);const raw=await readFile(journal,'utf8');
  hold=true;const child=spawn(process.execPath,[...args,'--action','send'],{stdio:'ignore'}),exited=once(child,'exit');
  t.after(()=>{release();if(child.exitCode===null)child.kill('SIGKILL');});
  await persisted;child.kill('SIGKILL');const [,signal]=await exited;assert.equal(signal,'SIGKILL');release();
  await f.restart();const result=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--action','status'])).stdout);
  assert.equal(result.operation_state,'recorded');assert.equal(result.current.state,'active');assert.equal(await readFile(journal,'utf8'),raw);
  const retry=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--action','retry'])).stdout);assert.deepEqual(retry.outcome,result.outcome);
});
