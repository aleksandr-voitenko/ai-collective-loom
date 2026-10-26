import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, plain } from '../helpers/references.js';
import { httpClient } from '../helpers/participation-http.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import { packageText } from '../helpers/file-text.js';
import { Value } from '@sinclair/typebox/value';
import { OperationalHealth, OutcomePage } from '../../src/contracts/operations.js';
import type { QueryResultRow } from 'pg';
const path='/api/v1/admin/operational-health';
type F=Awaited<ReturnType<typeof fixture>>;
async function observed(f:F,code:string){
  for(let i=0;i<100;i++){const page=await f.admin.call(path+'/outcomes',{});assert.equal(page.status,200,JSON.stringify(page.body));if(page.body.items.some((r:any)=>r.code===code))return page.body;await delay(25);}
  throw new Error('Expected classified observation: '+code);
}
async function snapshot(f:F){const result:Record<string,unknown>={};for(const {tablename} of (await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' AND tablename NOT IN ('participation_rate_windows','operational_capture','operational_observations') ORDER BY tablename")).rows)result[tablename]=(await f.observer.query(`SELECT row_to_json(t)::text AS row FROM loom."${tablename}" t ORDER BY 1`)).rows;return result;}

test('actual cookie/bearer conflicts and denials produce bounded content-free samples without changing domains',async t=>{
  let logs='';const stream=new Writable({write(chunk,_encoding,next){logs+=chunk.toString();next();}});
  const f=await fixture(t,{logger:{level:'warn',stream}}),a=await f.participant('operations_agent');
  const anonymous=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'));
  for(const client of [anonymous,a.client]){assert.equal((await client.call(path)).status,client===anonymous?401:403);assert.equal((await client.call(path+'/outcomes',{})).status,client===anonymous?401:403);}
  const secret='PRIVATE_OPERATIONS_CANARY_α',source=await f.artifact(a.client,'Original shared text');
  const {createNote}=await import('../helpers/notes.js');
  const privateNote=createNote([],{title:'PRIVATE_NOTE_TITLE',body:'PRIVATE_NOTE_BODY'});
  assert.equal((await a.client.call('/api/v1/me/notes/create',privateNote)).status,200);
  assert.equal((await a.client.call('/api/v1/me/notes/query',{query:'PRIVATE_QUERY_CANARY'})).status,200);
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Privacy proof',replace_credential_id:null});assert.equal(issued.status,200);
  const revision={idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:secret,content:plain(secret)};
  assert.equal((await a.client.call('/api/v1/revisions',revision)).status,201);
  const before=await snapshot(f);
  const conflict=await a.client.call('/api/v1/revisions',{...revision,idempotency_key:randomUUID()});assert.equal(conflict.body.error.code,'revision_conflict');
  await observed(f,'revision_conflict');await delay(110);
  const mismatch=await a.client.call('/api/v1/revisions',{...revision,title:secret+' changed'});assert.equal(mismatch.body.error.code,'idempotency_conflict');
  await observed(f,'idempotency_conflict');await delay(110);
  assert.equal((await a.client.call('/api/v1/admin/file-limits')).status,403);
  const page=await observed(f,'forbidden');assert.equal(Value.Check(OutcomePage,page),true);
  assert.equal(JSON.stringify(page).includes(secret),false);assert.equal(logs.includes(secret),false);
  assert.deepEqual(await snapshot(f),before);
  const health=await f.admin.call(path);assert.equal(health.status,200,JSON.stringify(health.body));assert.equal(Value.Check(OperationalHealth,health.body),true);
  assert.equal(health.body.authored.value.worker.state,'unknown');assert.equal(health.body.authored.value.coverage.coverage,'not_established');
  for(const canary of [privateNote.title,privateNote.body,'PRIVATE_QUERY_CANARY',issued.body.secret]){
    assert.equal(JSON.stringify(page).includes(canary),false);assert.equal(JSON.stringify(health.body).includes(canary),false);assert.equal(logs.includes(canary),false);
  }
  assert.equal(health.body.storage_reachability,'unverified');assert.equal((await f.admin.call('/health/ready')).status,200);
  const unchanged=await snapshot(f);for(const sub of ['authored','files','activity'])assert.equal((await f.admin.call(path+'/'+sub+'/failures',{})).status,200);assert.deepEqual(await snapshot(f),unchanged);
  await f.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[a.id]);
  assert.equal((await a.client.call(path)).status,200);const first=await a.client.call(path+'/outcomes',{limit:1});assert.ok(first.body.next_cursor);
  await f.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[a.id]);
  assert.equal((await a.client.call(path+'/outcomes',{cursor:first.body.next_cursor})).status,403);
  await f.observer.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[a.credential]);
  assert.equal((await a.client.call(path)).status,401);
  await f.observer.query("UPDATE loom.participation_rate_windows SET used=6000 WHERE participant_id=$1 AND category='ordinary_requests'",[f.administratorId]);
  assert.equal((await f.admin.call('/api/v1/areas')).status,429);assert.equal((await f.admin.call(path)).status,200);
  await f.observer.query("UPDATE loom.participation_rate_windows SET used=1200 WHERE participant_id=$1 AND category='recovery_control'",[f.administratorId]);
  assert.equal((await f.admin.call(path)).status,429);
});

