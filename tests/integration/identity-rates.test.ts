import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fixture, plain } from '../helpers/references.js';
import { administrationSnapshot } from '../helpers/administration.js';
import { packageText } from '../helpers/file-text.js';
import { httpClient } from '../helpers/participation-http.js';
import { barrier, bounded, blockedBy } from '../helpers/search-races.js';
import type { QueryResultRow } from 'pg';

const path='/api/v1/admin/participation-rates';
async function change(f:Awaited<ReturnType<typeof fixture>>,limits:Record<string,number>) {
  const current=await f.admin.call(path);assert.equal(current.status,200,JSON.stringify(current.body));
  const {window_seconds:_,version,...rates}=current.body;
  const input={...rates,...limits,expected_version:version,idempotency_key:randomUUID()};
  const response=await f.admin.call(path+'/state',input);assert.equal(response.status,200,JSON.stringify(response.body));
  return {input,result:response.body};
}
async function usage(f:Awaited<ReturnType<typeof fixture>>,id:string,category='ordinary_requests'){
  return (await f.observer.query('SELECT used FROM loom.participation_rate_windows WHERE participant_id=$1 AND category=$2',[id,category])).rows[0]?.used??0;
}
async function expire(f:Awaited<ReturnType<typeof fixture>>,id:string,category='ordinary_requests'){
  // Private deterministic fixture time; no HTTP reset or client-clock override.
  await f.observer.query("UPDATE loom.participation_rate_windows SET window_started_at=clock_timestamp()-interval '61 seconds' WHERE participant_id=$1 AND category=$2",[id,category]);
}
async function sourceState(f:Awaited<ReturnType<typeof fixture>>) {
  const result:Record<string,unknown>={};
  for(const table of ['resources','revisions','shared_activity','outbox_intents','idempotency_records','reading_states','file_contexts']) {
    result[table]=(await f.observer.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM loom.${table} t`)).rows[0].rows;
  }
  return result;
}
test('database windows enforce concurrent boundaries, participant isolation and shared bearer credentials',async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('rate_a'),b=await f.participant('rate_b');
  const second=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Second credential',replace_credential_id:null});assert.equal(second.status,200);
  const other=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),second.body.secret);
  await change(f,{ordinary_requests:3});
  const before=await sourceState(f);
  const responses=await Promise.all(Array.from({length:10},(_,i)=>(i%2?a.client:other).call('/api/v1/areas')));
  assert.equal(responses.filter(r=>r.status===200).length,3);
  for(const r of responses.filter(r=>r.status!==200)){
    assert.equal(r.status,429);assert.equal(r.body.error.code,'temporarily_throttled');
    assert.equal(r.body.error.rate_category,'ordinary_requests');
    assert.equal(r.headers['retry-after'],String(r.body.error.retry_after_seconds));
    assert.ok(r.body.error.retry_after_seconds>=1&&r.body.error.retry_after_seconds<=60);
    assert.equal(r.body.error.operation_outcome,undefined);
    assert.deepEqual(Object.keys(r.body.error).sort(),['code','message','rate_category','recovery','request_id','retry_after_seconds']);
  }
  assert.equal(await usage(f,a.id),3);assert.equal((await b.client.call('/api/v1/areas')).status,200);
  assert.equal((await a.client.call('/api/v1/identity/self')).body.participant_id,a.id);
  assert.equal((await a.client.call('/api/v1/operations/status',{operation_kind:'artifact.create',idempotency_key:randomUUID()})).status,200);
  assert.deepEqual(await sourceState(f),before);
  await expire(f,a.id);assert.equal((await other.call('/api/v1/areas')).status,200);assert.equal(await usage(f,a.id),1);
  assert.ok((await f.observer.query('SELECT count(*)::int n FROM loom.participation_rate_windows WHERE participant_id=$1',[a.id])).rows[0].n<=3);
});

test('cookie participants share the same small request and publication semantics; first throttle has no source effects',async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),human=await f.participant('rate_human','human');
  await change(f,{ordinary_requests:2,new_publications:1});
  const input={idempotency_key:randomUUID(),area_id:f.area,title:'One allowed',content:plain('Human publication')};
  const first=await human.client.call('/api/v1/artifacts',input);assert.equal(first.status,201);
  const before=await sourceState(f);
  const second=await human.client.call('/api/v1/artifacts',{...input,idempotency_key:randomUUID(),title:'Refused'});
  assert.equal(second.body.error.rate_category,'new_publications');
  assert.equal((await human.client.call('/api/v1/artifacts',input)).body.error.rate_category,'ordinary_requests');
  assert.deepEqual(await sourceState(f),before);assert.equal(await usage(f,human.id,'new_publications'),1);
  const status=await human.client.call('/api/v1/operations/status',{operation_kind:'artifact.create',idempotency_key:input.idempotency_key});assert.equal(status.body.revision_id,first.body.revision_id);
  await expire(f,human.id);
  assert.equal((await human.client.call('/api/v1/artifacts',input)).body.idempotency,'replayed');
  assert.equal(await usage(f,human.id,'new_publications'),1);
  assert.equal((await human.client.call('/api/v1/artifacts',{...input,title:'Changed digest'})).body.error.code,'idempotency_conflict');
  await expire(f,human.id);
  await f.observer.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[(await human.client.call('/api/v1/identity/self')).body.credential_id]);
  assert.equal((await human.client.call('/api/v1/artifacts',input)).status,401);
});

test('administrator policy changes preserve usage, serialize versions, recover exact decisions and audit without activity',async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('rate_policy_participant');
  assert.deepEqual((await f.admin.call(path)).body,{version:1,window_seconds:60,ordinary_requests:120,new_publications:20,recovery_control:60});
  for(const [p,b] of [[path,undefined],[path+'/state',{idempotency_key:randomUUID(),expected_version:1,ordinary_requests:1,new_publications:1,recovery_control:10}],[path+'/audit',{}],[path+'/status',{idempotency_key:randomUUID()}]] as const)
    assert.equal((await a.client.call(p,b)).status,403);
  for(const rates of [{ordinary_requests:0},{ordinary_requests:6001},{new_publications:0},{new_publications:601},{recovery_control:9},{recovery_control:1201}])
    assert.equal((await f.admin.call(path+'/state',{idempotency_key:randomUUID(),expected_version:1,ordinary_requests:120,new_publications:20,recovery_control:60,...rates})).status,400);
  const before=await sourceState(f),first=await change(f,{ordinary_requests:2});
  assert.equal((await a.client.call('/api/v1/areas')).status,200);assert.equal((await a.client.call('/api/v1/areas')).status,200);
  await change(f,{ordinary_requests:1});assert.equal((await a.client.call('/api/v1/areas')).status,429);
  const increased=await change(f,{ordinary_requests:3});assert.equal((await a.client.call('/api/v1/areas')).status,200);
  const input={...increased.input,expected_version:increased.result.current.version,idempotency_key:randomUUID(),new_publications:2};
  const race=await Promise.all([f.admin.call(path+'/state',input),f.admin.call(path+'/state',{...input,idempotency_key:randomUUID(),new_publications:3})]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);assert.equal(race.find(r=>r.status===409)!.body.error.code,'rate_policy_conflict');
  const latest=race.find(r=>r.status===200)!.body.current;
  const replay=await f.admin.call(path+'/state',first.input);assert.equal(replay.body.original.version,2);assert.deepEqual(replay.body.current,latest);
  assert.equal((await f.admin.call(path+'/state',{...first.input,new_publications:3})).body.error.code,'idempotency_conflict');
  assert.deepEqual((await f.admin.call(path+'/status',{idempotency_key:first.input.idempotency_key})).body,replay.body);
  const audit=await f.admin.call(path+'/audit',{limit:2});assert.equal(audit.body.items.length,2);assert.ok(audit.body.next_before_version);
  assert.equal(audit.body.items[0].actor_id,f.administratorId);assert.ok(audit.body.items[0].actor_credential_id);
  assert.equal((await f.admin.call(path+'/audit',{before_version:audit.body.next_before_version,limit:25})).body.items.length,2);
  assert.equal((await f.admin.call(path+'/audit',{limit:26})).status,400);
  assert.deepEqual(await sourceState(f),before);assert.equal(await usage(f,a.id),3);
  await f.restart();assert.deepEqual((await f.admin.call(path+'/state',first.input)).body,replay.body);
});

for(const order of ['admission-first','policy-first'] as const)test('HTTPS policy edit and admission have one PostgreSQL ordering: '+order,async t=>{
  const held=barrier(),release=barrier(),contending=barrier();let armed=false,participantId='',requestPid=0,editPid=0;
  t.after(()=>release.release());
  const f=await fixture(t,{rateLimits:'defaults',transactionWrapper:db=>({transaction:work=>db.transaction(tx=>{
    let participant='';
    return work({query:async <R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
      if(sql.startsWith('SELECT state, role, kind, nickname FROM loom.participants'))participant=String(args[0]);
      const request=armed&&participant===participantId&&sql.includes('FROM loom.participation_rate_policy WHERE id=1 FOR SHARE');
      const edit=armed&&sql.includes('FROM loom.participation_rate_policy WHERE id=1 FOR UPDATE');
      if(request||edit){
        const pid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid',[])).rows[0]!.pid;
        if(request)requestPid=pid;else editPid=pid;
        const first=order==='admission-first'?request:edit;
        if(first){const result=await tx.query<R>(sql,args);held.release();await bounded(release.promise);return result;}
        contending.release();
      }
      return tx.query<R>(sql,args);
    }});
  })})});
  const a=await f.participant('race_rate');participantId=a.id;
  const changed=await change(f,{ordinary_requests:2});
  assert.equal((await a.client.call('/api/v1/areas')).status,200);
  const input={...changed.input,idempotency_key:randomUUID(),expected_version:changed.result.current.version,ordinary_requests:1};
  armed=true;
  const first=order==='admission-first'?a.client.call('/api/v1/areas'):f.admin.call(path+'/state',input);
  await bounded(held.promise);
  const second=order==='admission-first'?f.admin.call(path+'/state',input):a.client.call('/api/v1/areas');
  try{
    await bounded(contending.promise);
    await blockedBy(f.observer,order==='admission-first'?editPid:requestPid,order==='admission-first'?requestPid:editPid);
  }finally{armed=false;release.release();}
  const results=await Promise.all([first,second]);
  const admission=results[order==='admission-first'?0:1]!,edit=results[order==='admission-first'?1:0]!;
  assert.equal(edit.status,200);assert.equal(edit.body.current.version,changed.result.current.version+1);
  assert.equal(admission.status,order==='admission-first'?200:429);
  assert.equal((await a.client.call('/api/v1/areas')).status,429);
});

test('separate compiled HTTPS processes and ordinary restart share the participant window', {timeout:90000},async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('multi_process_rate');
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Process client',replace_credential_id:null});
  await change(f,{ordinary_requests:3});
  const modulePath=(name:string)=>new URL('../../dist/server/'+name,import.meta.url).href;
  const script=f.directory+'/rate-server.mjs';
  await writeFile(script,`import {createApplication} from ${JSON.stringify(modulePath('http/app.js'))};
import {PostgresDatabase} from ${JSON.stringify(modulePath('db/postgres.js'))};
import {participationProfile} from ${JSON.stringify(modulePath('participation-profile.js'))};
process.once('message',async({configuration,origin,tls})=>{const database=new PostgresDatabase(configuration);
const app=await createApplication({database,logger:false,tls,participation:participationProfile(database,{LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:origin})});
await app.listen({host:'127.0.0.1',port:0});process.send(app.server.address().port);
process.once('SIGTERM',async()=>{await app.close();process.exit(0);});});`,{mode:0o600});
  const children:ChildProcess[]=[];
  const stop=async(child:ChildProcess)=>{const exit=once(child,'exit');child.kill('SIGTERM');assert.equal((await exit)[0],0);children.splice(children.indexOf(child),1);};
  t.after(async()=>{for(const child of [...children])await stop(child);});
  const start=async()=>{const child=fork(script,[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});children.push(child);const ready=once(child,'message');
    child.send({configuration:f.configuration,origin:f.origin,tls:{cert:await readFile(f.directory+'/cert.pem','utf8'),key:await readFile(f.directory+'/key.pem','utf8')}});
    const port=(await bounded(ready))[0];return {child,client:httpClient('https://localhost:'+port,await readFile(f.directory+'/cert.pem','utf8'),issued.body.secret)};};
  const one=await start(),two=await start();
  const results=await Promise.all(Array.from({length:8},(_,i)=>(i%2?one:two).client.call('/api/v1/areas')));
  assert.equal(results.filter(r=>r.status===200).length,3);assert.equal(results.filter(r=>r.status===429).length,5);
  await stop(one.child);const fresh=await start();assert.equal((await fresh.client.call('/api/v1/areas')).status,429);
  // Age the fixture close to expiry, then let database time cross it while both
  // serving processes are stopped. No process timer resets or replenishes it.
  await f.observer.query("UPDATE loom.participation_rate_windows SET window_started_at=clock_timestamp()-interval '59 seconds' WHERE participant_id=$1 AND category='ordinary_requests'",[a.id]);
  await stop(two.child);await stop(fresh.child);
  await f.observer.query('SELECT pg_sleep(1.1)');
  const afterExpiry=await start();assert.equal((await afterExpiry.client.call('/api/v1/areas')).status,200);
  assert.equal(await usage(f,a.id),1);
});

test('independent HTTPS journal survives lost acknowledgement, throttled retry, status and exact replay', {timeout:90000},async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('rate_external');
  const token=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'External rate',replace_credential_id:null});
  const discussion=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Rate recovery',content:plain('Opening')});assert.equal(discussion.status,201);
  await writeFile(f.directory+'/token',token.body.secret,{mode:0o600});await writeFile(f.directory+'/reply.txt','Retain exact reply',{mode:0o600});
  const run=(action:string)=>promisify(execFile)(process.execPath,['scripts/participation-client.mjs','--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',f.directory+'/token','--journal',f.directory+'/rate-intent.json','--action',action,...(action==='prepare'?['--parent',discussion.body.resource_id,'--text-file',f.directory+'/reply.txt']:[])],{timeout:20000});
  await run('prepare');await expire(f,a.id);await change(f,{ordinary_requests:1,new_publications:1,recovery_control:120});
  await assert.rejects(run('lose-response'),(e:any)=>e.code===75);
  const uncertain=await readFile(f.directory+'/rate-intent.json','utf8');
  await assert.rejects(run('retry'),(e:any)=>e.code===1 && /temporarily_throttled.*Wait at least/.test(e.stderr));
  assert.equal(await readFile(f.directory+'/rate-intent.json','utf8'),uncertain);
  await run('status');const confirmed=JSON.parse(await readFile(f.directory+'/rate-intent.json','utf8'));
  assert.equal(confirmed.state,'committed');assert.deepEqual(confirmed.body,JSON.parse(uncertain).body);
  await f.restart();await expire(f,a.id);await change(f,{ordinary_requests:3});await run('retry');
  assert.equal(await usage(f,a.id,'new_publications'),1);
  assert.equal((await f.observer.query("SELECT count(*)::int n FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind='reply.create'",[a.id])).rows[0].n,1);
});

test('control capacity is bounded independently and ordinary exhaustion leaves administrator intervention available',async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('control_rate'),b=await f.participant('control_other');
  await change(f,{ordinary_requests:1,new_publications:1,recovery_control:10});
  assert.equal((await f.admin.call('/api/v1/areas')).status,429);
  assert.equal((await f.admin.call(path)).status,200);
  const body={operation_kind:'artifact.create',idempotency_key:randomUUID()};
  for(let i=0;i<10;i++)assert.equal((await a.client.call('/api/v1/operations/status',body)).body.operation_state,'not_recorded');
  const limited=await a.client.call('/api/v1/operations/status',body);
  assert.equal(limited.status,429);assert.equal(limited.body.error.rate_category,'recovery_control');assert.equal(limited.body.error.operation_outcome,undefined);
  assert.equal(await usage(f,a.id,'recovery_control'),10);
  assert.equal((await a.client.call('/api/v1/areas')).status,200);
  assert.equal((await b.client.call('/api/v1/operations/status',body)).status,200);
  await expire(f,f.administratorId,'recovery_control');
  await change(f,{ordinary_requests:3});
  assert.equal((await f.admin.call('/api/v1/areas')).status,200);
  await expire(f,a.id,'recovery_control');assert.equal((await a.client.call('/api/v1/operations/status',body)).status,200);
});

test('failed publications roll back allowance; retained policy decisions have a finite cap with recovery intact',async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('rollback_rate');
  const changed=await change(f,{new_publications:1});
  const input={idempotency_key:randomUUID(),area_id:randomUUID(),title:'Unavailable parent',content:plain('No publish')};
  assert.equal((await a.client.call('/api/v1/artifacts',input)).status,404);
  assert.equal(await usage(f,a.id,'new_publications'),0);
  assert.equal((await a.client.call('/api/v1/artifacts',{...input,area_id:f.area})).status,201);
  assert.equal(await usage(f,a.id,'new_publications'),1);
  await f.observer.query('UPDATE loom.participation_rate_policy SET version=10001 WHERE id=1');
  const capped=await f.admin.call(path+'/state',{...changed.input,idempotency_key:randomUUID(),expected_version:10001});
  assert.equal(capped.body.error.code,'rate_policy_capacity');assert.notEqual(capped.body.error.code,'temporarily_throttled');
  assert.equal((await f.admin.call(path+'/state',changed.input)).body.original.version,2);
  assert.equal((await f.admin.call(path+'/status',{idempotency_key:changed.input.idempotency_key})).body.current.version,10001);
  await assert.rejects(f.database.transaction(tx=>tx.query('DELETE FROM loom.participation_rate_decisions',[])),/permission denied/);
  await assert.rejects(f.database.transaction(tx=>tx.query("UPDATE loom.participation_rate_windows SET category='recovery_control'",[])),/permission denied/);
});

test('migration 0027 preserves all existing table bytes and v4 publication replay while activating accounting',async t=>{
  const f=await fixture(t,{throughMigration:26,rateLimits:'defaults'});
  const command={idempotency_key:randomUUID(),area_id:f.area,title:'Before rates',content:{format:'loom-markdown-v4',text:'Exact v4',mentions:[],references:[]},change_note:null,change_account:null};
  const original=await f.admin.call('/api/v1/artifacts',command);assert.equal(original.status,201,JSON.stringify(original.body));
  const before=await administrationSnapshot(f);
  await f.migrate();
  const after=await administrationSnapshot(f);
  for(const [table,hash] of Object.entries(before))assert.equal(after[table],hash,table);
  assert.equal((await f.admin.call(path)).body.version,1);
  const replay=await f.admin.call('/api/v1/artifacts',command);
  assert.equal(replay.body.revision_id,original.body.revision_id);assert.equal(replay.body.idempotency,'replayed');
  assert.equal(await usage(f,f.administratorId,'new_publications'),0);
});

test('concurrent new publications cannot overdraw their separate budget and accounting failures fail closed',async t=>{
  const f=await fixture(t,{rateLimits:'defaults'}),a=await f.participant('concurrent_publications');
  await change(f,{ordinary_requests:10,new_publications:2});
  const commands=Array.from({length:8},(_,i)=>({idempotency_key:randomUUID(),area_id:f.area,title:'Concurrent '+i,content:plain('Bounded publication')}));
  const responses=await Promise.all(commands.map(command=>a.client.call('/api/v1/artifacts',command)));
  assert.equal(responses.filter(r=>r.status===201).length,2);
  for(const r of responses.filter(r=>r.status!==201)){assert.equal(r.status,429);assert.equal(r.body.error.rate_category,'new_publications');}
  assert.equal(await usage(f,a.id,'new_publications'),2);assert.equal(await usage(f,a.id),8);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.idempotency_records WHERE participant_id=$1',[a.id])).rows[0].n,2);
  const before=await sourceState(f);
  await f.observer.query('DELETE FROM loom.participation_rate_policy');
  const unavailable=await a.client.call('/api/v1/areas');assert.equal(unavailable.status,503);assert.equal(unavailable.body.error.code,'service_unavailable');
  assert.equal(await usage(f,a.id),8);assert.deepEqual(await sourceState(f),before);
});


test('cookie downloads and bearer uploads charge once while transfer authorization rechecks remain',async t=>{
  const f=await fixture(t,{rateLimits:'defaults',files:true}),human=await f.participant('rate_transfer_human','human'),agent=await f.participant('rate_transfer_agent');
  const bytes=Buffer.from('Exact transfer bytes'),published=await packageText(f,f.admin,'rate.txt',bytes);
  const upload=await agent.client.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'area',resource_id:f.area},path:'upload.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain'});
  assert.equal(upload.status,201);await expire(f,agent.id);
  await change(f,{ordinary_requests:1});
  const download=await human.client.call(published.file.download_url);
  assert.equal(download.status,200,JSON.stringify(download.body));assert.equal(download.body,bytes.toString());
  assert.equal(await usage(f,human.id),1);
  const transferred=await agent.client.call(`/api/v1/file-uploads/${upload.body.upload_id}/bytes`,undefined,{bytes});
  assert.equal(transferred.status,200,JSON.stringify(transferred.body));assert.equal(await usage(f,agent.id),1);
  assert.equal((await human.client.call(published.file.download_url)).status,429);
  assert.equal((await agent.client.call(`/api/v1/file-uploads/${upload.body.upload_id}/bytes`,undefined,{bytes})).status,429);
  assert.equal((await agent.client.call('/api/v1/file-uploads/'+upload.body.upload_id)).status,200);
});
