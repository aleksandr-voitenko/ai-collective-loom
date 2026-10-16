import assert from 'node:assert/strict';
import { randomUUID,createCipheriv,createDecipheriv } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/following.js';
import { eventPreferences } from '../../src/contracts/following.js';

test('hidden scans make opaque progress; complete UTF-8 budgets, exact policy and attributable reason pages',{timeout:120000},async t=>{
  const f=await fixture(t),reader=await f.participant('bounded_shared');
  for(let i=0;i<101;i++){
    const source=await f.artifact(f.admin,`Hidden ${i}`);
    await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[source.resource_id]));
  }
  const wanted=await f.artifact(f.admin,'Visible \"\\ 🌿'.repeat(8));
  const scope={kind:'explicit' as const,definition:f.settings('artifact',wanted.resource_id)};
  const started=performance.now(),first=await f.changes(reader.client,{scope,limit:1,max_response_bytes:4096});
  assert.deepEqual(first.items,[]);assert.ok(first.next_cursor);assert.equal(first.work_budget_reached,true);assert.equal(first.interval_complete,false);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=4096);assert.equal('position' in first,false);assert.equal('scanned' in first,false);
  const last=await f.allChanges(reader.client,{cursor:first.next_cursor!,max_response_bytes:4096});
  assert.deepEqual(last.items.map(i=>i.revision_id),[wanted.revision_id]);assert.equal(last.page.interval_complete,true);
  t.diagnostic(`Synthetic 103-event scan: first empty JSON ${Buffer.byteLength(JSON.stringify(first))} bytes; whole traversal ${Math.round(performance.now()-started)} ms.`);
  const original=(await f.admin.call('/api/v1/resources/'+wanted.resource_id)).body;
  const newer=await f.publish(f.admin,'/api/v1/revisions',{resource_id:wanted.resource_id,expected_revision_id:wanted.revision_id,title:'Suppressed current title',content:{format:'loom-markdown-v1',text:'Current body',mentions:[]}});
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[newer.revision_id]));
  const historical=await f.allChanges(reader.client,{scope});assert.equal(historical.items.length,1);assert.equal(historical.items[0]!.current.state,'available');
  if(historical.items[0]!.current.state==='available')assert.equal(historical.items[0]!.current.title,null);
  assert.ok(!JSON.stringify(historical.items).includes('Suppressed current title'));assert.equal(historical.items[0]!.revision_id,original.revision_id);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[wanted.revision_id]));
  const denied=await reader.client.call('/api/v1/shared-changes/detail',{cursor:historical.page.page_cursor,event_id:historical.items[0]!.event_id});
  assert.equal(denied.body.error.code,'shared_visibility_replay_required');

  let parent=f.area;const areas=[parent];
  for(let i=0;i<9;i++){parent=await f.newArea('Branch '+i,parent);areas.push(parent);}
  const many=await f.publish(f.admin,'/api/v1/artifacts',{area_id:parent,title:'Overlapping reasons',content:{format:'loom-markdown-v1',text:'One event',mentions:[]}});
  for(const area of areas)await f.follow(reader.client,f.settings('area',area,true,['artifact_revisions']));
  await f.follow(reader.client,f.settings('artifact',many.resource_id,false,['artifact_revisions']));
  const match=(await f.allChanges(reader.client)).items.find(i=>i.revision_id===many.revision_id)!;
  assert.equal(match.reasons.length,8);assert.equal(match.reasons_complete,false);
  const view=await f.allChanges(reader.client),details=await reader.client.call('/api/v1/shared-changes/detail',{cursor:view.page.page_cursor,event_id:match.event_id,reason_offset:8});
  assert.equal(details.status,200);assert.equal(details.body.reasons.length,3);assert.equal(details.body.reasons_complete,true);
  assert.deepEqual([...match.reasons,...details.body.reasons].map(r=>r.target.resource_id).sort(),[...areas,many.resource_id].sort());
  assert.equal((await reader.client.call('/api/v1/shared-changes/query',{max_response_bytes:4096})).body.error.code,'response_budget_too_small');
});

