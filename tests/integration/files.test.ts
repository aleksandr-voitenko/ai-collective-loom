import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {isolatedPublicationPostgres} from '../helpers/publication-postgres.js';
import {isolatedFileStorage} from '../helpers/file-storage.js';
import {ArtifactFiles} from '../../src/server/modules/participation/files.js';
import {ParticipationPublications} from '../../src/server/modules/participation/publications.js';
import {ParticipationRetrieval} from '../../src/server/modules/participation/retrieval.js';
import type {FileSetValue,FileEntryValue} from '../../src/contracts/files.js';
import {normalizeFileSet,normalizeFilePath,fileLimits} from '../../src/contracts/files.js';
import {barrier,bounded} from '../helpers/search-races.js';
import type {QueryResultRow} from 'pg';
import {actorFromVerifiedIdentity} from '../../src/server/modules/publication/actor.js';
import {createServer} from 'node:net';

test('native storage fixture owns its port throughout startup and provider recreation',async t=>{
  const contenders:ReturnType<typeof createServer>[]=[];
  t.after(async()=>{for(const server of contenders)if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const claim=async(endpoint:string)=>{
    const server=createServer();contenders.push(server);
    const result=await new Promise<string>(resolve=>{
      server.once('error',(error:NodeJS.ErrnoException)=>resolve(error.code??'unknown'));
      server.listen(Number(new URL(endpoint).port),'127.0.0.1',()=>resolve('bound'));
    });
    if(result!=='bound')assert.equal(result,'EADDRINUSE');
  };
  let native:Awaited<ReturnType<typeof isolatedFileStorage>>;
  try{native=await isolatedFileStorage({beforeProviderStart:claim});}
  catch(error){assert.equal(contenders.some(server=>server.listening),false,'Another socket acquired the fixture port during setup');throw error;}
  t.after(native.close);
  const endpoint=native.storage.configuration.endpoint;
  await native.stop();await claim(endpoint);await native.start();await native.recreate();
  assert.equal(native.storage.configuration.endpoint,endpoint);
  assert.equal(contenders.some(server=>server.listening),false,'Another socket acquired the fixture port during provider recreation');
  await native.storage.check();
  await native.close();
  const released=createServer();
  await new Promise<void>((resolve,reject)=>{released.once('error',reject);released.listen(Number(new URL(endpoint).port),'127.0.0.1',resolve);});
  await new Promise<void>(resolve=>released.close(()=>resolve()));
});

test('native storage fixture releases its port when provider startup fails',async()=>{
  const failure=new Error('Injected provider startup failure');let endpoint='';
  await assert.rejects(isolatedFileStorage({beforeProviderStart:async(value)=>{endpoint=value;throw failure;}}),error=>error===failure);
  const released=createServer();
  await new Promise<void>((resolve,reject)=>{released.once('error',reject);released.listen(Number(new URL(endpoint).port),'127.0.0.1',resolve);});
  await new Promise<void>(resolve=>released.close(()=>resolve()));
});

const text=(value:string)=>({format:'loom-markdown-v3' as const,text:value,mentions:[],references:[]});
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function fixture(t:test.TestContext){
  const db=await isolatedPublicationPostgres();t.after(db.close);
  const native=await isolatedFileStorage();t.after(native.close);
  const admin=await db.participant('administrator'),other=await db.participant();
  const pub=new ParticipationPublications(db.database),files=new ArtifactFiles(db.database,native.storage),reads=new ParticipationRetrieval(db.database);
  const setup=await pub.publish(admin.actor,'community.setup',{idempotency_key:randomUUID(),community_name:'Files',ordinary_area_name:'Files',proposal_area_name:'Proposals',overview:{format:'loom-markdown-v1',text:'Overview',mentions:[]}});
  const area=(await db.observer.query('SELECT owner_resource_id AS id FROM loom.resources WHERE id=$1',[setup.resource_id])).rows[0].id as string;
  const prepare=async(path:string,bytes:Buffer,target={kind:'area' as 'area'|'artifact',resource_id:area})=>{
    const input={idempotency_key:randomUUID(),target,path,size:bytes.length,sha256:sha(bytes),media_type:'application/octet-stream'};
    const upload=await files.create(admin.actor,input);await files.upload(admin.actor,upload.upload_id,bytes);
    return {input,prepared:await files.finalize(admin.actor,upload.upload_id)};
  };
  const publish=(set:FileSetValue,base?:{resource_id:string;revision_id:string},body='')=>pub.publish(admin.actor,base?'revision.publish':'artifact.create',{
    idempotency_key:randomUUID(),...(base?{resource_id:base.resource_id,expected_revision_id:base.revision_id}:{area_id:area}),
    title:'Package',content:text(body),change_note:null,change_account:null,file_set:set});
  return {...db,...native,admin,other,pub,files,reads,area,prepare,publish};
}

test('native versions: file-only R1 and mixed R2 preserve replacement, rename, omission and reuse through storage/API recreation',async t=>{
  const f=await fixture(t),chapter=Buffer.from('old chapter\n'),cover=Buffer.from([0,1,255,9]);
  const a=await f.prepare('chapters/01.md',chapter),b=await f.prepare('images/café #?%.png',cover),c=await f.prepare('omit.txt',Buffer.from('omit'));
  const r1=await f.publish({version:'artifact-files-v1',files:[a,b,c].map(x=>({path:x.input.path,source:{upload_id:x.prepared.upload_id}}))});
  const root=await f.files.manifest(f.other.actor,r1.resource_id,r1.revision_id);assert.deepEqual(root.items.map(x=>[x.kind,x.path]),[['folder','chapters'],['folder','images'],['file','omit.txt']]);
  const old=(await f.files.manifest(f.other.actor,r1.resource_id,r1.revision_id,{prefix:'chapters'})).items[0] as FileEntryValue;
  const image=(await f.files.manifest(f.other.actor,r1.resource_id,r1.revision_id,{prefix:'images'})).items[0] as FileEntryValue;
  const fresh=await f.prepare('chapters/02.md',Buffer.from('new chapter'),{kind:'artifact',resource_id:r1.resource_id});
  const r2=await f.publish({version:'artifact-files-v1',files:[{path:'chapters/02.md',source:{upload_id:fresh.prepared.upload_id}},
    {path:'cover.png',source:{revision_id:r1.revision_id,file_id:image.file_id}}]},r1,'Authored description');
  const now=(await f.files.manifest(f.other.actor,r2.resource_id,r2.revision_id)).items;
  assert.deepEqual(now.map(x=>x.path),['chapters','cover.png']);
  assert.deepEqual((await f.files.download(f.other.actor,r1.resource_id,r1.revision_id,old.file_id)).bytes,chapter);
  const copied=now[1] as FileEntryValue;assert.notEqual(copied.file_id,image.file_id);
  assert.deepEqual((await f.files.download(f.other.actor,r2.resource_id,r2.revision_id,copied.file_id)).bytes,cover);
  await f.stop();await f.start();await f.recreate();
  const restarted=new ArtifactFiles(f.database,f.storage);
  assert.deepEqual((await restarted.download(f.other.actor,r1.resource_id,r1.revision_id,image.file_id)).bytes,cover);
  assert.equal((await f.reads.detail(f.other.actor,r1.resource_id,r1.revision_id)).content.text,'');
  await assert.rejects(f.files.download(f.other.actor,r1.resource_id,r2.revision_id,image.file_id),{code:'unavailable'});
});

test('native mutable staging cannot retarget selected bytes; lost finalize acknowledgement reconciles without another publication',async t=>{
  const f=await fixture(t),bytes=Buffer.from('fixed'),a=await f.prepare('fixed.html',bytes);
  const overwrite=async()=>f.storage.client.send(new PutObjectCommand({Bucket:f.storage.configuration.stagingBucket,Key:f.storage.key(a.prepared.upload_id),Body:Buffer.from('attacker')}));
  await overwrite();assert.equal((await f.files.finalize(f.admin.actor,a.prepared.upload_id)).state,'prepared');
  const first=await f.publish({version:'artifact-files-v1',files:[{path:'fixed.html',source:{upload_id:a.prepared.upload_id}}]});await overwrite();
  const item=(await f.files.manifest(f.other.actor,first.resource_id,first.revision_id)).items[0] as FileEntryValue;
  assert.deepEqual((await f.files.download(f.other.actor,first.resource_id,first.revision_id,item.file_id)).bytes,bytes);
  const key=randomUUID(),input={idempotency_key:key,target:{kind:'area' as const,resource_id:f.area},path:'lost',size:bytes.length,sha256:sha(bytes),media_type:'text/plain'};
  const u=await f.files.create(f.admin.actor,input);await f.files.upload(f.admin.actor,u.upload_id,bytes);
  // Inject loss after native final write, before the application association.
  const saved=f.storage.put.bind(f.storage);let lost=true;
  f.storage.put=async(...args)=>{const version=await saved(...args);if(args[1]&&lost){lost=false;throw new Error('lost acknowledgement');}return version;};
  await assert.rejects(f.files.finalize(f.admin.actor,u.upload_id),{code:'file_storage_unavailable'});
  await f.observer.query("UPDATE loom.file_uploads SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[u.upload_id]);
  assert.equal((await f.files.finalize(f.admin.actor,u.upload_id)).state,'prepared');
  assert.equal((await f.storage.versions(u.upload_id,true,AbortSignal.timeout(15000))).length,1);
});

test('whole publication refuses unfinished, foreign, expired and changed bytes; exact old retries precede file-format refusal',async t=>{
  const f=await fixture(t),bytes=Buffer.from('one');
  const input={idempotency_key:randomUUID(),target:{kind:'area' as const,resource_id:f.area},path:'one',size:bytes.length,sha256:sha(bytes),media_type:'text/plain'};
  const u=await f.files.create(f.admin.actor,input),set:FileSetValue={version:'artifact-files-v1',files:[{path:'one',source:{upload_id:u.upload_id}}]};
  const before=(await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
  await assert.rejects(f.publish(set),{code:'file_not_prepared'});
  await assert.rejects(f.files.status(f.other.actor,u.upload_id),{code:'unavailable'});
  await assert.rejects(f.files.upload(f.admin.actor,u.upload_id,Buffer.from('two')),{code:'file_mismatch'});
  assert.deepEqual((await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,before);
  await f.files.upload(f.admin.actor,u.upload_id,bytes);await f.files.finalize(f.admin.actor,u.upload_id);
  const r=await f.publish(set);
  await assert.rejects(f.pub.publish(f.admin.actor,'revision.publish',{idempotency_key:randomUUID(),resource_id:r.resource_id,expected_revision_id:r.revision_id,title:'Legacy',content:text('legacy'),change_note:null,change_account:null}),{code:'file_format_required'});
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[u.upload_id]);
  await assert.rejects(f.publish(set),{code:'file_expired'});
  const entry=(await f.files.manifest(f.other.actor,r.resource_id,r.revision_id)).items[0] as FileEntryValue;
  const reused=await f.publish({version:'artifact-files-v1',files:[{path:'renamed',source:{revision_id:r.revision_id,file_id:entry.file_id}}]},r);
  assert.ok(reused.revision_id);assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:0,quarantined:0});
  assert.deepEqual((await f.files.download(f.other.actor,r.resource_id,r.revision_id,entry.file_id)).bytes,bytes);
});

test('finalization rechecks withdrawn credentials after native IO; replacement credentials recover only their owner’s handle',async t=>{
  const f=await fixture(t),bytes=Buffer.from('owner custody');
  const input={idempotency_key:randomUUID(),target:{kind:'area' as const,resource_id:f.area},path:'private',size:bytes.length,sha256:sha(bytes),media_type:'text/plain'};
  const upload=await f.files.create(f.other.actor,input),id=upload.upload_id;
  // Administrative content authority does not grant private upload custody.
  await assert.rejects(f.files.status(f.admin.actor,id),{code:'unavailable'});
  assert.deepEqual(await f.files.find(f.admin.actor,input.idempotency_key),{operation_state:'not_recorded'});
  await assert.rejects(f.files.upload(f.admin.actor,id,bytes),{code:'unavailable'});
  await assert.rejects(f.files.finalize(f.admin.actor,id),{code:'unavailable'});
  await f.files.upload(f.other.actor,id,bytes);
  const put=f.storage.put.bind(f.storage);let withdraw=true;
  f.storage.put=async(...args)=>{const version=await put(...args);if(args[1]&&withdraw){withdraw=false;
    await f.observer.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[f.other.credentialId]);
  }return version;};
  await assert.rejects(f.files.finalize(f.other.actor,id),{code:'unavailable'});
  assert.deepEqual((await f.observer.query('SELECT state,final_version FROM loom.file_uploads WHERE id=$1',[id])).rows,[{state:'finalizing',final_version:null}]);
  const original=await f.storage.versions(id,true,AbortSignal.timeout(15000));assert.equal(original.length,1);
  const credentialId=randomUUID();await f.observer.query("INSERT INTO loom.participant_credentials(id,participant_id,state) VALUES($1,$2,'active')",[credentialId,f.other.participantId]);
  const replacement=actorFromVerifiedIdentity({participantId:f.other.participantId,credentialId});
  assert.equal((await f.files.status(replacement,id)).state,'finalizing');
  await assert.rejects(f.files.finalize(replacement,id),{code:'file_busy'});
  await f.observer.query("UPDATE loom.file_uploads SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  assert.equal((await f.files.finalize(replacement,id)).state,'prepared');
  assert.deepEqual(await f.storage.versions(id,true,AbortSignal.timeout(15000)),original);
  await assert.rejects(f.publish({version:'artifact-files-v1',files:[{path:'private',source:{upload_id:id}}]}),{code:'unavailable'});
  const published=await f.pub.publish(replacement,'artifact.create',{idempotency_key:randomUUID(),area_id:f.area,title:'Recovered custody',content:text(''),change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'private',source:{upload_id:id}}]}});
  const entry=(await f.files.manifest(f.admin.actor,published.resource_id,published.revision_id)).items[0] as FileEntryValue;
  assert.deepEqual((await f.files.download(f.admin.actor,published.resource_id,published.revision_id,entry.file_id)).bytes,bytes);
});

