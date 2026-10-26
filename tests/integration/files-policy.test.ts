import {fork,execFile,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import type {QueryResultRow} from 'pg';
import {ListObjectVersionsCommand} from '@aws-sdk/client-s3';
import {fixture} from '../helpers/references.js';
import {httpClient} from '../helpers/participation-http.js';
import {barrier,bounded,blockedBy} from '../helpers/search-races.js';
import {administrationSnapshot} from '../helpers/administration.js';
import {packageText,prepareText} from '../helpers/file-text.js';

const path='/api/v1/admin/file-limits',own='/api/v1/file-limits';
const defaults={version:1,max_file_bytes:4194304,max_unfinished_uploads:4,participant_reserved_bytes:67108864,community_reserved_bytes:268435456};
type Fixture=Awaited<ReturnType<typeof fixture>>;
function upload(f:Fixture,bytes=Buffer.from('12345'),extra={}){return {idempotency_key:randomUUID(),target:{kind:'area',resource_id:f.area},path:'policy.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain',...extra};}
async function change(f:Fixture,patch:Record<string,number>){
  const current=await f.admin.call(path);assert.equal(current.status,200,JSON.stringify(current.body));
  const {version,...limits}=current.body.policy;
  const input={...limits,...patch,expected_version:version,idempotency_key:randomUUID()};
  const result=await f.admin.call(path+'/state',input);assert.equal(result.status,200,JSON.stringify(result.body));return {input,result:result.body};
}
async function reservation(f:Fixture){return (await f.observer.query("SELECT count(*)::int n,coalesce(sum(size*2) FILTER(WHERE reserved),0)::int bytes FROM loom.file_uploads")).rows[0];}
async function effects(f:Fixture){const state:Record<string,unknown>={};for(const table of ['file_uploads','file_contexts','resources','revisions','shared_activity','outbox_intents','idempotency_records','file_admission_policy','file_policy_decisions'])state[table]=(await f.observer.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') rows FROM loom.${table} t`)).rows[0].rows;return state;}

test('file policy defaults, integer ceilings, own discovery, administrator attribution and exact K1/K2 recovery',async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('file_policy_agent'),human=await f.participant('file_policy_human','human');
  assert.deepEqual((await f.admin.call(path)).body.policy,defaults);
  for(const who of [a,human]){
    const result=await who.client.call(own);assert.equal(result.status,200);assert.deepEqual(result.body.policy,defaults);
    assert.deepEqual(result.body.own,{reserved_bytes:0,unfinished_uploads:0,reserved_bytes_over_limit:false,unfinished_uploads_over_limit:false});
    assert.deepEqual(Object.keys(result.body).sort(),['observed_at','own','policy']);assert.ok(Date.parse(result.body.observed_at));
    for(const [url,body] of [[path,undefined],[path+'/audit',{}],[path+'/status',{idempotency_key:randomUUID()}],[path+'/state',{...defaults,version:undefined,expected_version:1,idempotency_key:randomUUID()}]] as const)assert.equal((await who.client.call(url,body)).status,403);
  }
  for(const field of ['max_file_bytes','max_unfinished_uploads','participant_reserved_bytes','community_reserved_bytes'] as const)for(const value of [0,-1,1.5,defaults[field]+1]){
    const {version,...limits}=defaults;assert.equal((await f.admin.call(path+'/state',{...limits,[field]:value,expected_version:version,idempotency_key:randomUUID()})).status,400);
  }
  const first=await change(f,{max_file_bytes:10,participant_reserved_bytes:20,community_reserved_bytes:40}),second=await change(f,{max_file_bytes:2});
  const replay=await f.admin.call(path+'/state',first.input);assert.deepEqual(replay.body.original,first.result.original);assert.deepEqual(replay.body.current,second.result.current);
  assert.equal((await f.admin.call(path+'/state',{...first.input,max_file_bytes:9})).body.error.code,'idempotency_conflict');
  assert.deepEqual((await f.admin.call(path+'/status',{idempotency_key:first.input.idempotency_key})).body,replay.body);
  const otherAdmin=await f.admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'other_file_admin',kind:'agent',role:'administrator'});
  const otherCredential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:otherAdmin.body.participant_id,kind:'agent',purpose:null,label:'Separate policy owner',replace_credential_id:null});assert.equal(otherCredential.status,200);
  const otherClient=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),otherCredential.body.secret);
  assert.deepEqual((await otherClient.call(path+'/status',{idempotency_key:first.input.idempotency_key})).body,{operation_state:'not_recorded'});
  const audit=await f.admin.call(path+'/audit',{limit:1});assert.equal(audit.body.items[0].actor_id,f.administratorId);assert.ok(audit.body.items[0].actor_credential_id);assert.equal(audit.body.items[0].policy.version,3);
  const earlier=await f.admin.call(path+'/audit',{before_version:audit.body.next_before_version});assert.equal(earlier.body.items[0].policy.version,2);assert.equal(earlier.body.next_before_version,null);
  assert.equal((await f.admin.call(path+'/audit',{limit:26})).status,400);
  const state=await effects(f);await f.admin.call(path);await a.client.call(own);await f.admin.call(path+'/audit',{});assert.deepEqual(await effects(f),state);
  await f.restart();assert.deepEqual((await f.admin.call(path)).body.policy,second.result.current);assert.deepEqual((await f.admin.call(path+'/state',first.input)).body,replay.body);
  const conflict=await f.admin.call(path+'/state',{...second.input,idempotency_key:randomUUID()});assert.equal(conflict.body.error.code,'file_policy_conflict');
  await f.observer.query('UPDATE loom.file_admission_policy SET version=10001');
  assert.equal((await f.admin.call(path+'/state',{...first.input,expected_version:10001,idempotency_key:randomUUID()})).body.error.code,'file_policy_capacity');
  assert.equal((await f.admin.call(path+'/status',{idempotency_key:first.input.idempotency_key})).body.original.version,2);
  await assert.rejects(f.database.transaction(tx=>tx.query('DELETE FROM loom.file_policy_decisions',[])),/permission denied/);
});

