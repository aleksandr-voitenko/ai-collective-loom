import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/updates.js';
import {plain} from '../helpers/references.js';
import type {UploadInputValue} from '../../src/contracts/files.js';

type Fixture=Awaited<ReturnType<typeof fixture>>;
const set=(files:unknown[])=>({version:'contribution-attachments-v1',files});
async function prepare(client:Fixture['admin'],target:UploadInputValue['target'],path='tokens [[mention:a]].txt',bytes=Buffer.from('inert [[mention:a]]')){
  const input={idempotency_key:randomUUID(),target,path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/html'};
  const upload=await client.call('/api/v1/file-uploads',input);assert.equal(upload.status,201,JSON.stringify(upload.body));
  const id=upload.body.upload_id;assert.equal((await client.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes})).status,200);
  assert.equal((await client.call(`/api/v1/file-uploads/${id}/finalize`,{})).status,200);return {path,source:{upload_id:id}};
}
async function snapshot(f:Fixture,tables:string[]){const state:Record<string,unknown>={};for(const name of tables)state[name]=(await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${name} t ORDER BY 1`)).rows;return state;}
const shared=['resources','discussions','contributions','artifacts','revisions','resource_editors','revision_mentions','revision_references','shared_activity','outbox_intents','community_clocks','idempotency_records','artifact_file_sets','contribution_attachment_sets','file_contexts','attachment_promotions'];

test('attachment membership is atomic through every publication tail failure and retains legacy requests',async t=>{
  let fail='';const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{const r=await tx.query<Row>(sql,values);if(fail&&sql.startsWith(fail))throw new Error('Synthetic transaction rollback');return r;}}))})});
  const person=await f.participant('atomic'),member=await prepare(person.client,{kind:'opening',resource_id:f.area});
  const input={idempotency_key:randomUUID(),area_id:f.area,title:'Atomic opening',content:plain('Nonempty prose'),attachment_set:set([member])};
  const unfinished=(await person.client.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'opening',resource_id:f.area},path:'pending',size:0,sha256:createHash('sha256').update('').digest('hex'),media_type:'text/plain'})).body;
  const before=await snapshot(f,shared);
  for(const other of [{path:'missing',source:{upload_id:randomUUID()}},{path:'pending',source:{upload_id:unfinished.upload_id}}]){assert.ok((await person.client.call('/api/v1/discussions',{...input,attachment_set:set([member,other])})).status>=400);assert.deepEqual(await snapshot(f,shared),before);}
  for(const stage of ['INSERT INTO loom.contributions','INSERT INTO loom.contribution_attachment_sets','INSERT INTO loom.file_contexts','UPDATE loom.community_clocks','INSERT INTO loom.shared_activity','INSERT INTO loom.outbox_intents','INSERT INTO loom.idempotency_records']){
    fail=stage;assert.equal((await person.client.call('/api/v1/discussions',input)).status,503,stage);fail='';assert.deepEqual(await snapshot(f,shared),before,stage);
    assert.deepEqual((await person.client.call('/api/v1/operations/status',{operation_kind:'discussion.create',idempotency_key:input.idempotency_key})).body,{operation_state:'not_recorded'});
  }
  const made=(await person.client.call('/api/v1/discussions',input)).body;assert.ok(made.revision_id);
  assert.equal((await person.client.call('/api/v1/discussions',{...input,idempotency_key:randomUUID()})).status,404,'published private handle cannot seed another contribution');
  const view=(await person.client.call('/api/v1/resources/'+made.resource_id)).body,file=(await person.client.call(view.attachment_set.manifest_url)).body.items[0];
  const edit={idempotency_key:randomUUID(),resource_id:made.resource_id,expected_revision_id:made.revision_id,title:'Atomic opening',content:plain('Nonempty prose')};
  assert.equal((await person.client.call('/api/v1/revisions',edit)).body.error.code,'file_format_required');
  const retained=await person.client.call('/api/v1/revisions',{...edit,attachment_set:set([{path:'renamed.txt',source:{revision_id:made.revision_id,file_id:file.file_id}}])});assert.equal(retained.status,201);
  assert.equal((await person.client.call('/api/v1/revisions',{...edit,idempotency_key:randomUUID(),attachment_set:set([])})).body.error.code,'revision_conflict');
  const p={idempotency_key:randomUUID(),source:{contribution_id:made.resource_id,revision_id:made.revision_id,file_id:file.file_id},area_id:f.other,title:'Atomic promotion'};
  const promotionBefore=await snapshot(f,shared);
  for(const stage of ['INSERT INTO loom.artifacts','INSERT INTO loom.resource_editors','INSERT INTO loom.artifact_file_sets','INSERT INTO loom.attachment_promotions','UPDATE loom.community_clocks','INSERT INTO loom.outbox_intents','INSERT INTO loom.idempotency_records']){fail=stage;assert.equal((await person.client.call('/api/v1/attachment-promotions',p)).status,503,stage);fail='';assert.deepEqual(await snapshot(f,shared),promotionBefore,stage);}
  for(const source of [{...p.source,file_id:member.source.upload_id},{...p.source,revision_id:retained.body.revision_id},{...p.source,contribution_id:randomUUID()}])assert.equal((await person.client.call('/api/v1/attachment-promotions',{...p,source})).status,404);
  assert.equal((await person.client.call('/api/v1/attachment-promotions',p)).status,201);
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3']){
    const legacy={idempotency_key:randomUUID(),discussion_id:view.discussion_id,parent_id:made.resource_id,content:{format,text:'Old request',mentions:[],...(format==='loom-markdown-v1'?{}:{references:[]})},...(format==='loom-markdown-v3'?{change_note:null,change_account:null}:{})};
    const one=await person.client.call('/api/v1/replies',legacy);assert.equal(one.status,201);const two=await person.client.call('/api/v1/replies',legacy);assert.equal(two.body.revision_id,one.body.revision_id);
  }
});

test('attachment-only source evolution, change accounts, personal state and native lifetime remain independent',async t=>{
  const f=await fixture(t,{files:true}),alice=await f.participant('invariant_alice'),bob=await f.participant('invariant_bob'),d=await f.discussion(alice.client),target=await f.artifact();
  const pair={resource_id:target.resource_id,revision_id:target.revision_id};
  await f.follow(bob.client,f.settings('discussion',d.id));
  assert.equal((await bob.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'discussion',resource_id:d.id},saved:true,expected_version:0})).status,200);
  assert.equal((await bob.client.call('/api/v1/me/reading/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{...pair,read:true,expected_version:0}]})).status,200);
  assert.equal((await bob.client.call('/api/v1/me/attention/mutes/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:target.resource_id},include_descendants:false,muted:true,expected_version:0})).status,200);
  const member=await prepare(alice.client,{kind:'reply',resource_id:d.opening.resource_id});
  const body={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:{format:'loom-markdown-v3',text:'Account [[mention:a]]',mentions:[{token:'a',participant_id:bob.id}],references:[]},change_note:null,change_account:{revisions:[{kind:'artifact',...pair}]},attachment_set:set([member])};
  const created=await alice.client.call('/api/v1/replies',body);assert.equal(created.status,201,JSON.stringify(created.body));const source=created.body;await f.drain();
  const summary=await f.create(d.id);assert.equal((await f.coverage(summary)).body.coverage.changed_eligible,0);
  const privateTables=['saved_collections','saved_items','saved_operations','following_collections','following_targets','following_operations','reading_owners','reading_states','reading_operations','attention_owners','attention_mutes','attention_dismissals','attention_operations','personal_deliveries','notification_signals','notification_claims'];
  const tables=privateTables;
  const before=await snapshot(f,tables),prior=await f.ready(bob.client,{selection:'complete'});
  const page=await bob.client.call(`/api/v1/contributions/${source.resource_id}/revisions/${source.revision_id}/attachments?limit=1&max_response_bytes=4096`);assert.equal(page.status,200);assert.ok(Buffer.byteLength(JSON.stringify(page.body))<=4096);const file=page.body.items[0];
  assert.equal((await bob.client.call(file.download_url)).body,'inert [[mention:a]]');
  const promotion=await bob.client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:source.resource_id,revision_id:source.revision_id,file_id:file.file_id},area_id:f.other,title:'Independent'});assert.equal(promotion.status,201);
  assert.equal((await f.coverage(summary)).body.coverage.changed_eligible,0);assert.deepEqual(await snapshot(f,tables),before);
  const same=await f.ready(bob.client,{cursor:prior.page_cursor});assert.equal(same.traversal.id,prior.traversal.id);
  const edit=await alice.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:null,content:body.content,change_note:null,change_account:{carry_forward_revision_id:source.revision_id},attachment_set:set([])});assert.equal(edit.status,201);assert.equal((await f.coverage(summary)).body.coverage.changed_eligible,1);
  await f.drain();assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.revision_mentions WHERE revision_id=$1',[promotion.body.revision_id])).rows[0].n,0);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.notification_signals WHERE revision_id=$1',[source.revision_id])).rows[0].n,1,'one explicit mention, no file-derived mention');
  await f.fileFixture!.stop();await f.fileFixture!.start();await f.restart();await f.fileFixture!.recreate();
  assert.equal((await bob.client.call(file.download_url)).body,'inert [[mention:a]]');
  const promoted=(await bob.client.call(`/api/v1/artifacts/${promotion.body.resource_id}/revisions/${promotion.body.revision_id}/files`)).body.items[0];assert.equal((await bob.client.call(promoted.download_url)).body,'inert [[mention:a]]');
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[member.source.upload_id]);
  assert.deepEqual((await alice.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:0});
  // Fixture-only native-version loss; retained metadata is never silently retargeted.
  await f.fileFixture!.storage.remove(member.source.upload_id,true,AbortSignal.timeout(15000));
  assert.equal((await bob.client.call(file.download_url)).body.error.code,'file_storage_unavailable');assert.equal((await bob.client.call(promoted.download_url)).body.error.code,'file_storage_unavailable');
});

for(const quota of ['owner sets','global sets','owner contexts','global contexts'])test('logical '+quota+' capacity stops new contexts but preserves exact publication recovery',async t=>{
  const f=await fixture(t,{files:true}),alice=await f.participant('quota_alice'),bob=await f.participant('quota_bob');
  const member=await prepare(alice.client,{kind:'opening',resource_id:f.area},'retained');
  const input={idempotency_key:randomUUID(),area_id:f.area,title:'At capacity',content:plain('Retained'),attachment_set:set([member])};
  const source=(await alice.client.call('/api/v1/discussions',input)).body,view=(await alice.client.call('/api/v1/resources/'+source.resource_id)).body;
  const file=(await bob.client.call(view.attachment_set.manifest_url)).body.items[0],p={idempotency_key:randomUUID(),source:{contribution_id:source.resource_id,revision_id:source.revision_id,file_id:file.file_id},area_id:f.other,title:'Retained promotion'};
  const promoted=await bob.client.call('/api/v1/attachment-promotions',p);assert.equal(promoted.status,201);
  // Fixture-only capacity population: real constrained rows with at most 16
  // contexts per complete set, not thousands of HTTP requests or relaxed limits.
  const sets=quota==='owner sets'?2047:quota==='global sets'?8190:quota==='owner contexts'?512:4096;
  const revisions=(await f.observer.query(`INSERT INTO loom.revisions SELECT
    (jsonb_populate_record(NULL::loom.revisions,to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'revision_number',n+1))).*
    FROM loom.revisions r CROSS JOIN generate_series(1,$2::integer) n WHERE r.id=$1 RETURNING id`,[source.revision_id,sets])).rows.map(r=>r.id);
  await f.observer.query("INSERT INTO loom.contribution_attachment_sets SELECT id,$2,$3,'contribution-attachments-v1' FROM unnest($1::uuid[]) id",[revisions,source.resource_id,view.discussion_id]);
  if(quota.endsWith('contexts'))await f.observer.query("INSERT INTO loom.file_contexts(id,contribution_id,revision_id,path,upload_id,reused_from) SELECT gen_random_uuid(),$2,id,'member-'||n,$3,$4 FROM unnest($1::uuid[]) id CROSS JOIN generate_series(1,16) n",[revisions,source.resource_id,member.source.upload_id,file.file_id]);
  const actor=quota.startsWith('owner')?alice.client:bob.client;
  const counts=await snapshot(f,['file_contexts','contribution_attachment_sets','artifact_file_sets','idempotency_records','file_uploads']);
  const denied=await actor.call('/api/v1/attachment-promotions',{...p,idempotency_key:randomUUID()});assert.equal(denied.body.error.code,'file_capacity');
  assert.equal((await alice.client.call('/api/v1/discussions',input)).body.revision_id,source.revision_id);
  assert.equal((await bob.client.call('/api/v1/attachment-promotions',p)).body.revision_id,promoted.body.revision_id);
  assert.equal((await bob.client.call('/api/v1/operations/status',{operation_kind:'attachment.promote',idempotency_key:p.idempotency_key})).body.revision_id,promoted.body.revision_id);
  assert.deepEqual(await snapshot(f,['file_contexts','contribution_attachment_sets','artifact_file_sets','idempotency_records','file_uploads']),counts);
});