test('expired unassociated versions clean up exactly; missing published native version fails without latest fallback',async t=>{
  const f=await fixture(t),bytes=Buffer.from('original'),a=await f.prepare('abandoned',bytes);
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[a.prepared.upload_id]);
  assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:1,quarantined:0});
  assert.equal((await f.files.status(f.admin.actor,a.prepared.upload_id)).state,'expired');
  assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:0,quarantined:0});
  const b=await f.prepare('published',bytes),r=await f.publish({version:'artifact-files-v1',files:[{path:'published',source:{upload_id:b.prepared.upload_id}}]});
  const entry=(await f.files.manifest(f.other.actor,r.resource_id,r.revision_id)).items[0] as FileEntryValue;
  const version=(await f.observer.query('SELECT final_version FROM loom.file_uploads WHERE id=$1',[b.prepared.upload_id])).rows[0].final_version;
  await f.storage.client.send(new PutObjectCommand({Bucket:f.storage.configuration.finalBucket,Key:f.storage.key(b.prepared.upload_id),Body:Buffer.from('replacement')}));
  await f.storage.client.send(new DeleteObjectCommand({Bucket:f.storage.configuration.finalBucket,Key:f.storage.key(b.prepared.upload_id),VersionId:version}));
  await assert.rejects(f.files.download(f.other.actor,r.resource_id,r.revision_id,entry.file_id),{code:'file_storage_unavailable'});
  assert.equal((await f.files.manifest(f.other.actor,r.resource_id,r.revision_id)).availability,'declared_not_probed');
});