test('collector failure and saturation preserve exact refusal and success with bounded nonrecursive fallback',async t=>{
  let fail=false,logs='',captures=0;
  const f=await fixture(t,{logger:{level:'warn',stream:new Writable({write(chunk,_e,next){logs+=chunk.toString();next();}})},transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
    if(sql.includes('UPDATE loom.operational_capture')){captures++;if(fail)throw new Error('PRIVATE_COLLECTOR_EXCEPTION');}return tx.query<R>(sql,args);
  }}))})});
  const a=await f.participant('collector_agent');fail=true;
  const before=await snapshot(f),start=Date.now();
  const denials=await Promise.all(Array.from({length:12},()=>a.client.call('/api/v1/admin/file-limits')));
  assert.ok(denials.every(r=>r.status===403&&r.body.error.code==='forbidden'));assert.ok(Date.now()-start<5000);
  await delay(300);const page=await f.admin.call(path+'/outcomes',{});assert.equal(page.body.process_collection_failed,true);assert.ok(page.body.process_dropped>0);assert.ok(captures<=3);
  assert.equal(logs.includes('PRIVATE_COLLECTOR_EXCEPTION'),false);assert.equal(logs.split('"event":"operational_collection_incomplete"').length-1,1);
  assert.deepEqual(await snapshot(f),before);
  const published=await f.artifact(a.client,'Publication survives observer failure');assert.ok(published.revision_id);
  fail=false;await delay(110);await a.client.call('/api/v1/admin/file-limits');await observed(f,'forbidden');
  await f.restart();assert.equal((await f.admin.call(path+'/outcomes',{})).body.items.some((r:any)=>r.code==='forbidden'),true);
});

