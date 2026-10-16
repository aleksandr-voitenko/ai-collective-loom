import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID,createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile,writeFile } from 'node:fs/promises';
import type { QueryResultRow } from 'pg';
import { fixture,mentioned } from '../helpers/notifications.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';

test('bounded empty scans, complete Unicode JSON, descriptor renewal, retained gaps and recovery epoch',{timeout:90000},async t=>{
  let slow=false,unavailable=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    if(slow&&sql.includes('SELECT d.id,d.signal_id,d.position')){slow=false;await tx.query('SELECT pg_sleep(3)',[]);}
    if(unavailable&&sql.includes('SELECT d.id,d.signal_id,d.position')){unavailable=false;throw new Error('Private database fault, never disclose');}return tx.query<Row>(sql,values);
  }}))})}),a=await f.participant('bounded_attention');
  for(let i=0;i<102;i++)await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'🦉'.repeat(60)+i,content:mentioned(a.id),change_note:null,change_account:null});
  await f.drain();const empty=await f.page(a.client,{reason:'reply',max_response_bytes:4096});
  assert.deepEqual(empty.items,[]);assert.equal(empty.interval_complete,false);assert.equal(empty.work_budget_reached,true);assert.ok(empty.next_cursor);
  assert.equal((await f.page(a.client,{reason:'reply',cursor:empty.next_cursor!})).interval_complete,true);
  assert.equal((await a.client.call('/api/v1/me/notifications/query',{reason:'mention',cursor:empty.next_cursor})).body.error.code,'notification_token_invalid');
  const page=await a.client.call('/api/v1/me/notifications/query',{max_response_bytes:12000,limit:25});assert.equal(page.status,200);assert.ok(page.bytes<=12000);assert.ok(page.body.items.length>0&&page.body.items.length<25);assert.ok(page.body.page_cursor.length<=2048);
  assert.equal(page.body.items[0].source.title,(await f.observer.query('SELECT title FROM loom.revisions WHERE id=$1',[page.body.items[0].source.revision_id])).rows[0].title);
  for(const query of [{limit:26},{max_response_bytes:4095},{cursor:'x'.repeat(2049)},{cursor:page.body.page_cursor,checkpoint:page.body.checkpoint??'bad'}])assert.equal((await a.client.call('/api/v1/me/notifications/query',query)).status,400);
  // Private fixture edits an authenticated descriptor's time without waiting a day;
  // public callers never receive the database custody key or a token minting route.
  const key=(await f.observer.query('SELECT cursor_key FROM loom.notification_state')).rows[0].cursor_key as Buffer;
  const encoded=Buffer.from(page.body.page_cursor,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,encoded.subarray(0,12));decipher.setAuthTag(encoded.subarray(12,28));
  const descriptor=JSON.parse(Buffer.concat([decipher.update(encoded.subarray(28)),decipher.final()]).toString());descriptor.expires=Date.now()-1;
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),bytes=Buffer.concat([cipher.update(JSON.stringify(descriptor)),cipher.final()]),expired=Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
  assert.equal((await a.client.call('/api/v1/me/notifications/query',{cursor:expired})).body.error.code,'notification_descriptor_expired');
  const renewed=await f.page(a.client,{limit:page.body.limit,max_response_bytes:12000,recovery:{action:'renew',token:expired}});assert.deepEqual(renewed.items,page.body.items);assert.equal(renewed.traversal.id,page.body.traversal.id);assert.equal(renewed.recovery,'renewed');
  slow=true;assert.equal((await a.client.call('/api/v1/me/notifications/query',{})).body.error.code,'notification_work_limit');
  unavailable=true;const failed=await a.client.call('/api/v1/me/notifications/query',{});assert.equal(failed.status,503);
  assert.equal(failed.body.error.recovery.action,'retry_same_request');assert.equal(failed.body.error.operation_outcome,undefined);assert.ok(!JSON.stringify(failed.body).includes('Private database fault'));
  const small=await a.client.call('/api/v1/me/notifications/query',{max_response_bytes:4096});
  if(small.status===200)assert.ok(small.bytes<=4096);else{assert.equal(small.body.error.code,'response_budget_too_small');assert.ok(small.body.error.minimum_response_bytes>4096);}
  const before=(await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows;
  await f.observer.query('UPDATE loom.participant_delivery_clocks SET retained_after=1 WHERE participant_id=$1',[a.id]);
  assert.equal((await a.client.call('/api/v1/me/notifications/query',{cursor:expired})).body.error.code,'notification_history_gap');
  const retained=await f.page(a.client,{recovery:{action:'resynchronize',token:expired}});assert.equal(retained.history,'incomplete');assert.ok(!retained.items.some(i=>i.delivery_id===page.body.items[0].delivery_id));
  await f.observer.query('UPDATE loom.notification_state SET recovery_epoch=$1',[randomUUID()]);
  assert.equal((await a.client.call('/api/v1/me/notifications/query',{cursor:retained.page_cursor})).body.error.code,'notification_epoch_changed');
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows,before);
});

