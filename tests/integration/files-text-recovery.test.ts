import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DeleteObjectCommand} from '@aws-sdk/client-s3';
import {fixture} from '../helpers/references.js';
import {packageText,sourceSnapshot} from '../helpers/file-text.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';
import {NativeSearchWorker} from '../../scripts/lib/native-search-worker.js';
import {barrier,bounded} from '../helpers/search-races.js';
import {prepareText} from '../helpers/file-text.js';
import {randomUUID} from 'node:crypto';
import {fileLimits} from '../../src/contracts/files.js';

test('native storage loss, retry exhaustion, exact-version refusal and derived capacity stay honest',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),p=await packageText(f),worker=new FileTextWorker(f.database,f.fileFixture!.storage);
  await worker.discover();await f.fileFixture!.stop();
  try{for(let n=1;n<=3;n++){
    const claim=(await worker.claim(1))[0]!;assert.ok(claim);assert.equal(await worker.process(claim),false);
    const row=(await f.observer.query('SELECT state,attempts,reason FROM loom.file_text_jobs WHERE file_id=$1',[p.file.file_id])).rows[0];
    assert.deepEqual(row,{state:n===3?'failed':'queued',attempts:n,reason:'storage'});
    await f.observer.query('UPDATE loom.file_text_jobs SET due_at=clock_timestamp() WHERE file_id=$1',[p.file.file_id]);
  }}finally{await f.fileFixture!.start();}
  assert.equal((await f.admin.call(p.base+'/text')).body.processing,'failed');
  const health=(await f.admin.call('/api/v1/admin/file-text/health')).body;assert.equal(health.items.length,1);assert.equal(health.reserved_bytes,0);
  const body={file_id:p.file.file_id,claim_generation:health.items[0].claim_generation};
  for(let n=0;n<2;n++)assert.equal((await f.admin.call('/api/v1/admin/file-text/retry',body)).status,200);
  assert.equal(await worker.process((await worker.claim(1))[0]!),true);
  assert.equal((await f.admin.call('/api/v1/admin/file-text/retry',body)).status,200,'Old exact retry is a convergent no-op after worker progress');
  assert.equal((await f.admin.call(p.base+'/text')).body.processing,'complete');
  const missing=await packageText(f,f.admin,'missing.txt');await worker.discover();
  const input=(await f.observer.query('SELECT u.* FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id WHERE f.id=$1',[missing.file.file_id])).rows[0];
  await f.fileFixture!.storage.client.send(new DeleteObjectCommand({Bucket:f.fileFixture!.storage.configuration.finalBucket,Key:f.fileFixture!.storage.key(input.id),VersionId:input.final_version}));
  const newer=await f.fileFixture!.storage.put(input.id,true,Buffer.from('quartzneedle file content'),input,AbortSignal.timeout(15000));assert.notEqual(newer,input.final_version);
  assert.equal(await worker.process((await worker.claim(1))[0]!),false,'A verified newer version never substitutes for the pinned missing one');
  assert.equal((await f.admin.call(missing.base+'/text')).body.reason,'storage');
  assert.equal((await f.admin.call(missing.file.download_url)).body.error.code,'file_storage_unavailable');
  const cap=await packageText(f,f.admin,'capacity.txt');await worker.discover();
  await f.observer.query('UPDATE loom.file_text_state SET retained_bytes=33554432 WHERE id=1');
  assert.deepEqual(await worker.claim(2),[]);
  assert.equal((await f.admin.call(cap.base+'/text')).body.reason,'derived_capacity');
  await f.observer.query('UPDATE loom.file_text_state SET retained_bytes=(SELECT COALESCE(sum(octet_length(body)),0) FROM loom.file_text_documents) WHERE id=1');
  const person=await f.participant('non_admin_files');assert.equal((await person.client.call('/api/v1/admin/file-text/health')).status,403);
  assert.equal((await person.client.call('/api/v1/admin/file-text/retry',body)).status,403);
  assert.equal((await person.client.call('/api/v1/admin/file-text/rebuild',{expected_generation:1})).status,403);
  assert.equal((await f.admin.call('/api/v1/admin/file-text/retry',{...body,claim_generation:9999})).body.error.code,'search_changed');
  assert.equal((await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:9999})).body.error.code,'search_changed');
});