test('live window paging, actual multi-page captures, limits and unavailable sources never become healthy zeros',async t=>{
  let unavailable=false;
  const f=await fixture(t,{transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
    if(unavailable&&sql.includes('FROM loom.search_state'))throw new Error('PRIVATE_SOURCE_EXCEPTION');return tx.query<R>(sql,args);
  }}))})}),a=await f.participant('bounded_agent');
  for(let i=0;i<80;i++){await delay(120);assert.equal((await a.client.call('/api/v1/admin/file-limits')).status,403);if((await f.observer.query('SELECT count(*)::int n FROM loom.operational_observations')).rows[0].n>=28)break;}
  assert.ok((await f.observer.query('SELECT count(*)::int n FROM loom.operational_observations')).rows[0].n>=28,'Measured multi-page sample population');
  await observed(f,'forbidden');const ids:string[]=[];let cursor:string|undefined;
  do{const result=await f.admin.call(path+'/outcomes',{limit:7,max_bytes:1600,...(cursor?{cursor}:{})});assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.bytes<=1600);assert.ok(result.body.items.length<=7);ids.push(...result.body.items.map((r:any)=>r.position));cursor=result.body.next_cursor ?? undefined;}while(cursor);
  assert.equal(new Set(ids).size,ids.length);assert.ok(ids.length>=26);
  for(const body of [{limit:26},{max_bytes:1023},{cursor:'private-text'},{extra:'secret'}])assert.equal((await f.admin.call(path+'/outcomes',body)).status,400);
  unavailable=true;const health=await f.admin.call(path);assert.equal(health.status,200);assert.equal(health.body.authored.state,'unavailable');assert.equal(health.body.authored.value,null);assert.equal(health.body.activity.state,'observed');
  unavailable=false;
  await f.observer.query("UPDATE loom.operational_observations SET observed_at=clock_timestamp()-interval '25 hours'");
  const empty=await f.admin.call(path+'/outcomes',{});assert.deepEqual(empty.body.items,[]);assert.equal(empty.body.coverage,'incomplete_sample');assert.equal(empty.body.oldest_retained_at,null);
});

test('real independent worker stop/resume leaves HTTPS and publication identity intact', {timeout:180000},async t=>{
  const f=await fixture(t,{files:true});const search=new NativeSearchWorker(f.configuration),files=new NativeSearchWorker(f.configuration,'file-text',f.fileFixture!.storage.configuration);
  t.after(async()=>{await search.stop();await files.stop();});
  await search.start();await files.start();
  const first=await f.artifact(),file=await packageText(f);
  await search.observeUntil(async()=>(await f.admin.call(path)).body.authored.value?.coverage.coverage==='current_supported_text');
  await files.observeUntil(async()=>(await f.admin.call(path)).body.files.value?.jobs.complete===1);
  await search.stop();await files.stop();
  const before=await snapshot(f),heartbeat=(await f.admin.call(path)).body.authored.value.worker.heartbeat_at;
  const second=await f.artifact(),secondFile=await packageText(f,f.admin,'second.txt');
  const stopped=await f.admin.call(path);assert.equal(stopped.status,200);assert.equal(stopped.body.authored.value.coverage.coverage,'not_established');assert.equal(stopped.body.files.value.discovery_missing,true);
  assert.equal((await f.admin.call('/health/ready')).status,200);assert.equal((await f.admin.call('/api/v1/resources/'+second.resource_id)).body.revision_id,second.revision_id);
  // Natural elapsed stop, not a rewritten heartbeat fixture.
  await delay(46000);const stale=await f.admin.call(path);assert.equal(stale.body.authored.value.worker.state,'stale');assert.equal(stale.body.files.value.worker.state,'stale');assert.equal(stale.body.authored.value.worker.heartbeat_at,heartbeat);
  await search.start();await search.observeUntil(async()=>(await f.admin.call(path)).body.authored.value.coverage.coverage==='current_supported_text');
  assert.equal((await f.admin.call(path)).body.files.value.discovery_missing,true);
  await files.start();await files.observeUntil(async()=>(await f.admin.call(path)).body.files.value.jobs.complete===2);
  await search.stop();await files.stop();
  for(const resource of [first,second])assert.equal((await f.admin.call('/api/v1/resources/'+resource.resource_id)).body.revision_id,resource.revision_id);
  for(const resource of [file,secondFile])assert.equal((await f.admin.call(resource.file.download_url)).status,200);
  assert.deepEqual((await snapshot(f)).notification_deliveries,before.notification_deliveries);
});