test('descriptor expiry, renewal, cross-owner/purpose, history floor, unsupported facts and recovery epoch',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('token_shared'),b=await f.participant('other_shared'),source=await f.artifact();
  await f.follow(a.client,f.settings('artifact',source.resource_id));const first=await f.changes(a.client);
  assert.equal((await b.client.call('/api/v1/shared-changes/query',{cursor:first.page_cursor})).body.error.code,'shared_token_invalid');
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{cursor:first.page_cursor+'x'})).body.error.code,'shared_token_invalid');
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{cursor:first.page_cursor,checkpoint:first.checkpoint})).status,400);
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{cursor:first.page_cursor,scope:{kind:'explicit',definition:f.settings('artifact',source.resource_id)}})).body.error.code,'shared_token_invalid');
  const key=(await f.observer.query('SELECT cursor_key FROM loom.shared_retrieval_state')).rows[0].cursor_key as Buffer;
  function edited(token:string,change:(d:any)=>void){const bytes=Buffer.from(token,'base64url'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    decipher.setAAD(Buffer.from('shared-changes-1'));decipher.setAuthTag(bytes.subarray(12,28));const d=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());change(d);
    const nonce=Buffer.alloc(12,7),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('shared-changes-1'));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(d)),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64url');}
  const expired=edited(first.page_cursor,d=>d.expires=0);
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{cursor:expired})).body.error.code,'shared_descriptor_expired');
  const renewed=await f.changes(a.client,{recovery:{action:'renew',token:expired}});assert.deepEqual(renewed.items,first.items);assert.equal(renewed.traversal.id,first.traversal.id);
  await f.restart();assert.deepEqual((await f.changes(a.client,{cursor:renewed.page_cursor})).items,first.items);
  await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=(SELECT shared_position FROM loom.community_clocks)');
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{cursor:first.page_cursor})).body.error.code,'shared_history_gap');
  const replay=await a.client.call('/api/v1/shared-changes/query',{recovery:{action:'replay',token:first.checkpoint}});
  assert.equal(replay.body.error?.code,'shared_history_gap','replaying a completed checkpoint needs older retained history too');
  const baseline=await f.changes(a.client,{recovery:{action:'resynchronize',token:first.page_cursor}});
  assert.equal(baseline.baseline_established,true);assert.equal(baseline.interval_complete,false);assert.equal(baseline.history,'incomplete');assert.ok(baseline.checkpoint);assert.ok(baseline.inventory[0]!.url.endsWith('/history'));
  await f.observer.query('UPDATE loom.shared_retrieval_state SET recovery_epoch=$1',[randomUUID()]);
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{checkpoint:baseline.checkpoint})).body.error.code,'shared_epoch_changed');
  assert.equal((await a.client.call('/api/v1/shared-changes/query',{recovery:{action:'resynchronize',token:baseline.page_cursor}})).body.error.code,'shared_epoch_changed');
});

test('retention caps reject new choices without evicting existing decisions; closed targets and no-op replay remain usable',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('cap_shared');
  const first=await f.follow(a.client,f.settings('area',f.area));
  const state=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;
  assert.equal((await f.admin.call('/api/v1/organization/changes',{kind:'area.close',resource_id:f.area,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version,idempotency_key:randomUUID()})).status,200);
  assert.equal((await f.follow(f.admin,f.settings('area',f.area))).result.operation_state,'applied');
  await f.observer.query(`WITH ids AS (INSERT INTO loom.resources(id,kind) SELECT gen_random_uuid(),'area' FROM generate_series(1,499) RETURNING id),
    areas AS (INSERT INTO loom.areas(id,title,description) SELECT id,'Capacity','Synthetic' FROM ids RETURNING id)
    INSERT INTO loom.following_targets(id,participant_id,target_kind,resource_id,following,preferences) SELECT gen_random_uuid(),$1,'area',id,false,$2 FROM areas`,[a.id,[...eventPreferences]]);
  assert.equal((await a.client.call('/api/v1/me/following/state',{...f.settings('area',f.other),following:true,expected_version:0,idempotency_key:randomUUID()})).body.error.code,'following_limit_reached');
  await f.follow(a.client,f.settings('area',f.area),false,1);
  assert.equal((await a.client.call('/api/v1/me/following/state',first.body)).body.current.following,false);
  await f.observer.query(`INSERT INTO loom.following_operations(id,participant_id,idempotency_key,target_id,request_digest,desired_following,include_descendants,preferences,expected_version,result_version,decision)
    SELECT gen_random_uuid(),participant_id,gen_random_uuid(),id,repeat('0',64),false,false,preferences,0,0,'version_conflict'
    FROM loom.following_targets CROSS JOIN generate_series(1,10000) WHERE participant_id=$1 AND resource_id=$2 LIMIT 10000`,[a.id,f.area]);
  assert.equal((await a.client.call('/api/v1/me/following/state',{...first.body,idempotency_key:randomUUID(),expected_version:2})).body.error.code,'following_limit_reached');
  assert.equal((await a.client.call('/api/v1/me/following/status',{idempotency_key:first.body.idempotency_key})).body.outcome.following,true);
});

test('unclassified public retained work prevents a false checkpoint',{timeout:60000},async t=>{
  const f=await fixture(t),reader=await f.participant('unknown_shared');
  const resource=randomUUID(),revision=randomUUID(),event=randomUUID();
  // Foundation data permits an untyped resource; public work outside the known
  // classification cannot silently become an empty, complete shared interval.
  await f.observer.query('BEGIN');
  try{
    await f.observer.query("INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,'artifact',$2,$3)",[resource,f.area,reader.id]);
    await f.observer.query("INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text) VALUES ($1,$2,1,$3,'text/plain','Unsupported retained public format')",[revision,resource,reader.id]);
    await f.observer.query('UPDATE loom.resources SET current_revision_id=$2 WHERE id=$1',[resource,revision]);
    const position=(await f.observer.query('UPDATE loom.community_clocks SET shared_position=shared_position+1 RETURNING shared_position')).rows[0].shared_position;
    await f.observer.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids) VALUES ($1,$2,'revision.published',$3,$4,$5,$6)",[event,position,resource,revision,reader.id,[f.area]]);
    await f.observer.query('COMMIT');
  }catch(error){await f.observer.query('ROLLBACK');throw error;}
  const page=await f.changes(reader.client,{scope:{kind:'explicit',definition:f.settings('area',f.area)}});
  assert.equal(page.coverage,'unknown');assert.equal(page.interval_complete,false);assert.equal(page.checkpoint,null);assert.equal(page.page_exhausted,true);
  const other=await f.changes(reader.client,{scope:{kind:'explicit',definition:f.settings('area',f.other)}});assert.equal(other.interval_complete,true);
});