test('path normalization, complete set collisions and conservative synthetic limits are explicit',()=>{
  for(const path of ['/a','C:x','\\a','a/../b','a/./b','a//b','a/','a\0b','a\nb','a\\b','x/'.repeat(9)+'a','x'.repeat(513),'\ud800'])assert.throws(()=>normalizeFilePath(path));
  assert.equal(normalizeFilePath('cafe\u0301/space #?%.txt'),'café/space #?%.txt');
  const set=(paths:string[])=>({version:'artifact-files-v1' as const,files:paths.map(path=>({path,source:{upload_id:randomUUID()}}))});
  for(const paths of [['a','a/b'],['café','cafe\u0301'],['A','a'],['A','a/b']])assert.throws(()=>normalizeFileSet(set(paths)));
  assert.equal(normalizeFileSet(set(['Ä','ä'])).files.length,2);
  assert.throws(()=>normalizeFileSet(set(Array.from({length:fileLimits.entries+1},(_,i)=>'f'+i))));
});

test('native quotas serialize concurrent reservations; byte, transfer, page and context budgets fail closed',async t=>{
  const f=await fixture(t),bytes=Buffer.alloc(fileLimits.fileBytes,7),prepared=await f.prepare('maximum.bin',bytes);
  const upload=prepared.prepared.upload_id;
  const small=await f.prepare('small',Buffer.from('x'));
  await assert.rejects(f.files.upload(f.admin.actor,upload,Buffer.concat([bytes,Buffer.from([1])])),{code:'file_mismatch'});
  const input={...prepared.input,idempotency_key:randomUUID(),size:fileLimits.fileBytes+1};
  await assert.rejects(f.files.create(f.admin.actor,input),{code:'invalid_input'});
  await assert.rejects(f.files.create(f.admin.actor,{...prepared.input,path:'changed'}),{code:'idempotency_conflict'});
  const reservations=await Promise.allSettled(Array.from({length:6},()=>f.files.create(f.admin.actor,{...prepared.input,idempotency_key:randomUUID()})));
  assert.equal(reservations.filter(r=>r.status==='fulfilled').length,fileLimits.active);
  assert.ok(reservations.filter(r=>r.status==='rejected').every(r=>r.reason.code==='file_unfinished_capacity'));
  assert.equal((await f.observer.query("SELECT count(*)::int AS n FROM loom.file_uploads WHERE state='waiting'")).rows[0].n,4);
  assert.equal((await f.files.find(f.admin.actor,prepared.input.idempotency_key) as {state:string}).state,'prepared');
  assert.deepEqual(await f.files.find(f.other.actor,prepared.input.idempotency_key),{operation_state:'not_recorded'});
  assert.equal((await f.files.create(f.admin.actor,prepared.input)).upload_id,upload,'Exact recovery remains useful at capacity');
  const holds=Array.from({length:4},()=>barrier()),running=holds.map(held=>f.storage.bounded(()=>held.promise));
  await assert.rejects(f.storage.bounded(async()=>{}),{code:'file_capacity'});holds.forEach(held=>held.release());await Promise.all(running);
  const overset:FileSetValue={version:'artifact-files-v1',files:Array.from({length:9},(_,i)=>({path:'copy'+i,source:{upload_id:upload}}))};
  const before=(await f.observer.query('SELECT * FROM loom.community_clocks')).rows;
  await assert.rejects(f.publish(overset),{code:'file_capacity'});assert.deepEqual((await f.observer.query('SELECT * FROM loom.community_clocks')).rows,before);
  // The 512-byte path limit keeps one entry under the minimum response budget.
  // Multiple escaped entries still require continuation with no skipped member.
  const paths=Array.from({length:16},(_,i)=>String(i).padStart(2,'0')+'"'.repeat(220));
  const r=await f.publish({version:'artifact-files-v1',files:paths.map(path=>({path,source:{upload_id:small.prepared.upload_id}}))});
  let cursor:string|undefined;const seen:string[]=[];
  do{const page=await f.files.manifest(f.other.actor,r.resource_id,r.revision_id,{max_response_bytes:'4096',limit:'25',...cursor?{cursor}:{}});
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=4096);seen.push(...page.items.map(i=>i.path));cursor=page.next_cursor??undefined;
  }while(cursor);assert.deepEqual(seen,paths);
  const first=await f.files.manifest(f.other.actor,r.resource_id,r.revision_id,{limit:'1'});
  await assert.rejects(f.files.manifest(f.other.actor,r.resource_id,r.revision_id,{cursor:first.next_cursor!,prefix:'different'}),{code:'invalid_cursor'});
  await assert.rejects(f.files.manifest(f.admin.actor,r.resource_id,r.revision_id,{cursor:first.next_cursor!}),{code:'invalid_cursor'});
  await assert.rejects(f.files.manifest(f.other.actor,r.resource_id,r.revision_id,{prefix:'../bad'}),{code:'invalid_input'});
  await assert.rejects(f.files.manifest(f.other.actor,r.resource_id,r.revision_id,{limit:'26'}),{code:'invalid_input'});
  await assert.rejects(f.files.manifest(f.other.actor,r.resource_id,r.revision_id,{max_response_bytes:'4095'}));
  const elsewhere=await f.publish({version:'artifact-files-v1',files:[]},undefined,'Text');
  await assert.rejects(f.publish({version:'artifact-files-v1',files:[{path:'stolen',source:{revision_id:r.revision_id,file_id:(first.items[0] as FileEntryValue).file_id}}]},elsewhere),{code:'unavailable'});
  const manifestBytes={version:'artifact-files-v1' as const,files:paths.map((_,i)=>({path:String(i)+'"'.repeat(500),source:{upload_id:upload}}))};
  assert.throws(()=>normalizeFileSet(manifestBytes));
});