test('native upload acknowledgement and cleanup failure retain exact bytes/reservations; processing outcomes remain distinct',async t=>{
  let loseObservation=true;
  const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
    if(loseObservation&&sql.includes('UPDATE loom.operational_capture'))throw new Error('PRIVATE_OBSERVER_UNCERTAINTY');return tx.query<R>(sql,args);
  }}))})}),storage=f.fileFixture!.storage,bytes=Buffer.from('safe original');
  const input={idempotency_key:randomUUID(),target:{kind:'area',resource_id:f.area},path:'PRIVATE_PATH_CANARY.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain'};
  const admitted=await f.admin.call('/api/v1/file-uploads',input);assert.equal(admitted.status,201);const id=admitted.body.upload_id;
  const put=storage.put.bind(storage);const lost=t.mock.method(storage,'put',async(...args:Parameters<typeof storage.put>)=>{await put(...args);throw new Error('PRIVATE_NATIVE_EXCEPTION');});
  const failed=await f.admin.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes});assert.equal(failed.status,503);assert.equal(failed.body.error.operation_outcome,'unknown');lost.mock.restore();
  for(let n=0;n<100;n++){if((await f.admin.call(path+'/outcomes',{})).body.process_collection_failed)break;await delay(25);}
  const uncertainState=await snapshot(f),gap=await f.admin.call(path+'/outcomes',{});
  assert.equal(gap.body.process_collection_failed,true);assert.equal(failed.body.error.operation_outcome,'unknown');assert.deepEqual(await snapshot(f),uncertainState);
  loseObservation=false;
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 day',lease_until=NULL WHERE id=$1",[id]);
  const removal=t.mock.method(storage,'remove',async()=>{throw new Error('PRIVATE_CLEANUP_EXCEPTION');});
  assert.deepEqual((await f.admin.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:1});removal.mock.restore();
  const signal=new AbortController().signal,versions=await storage.versions(id,false,signal);
  assert.equal(versions.length,1);assert.deepEqual(await storage.read(id,false,versions[0]!,{size:bytes.length,sha256:input.sha256},signal),bytes);
  const before=await snapshot(f),health=await f.admin.call(path);assert.equal(health.body.uploads.value.quarantined_uploads,1);assert.equal(health.body.uploads.value.expired_reserved_uploads,1);assert.equal(health.body.uploads.value.reserved_bytes,bytes.length*2);assert.deepEqual(await snapshot(f),before);
  assert.equal(JSON.stringify(health.body).includes('PRIVATE_'),false);
  await packageText(f,f.admin,'unsupported.png',Buffer.from('opaque'));
  await packageText(f,f.admin,'partial.txt',Buffer.from('x'.repeat(70000)));
  const failedFile=await packageText(f,f.admin,'failed.txt');
  const {FileTextWorker}=await import('../../src/server/modules/search/file-worker.js');const worker=new FileTextWorker(f.database,storage),read=storage.read.bind(storage);
  const fault=t.mock.method(storage,'read',async(...args:Parameters<typeof storage.read>)=>{if(args[0]===(await f.observer.query('SELECT upload_id FROM loom.file_contexts WHERE id=$1',[failedFile.file.file_id])).rows[0].upload_id)throw new Error('PRIVATE_PROCESSOR_EXCEPTION');return read(...args);});
  for(let i=0;i<10;i++){await worker.tick();await delay(1100);if((await f.observer.query("SELECT count(*)::int n FROM loom.file_text_jobs WHERE state='failed'")).rows[0].n)break;}
  assert.equal((await f.admin.call(failedFile.file.download_url)).body.error.code,'file_storage_unavailable');
  await observed(f,'file_storage_unavailable');fault.mock.restore();const processed=await f.admin.call(path);assert.equal(processed.body.files.value.jobs.failed,1);assert.equal(processed.body.files.value.jobs.partial,1);assert.equal(processed.body.files.value.jobs.unsupported,1);
  const failures=await f.admin.call(path+'/files/failures',{});assert.equal(failures.body.items.length,1);assert.ok(['storage','processing'].includes(failures.body.items[0].code));
  assert.equal((await f.admin.call('/api/v1/artifacts',failedFile.input)).body.revision_id,failedFile.revision_id);
  assert.equal((await f.admin.call(failedFile.file.download_url)).body,'quartzneedle file content');assert.equal(JSON.stringify(processed.body).includes('PRIVATE_'),false);
});