test('shared owner reservations isolate participants, include zero-byte unfinished identities and never refill on restart',async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('reservation_a'),b=await f.participant('reservation_b','human');
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Separate file client',replace_credential_id:null});
  const other=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),issued.body.secret);
  await change(f,{max_file_bytes:10,participant_reserved_bytes:20,community_reserved_bytes:30,max_unfinished_uploads:3});
  const one=await a.client.call('/api/v1/file-uploads',upload(f));assert.equal(one.status,201);
  assert.equal((await other.call('/api/v1/file-uploads',upload(f))).status,201);
  const before=await reservation(f);const denied=await a.client.call('/api/v1/file-uploads',upload(f));assert.equal(denied.body.error.code,'file_reserved_capacity');assert.equal(denied.status,409);assert.equal(denied.headers['retry-after'],undefined);assert.equal(denied.body.error.retry_after_seconds,undefined);assert.deepEqual(await reservation(f),before);
  assert.equal((await b.client.call('/api/v1/file-uploads',upload(f))).status,201);
  assert.equal((await b.client.call('/api/v1/file-uploads',upload(f))).body.error.code,'file_reserved_capacity');
  assert.equal((await other.call(own)).body.own.reserved_bytes,20);assert.equal((await b.client.call(own)).body.own.reserved_bytes,10);
  const zero=upload(f,Buffer.alloc(0));assert.equal((await other.call('/api/v1/file-uploads',zero)).status,201);
  assert.equal((await a.client.call('/api/v1/file-uploads',upload(f,Buffer.alloc(0)))).body.error.code,'file_unfinished_capacity');
  assert.deepEqual(await reservation(f),{n:4,bytes:30});
  await change(f,{participant_reserved_bytes:1,community_reserved_bytes:1,max_unfinished_uploads:1});
  const current=(await a.client.call(own)).body;assert.equal(current.own.reserved_bytes,20);assert.equal(current.own.reserved_bytes_over_limit,true);assert.equal(current.own.unfinished_uploads_over_limit,true);
  assert.equal((await f.admin.call(path)).body.community.reserved_bytes_over_limit,true);
  await f.restart();assert.deepEqual(await reservation(f),{n:4,bytes:30});assert.equal((await other.call(own)).body.own.reserved_bytes,20);
});