test('a stalled exact native download returns bounded storage failure without resetting HTTPS',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),p=await packageText(f),storage=f.fileFixture!.storage;
  const before=await sourceSnapshot(f),read=storage.read.bind(storage),entered=barrier(),aborted=barrier(),prepared=barrier(),release=barrier();let calls=0;
  storage.read=async(...args)=>{
    if(++calls===2){const bytes=await read(...args);prepared.release();await release.promise;return bytes;}
    entered.release();
    await new Promise<void>((_resolve,reject)=>{
      const signal=args[4];
      if(signal.aborted){aborted.release();reject(signal.reason);return;}
      signal.addEventListener('abort',()=>{aborted.release();reject(signal.reason);},{once:true});
    });
    return read(...args);
  };
  try{
    const started=Date.now(),pending=Promise.all([f.admin.call(p.file.download_url),f.admin.call(p.file.download_url)]);
    await bounded(Promise.all([entered.promise,prepared.promise]));
    for(const response of await pending){
      assert.equal(response.status,503);assert.equal(response.body.error.code,'file_storage_unavailable');
      assert.equal(response.body.error.recovery.action,'retry_same_request');
      assert.equal(response.headers['content-type'],'application/json; charset=utf-8');
      assert.ok(!JSON.stringify(response.body).includes('quartzneedle'),'A late verified buffer cannot replace the deadline failure');
    }
    assert.ok(Date.now()-started<fileLimits.transferMs+2000,'The existing transfer deadline still bounds the response');
    release.release();await bounded(aborted.promise);assert.equal(calls,2,'Do not replay either native read');
  }finally{release.release();storage.read=read;}
  assert.deepEqual(await sourceSnapshot(f),before);
  assert.equal((await f.admin.call(p.base+'/text')).body.processing,'not_discovered');
  assert.deepEqual((await f.admin.call(p.file.download_url)).body,'quartzneedle file content','The failed transfers release admission for an explicit exact later read');
});

test('leases, stale claims, rebuild and lost COMMIT acknowledgement fence output without changing sources',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),p=await packageText(f),worker=new FileTextWorker(f.database,f.fileFixture!.storage);
  await worker.discover();const claim=(await worker.claim(1))[0]!,prepared=await worker.prepare(claim);
  assert.equal(await worker.renew(claim),true);
  await f.observer.query("UPDATE loom.file_text_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE file_id=$1",[claim.file_id]);
  assert.equal(await worker.renew(claim),false);assert.equal(await worker.finalize(claim,prepared),false);assert.equal(await worker.fail(claim),false);
  const replacement=(await worker.claim(1))[0]!;assert.ok(replacement.claim_generation>claim.claim_generation);assert.equal(await worker.process(replacement),true);assert.equal(await worker.finalize(claim,prepared),false);
  const first=(await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:1})).body;assert.deepEqual(first,{generation:2});
  assert.deepEqual((await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:1})).body,first);
  assert.equal((await f.admin.call(p.base+'/text')).body.processing,'not_discovered');
  await worker.discover();const old=(await worker.claim(1))[0]!,oldPrepared=await worker.prepare(old);
  assert.equal((await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:2})).status,200);assert.equal(await worker.finalize(old,oldPrepared),false);
  let lose=true;
  const wrapped={transaction:async<T>(work:(tx:import('../../src/server/db/postgres.js').SqlTransaction)=>Promise<T>)=>{
    let wrote=false;const result=await f.database.transaction(tx=>work({query:async(sql,values)=>{if(sql.startsWith('INSERT INTO loom.file_text_documents'))wrote=true;return tx.query(sql,values);}}));
    if(wrote&&lose){lose=false;throw new Error('Lost acknowledgement after actual COMMIT');}return result;
  }};
  const lost=new FileTextWorker(wrapped,f.fileFixture!.storage);await lost.discover();const fresh=(await lost.claim(1))[0]!;
  const before=await sourceSnapshot(f);assert.equal(await lost.process(fresh),false);
  assert.equal((await f.admin.call(p.base+'/text')).body.processing,'complete');assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n,1);
  assert.deepEqual(await sourceSnapshot(f),before);assert.deepEqual(await worker.claim(),[]);
  assert.throws(()=>worker.claim(3));assert.throws(()=>worker.claim(0));
  // Expired third attempts release their retained reservation without resurrection.
  await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:3});await worker.discover();const exhausted=(await worker.claim(1))[0]!;
  await f.observer.query("UPDATE loom.file_text_jobs SET attempts=3,lease_until=clock_timestamp()-interval '1 second' WHERE file_id=$1",[exhausted.file_id]);
  assert.deepEqual(await worker.claim(),[]);assert.equal((await f.admin.call(p.base+'/text')).body.reason,'lease_expired');assert.equal((await f.admin.call('/api/v1/admin/file-text/health')).body.reserved_bytes,0);
});