test('native cleanup cannot delete a committed lifetime, and loss after cleanup remains explicit and restartable',async t=>{
  const f=await fixture(t),a=await f.prepare('lifetime',Buffer.from('lifetime'));
  const held=barrier(),release=barrier();let paused=false;
  const guarded=new ParticipationPublications({transaction:work=>f.database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);
    if(!paused&&sql.startsWith('INSERT INTO loom.file_contexts')){paused=true;held.release();await release.promise;}return result;
  }}))});
  const request={idempotency_key:randomUUID(),area_id:f.area,title:'Lifetime',content:text(''),change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'lifetime',source:{upload_id:a.prepared.upload_id}}]}};
  const pending=guarded.publish(f.admin.actor,'artifact.create',request);await bounded(held.promise);
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[a.prepared.upload_id]);
  const cleanup=f.files.cleanup(f.admin.actor);
  try{await bounded((async()=>{while(!(await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()")).rowCount)await new Promise(resolve=>setTimeout(resolve,5));})());}
  finally{release.release();}
  const result=await pending;assert.deepEqual(await cleanup,{removed:0,quarantined:0});
  assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:0,quarantined:0});
  assert.equal((await f.pub.publish(f.admin.actor,'artifact.create',request)).revision_id,result.revision_id,'Expiry does not invalidate a committed retry');
  const item=(await f.files.manifest(f.other.actor,result.resource_id,result.revision_id)).items[0] as FileEntryValue;
  assert.equal((await f.files.download(f.other.actor,result.resource_id,result.revision_id,item.file_id)).bytes.toString(),'lifetime');
  const b=await f.prepare('unassociated',Buffer.from('other'));
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[b.prepared.upload_id]);
  const remove=f.storage.remove.bind(f.storage);f.storage.remove=async()=>{throw new Error('native outage');};
  assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:0,quarantined:1});
  assert.equal((await f.files.status(f.admin.actor,b.prepared.upload_id)).state,'quarantined');
  await f.observer.query("UPDATE loom.file_uploads SET lease_until=clock_timestamp()-interval '2 hours' WHERE id=$1",[b.prepared.upload_id]);
  const cleaning=barrier(),finishCleanup=barrier();
  f.storage.remove=async(...args)=>{cleaning.release();await finishCleanup.promise;return remove(...args);};
  const cleanupFirst=f.files.cleanup(f.admin.actor);
  const expired={...request,idempotency_key:randomUUID(),file_set:{version:'artifact-files-v1',files:[{path:'expired',source:{upload_id:b.prepared.upload_id}}]}};
  try{
    await bounded(cleaning.promise);
    assert.equal((await f.files.status(f.admin.actor,b.prepared.upload_id)).state,'cleaning');
    await assert.rejects(f.pub.publish(f.admin.actor,'artifact.create',expired),{code:'file_expired',definitive:true});
    assert.equal((await f.observer.query('SELECT 1 FROM loom.file_contexts WHERE upload_id=$1',[b.prepared.upload_id])).rowCount,0);
  }finally{finishCleanup.release();}
  assert.deepEqual(await cleanupFirst,{removed:1,quarantined:0});f.storage.remove=remove;
  await assert.rejects(f.pub.reconcile(f.admin.actor,'artifact.create',expired.idempotency_key),{code:'file_expired',definitive:true});
  await assert.rejects(f.pub.publish(f.admin.actor,'artifact.create',{...expired,title:'Changed'}),{code:'idempotency_conflict'});
  assert.equal((await f.storage.versions(b.prepared.upload_id,true,AbortSignal.timeout(15000))).length,0);
});