for(const boundary of ['owner','community','unfinished'] as const)test('competing upload identities cannot over-admit '+boundary,async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('racing_owner'),b=await f.participant('racing_other');
  await change(f,{max_file_bytes:10,participant_reserved_bytes:boundary==='owner'?10:100,community_reserved_bytes:boundary==='community'?10:200,max_unfinished_uploads:boundary==='unfinished'?1:4});
  const results=await Promise.all(Array.from({length:8},(_,i)=>(boundary==='community'&&i%2?b:a).client.call('/api/v1/file-uploads',upload(f))));
  assert.equal(results.filter(r=>r.status===201).length,1);
  for(const r of results.filter(r=>r.status!==201))assert.equal(r.body.error.code,boundary==='unfinished'?'file_unfinished_capacity':'file_reserved_capacity');
  assert.deepEqual(await reservation(f),{n:1,bytes:10});
});

for(const order of ['admission-first','policy-first'] as const)test('file policy and new admission observe actual custody contention: '+order,async t=>{
  const held=barrier(),release=barrier(),contending=barrier();let armed=false,owner='',uploadPid=0,policyPid=0;
  t.after(()=>release.release());
  const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:work=>db.transaction(tx=>{
    let participant='';return work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{
      if(sql.startsWith('SELECT state, role, kind, nickname FROM loom.participants'))participant=String(args[0]);
      if(armed&&sql.includes('pg_advisory_xact_lock')&&args[0]===0x4c4f4f4d&&args[1]===15){
        const admission=participant===owner,pid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid;
        if(admission)uploadPid=pid;else policyPid=pid;
        if((order==='admission-first')===admission){const result=await tx.query<R>(sql,args);held.release();await bounded(release.promise);return result;}contending.release();
      }return tx.query<R>(sql,args);
    }});
  })})});
  const a=await f.participant('file_guard_race');owner=a.id;
  const firstPolicy=await change(f,{participant_reserved_bytes:10});
  const body={...firstPolicy.input,idempotency_key:randomUUID(),expected_version:firstPolicy.result.current.version,participant_reserved_bytes:1};
  const input=upload(f);armed=true;
  const first=order==='admission-first'?a.client.call('/api/v1/file-uploads',input):f.admin.call(path+'/state',body);await bounded(held.promise);
  const second=order==='admission-first'?f.admin.call(path+'/state',body):a.client.call('/api/v1/file-uploads',input);
  try{await bounded(contending.promise);await blockedBy(f.observer,order==='admission-first'?policyPid:uploadPid,order==='admission-first'?uploadPid:policyPid);}finally{armed=false;release.release();}
  const results=await Promise.all([first,second]);assert.equal(results[order==='admission-first'?1:0]!.status,200);assert.equal(results[order==='admission-first'?0:1]!.status,order==='admission-first'?201:409);
  assert.deepEqual(await reservation(f),order==='admission-first'?{n:1,bytes:10}:{n:0,bytes:0});
  if(order==='admission-first')assert.equal((await a.client.call('/api/v1/file-uploads',input)).body.upload_id,results[0]!.body.upload_id);
});