test('file leases cannot resurrect across unchanged native job-lock waits',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),p=await packageText(f),worker=new FileTextWorker(f.database,f.fileFixture!.storage);await worker.discover();
  const holder=(await f.observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  for(const operation of ['renew','fail','finalize'] as const){
    const claim=(await worker.claim(1))[0]!;assert.ok(claim);const prepared=await worker.prepare(claim);
    await f.observer.query('BEGIN');let pending:Promise<boolean>|undefined;
    try{
      await f.observer.query("UPDATE loom.file_text_jobs SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE file_id=$1",[claim.file_id]);
      pending=operation==='renew'?worker.renew(claim):operation==='fail'?worker.fail(claim):worker.finalize(claim,prepared);
      const end=Date.now()+1000;let blocked=false;while(Date.now()<end){if((await f.observer.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[holder])).rowCount){blocked=true;break;}}assert.ok(blocked,'Observe the worker waiting for the unchanged native job row');
      await f.observer.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM lease_until-clock_timestamp()))::double precision+0.02) FROM loom.file_text_jobs WHERE file_id=$1',[claim.file_id]);
      await f.observer.query('COMMIT');assert.equal(await pending,false);
    }catch(error){await f.observer.query('ROLLBACK');await pending?.catch(()=>{});throw error;}
  }
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n,0);
  assert.deepEqual(await worker.claim(),[]);assert.equal((await f.admin.call(p.base+'/text')).body.reason,'lease_expired');
});

test('two file processors admit before queued database work and a third cannot allocate input',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),member=await prepareText(f.admin,{kind:'area',resource_id:f.area});
  const published=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Admission',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[0,1,2].map(n=>({...member,path:n+'.txt'}))}});assert.equal(published.status,201);
  let gated=false,arrived=0,transactions=0;const entered=barrier(),release=barrier();
  const wrapped={transaction:<T>(work:(tx:import('../../src/server/db/postgres.js').SqlTransaction)=>Promise<T>)=>{transactions++;return f.database.transaction(tx=>work({query:async(sql,values)=>{if(gated&&sql.startsWith('SELECT f.id AS file_id')){arrived++;if(arrived===2)entered.release();await release.promise;}return tx.query(sql,values);}}));}};
  const worker=new FileTextWorker(wrapped,f.fileFixture!.storage);await worker.discover();const claims=await worker.claim(2),third=(await worker.claim(1))[0]!;gated=true;
  const first=worker.process(claims[0]!),second=worker.process(claims[1]!);
  try{await bounded(entered.promise);const before=transactions;assert.equal(await worker.process(third),false);assert.equal(transactions,before,'A third processor never enters the database/input boundary');assert.equal(await worker.tick(),0);}
  finally{gated=false;release.release();}assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n,2);assert.equal(await worker.process(third),true);
});

for(const phase of ['prepared','before_commit','after_commit'])test('native file worker death at '+phase+' recovers without duplicate output',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),p=await packageText(f),c=f.configuration;
  const child=fork(fileURLToPath(new URL('../fixtures/file-text-worker.ts',import.meta.url)),[phase],{execArgv:['--import','tsx'],env:{...process.env,LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password,LOOM_FILE_STORAGE:JSON.stringify(f.fileFixture!.storage.configuration)},stdio:['ignore','ignore','ignore','ipc']});
  const reached=barrier<void>();let stage='';child.on('message',(message:any)=>{if(message.stage===phase||message.stage==='failed'){stage=message.stage;reached.release();}});
  const exit=new Promise<void>(resolve=>child.once('close',()=>resolve()));t.after(async()=>{child.kill('SIGKILL');await exit;});
  await bounded(reached.promise);assert.equal(stage,phase);child.kill('SIGKILL');await exit;
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n,phase==='after_commit'?1:0);
  await f.observer.query("UPDATE loom.file_text_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE state='running'");
  await f.restart();const native=new NativeSearchWorker(f.configuration,'file-text',f.fileFixture!.storage.configuration);t.after(()=>native.stop());await native.start();
  await native.observeUntil(async()=>(await f.observer.query("SELECT state FROM loom.file_text_jobs WHERE file_id=$1",[p.file.file_id])).rows[0]?.state==='complete');await native.stop();
  assert.equal((await f.admin.call(p.base+'/text')).body.text,'quartzneedle file content');
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents')).rows[0].n,1);
});