test('upload admission covers input buffers waiting for their first database connection',async t=>{
  const f=await fixture(t),bytes=Buffer.from('waiting for custody');
  const upload=await f.files.create(f.admin.actor,{idempotency_key:randomUUID(),target:{kind:'area',resource_id:f.area},path:'queued',size:bytes.length,sha256:sha(bytes),media_type:'text/plain'});
  const ready=barrier(),release=barrier();let waiting=0;
  const guarded=new ArtifactFiles({transaction:async work=>{
    if(++waiting<=4){if(waiting===4)ready.release();await release.promise;}
    return f.database.transaction(work);
  }},f.storage);
  const pending=Array.from({length:4},()=>guarded.upload(f.admin.actor,upload.upload_id,Buffer.from(bytes)));
  try{
    await bounded(ready.promise);
    await assert.rejects(guarded.upload(f.admin.actor,upload.upload_id,Buffer.from(bytes)),{code:'file_capacity'});
    assert.equal(waiting,4,'Excess buffers never join the database queue');
  }finally{release.release();await Promise.allSettled(pending);}
  await assert.rejects(guarded.upload(f.other.actor,upload.upload_id,bytes),{code:'unavailable'});
  await assert.rejects(guarded.upload(f.admin.actor,upload.upload_id,Buffer.from('different')),{code:'file_mismatch'});
  assert.equal((await guarded.upload(f.admin.actor,upload.upload_id,bytes)).state,'staged');
});