test('lost admission acknowledgement recovers the exact identity after decrease and completes original bytes without renewing expiry',async t=>{
  let lose=false;
  const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:async work=>{let created=false;const value=await db.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{const result=await tx.query<R>(sql,args);if(sql.startsWith('INSERT INTO loom.file_uploads'))created=true;return result;}}));if(lose&&created){lose=false;throw new Error('Lost committed admission acknowledgement');}return value;}})});
  const a=await f.participant('lost_file'),bytes=Buffer.from('12345'),input=upload(f,bytes);lose=true;
  assert.equal((await a.client.call('/api/v1/file-uploads',input)).status,503);
  const admitted=(await a.client.call('/api/v1/file-uploads/status',{idempotency_key:input.idempotency_key})).body;
  await change(f,{max_file_bytes:1,participant_reserved_bytes:1,community_reserved_bytes:1});
  assert.deepEqual((await a.client.call('/api/v1/file-uploads',input)).body,admitted);
  assert.equal((await a.client.call('/api/v1/file-uploads',{...input,sha256:'0'.repeat(64)})).body.error.code,'idempotency_conflict');
  assert.equal((await a.client.call('/api/v1/file-uploads',{...input,idempotency_key:randomUUID()})).body.error.code,'file_size_limit');
  assert.equal((await a.client.call(`/api/v1/file-uploads/${admitted.upload_id}/bytes`,undefined,{bytes})).status,200);
  const prepared=await a.client.call(`/api/v1/file-uploads/${admitted.upload_id}/finalize`,{});assert.equal(prepared.body.state,'prepared');assert.equal(prepared.body.upload_expires_at,admitted.upload_expires_at);assert.equal(prepared.body.prepared_expires_at,admitted.prepared_expires_at);
  assert.deepEqual(await reservation(f),{n:1,bytes:10});await f.restart();assert.equal((await a.client.call('/api/v1/file-uploads',input)).body.upload_id,admitted.upload_id);
  await change(f,{max_file_bytes:10,participant_reserved_bytes:20,community_reserved_bytes:20});assert.equal((await a.client.call('/api/v1/file-uploads',{...input,idempotency_key:randomUUID()})).status,201);assert.deepEqual(await reservation(f),{n:2,bytes:20});
});

test('policy and admission failures roll back atomic custody; missing policy fails closed',async t=>{
  let fail='';const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<R extends QueryResultRow>(sql:string,args:readonly unknown[])=>{const result=await tx.query<R>(sql,args);if(fail&&sql.startsWith(fail))throw new Error('Injected failure');return result;}}))})});
  const before=await effects(f);fail='INSERT INTO loom.file_policy_decisions';
  const {version,...limits}=defaults;assert.equal((await f.admin.call(path+'/state',{...limits,max_file_bytes:1,expected_version:version,idempotency_key:randomUUID()})).status,503);fail='';assert.deepEqual(await effects(f),before);
  fail='INSERT INTO loom.file_uploads';assert.equal((await f.admin.call('/api/v1/file-uploads',upload(f))).status,503);fail='';assert.deepEqual(await effects(f),before);
  await change(f,{max_file_bytes:1});const deniedBefore=await effects(f);assert.equal((await f.admin.call('/api/v1/file-uploads',upload(f))).body.error.code,'file_size_limit');assert.deepEqual(await effects(f),deniedBefore);
  const storage=f.fileFixture!.storage;
  for(const Bucket of [storage.configuration.stagingBucket,storage.configuration.finalBucket]){
    const native=await storage.client.send(new ListObjectVersionsCommand({Bucket,MaxKeys:1}));
    assert.deepEqual(native.Versions??[],[]);assert.deepEqual(native.DeleteMarkers??[],[]);assert.equal(native.IsTruncated,false);
  }
  await f.observer.query('DELETE FROM loom.file_admission_policy');assert.equal((await f.admin.call('/api/v1/file-uploads',upload(f))).status,503);assert.deepEqual(await reservation(f),{n:0,bytes:0});
});