test('populated 0028 upgrade preserves every old row, exact files, retry and policy limits',async t=>{
  const f=await fixture(t,{files:true,throughMigration:28}),file=await packageText(f);
  const before=await snapshot(f);await f.migrate();const after=await snapshot(f);assert.deepEqual(after,before);
  assert.equal((await f.admin.call(path+'/outcomes',{})).body.items.length,0);
  assert.equal((await f.admin.call('/api/v1/artifacts',file.input)).body.revision_id,file.revision_id);
  assert.equal((await f.admin.call(file.file.download_url)).body,'quartzneedle file content');
  const health=await f.admin.call(path);assert.equal(health.body.files.value.worker.state,'unknown');assert.equal(health.body.files.value.discovery_missing,true);
});

test('real notification processing failure and traversal gaps stay distinct from expiry; existing repair preserves identities',async t=>{
  const {fixture:notifications,mentioned}=await import('../helpers/notifications.js');
  let broken=false;
  const f=await notifications(t),a=await f.participant('operations_recipient');await f.drain();
  const {NotificationWorker}=await import('../../src/server/modules/notifications/worker.js');
  const worker=new NotificationWorker({transaction:work=>f.database.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
    if(broken&&sql.includes('INSERT INTO loom.notification_signals'))throw new Error('PRIVATE_WORKER_EXCEPTION');return tx.query<R>(sql,args);
  }}))});
  const first=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'First',content:mentioned(a.id),change_note:null,change_account:null});await f.drain();
  const firstPage=await f.page(a.client),identities=(await f.observer.query('SELECT * FROM loom.notification_signals ORDER BY id')).rows;
  const delayed=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Delayed',content:mentioned(a.id,'loom-markdown-v3','PRIVATE_RECIPIENT_CANARY'),change_note:null,change_account:null});
  broken=true;for(let n=0;n<3;n++){await worker.tick();await f.observer.query("UPDATE loom.notification_jobs SET due_at=clock_timestamp() WHERE state='pending'");}broken=false;
  const health=await f.admin.call(path);assert.equal(health.body.activity.value.health.jobs.failed,1);
  const failures=await f.admin.call(path+'/activity/failures',{limit:1});assert.equal(failures.body.items[0].code,'processing_failed');assert.equal(JSON.stringify(failures.body).includes('PRIVATE_'),false);
  const unchanged=await snapshot(f);await f.admin.call(path);await f.admin.call(path+'/activity/failures',{});assert.deepEqual(await snapshot(f),unchanged);
  const failed=(await f.admin.call('/api/v1/admin/notifications/failures')).body.items[0];
  assert.equal((await f.admin.call('/api/v1/admin/notifications/retry',{id:failed.id,claim_generation:failed.claim_generation})).status,200);await f.drain();
  const repaired=await f.page(a.client,{checkpoint:firstPage.checkpoint!});assert.deepEqual(repaired.items.map(i=>i.source.resource_id),[delayed.resource_id]);
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.notification_signals WHERE revision_id=$1 ORDER BY id',[first.revision_id])).rows,identities);
  const {createDecipheriv,createCipheriv,randomBytes}=await import('node:crypto');
  const key=(await f.observer.query('SELECT cursor_key FROM loom.notification_state')).rows[0].cursor_key;
  const encoded=Buffer.from(firstPage.page_cursor,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,encoded.subarray(0,12));decipher.setAuthTag(encoded.subarray(12,28));
  const descriptor=JSON.parse(Buffer.concat([decipher.update(encoded.subarray(28)),decipher.final()]).toString());descriptor.expires=Date.now()-1;
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce),encrypted=Buffer.concat([cipher.update(JSON.stringify(descriptor)),cipher.final()]),expired=Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');
  await delay(110);assert.equal((await a.client.call('/api/v1/me/notifications/query',{cursor:expired})).body.error.code,'notification_descriptor_expired');await observed(f,'notification_descriptor_expired');
  await f.observer.query('UPDATE loom.participant_delivery_clocks SET retained_after=1 WHERE participant_id=$1',[a.id]);await delay(110);
  assert.equal((await a.client.call('/api/v1/me/notifications/query',{cursor:expired})).body.error.code,'notification_history_gap');const samples=await observed(f,'notification_history_gap');
  assert.ok(samples.items.some((r:any)=>r.code==='notification_descriptor_expired'));assert.equal(JSON.stringify(samples).includes(a.id),false);
  const deliveries=(await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows;
  assert.equal((await f.page(a.client,{recovery:{action:'resynchronize',token:expired}})).history,'incomplete');
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows,deliveries);
});

