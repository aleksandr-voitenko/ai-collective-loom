import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { syntheticServer } from '../helpers/participation-server.js';
import { httpClient } from '../helpers/participation-http.js';
import { populateAdministration, administrationSnapshot, administrationTarget } from '../helpers/administration.js';
import { actorFromVerifiedIdentity } from '../../src/server/modules/publication/actor.js';
import { AdministrationBrowsing } from '../../src/server/modules/identity/browsing.js';
import { opaqueToken } from '../../src/server/modules/identity/secrets.js';
import { barrier, bounded, blockedBy } from '../helpers/search-races.js';
const base='/api/v1/identity/';
async function setup(t: TestContext, populated=true) {
  const server=await syntheticServer();t.after(()=>server.close());
  const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert);
  const self=await admin.enroll(server.ticket);
  if(populated) await populateAdministration(server);
  return {server,admin,self,cert};
}
async function page(client:ReturnType<typeof httpClient>,collection:string,body:Record<string,unknown>={}) {
  const response=await client.call(base+collection+'/query',body);
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.ok(response.bytes<=(Number(body.max_bytes)||32768));
  assert.match(String(response.headers['cache-control']),/no-store/);
  assert.equal(response.body.complete,response.body.next_cursor===null);
  if(response.body.next_cursor!==null)assert.ok(Buffer.byteLength(response.body.next_cursor,'utf8')<=1024,'Every returned continuation must fit the independent input cursor limit');
  return response.body;
}
async function all(client:ReturnType<typeof httpClient>,collection:string,extra:Record<string,unknown>={}) {
  const items:any[]=[];let cursor:string|undefined;
  for(let n=0;n<200;n++) { const result=await page(client,collection,{...extra,limit:7,...(cursor?{cursor}:{})});items.push(...result.items);if(result.complete)return items;cursor=result.next_cursor; }
  throw new Error('Traversal did not complete within its fixture bound');
}
test('complete eligible ID sets and metadata through HTTPS; legacy views stay limited; reads change no tables',async t=>{
 const {server,admin,self,cert}=await setup(t);
 const agent=opaqueToken('agent'),agentId=randomUUID();
 await server.observer.query("INSERT INTO loom.participants(id,state,role,kind,nickname) VALUES($1,'active','administrator','agent','bearer_admin')",[agentId]);
 await server.observer.query("INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label,verifier,expires_at) VALUES($1,$2,'active','agent','Admin bearer',$3,clock_timestamp()+interval '1 hour')",[agent.id,agentId,agent.verifier]);
 const bearer=httpClient(server.origin,cert,agent.secret);
 const before=await administrationSnapshot(server);
 for(const client of [admin,bearer])for(const collection of ['accounts','credentials','audit']){
  const result=await all(client,collection,collection==='credentials'?{participant_id:administrationTarget}:{});
  const sql=collection==='accounts'?"SELECT id,nickname,kind,role,state FROM loom.participants WHERE kind <> 'internal' ORDER BY id":collection==='credentials'?`SELECT id,kind,label,state,expires_at,created_at,parent_credential_id FROM loom.participant_credentials WHERE participant_id='${administrationTarget}' ORDER BY id`:`SELECT id,actor_id,actor_credential_id,authority,target_id,action,operation_id,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at FROM loom.administrative_audit ORDER BY loom.administrative_audit.recorded_at,id`;
  const expected=(await server.observer.query(`SELECT row_to_json(t) AS item FROM (${sql}) t`)).rows.map(r=>r.item);
  assert.ok(expected.length>100);assert.deepEqual(result,expected);assert.equal(new Set(result.map(r=>r.id)).size,result.length);
  assert.equal((await client.call(base+collection+(collection==='credentials'?'?participant_id='+administrationTarget:''))).body.length,100);
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes(agent.secret));assert.ok(!serialized.includes(agent.verifier));assert.ok(!serialized.includes('private-content-canary'));
 }
 assert.deepEqual(await administrationSnapshot(server),before);
 for(const body of [{id:administrationTarget.toUpperCase()},{nickname:'BROWSE_TARGET'}])assert.equal((await admin.call(base+'accounts/lookup',body)).body.id,administrationTarget);
 const missing=await admin.call(base+'accounts/lookup',{id:randomUUID()});assert.equal(missing.status,404);
 assert.equal((await admin.call(base+'accounts/lookup',{id:self.participant_id,nickname:'extra'})).status,400);
});
test('page edges, microsecond ties, full serialized Unicode budgets, oversized item and independent item/work limits',async t=>{
 const {server,admin}=await setup(t);
 const first=await page(admin,'credentials',{participant_id:administrationTarget,limit:1});assert.equal(first.items.length,1);assert.equal(first.complete,false);
 const exact=await page(admin,'credentials',{participant_id:administrationTarget,limit:5});assert.equal(exact.items.length,5);
 const changedSize=await page(admin,'credentials',{participant_id:administrationTarget,limit:2,max_bytes:2048,cursor:exact.next_cursor});assert.equal(changedSize.items[0].id,'20000000-0000-4000-8000-000000000006');
 const small=await all(admin,'credentials',{participant_id:administrationTarget,max_bytes:1536});assert.equal(small.length,135);
 const empty=await page(admin,'credentials',{participant_id:server.administratorId,limit:25});assert.equal(empty.complete,true);
 const other=randomUUID();await server.observer.query("INSERT INTO loom.participants(id,state,role,kind,nickname) VALUES($1,'active','participant','agent','empty_fixture')",[other]);
 assert.deepEqual((await page(admin,'credentials',{participant_id:other})).items,[]);
 const two=['40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002'];
 await server.observer.query("INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label,verifier,expires_at) SELECT id::uuid,$2,'revoked','agent','Small boundary',repeat('c',64),'2020-01-01Z' FROM unnest($1::text[]) AS ids(id)",[two,other]);
 const full=await page(admin,'credentials',{participant_id:other,limit:2});assert.equal(full.complete,true);assert.deepEqual(full.items.map((r:any)=>r.id),two);
 const extra=await page(admin,'credentials',{participant_id:other,limit:1});assert.equal(extra.complete,false);assert.deepEqual((await page(admin,'credentials',{participant_id:other,limit:1,cursor:extra.next_cursor})).items.map((r:any)=>r.id),[two[1]]);
 await server.observer.query("UPDATE loom.participant_credentials SET label=repeat('Ω',700) WHERE id=$1",[two[0]]);
 const retained=await page(admin,'credentials',{participant_id:other,limit:1});
 assert.deepEqual(retained.items.map((r:any)=>r.id),[two[0]]);
 assert.deepEqual((await page(admin,'credentials',{participant_id:other,limit:1,cursor:retained.next_cursor})).items.map((r:any)=>r.id),[two[1]]);
 await server.observer.query("UPDATE loom.participant_credentials SET label=repeat('oversized',10000) WHERE id=$1",[two[1]]);
 const prefix=await page(admin,'credentials',{participant_id:other,limit:2});assert.deepEqual(prefix.items.map((r:any)=>r.id),[two[0]]);assert.equal(prefix.complete,false);
 assert.equal((await admin.call(base+'credentials/query',{participant_id:other,cursor:prefix.next_cursor})).body.error.code,'page_budget_exceeded');

 await server.observer.query("UPDATE loom.participant_credentials SET label=repeat('Ω\"\\',20000) WHERE id=$1",[first.items[0].id]);
 const oversized=await admin.call(base+'credentials/query',{participant_id:administrationTarget,max_bytes:1024});assert.equal(oversized.status,413);assert.equal(oversized.body.error.code,'page_budget_exceeded');
 assert.equal((await admin.call(base+'accounts/query',{limit:26})).status,400);
 assert.equal((await admin.call(base+'accounts/query',{max_bytes:1023})).status,400);
 assert.equal((await admin.call(base+'accounts/query',{cursor:'x'.repeat(1025)})).status,400);
 assert.equal((await admin.call(base+'accounts/query',{cursor:'x'.repeat(5000)})).status,413);
 for(const [sql,args] of [
  ["SELECT id FROM loom.participants WHERE kind <> 'internal' AND id > $1 ORDER BY id LIMIT 26",['10000000-0000-4000-8000-000000000100']],
  ['SELECT id FROM loom.participant_credentials WHERE participant_id=$1 AND id>$2 ORDER BY id LIMIT 26',[administrationTarget,'20000000-0000-4000-8000-000000000100']],
  ["SELECT id FROM loom.administrative_audit WHERE (recorded_at,id)>($1,$2) ORDER BY recorded_at,id LIMIT 26",['2020-01-01T00:00:00.000123Z','30000000-0000-4000-8000-000000000100']],
 ] as const){await server.observer.query('ANALYZE');const result=await server.observer.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,[...args]);const plan=result.rows[0]['QUERY PLAN'][0];console.log(JSON.stringify({administration_query:plan.Plan['Node Type'],rows:plan.Plan['Actual Rows'],execution_ms:plan['Execution Time'],plan:plan.Plan}));assert.ok(plan.Plan['Actual Rows']<=26);}
});
test('every collection invalidates on committed creation/rename/state/issuance/revocation/audit insertion, including behind the key',async t=>{
 const {server,admin}=await setup(t);
 for(const sql of ["UPDATE loom.participants SET nickname='renamed_target' WHERE id=$1","UPDATE loom.participants SET state='suspended' WHERE id=$1","UPDATE loom.participants SET state='active' WHERE id=$1"]){const first=await page(admin,'accounts',{limit:1});await server.observer.query(sql,[administrationTarget]);const next=await admin.call(base+'accounts/query',{cursor:first.next_cursor});assert.equal(next.body.error.code,'collection_changed');}
 const first=await page(admin,'accounts',{limit:1});await server.observer.query("INSERT INTO loom.participants(id,state,role,kind,nickname) VALUES('00000000-0000-4000-8000-000000000003','active','participant','agent','behind_key')");assert.equal((await admin.call(base+'accounts/query',{cursor:first.next_cursor})).body.error.code,'collection_changed');
 const credentials=await page(admin,'credentials',{participant_id:administrationTarget,limit:1});
 const issued=await admin.call(base+'credentials',{idempotency_key:randomUUID(),participant_id:administrationTarget,kind:'agent',purpose:null,label:'Fresh',replace_credential_id:null});assert.equal(issued.status,200);
 assert.equal((await admin.call(base+'credentials/query',{participant_id:administrationTarget,cursor:credentials.next_cursor})).body.error.code,'collection_changed');
 const current=await page(admin,'credentials',{participant_id:administrationTarget,limit:1});
 assert.equal((await admin.call(base+'revoke',{idempotency_key:randomUUID(),participant_id:administrationTarget,credential_id:issued.body.credential_id})).status,200);
 assert.equal((await admin.call(base+'credentials/query',{participant_id:administrationTarget,cursor:current.next_cursor})).body.error.code,'collection_changed');
 const audit=await page(admin,'audit',{limit:1});await server.observer.query("INSERT INTO loom.administrative_audit(id,authority,target_id,action,operation_id,recorded_at) SELECT $1,'deployment_recovery',participant_id,'late behind timestamp',id,'1900-01-01Z' FROM loom.identity_outcomes LIMIT 1",[randomUUID()]);assert.equal((await admin.call(base+'audit/query',{cursor:audit.next_cursor})).body.error.code,'collection_changed');
 assert.ok((await all(admin,'accounts')).some(r=>r.nickname==='behind_key'));
});
test('cursor scope, owner, tampering, expiry and restart are explicit; authority is checked before cursor and target',async t=>{
 const {server,admin,self,cert}=await setup(t);
 const first=await page(admin,'accounts',{limit:1});
 for(const [collection,body] of [['audit',{cursor:first.next_cursor}],['credentials',{participant_id:administrationTarget,cursor:first.next_cursor}],['accounts',{cursor:first.next_cursor.slice(0,-5)+'aaaaa'}],['accounts',{cursor:'malformed'}]] as const){assert.equal((await admin.call(base+collection+'/query',body)).body.error.code,'invalid_cursor');}
 const c=await page(admin,'credentials',{participant_id:administrationTarget,limit:1});assert.equal((await admin.call(base+'credentials/query',{participant_id:self.participant_id,cursor:c.next_cursor})).body.error.code,'invalid_cursor');
 const now=Date.now;t.mock.method(Date,'now',()=>now()+601000);assert.equal((await admin.call(base+'accounts/query',{cursor:first.next_cursor})).body.error.code,'cursor_expired');t.mock.restoreAll();
 const actor=actorFromVerifiedIdentity({participantId:self.participant_id,credentialId:self.credential_id});
 const restarted=new AdministrationBrowsing(server.database);await assert.rejects(restarted.accounts(actor,{cursor:first.next_cursor}),{code:'cursor_restart'});
 const token=opaqueToken('agent'),id=randomUUID();await server.observer.query("INSERT INTO loom.participants(id,state,role,kind,nickname) VALUES($1,'active','administrator','agent','other_admin')",[id]);await server.observer.query("INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label,verifier,expires_at) VALUES($1,$2,'active','agent','Other',$3,clock_timestamp()+interval '1 hour')",[token.id,id,token.verifier]);const other=httpClient(server.origin,cert,token.secret);
 assert.equal((await other.call(base+'accounts/query',{cursor:first.next_cursor})).body.error.code,'invalid_cursor');
 await server.observer.query("UPDATE loom.participants SET role='participant' WHERE id=$1",[id]);
 for(const path of ['accounts/query','credentials/query','audit/query','accounts/lookup'])assert.equal((await other.call(base+path,path==='accounts/lookup'?{id:randomUUID()}:{...(path.startsWith('credentials')?{participant_id:randomUUID()}:{}),cursor:first.next_cursor})).status,403);
 await server.observer.query("UPDATE loom.participants SET role='administrator',state='suspended' WHERE id=$1",[id]);assert.equal((await other.call(base+'accounts/query',{cursor:first.next_cursor})).status,401);
 await server.observer.query("UPDATE loom.participants SET state='active' WHERE id=$1",[id]);await server.observer.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[token.id]);assert.equal((await other.call(base+'audit/query',{cursor:first.next_cursor})).status,401);
});
for(const change of ['demote','suspend','revoke'] as const)for(const order of ['withdrawal-first','read-first'] as const)
test(`current authority at actual database guard ordering: ${change} ${order}`,async t=>{
 let armed=false,phase='';const entered=barrier(),release=barrier();let readerPid=0;
 const server=await syntheticServer({transactionWrapper:database=>({transaction:operation=>database.transaction(async tx=>{
  let browsing=false;
  return operation({query:async(sql,args)=>{
   if(sql.startsWith('SET TRANSACTION ISOLATION'))browsing=true;
   if(armed&&browsing&&((order==='withdrawal-first'&&sql.startsWith('SELECT state, role, kind, nickname'))||(order==='read-first'&&sql.startsWith('SELECT version::text')))){
    armed=false;phase='paused';if(order==='read-first')readerPid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid',[])).rows[0]!.pid;
    entered.release();await bounded(release.promise);
   }
   return tx.query(sql,args);
  }});
 })})});t.after(()=>server.close());
 const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert),self=await admin.enroll(server.ticket);
 await populateAdministration(server);const first=await page(admin,'accounts',{limit:1});
 const sql=change==='revoke'?"UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1":change==='suspend'?"UPDATE loom.participants SET state='suspended' WHERE id=$1":"UPDATE loom.participants SET role='participant' WHERE id=$1";
 const id=change==='revoke'?self.credential_id:self.participant_id;
 armed=true;const pending=admin.call(base+'accounts/query',{cursor:first.next_cursor});await bounded(entered.promise);assert.equal(phase,'paused');
 const observer=server.observer,holder=(await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await observer.query('BEGIN');let mutation:Promise<unknown>|undefined;
 try {
  if(order==='withdrawal-first'){
   await observer.query(sql,[id]);release.release();
   const deadline=Date.now()+5000;let waiter=0;
   while(!waiter){const r=await observer.query("SELECT pid FROM pg_stat_activity WHERE usename='loom_app' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1",[holder]);waiter=r.rows[0]?.pid??0;if(Date.now()>deadline)throw new Error('Authority reader did not wait');}
   await blockedBy(observer,waiter,holder);await observer.query('COMMIT');
   const response=await pending;assert.ok([401,403,503].includes(response.status));
  } else {
   mutation=observer.query(sql,[id]);
   // A second observer connection is needed while the writer is blocked.
   const monitor=new pg.Client({...server.configuration,user:server.configuration.user});await monitor.connect();
   try{await blockedBy(monitor,holder,readerPid);}finally{await monitor.end();}
   release.release();assert.equal((await pending).status,200);await mutation;await observer.query('COMMIT');
  }
  assert.equal((await admin.call(base+'accounts/query',{cursor:first.next_cursor})).status,change==='demote'?403:401);
 }finally{release.release();await mutation;await observer.query('ROLLBACK');await pending;}
});
test('audit commit order rather than timestamp/UUID determines invalidation, without blocking reads on a pending writer',async t=>{
 const {server,admin}=await setup(t);const db=server.observer;
 const first=await page(admin,'audit',{limit:1});
 const operation=(await db.query('SELECT id FROM loom.identity_outcomes LIMIT 1')).rows[0].id;
 // Own separate connections and committed parent references; audit times are reversed.
 const writer=new pg.Client(server.configuration),monitor=new pg.Client(server.configuration);await writer.connect();await monitor.connect();

 const a=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,b=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await db.query('BEGIN');await writer.query('BEGIN');
 const insert="INSERT INTO loom.administrative_audit(id,authority,target_id,action,operation_id,recorded_at) VALUES($1,'deployment_recovery',$2,'reversed commit',$3,$4)";
 await db.query(insert,[randomUUID(),administrationTarget,operation,'2090-01-01Z']);
 const pending=writer.query(insert,[randomUUID(),administrationTarget,operation,'1900-01-01Z']);
 try{
  await blockedBy(monitor,b,a);await db.query('COMMIT');await pending;
  assert.equal((await admin.call(base+'audit/query',{cursor:first.next_cursor})).body.error.code,'collection_changed');
  const intermediate=await page(admin,'audit',{limit:1});
  await writer.query('COMMIT');assert.equal((await admin.call(base+'audit/query',{cursor:intermediate.next_cursor})).body.error.code,'collection_changed');
  const refreshed=await all(admin,'audit');assert.ok(refreshed.some(r=>r.recorded_at==='1900-01-01T00:00:00.000000Z'));assert.ok(refreshed.some(r=>r.recorded_at==='2090-01-01T00:00:00.000000Z'));
 }finally{await db.query('ROLLBACK');await writer.query('ROLLBACK');await pending;await writer.end();await monitor.end();}
});
test('populated additive upgrade preserves all old table bytes and exact issuance replay identities',async t=>{
 const server=await syntheticServer({throughMigration:24});t.after(()=>server.close());
 const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert);await admin.enroll(server.ticket);await populateAdministration(server);
 const body={idempotency_key:randomUUID(),participant_id:administrationTarget,kind:'agent',purpose:null,label:'Upgrade replay',replace_credential_id:null};
 const issued=await admin.call(base+'credentials',body);assert.equal(issued.status,200);
 const before=await administrationSnapshot(server);await server.migrate();
 const after=await administrationSnapshot(server);for(const [name,hash]of Object.entries(before))assert.equal(after[name],hash,name);
 const replay=await admin.call(base+'credentials',body);assert.equal(replay.status,200);assert.equal(replay.body.operation_id,issued.body.operation_id);assert.equal(replay.body.credential_id,issued.body.credential_id);assert.equal(replay.body.secret,undefined);
 assert.ok((await all(admin,'accounts')).some(r=>r.id===administrationTarget));
});
test('independent HTTPS client walks all three collections with private files and no mutation or secret output',async t=>{
 const {server,admin,self}=await setup(t);const actor=actorFromVerifiedIdentity({participantId:self.participant_id,credentialId:self.credential_id});
 const created=await server.administration.createAccount(actor,{idempotency_key:randomUUID(),nickname:'client_admin',kind:'agent',role:'administrator'});
 const issued=await server.administration.issueCredential(actor,{idempotency_key:randomUUID(),participant_id:created.participant_id,kind:'agent',purpose:null,label:'Client',replace_credential_id:null});
 const directory=await mkdtemp(join(tmpdir(),'loom-admin-client-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const credential=join(directory,'credential');await writeFile(credential,issued.secret!,{mode:0o600});const before=await administrationSnapshot(server);
 for(const collection of ['accounts','credentials','audit']){
  let previous:string|undefined;const ids:string[]=[];
  for(let n=0;n<30;n++){
   const output=join(directory,collection+'-'+n+'.json');const args=['scripts/administration-client.mjs','--origin',server.origin,'--ca',server.directory+'/cert.pem','--credential-file',credential,'--collection',collection,'--output',output,'--limit','11',...(collection==='credentials'?['--participant',administrationTarget.toUpperCase()]:[]),...(previous?['--after-page',previous]:[])];
   const result=await promisify(execFile)(process.execPath,args);assert.ok(!result.stdout.includes(issued.secret!));assert.equal(result.stderr,'');
   const saved=JSON.parse(await readFile(output,'utf8'));ids.push(...saved.page.items.map((i:any)=>i.id));previous=output;if(saved.page.complete)break;
  }
  const expected=await all(admin,collection,collection==='credentials'?{participant_id:administrationTarget}:{});assert.deepEqual(ids,expected.map(r=>r.id));assert.ok(ids.length>100);
 }
 assert.deepEqual(await administrationSnapshot(server),before);
 const lookup=join(directory,'lookup.json');await promisify(execFile)(process.execPath,['scripts/administration-client.mjs','--origin',server.origin,'--ca',server.directory+'/cert.pem','--credential-file',credential,'--nickname','browse_target','--output',lookup]);assert.equal(JSON.parse(await readFile(lookup,'utf8')).page.id,administrationTarget);
});
test('serialized responses and actual logs exclude secrets, verifiers and private content; query timeout remains a retryable read',async t=>{
 let log='',slow=false,fail=false;
 const secretCanary='ADMIN_SECRET_CANARY_9c7f',privateCanary='ADMIN_PRIVATE_CANARY_7fa2';
 const server=await syntheticServer({logger:{stream:{write:(chunk:string)=>{log+=chunk;}}},transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async(sql,args)=>{
  if(sql.startsWith('SELECT version::text')){if(fail)throw new Error(secretCanary);if(slow)await tx.query('SELECT pg_sleep(2)',[]);}
  return tx.query(sql,args);
 }}))})});t.after(()=>server.close());
 const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert),self=await admin.enroll(server.ticket);await populateAdministration(server);
 await server.observer.query('INSERT INTO loom.note_owners(participant_id,identities,active) VALUES($1,1,1)',[self.participant_id]);
 await server.observer.query('INSERT INTO loom.private_notes(participant_id,id,version,title,body,links) VALUES($1,$2,1,$3,$3,$4)',[self.participant_id,randomUUID(),privateCanary,JSON.stringify([])]);
 const before=await administrationSnapshot(server),responses:string[]=[];
 for(const collection of ['accounts','credentials','audit'])responses.push(JSON.stringify(await all(admin,collection,collection==='credentials'?{participant_id:administrationTarget}:{})));
 responses.push(JSON.stringify((await admin.call(base+'accounts/query',{extra:secretCanary})).body));
 fail=true;const failed=await admin.call(base+'audit/query',{});assert.equal(failed.status,503);assert.equal(failed.body.error.operation_outcome,undefined);fail=false;
 slow=true;const started=Date.now(),timeout=await admin.call(base+'accounts/query',{});slow=false;
 assert.equal(timeout.status,503);assert.equal(timeout.body.error.code,'retryable');assert.equal(timeout.body.error.recovery.action,'retry_same_request');assert.ok(Date.now()-started<3000);
 assert.equal((await admin.call(base+'accounts/query',{})).status,200);
 for(const value of [secretCanary,privateCanary,server.ticket,'a'.repeat(64)]){assert.ok(!log.includes(value));assert.ok(responses.every(r=>!r.includes(value)));}
 assert.ok(log.length>0);assert.deepEqual(await administrationSnapshot(server),before);
});
test('compiled HTTPS process restart invalidates every page cursor while preserving current cookie identity and fresh traversal',{timeout:90000},async t=>{
 const {server,admin}=await setup(t);await server.app.close();
 const directory=await mkdtemp(join(tmpdir(),'loom-admin-restart-'));
 const script=join(directory,'server.mjs');
 const modulePath=(name:string)=>new URL('../../dist/server/'+name,import.meta.url).href;
 await writeFile(script,`import {createApplication} from ${JSON.stringify(modulePath('http/app.js'))};
import {PostgresDatabase} from ${JSON.stringify(modulePath('db/postgres.js'))};
import {participationProfile} from ${JSON.stringify(modulePath('participation-profile.js'))};
process.once('message',async({configuration,origin,tls,browserRoot})=>{
 const database=new PostgresDatabase(configuration);
 const application=await createApplication({database,logger:false,tls,browserRoot,participation:participationProfile(database,{LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:origin})});
 await application.listen({host:'127.0.0.1',port:Number(new URL(origin).port)});
 process.once('SIGTERM',async()=>{await application.close();process.exit(0);});process.send('ready');
});`,{mode:0o600});
 let child:ChildProcess|undefined;
 const stop=async()=>{if(!child)return;const current=child;child=undefined;const exit=once(current,'exit');current.kill('SIGTERM');assert.equal((await exit)[0],0);};
 const tls={cert:await readFile(server.directory+'/cert.pem','utf8'),key:await readFile(server.directory+'/key.pem','utf8')};
 const start=async()=>{
  child=fork(script,[],{execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout!.on('data',b=>{output+=b});child.stderr!.on('data',b=>{output+=b});
  const ready=once(child,'message');child.send({configuration:server.configuration,origin:server.origin,tls,browserRoot:fileURLToPath(new URL('../../dist/web/',import.meta.url))});assert.equal((await bounded(ready))[0],'ready');assert.equal(output,'');
 };
 try{
  await start();const cursors:{collection:string;body:Record<string,unknown>}[]=[];
  for(const collection of ['accounts','credentials','audit']){const body={limit:1,...(collection==='credentials'?{participant_id:administrationTarget}:{})};const r=await page(admin,collection,body);assert.ok(r.next_cursor);cursors.push({collection,body:{...body,cursor:r.next_cursor}});}
  const self=(await admin.call(base+'self')).body;await stop();await start();assert.equal((await admin.call(base+'self')).body.participant_id,self.participant_id);
  for(const {collection,body}of cursors){const refused=await admin.call(base+collection+'/query',body);assert.equal(refused.status,409);assert.equal(refused.body.error.code,'cursor_restart');const result=await all(admin,collection,collection==='credentials'?{participant_id:administrationTarget}:{});assert.ok(result.length>100);}
 }finally{await stop();await rm(directory,{recursive:true,force:true});}
});