test('0028 preserves populated custody, promotion, v4 references, private state, rates and original outcomes',async t=>{
  const f=await fixture(t,{files:true,throughMigration:27});
  const published=await packageText(f),prepared=upload(f),abandoned=upload(f,Buffer.from('unused'));
  assert.equal((await f.admin.call('/api/v1/file-uploads',abandoned)).status,201);
  const admitted=await f.admin.call('/api/v1/file-uploads',prepared);assert.equal(admitted.status,201);
  assert.equal((await f.admin.call(`/api/v1/file-uploads/${admitted.body.upload_id}/bytes`,undefined,{bytes:Buffer.from('12345')})).status,200);
  assert.equal((await f.admin.call(`/api/v1/file-uploads/${admitted.body.upload_id}/finalize`,{})).status,200);
  const attachment=await prepareText(f.admin,{kind:'opening',resource_id:f.area},'attachment.txt',Buffer.from('promoted'));
  const discussion=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Upgrade attachments',content:{format:'loom-markdown-v4',text:'Exact file reference',mentions:[],references:[{reference_id:randomUUID(),target:{kind:'artifact',resource_id:published.resource_id,revision_id:published.revision_id,file_id:published.file.file_id,path:published.file.path},relationship:null,rationale:null}]},change_note:null,change_account:null,attachment_set:{version:'contribution-attachments-v1',files:[attachment]}});assert.equal(discussion.status,201,JSON.stringify(discussion.body));
  const opening={id:discussion.body.resource_id,current_revision_id:discussion.body.revision_id};
  const file=(await f.admin.call(`/api/v1/contributions/${opening.id}/revisions/${opening.current_revision_id}/attachments`)).body.items[0];
  assert.equal((await f.admin.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:opening.id,revision_id:opening.current_revision_id,file_id:file.file_id},area_id:f.area,title:'Upgrade promotion'})).status,201);
  assert.equal((await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:published.resource_id},saved:true,expected_version:0})).status,200);
  const rateBefore=(await f.observer.query('SELECT * FROM loom.participation_rate_windows ORDER BY participant_id,category')).rows;
  const before=await administrationSnapshot(f);await f.migrate();const after=await administrationSnapshot(f);assert.deepEqual((await f.observer.query('SELECT * FROM loom.participation_rate_windows ORDER BY participant_id,category')).rows,rateBefore);for(const [table,hash] of Object.entries(before))assert.equal(after[table],hash,table);
  assert.deepEqual((await f.admin.call(path)).body.policy,defaults);assert.equal((await f.admin.call('/api/v1/artifacts',published.input)).body.revision_id,published.revision_id);assert.equal((await f.admin.call(published.file.download_url)).body,'quartzneedle file content');
});