test('real SQL deadlines and collector lock contention preserve responses; standalone HTTPS reads retain bounded pages',async t=>{
  let slow=false;const f=await fixture(t,{transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
    if(slow&&sql.includes('FROM loom.search_state')){slow=false;await tx.query('SELECT pg_sleep(3)',[]);}return tx.query<R>(sql,args);
  }}))})}),a=await f.participant('diagnostic_client');
  slow=true;const begin=Date.now(),health=await f.admin.call(path);assert.equal(health.status,200);assert.equal(health.body.authored.state,'unavailable');assert.ok(Date.now()-begin<5000);
  const lock=f.observer;await lock.query('BEGIN');await lock.query('SELECT id FROM loom.operational_capture FOR UPDATE');
  try{const started=Date.now();assert.equal((await a.client.call('/api/v1/admin/file-limits')).status,403);assert.ok(Date.now()-started<3000);await delay(200);assert.equal((await f.admin.call(path+'/outcomes',{})).body.process_collection_failed,true);}finally{await lock.query('ROLLBACK');}
  for(let n=0;n<4;n++){await delay(120);await a.client.call('/api/v1/admin/file-limits');}await observed(f,'forbidden');
  await f.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[a.id]);
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Independent diagnostics',replace_credential_id:null});assert.equal(credential.status,200);
  const {writeFile}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util');
  await writeFile(f.directory+'/token',credential.body.secret,{mode:0o600});
  const run=(collection:string,output:string,extra:string[]=[])=>promisify(execFile)(process.execPath,['scripts/operational-health-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',f.directory+'/token','--collection',collection,'--output',f.directory+'/'+output,...extra],{timeout:20000});
  await run('health','health.json');await run('outcomes','one.json',['--limit','1']);await run('outcomes','two.json',['--limit','1','--after-page',f.directory+'/one.json']);
  const one=JSON.parse(await readFile(f.directory+'/one.json','utf8')),two=JSON.parse(await readFile(f.directory+'/two.json','utf8'));assert.notEqual(one.page.items[0].position,two.page.items[0].position);assert.equal(JSON.stringify(one).includes(credential.body.secret),false);
  await f.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[a.id]);await assert.rejects(run('outcomes','denied.json',['--after-page',f.directory+'/two.json']));assert.deepEqual(JSON.parse(await readFile(f.directory+'/one.json','utf8')),one);
});

test('late composed observations recheck current authority after source transactions finish',async t=>{
  let armed=false,enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
  const f=await fixture(t,{transactionWrapper:db=>({transaction:async work=>{const result=await db.transaction(work);if(armed&&result&&typeof result==='object'&&'worker_available' in result){armed=false;enter();await held;}return result;}})}),a=await f.participant('racing_administrator');
  await f.observer.query("UPDATE loom.participants SET role='administrator' WHERE id=$1",[a.id]);armed=true;
  const read=a.client.call(path);await entered;await f.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[a.id]);release();assert.equal((await read).status,403);
});