test('download admission remains held while final authorization owns verified byte buffers',async t=>{
  const f=await fixture(t),prepared=await f.prepare('buffer',Buffer.from('bounded'));
  const r=await f.publish({version:'artifact-files-v1',files:[{path:'buffer',source:{upload_id:prepared.prepared.upload_id}}]});
  const item=(await f.files.manifest(f.other.actor,r.resource_id,r.revision_id)).items[0] as FileEntryValue;
  const ready=barrier(),release=barrier();let transactions=0,held=0;
  const guarded=new ArtifactFiles({transaction:work=>{
    const ordinal=++transactions;
    return f.database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);
      if(ordinal>4&&ordinal<=8&&sql.startsWith('SELECT upload_id,path')){
        if(++held===4)ready.release();await release.promise;
      }
      return result;
    }}));
  }},f.storage);
  const pending=Array.from({length:4},()=>guarded.download(f.other.actor,r.resource_id,r.revision_id,item.file_id));
  try{await bounded(ready.promise);await assert.rejects(guarded.download(f.other.actor,r.resource_id,r.revision_id,item.file_id),{code:'file_capacity'});}
  finally{release.release();await Promise.all(pending);}
});

test('retained identity, owner/community byte and cleanup batch frontiers preserve exact recovery',async t=>{
  const f=await fixture(t);
  const seed=async(owner:string,count:number,size:number,reserved=true)=>f.observer.query(`INSERT INTO loom.file_uploads(id,participant_id,idempotency_key,request_digest,target_kind,target_id,path,size,sha256,media_type,state,reserved,prepared_expires_at)
    SELECT gen_random_uuid(),$1,gen_random_uuid(),repeat('0',64),'area',$2,'abandoned',$3,repeat('0',64),'text/plain','expired',$4,clock_timestamp()-interval '1 day' FROM generate_series(1,$5)`,[owner,f.area,size,reserved,count]);
  const input=(size=1)=>({idempotency_key:randomUUID(),target:{kind:'area' as const,resource_id:f.area},path:'quota',size,sha256:sha(Buffer.alloc(size)),media_type:'application/octet-stream'});
  await seed(f.admin.participantId,8,fileLimits.fileBytes);await seed(f.admin.participantId,1,0);
  const race=await Promise.allSettled([f.files.create(f.admin.actor,input()),f.files.create(f.admin.actor,input())]);
  assert.ok(race.every(r=>r.status==='rejected'&&r.reason.code==='file_reserved_capacity'));
  assert.equal((await f.observer.query('SELECT sum(size*2)::text AS bytes FROM loom.file_uploads WHERE reserved')).rows[0].bytes,String(fileLimits.ownerBytes));
  assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:8,quarantined:0});
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_uploads WHERE reserved')).rows[0].n,1);
  assert.deepEqual(await f.files.cleanup(f.admin.actor),{removed:1,quarantined:0});
  await seed(f.admin.participantId,fileLimits.ownerSessions-9,0,false);
  await assert.rejects(f.files.create(f.admin.actor,input(0)),{code:'file_capacity'});
  for(let i=0;i<4;i++){const owner=await f.participant();await seed(owner.participantId,8,fileLimits.fileBytes);}
  await assert.rejects(f.files.create(f.other.actor,input()),{code:'file_reserved_capacity'});
  const empty=input(0),zero=await f.files.create(f.other.actor,empty);
  await f.files.upload(f.other.actor,zero.upload_id,Buffer.alloc(0));assert.equal((await f.files.finalize(f.other.actor,zero.upload_id)).state,'prepared');
  const count=(await f.observer.query('SELECT count(*)::int AS n FROM loom.file_uploads')).rows[0].n;
  const filler=await f.participant();await seed(filler.participantId,fileLimits.sessions-count,0,false);
  await assert.rejects(f.files.create(f.other.actor,input(0)),{code:'file_capacity'});
  assert.equal((await f.files.create(f.other.actor,empty)).upload_id,zero.upload_id);
  assert.equal((await f.files.status(f.other.actor,zero.upload_id)).state,'prepared');
});