test('below-usage policy preserves prepared publication, exact reuse and independent promotion with original-owner charges',async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('custody_owner'),b=await f.participant('independent_promoter');
  const bytes=Buffer.from('abcde'),input=upload(f,bytes,{target:{kind:'opening',resource_id:f.area}});
  const admitted=await a.client.call('/api/v1/file-uploads',input);assert.equal(admitted.status,201);
  await a.client.call(`/api/v1/file-uploads/${admitted.body.upload_id}/bytes`,undefined,{bytes});await a.client.call(`/api/v1/file-uploads/${admitted.body.upload_id}/finalize`,{});
  await change(f,{max_file_bytes:1,participant_reserved_bytes:1,community_reserved_bytes:1});
  const discussion=await a.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Independent contexts',content:{format:'loom-markdown-v3',text:'Opening',mentions:[],references:[]},change_note:null,change_account:null,attachment_set:{version:'contribution-attachments-v1',files:[{path:input.path,source:{upload_id:admitted.body.upload_id}}]}});assert.equal(discussion.status,201,JSON.stringify(discussion.body));
  const contribution={id:discussion.body.resource_id,current_revision_id:discussion.body.revision_id};
  const manifest=await b.client.call(`/api/v1/contributions/${contribution.id}/revisions/${contribution.current_revision_id}/attachments`);assert.equal(manifest.status,200);const file=manifest.body.items[0];
  const promotion=await b.client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:contribution.id,revision_id:contribution.current_revision_id,file_id:file.file_id},area_id:f.area,title:'Independent'});assert.equal(promotion.status,201,JSON.stringify(promotion.body));
  const promoted=(await b.client.call(`/api/v1/artifacts/${promotion.body.resource_id}/revisions/${promotion.body.revision_id}/files`)).body.items[0];assert.notEqual(promoted.file_id,file.file_id);
  const revision=await b.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:promotion.body.resource_id,expected_revision_id:promotion.body.revision_id,title:'Reused',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'renamed.txt',source:{revision_id:promotion.body.revision_id,file_id:promoted.file_id}}]}});assert.equal(revision.status,201,JSON.stringify(revision.body));
  assert.deepEqual(await reservation(f),{n:1,bytes:10});assert.equal((await a.client.call(own)).body.own.reserved_bytes,10);assert.equal((await b.client.call(own)).body.own.reserved_bytes,0);
  assert.equal((await b.client.call(file.download_url)).body,'abcde');assert.equal((await a.client.call(promoted.download_url)).body,'abcde');
  await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=(SELECT owner_resource_id FROM loom.resources WHERE id=$1)",[discussion.body.resource_id]);
  assert.equal((await b.client.call(file.download_url)).status,404);assert.equal((await a.client.call(promoted.download_url)).body,'abcde');
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 day'");
  assert.deepEqual((await a.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:0});assert.deepEqual(await reservation(f),{n:1,bytes:10});
});

test('native uncertainty, expiry and failed cleanup retain reservation until exact native removal succeeds once',async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('cleanup_policy'),storage=f.fileFixture!.storage,bytes=Buffer.from('12345'),input=upload(f,bytes);
  const admitted=await a.client.call('/api/v1/file-uploads',input);assert.equal(admitted.status,201);const id=admitted.body.upload_id;
  const put=storage.put.bind(storage);let lose=true;
  const fault=t.mock.method(storage,'put',async(...args:Parameters<typeof storage.put>)=>{const version=await put(...args);if(lose){lose=false;throw new Error('Lost native acknowledgement');}return version;});
  assert.equal((await a.client.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes})).status,503);fault.mock.restore();
  await change(f,{participant_reserved_bytes:1,community_reserved_bytes:1});assert.deepEqual(await reservation(f),{n:1,bytes:10});
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 day',lease_until=NULL WHERE id=$1",[id]);
  const signal=new AbortController().signal;assert.equal((await storage.versions(id,false,signal)).length,1);
  const removal=t.mock.method(storage,'remove',async()=>{throw new Error('Synthetic removal failure');});
  assert.deepEqual((await a.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:1});removal.mock.restore();
  assert.deepEqual(await reservation(f),{n:1,bytes:10});assert.equal((await a.client.call('/api/v1/file-uploads/'+id)).body.state,'quarantined');
  assert.deepEqual((await a.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:0});
  await f.observer.query("UPDATE loom.file_uploads SET lease_until=clock_timestamp()-interval '2 hours' WHERE id=$1",[id]);
  assert.deepEqual((await a.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:1,quarantined:0});
  assert.deepEqual(await storage.versions(id,false,signal),[]);assert.deepEqual(await storage.versions(id,true,signal),[]);
  assert.deepEqual(await reservation(f),{n:1,bytes:0});assert.deepEqual((await a.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:0});
  assert.equal((await a.client.call('/api/v1/file-uploads',input)).body.upload_id,id);assert.equal((await a.client.call('/api/v1/file-uploads',input)).body.state,'expired');
});