test('native HTTPS client and compiled API restart retain personal page ownership and exact identity',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('external_attention');
  for(let i=0;i<3;i++)await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'External '+i,content:mentioned(a.id),change_note:null,change_account:null});
  const worker=new NativeSearchWorker(f.configuration,'notifications');await worker.start();try{await worker.observeUntil(async()=> (await f.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n===3);}finally{await worker.stop();}
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'External reader',replace_credential_id:null});assert.equal(credential.status,200);
  await writeFile(f.directory+'/token',credential.body.secret,{mode:0o600});
  const journal=f.directory+'/attention.json',run=(action:string,journalFile=journal)=>promisify(execFile)(process.execPath,['scripts/notifications-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem','--journal',journalFile,'--action',action,'--limit','1'],{timeout:20000});
  const first=JSON.parse((await run('read')).stdout),saved=await readFile(journal,'utf8');assert.ok(!saved.includes(credential.body.secret));assert.ok(!saved.includes('External'));assert.equal(JSON.parse(saved).cursor,first.page_cursor);
  await f.app.close();
  async function api(){
    const c=f.configuration,child=spawn(process.execPath,['dist/server/main.js'],{env:{...process.env,LOOM_API_HOST:'127.0.0.1',LOOM_API_PORT:new URL(f.origin).port,LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password,LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:f.origin,LOOM_TLS_KEY_FILE:f.directory+'/key.pem',LOOM_TLS_CERT_FILE:f.directory+'/cert.pem'},stdio:['ignore','pipe','pipe']});
    const exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
    await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Native HTTPS startup deadline')),10000);child.stdout.on('data',bytes=>{if(bytes.toString().includes('application_started')){clearTimeout(timeout);resolve();}});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Native HTTPS startup failed'));});});
    return async()=>{child.kill('SIGTERM');const [code]=await exit;assert.equal(code,0);};
  }
  let stop=await api();assert.deepEqual(JSON.parse((await run('read')).stdout).items,first.items);
  const second=JSON.parse((await run('next')).stdout);assert.notEqual(second.items[0].delivery_id,first.items[0].delivery_id);await stop();stop=await api();
  assert.deepEqual(JSON.parse((await run('read')).stdout).items,second.items);
  assert.deepEqual(JSON.parse((await run('read',f.directory+'/independent.json')).stdout).items,first.items);
  const third=JSON.parse((await run('next')).stdout);assert.equal(third.interval_complete,true);assert.deepEqual(JSON.parse((await run('next')).stdout).items,[]);
  const again=JSON.parse((await run('replay')).stdout);assert.deepEqual(again.items,first.items);await stop();
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n,3);
});

test('standalone next preserves the displayed page boundary across page-size changes and first use',{timeout:60000},async t=>{
  const f=await fixture(t),a=await f.participant('resized_attention');
  for(let i=0;i<4;i++)await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Sized page '+i,content:mentioned(a.id),change_note:null,change_account:null});
  await f.drain();
  const expected=(await f.page(a.client)).items.map(item=>item.delivery_id);
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Page-size reader',replace_credential_id:null});assert.equal(issued.status,200);
  const credential=f.directory+'/resize-token',journal=f.directory+'/resize-attention.json';await writeFile(credential,issued.body.secret,{mode:0o600});
  const run=async(action:string,limit?:number,path=journal)=>JSON.parse((await promisify(execFile)(process.execPath,
    ['scripts/notifications-client.mjs','--origin',f.origin,'--credential-file',credential,'--ca',f.directory+'/cert.pem','--journal',path,'--action',action,
      ...(limit===undefined?[]:['--limit',String(limit)])],{timeout:20000})).stdout);
  const ids=(page:any)=>page.items.map((item:any)=>item.delivery_id);
  assert.deepEqual(ids(await run('read',1)),expected.slice(0,1));
  assert.deepEqual(ids(await run('next',2)),expected.slice(1,3),'changing the next page size must not skip unseen signals');
  assert.deepEqual(ids(await run('read')),expected.slice(1,3),'restart reauthorizes the same displayed page and size');
  assert.deepEqual(ids(await run('next',1)),expected.slice(3));
  assert.deepEqual(ids(await run('next',2,f.directory+'/first-next.json')),expected.slice(0,2),'first next must expose the first page');
  const legacy=JSON.parse(await readFile(journal,'utf8'));delete legacy.next_cursor;delete legacy.checkpoint;
  await writeFile(journal,JSON.stringify(legacy));const before=await readFile(journal,'utf8');
  await assert.rejects(run('next',2),/saved page boundary is unavailable/);assert.equal(await readFile(journal,'utf8'),before);
  assert.deepEqual(ids(await run('read',1)),expected.slice(3),'legacy journals explicitly re-display their page before next is enabled');
});