test('untyped public contributions and summaries retain their known discussion coverage',{timeout:60000},async t=>{
  const f=await fixture(t),reader=await f.participant('unknown_discussion');
  for(const kind of ['contribution','summary']){
    const opening=await f.publish(f.admin,'/api/v1/discussions',{area_id:f.area,title:'Unsupported '+kind,
      content:{format:'loom-markdown-v1',text:'Typed opening',mentions:[]}});
    const discussion=(await f.observer.query('SELECT discussion_id FROM loom.contributions WHERE id=$1',[opening.resource_id])).rows[0].discussion_id as string;
    const resource=randomUUID(),revision=randomUUID(),event=randomUUID();
    await f.observer.query('BEGIN');
    try{
      await f.observer.query('INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,$2,$3,$4)',[resource,kind,discussion,reader.id]);
      await f.observer.query("INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text) VALUES ($1,$2,1,$3,'text/plain','Unsupported retained public work')",[revision,resource,reader.id]);
      await f.observer.query('UPDATE loom.resources SET current_revision_id=$2 WHERE id=$1',[resource,revision]);
      const position=(await f.observer.query('UPDATE loom.community_clocks SET shared_position=shared_position+1 RETURNING shared_position')).rows[0].shared_position;
      await f.observer.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids) VALUES ($1,$2,'revision.published',$3,$4,$5,$6)",[event,position,resource,revision,reader.id,[f.area]]);
      await f.observer.query('COMMIT');
    }catch(error){await f.observer.query('ROLLBACK');throw error;}
    const definition=f.settings('discussion',discussion);
    await f.follow(reader.client,definition);
    for(const scope of [{kind:'explicit' as const,definition},{kind:'following' as const}]){
      const page=await f.changes(reader.client,{scope});
      assert.deepEqual(page.items.map(i=>i.event_id),[await f.event(opening.revision_id)]);
      assert.equal(page.coverage,'unknown',kind+' must prevent a false discussion checkpoint');
      assert.equal(page.interval_complete,false);assert.equal(page.checkpoint,null);assert.equal(page.page_exhausted,true);
    }
    await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[resource]);
    const hidden=await f.changes(reader.client);
    assert.equal(hidden.coverage,'known');assert.equal(hidden.interval_complete,true);
    await f.follow(reader.client,definition,false,1);
  }
  const unrelated=await f.changes(reader.client,{scope:{kind:'explicit',definition:f.settings('area',f.other)}});
  assert.equal(unrelated.coverage,'known');assert.equal(unrelated.interval_complete,true);
});

test('active definition cap, bounded descriptors and SQL deadlines remain explicit',{timeout:90000},async t=>{
  let slow=false,queryCount=0;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async(sql,values)=>{
    queryCount++;if(slow&&sql.startsWith('SELECT e.*,e.position')){slow=false;await tx.query('SELECT pg_sleep(3)',[]);}return tx.query(sql,values);
  }}))})}),a=await f.participant('active_cap');
  const ids=[];
  for(let n=0;n<65;n++){const r=await f.artifact(f.admin,'Capacity '+n);ids.push(r.resource_id);if(n<64)await f.follow(a.client,f.settings('artifact',r.resource_id));}
  assert.equal((await a.client.call('/api/v1/me/following/state',{...f.settings('artifact',ids[64]!),following:true,expected_version:0,idempotency_key:randomUUID()})).body.error.code,'following_limit_reached');
  const start=queryCount,page=await f.changes(a.client,{limit:25});
  assert.equal(page.traversal.definitions.length,64);assert.ok(page.page_cursor.length<=16384);assert.ok(page.next_cursor!.length<=16384);
  assert.ok(Buffer.byteLength(JSON.stringify(page))<=131072);t.diagnostic(`Synthetic 64-follow/66-event page: ${queryCount-start} SQL calls; ${Buffer.byteLength(JSON.stringify(page))} JSON bytes; ${page.page_cursor.length}-byte descriptor.`);
  for(const query of [{limit:26},{max_response_bytes:4095},{cursor:'x'.repeat(16385)}])assert.equal((await a.client.call('/api/v1/shared-changes/query',query)).status,400);
  slow=true;assert.equal((await a.client.call('/api/v1/shared-changes/query',{})).body.error.code,'shared_work_limit');
});