test('admission grandfathering retains current source/credential authority and original transfer expiry',async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('current_file_authority'),bytes=Buffer.from('12345');
  const attempts=[];for(let i=0;i<3;i++){const input=upload(f,bytes),r=await a.client.call('/api/v1/file-uploads',input);assert.equal(r.status,201);attempts.push(r.body);}
  await change(f,{max_file_bytes:1,participant_reserved_bytes:1,community_reserved_bytes:1});
  await f.observer.query("UPDATE loom.file_uploads SET upload_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[attempts[0].upload_id]);
  assert.equal((await a.client.call(`/api/v1/file-uploads/${attempts[0].upload_id}/bytes`,undefined,{bytes})).body.error.code,'file_expired');
  await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[f.area]);
  assert.equal((await a.client.call(`/api/v1/file-uploads/${attempts[1].upload_id}/bytes`,undefined,{bytes})).status,404);
  await f.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1",[f.area]);
  await f.observer.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[a.credential]);
  assert.equal((await a.client.call(`/api/v1/file-uploads/${attempts[2].upload_id}/bytes`,undefined,{bytes})).status,401);
  assert.deepEqual(await reservation(f),{n:3,bytes:30});
});

test('separate compiled HTTPS processes share the upload owner and committed policy through process restart',async t=>{
  const f=await fixture(t,{files:true}),a=await f.participant('file_process_owner');
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Separate process',replace_credential_id:null});assert.equal(issued.status,200);
  await change(f,{participant_reserved_bytes:10});
  const module=(name:string)=>new URL('../../dist/server/'+name,import.meta.url).href,script=f.directory+'/file-server.mjs';
  await writeFile(script,`import {createApplication} from ${JSON.stringify(module('http/app.js'))};
import {PostgresDatabase} from ${JSON.stringify(module('db/postgres.js'))};
import {participationProfile} from ${JSON.stringify(module('participation-profile.js'))};
import {FileStorage} from ${JSON.stringify(module('modules/participation/file-storage.js'))};
process.once('message',async({configuration,origin,tls,storage})=>{const database=new PostgresDatabase(configuration);
const app=await createApplication({database,logger:false,tls,participation:{...participationProfile(database,{LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:origin}),fileStorage:new FileStorage(storage)}});
await app.listen({host:'127.0.0.1',port:0});process.send(app.server.address().port);process.once('SIGTERM',async()=>{await app.close();process.exit(0);});});`,{mode:0o600});
  const children:ChildProcess[]=[];
  const stop=async(child:ChildProcess)=>{const exited=once(child,'exit');child.kill('SIGTERM');assert.equal((await exited)[0],0);children.splice(children.indexOf(child),1);};t.after(async()=>{for(const child of [...children])await stop(child);});
  const start=async()=>{const child=fork(script,[],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});children.push(child);const ready=once(child,'message');child.send({configuration:f.configuration,origin:f.origin,tls:{cert:await readFile(f.directory+'/cert.pem','utf8'),key:await readFile(f.directory+'/key.pem','utf8')},storage:f.fileFixture!.storage.configuration});const port=(await bounded(ready))[0],transport=httpClient('https://localhost:'+port,await readFile(f.directory+'/cert.pem','utf8'),issued.body.secret);return {child,client:{call:(path:string,body?:unknown)=>transport.call(path,body,{headers:{origin:f.origin}})}};};
  const one=await start(),two=await start();const input=upload(f);
  const results=await Promise.all([one.client.call('/api/v1/file-uploads',input),two.client.call('/api/v1/file-uploads',upload(f))]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.deepEqual(await reservation(f),{n:1,bytes:10});
  await stop(one.child);await stop(two.child);await change(f,{participant_reserved_bytes:1});const restarted=await start();assert.equal((await restarted.client.call(own)).body.own.reserved_bytes,10);assert.equal((await restarted.client.call('/api/v1/file-uploads',upload(f))).body.error.code,'file_reserved_capacity');
});