test('two compiled API processes share capture admission and a full ring remains bounded across restart',async t=>{
 const f=await fixture(t),a=await f.participant('multi_process'),credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Multiple API processes',replace_credential_id:null});assert.equal(credential.status,200);
 // Capacity fixture only. Every new sample below is produced by actual refused HTTPS requests.
 await f.observer.query("INSERT INTO loom.operational_observations SELECT n%1024,n,gen_random_uuid(),clock_timestamp(),'administration','forbidden',403 FROM generate_series(1,1024) n ON CONFLICT(slot) DO NOTHING");
 await f.observer.query('UPDATE loom.operational_capture SET position=1024,admitted_at=NULL');
 const {spawn}=await import('node:child_process');const cert=await readFile(f.directory+'/cert.pem','utf8');
 async function api(){const c=f.configuration,child=spawn(process.execPath,['dist/server/main.js'],{env:{...process.env,LOOM_API_HOST:'127.0.0.1',LOOM_API_PORT:'0',LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password,LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:f.origin,LOOM_TLS_KEY_FILE:f.directory+'/key.pem',LOOM_TLS_CERT_FILE:f.directory+'/cert.pem'},stdio:['ignore','pipe','ignore']});const exit=once(child,'exit');let stopped=false;
 const stop=async()=>{if(stopped)return;stopped=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const [code]=await exit;assert.equal(code,0);};t.after(stop);
 const address=await new Promise<string>((resolve,reject)=>{let pending='';const timer=setTimeout(()=>reject(new Error('Compiled API startup deadline')),10000);child.stdout.on('data',chunk=>{pending+=chunk;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const event=JSON.parse(line);if(event.event==='application_started'){clearTimeout(timer);resolve(event.address);}}catch{}}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Compiled API startup failed'));});});return{client:httpClient(address,cert,credential.body.secret),stop};}
 const one=await api(),two=await api();const start=Date.now();
 const responses=await Promise.all(Array.from({length:36},(_,i)=>(i%2?one:two).client.call('/api/v1/admin/file-limits')));assert.ok(responses.every(r=>r.status===403&&r.body.error.code==='forbidden'));
 await one.stop();await two.stop();
 const rows=(await f.observer.query('SELECT * FROM loom.operational_observations WHERE position>1024 ORDER BY position')).rows;assert.ok(rows.length>=1);assert.ok(rows.length<=Math.ceil((Date.now()-start)/100));
 const requests=new Set(responses.map(r=>r.body.error.request_id));assert.ok(rows.every(r=>requests.has(r.request_id)));for(let i=1;i<rows.length;i++)assert.ok(rows[i].observed_at.getTime()-rows[i-1].observed_at.getTime()>=99);
 assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.operational_observations')).rows[0].n,1024);
 const three=await api();await delay(110);const response=await three.client.call('/api/v1/admin/file-limits');await three.stop();assert.ok((await f.observer.query('SELECT request_id FROM loom.operational_observations WHERE request_id=$1',[response.body.error.request_id])).rowCount);
 assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.operational_observations')).rows[0].n,1024);
});

test('published originals with expired preparation timestamps are retained files, never expired upload incidents',async t=>{
 const f=await fixture(t,{files:true}),file=await packageText(f);
 await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 day'");
 const before=await snapshot(f),health=await f.admin.call(path);
 assert.equal(health.body.uploads.value.expired_reserved_uploads,0);
 assert.equal(health.body.uploads.value.reserved_bytes,Buffer.byteLength('quartzneedle file content')*2);
 assert.deepEqual(await snapshot(f),before);assert.equal((await f.admin.call(file.file.download_url)).body,'quartzneedle file content');
});
