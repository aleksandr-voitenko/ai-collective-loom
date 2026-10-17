import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fixture } from '../helpers/references.js';
import { gates } from '../helpers/updates-gates.js';
import { barrier, blockedBy, bounded } from '../helpers/search-races.js';

const endpoint='/api/v1/me/reading';
test('native immutable HTTPS journals recover response loss, API/client restart and replacement credentials on the same participant',{timeout:90000},async t=>{
  const f=await fixture(t),agent=await f.participant('reading_native'),a=await f.artifact();
  const issue=async(replace:string|null)=>(await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:agent.id,kind:'agent',purpose:null,label:'Native reading',replace_credential_id:replace})).body;
  const credential=await issue(null);assert.ok(credential.secret);await writeFile(f.directory+'/token',credential.secret,{mode:0o600});
  const run=async(action:string,journal='read',desired=true,revision:{resource_id:string;revision_id:string}=a)=>{
    const result=await promisify(execFile)(process.execPath,['scripts/reading-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem','--action',action,
      '--journal',f.directory+'/'+journal+'.json',...(action==='prepare'||action==='lookup'?['--resource',revision.resource_id,'--revision',revision.revision_id,'--read',String(desired)]:[])],{timeout:20000});return JSON.parse(result.stdout);
  };
  await run('prepare');const original=await readFile(f.directory+'/read.json','utf8');assert.ok(!original.includes(credential.secret));
  await assert.rejects(run('lose-response'),(e:any)=>e.code===75);await f.restart();
  assert.equal((await run('status')).current[0].read,true);
  await run('prepare','unread',false);await run('send','unread');
  const replay=await run('retry');assert.equal(replay.outcome.targets[0].read,true);assert.equal(replay.current[0].read,false);assert.equal(replay.current[0].version,2);
  const newer=await f.revise(f.admin,a,'New native revision',[]);assert.equal((await run('lookup','x',false,newer)).items[0].version,0);
  const replacement=await issue(credential.credential_id);assert.ok(replacement.secret);await writeFile(f.directory+'/token',replacement.secret,{mode:0o600});
  assert.equal((await run('status')).current[0].version,2);assert.equal(await readFile(f.directory+'/read.json','utf8'),original);
  await writeFile(f.directory+'/token',credential.secret,{mode:0o600});await assert.rejects(run('status'));
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reading_operations WHERE participant_id=$1',[agent.id])).rows[0].n,2);
});

for(const boundary of ['source','revision','credential'] as const)for(const first of ['restriction','reading'] as const){
  test(`current ${boundary} guard: ${first} commits first`,{timeout:90000},async t=>{
    const control=gates(),f=await fixture(t,{transactionWrapper:control.wrapper}),reader=await f.participant('reading_guard'),a=await f.artifact();
    const body={idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{resource_id:a.resource_id,revision_id:a.revision_id,read:true,expected_version:0}]};
    let readingTransaction=false;
    const match=(sql:string,values:readonly unknown[])=>{
      if(sql.includes("set_config('transaction_timeout','15000ms',true)"))readingTransaction=true;
      return boundary==='source'?sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&values[0]===a.resource_id:
        boundary==='revision'?sql==='SELECT id FROM loom.revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE':readingTransaction&&sql.includes('FROM loom.participant_credentials WHERE id = $1 OR id = (')&&values[0]===reader.credential;
    };
    const gate=control.pause(match,first==='restriction'?'before':'after');
    const pending=reader.client.call(endpoint+'/state',body),pid=await bounded(gate.entered.promise);
    const writer=barrier<number>();
    const restriction=f.database.transaction(async tx=>{
      writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);
      if(boundary==='source')await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]);
      else if(boundary==='revision')await tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[a.revision_id]);
      else await tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[reader.credential]);
    });
    if(first==='restriction')await restriction;
    else await blockedBy(f.observer,await writer.promise,pid);
    gate.release.release();const result=await pending;await restriction;
    assert.equal(result.status,first==='reading'?200:404,JSON.stringify(result.body));
    const rows=(await f.observer.query('SELECT revision_id,is_read,version FROM loom.reading_states WHERE participant_id=$1',[reader.id])).rows;
    assert.deepEqual(rows,first==='reading'?[{revision_id:a.revision_id,is_read:true,version:1}]:[]);
    if(first==='reading'&&boundary!=='credential'){
      const replay=await reader.client.call(endpoint+'/status',{idempotency_key:body.idempotency_key});assert.equal(replay.body.current[0].availability,'unavailable');
    }
  });
}

test('native client death after COMMIT retains exact recovery and creates one outcome',{timeout:90000},async t=>{
  const committed=barrier(),release=barrier();let armed=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    const result=await database.transaction(work);
    if(armed&&result&&typeof result==='object'&&'operation_state' in result&&result.operation_state==='applied'){
      armed=false;committed.release();await bounded(release.promise);
    }
    return result;
  }})}),agent=await f.participant('reading_killed'),a=await f.artifact();
  const credential=(await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:agent.id,kind:'agent',purpose:null,label:'Killed client',replace_credential_id:null})).body;
  await writeFile(f.directory+'/token',credential.secret,{mode:0o600});
  const args=['scripts/reading-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem','--journal',f.directory+'/intent.json'];
  await promisify(execFile)(process.execPath,[...args,'--action','prepare','--resource',a.resource_id,'--revision',a.revision_id,'--read','true']);
  const journal=await readFile(f.directory+'/intent.json','utf8');armed=true;
  const child=spawn(process.execPath,[...args,'--action','send'],{stdio:'ignore'});const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try{await bounded(committed.promise);child.kill('SIGKILL');await exit;}finally{release.release();}
  await f.restart();const result=JSON.parse((await promisify(execFile)(process.execPath,[...args,'--action','retry'])).stdout);
  assert.equal(result.idempotency,'replayed');assert.equal(result.current[0].read,true);assert.equal(await readFile(f.directory+'/intent.json','utf8'),journal);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reading_operations WHERE participant_id=$1',[agent.id])).rows[0].n,1);
});