test('independent HTTPS client retains policy and upload journals across lost replies, decreased limits and restart',async t=>{
  const f=await fixture(t,{files:true}),account=await f.admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'file_external_admin',kind:'agent',role:'administrator'});
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.body.participant_id,kind:'agent',purpose:null,label:'Independent file client',replace_credential_id:null});assert.equal(issued.status,200);
  await writeFile(f.directory+'/client-token',issued.body.secret,{mode:0o600});
  const client=new URL('../../scripts/file-artifacts-client.mjs',import.meta.url).pathname;
  const run=async(action:string,journal:string,args:string[]=[])=>JSON.parse((await promisify(execFile)(process.execPath,[client,'--origin',f.origin,'--ca',f.directory+'/cert.pem','--credential-file',f.directory+'/client-token','--action',action,'--journal',f.directory+'/'+journal,...args],{timeout:30000})).stdout);
  const bytes=Buffer.from('12345'),input=upload(f,bytes);const {idempotency_key:_,...body}=input;await writeFile(f.directory+'/upload.json',JSON.stringify(body));await writeFile(f.directory+'/bytes',bytes);
  await run('prepare','upload-journal',['--kind','file.upload','--input',f.directory+'/upload.json']);
  await assert.rejects(run('lose-admission-response','upload-journal'),(e:any)=>e.code===75);
  const retained=await readFile(f.directory+'/upload-journal','utf8');
  const {version,...limits}=defaults;await writeFile(f.directory+'/policy.json',JSON.stringify({...limits,max_file_bytes:1,participant_reserved_bytes:1,community_reserved_bytes:1,expected_version:version}));
  await run('prepare','policy-journal',['--kind','file.policy','--input',f.directory+'/policy.json']);
  await writeFile(f.directory+'/publication.json',JSON.stringify({area_id:f.area,title:'Upload-only action must not publish',content:{format:'loom-markdown-v1',text:'Retained publication draft',mentions:[]}}));
  await run('prepare','publication-journal',['--kind','artifact.create','--input',f.directory+'/publication.json']);
  const beforeWrongAction=await effects(f);
  for(const name of ['policy-journal','publication-journal']){
    const original=await readFile(f.directory+'/'+name,'utf8');
    for(const action of ['admit','lose-admission-response'])await assert.rejects(run(action,name),(e:any)=>e.code===1);
    assert.equal(await readFile(f.directory+'/'+name,'utf8'),original);
  }
  assert.deepEqual(await effects(f),beforeWrongAction);
  await assert.rejects(run('lose-response','policy-journal'),(e:any)=>e.code===75);
  const policyBytes=await readFile(f.directory+'/policy-journal','utf8');await f.restart();assert.equal((await run('status','policy-journal')).original.version,2);assert.equal(await readFile(f.directory+'/policy-journal','utf8'),policyBytes);
  assert.equal((await run('status','upload-journal')).state,'waiting');assert.equal((await run('send','upload-journal',['--bytes',f.directory+'/bytes'])).state,'prepared');assert.equal(await readFile(f.directory+'/upload-journal','utf8'),retained);
  await run('prepare','new-journal',['--kind','file.upload','--input',f.directory+'/upload.json']);const refused=await readFile(f.directory+'/new-journal','utf8');
  await assert.rejects(run('send','new-journal',['--bytes',f.directory+'/bytes']),(e:any)=>e.code===1&&e.stdout.includes('file_size_limit'));assert.equal(await readFile(f.directory+'/new-journal','utf8'),refused);
  await run('inspect-limits','unused',['--output',f.directory+'/limits.json']);const ownView=JSON.parse(await readFile(f.directory+'/limits.json','utf8'));assert.equal(ownView.own.reserved_bytes,10);assert.equal(ownView.community,undefined);
  await run('admin-limits','unused',['--output',f.directory+'/community.json']);assert.equal(JSON.parse(await readFile(f.directory+'/community.json','utf8')).community.reserved_bytes,10);
  assert.deepEqual(await reservation(f),{n:1,bytes:10});
});