test('lost staging and database acknowledgements retain one exact intent and all-or-nothing publication',async t=>{
  const f=await fixture(t),bytes=Buffer.from('exact staging');
  const input={idempotency_key:randomUUID(),target:{kind:'area' as const,resource_id:f.area},path:'recovery',size:bytes.length,sha256:sha(bytes),media_type:'text/plain'};
  const upload=await f.files.create(f.admin.actor,input),id=upload.upload_id,saved=f.storage.put.bind(f.storage);let lose=true;
  f.storage.put=async(...args)=>{const version=await saved(...args);if(!args[1]&&lose){lose=false;throw new Error('lost staging acknowledgement');}return version;};
  await assert.rejects(f.files.upload(f.admin.actor,id,bytes),{code:'file_storage_unavailable'});
  assert.equal((await f.files.status(f.admin.actor,id)).state,'uploading');
  await assert.rejects(f.files.upload(f.admin.actor,id,bytes),{code:'file_busy'});
  await f.storage.client.send(new PutObjectCommand({Bucket:f.storage.configuration.stagingBucket,Key:f.storage.key(id),Body:Buffer.from('different size')}));
  await f.observer.query("UPDATE loom.file_uploads SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
  await f.files.upload(f.admin.actor,id,bytes);await f.files.finalize(f.admin.actor,id);
  assert.equal((await f.storage.versions(id,false,AbortSignal.timeout(15000))).length,2,'Reconciliation does not add a third version');
  await assert.rejects(f.files.upload(f.other.actor,id,bytes),{code:'unavailable'});
  await assert.rejects(f.files.finalize(f.other.actor,id),{code:'unavailable'});
  const request={idempotency_key:randomUUID(),area_id:f.area,title:'Recoverable',content:text(''),change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'recovery',source:{upload_id:id}}]}};
  await assert.rejects(f.pub.publish(f.other.actor,'artifact.create',request),{code:'unavailable'});
  const before=(await f.observer.query('SELECT * FROM loom.community_clocks')).rows;
  const failing=new ParticipationPublications({transaction:work=>f.database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.file_contexts'))throw new Error('Injected database rollback');return result;
  }}))});
  await assert.rejects(failing.publish(f.admin.actor,'artifact.create',request));
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.community_clocks')).rows,before);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_contexts')).rows[0].n,0);
  assert.deepEqual(await f.pub.reconcile(f.admin.actor,'artifact.create',request.idempotency_key),{operation_state:'not_recorded'});
  const r=await f.pub.publish(f.admin.actor,'artifact.create',request),file=(await f.files.manifest(f.other.actor,r.resource_id,r.revision_id)).items[0] as FileEntryValue;
  assert.deepEqual((await f.files.download(f.other.actor,r.resource_id,r.revision_id,file.file_id)).bytes,bytes);
  assert.equal((await f.pub.publish(f.admin.actor,'artifact.create',request)).revision_id,r.revision_id);
});
