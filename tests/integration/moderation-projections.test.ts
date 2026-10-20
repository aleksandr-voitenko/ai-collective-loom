import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/moderation.js';
import {mentioned} from '../helpers/notifications.js';
import {reference,incoming,outgoing} from '../helpers/references.js';
import {revisionBody,note,notePath,discover} from '../helpers/changes.js';
import {SearchWorker} from '../../src/server/modules/search/worker.js';

test('supported lifecycle controls govern stale derived reads and preserve private choices, source bytes and attribution',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('moderation_surfaces'),d=await f.discussion(r.client);
  const comment=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(r.id),change_note:null,change_account:null});
  const summary=await f.create(d.id),a=await f.artifact(f.admin,'Nebulamoderation');
  const newer=await f.publish(f.admin,'/api/v1/revisions',revisionBody(a,'Nebulamoderation',note('Owned explanation')));
  const ref=reference({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id});
  const independent=await f.artifact(f.admin,'Independent quotation remains',[ref]);
  const saved={kind:'revision',resource_id:a.resource_id,revision_id:a.revision_id};
  assert.equal((await r.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:saved,saved:true,expected_version:0})).status,200);
  assert.equal((await r.client.call('/api/v1/me/reading/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{resource_id:a.resource_id,revision_id:a.revision_id,read:true,expected_version:0}]})).status,200);
  await f.follow(r.client,f.settings('artifact',a.resource_id));await f.follow(r.client,f.settings('discussion',d.id));
  await f.mute(r.client,'artifact',a.resource_id);
  await f.dismiss(r.client,{idempotency_key:randomUUID(),inputs:[{kind:'shared_event',id:await f.event(a.revision_id),dismissed:true,expected_version:0}]});
  await f.drain();
  const worker=new SearchWorker(f.database);
  for(let i=0;i<30;i++){await worker.tick();if((await f.admin.call('/api/v1/search/status')).body.indexing==='ready')break;}
  assert.ok((await r.client.call('/api/v1/search?q=Nebulamoderation')).body.items.some((i:any)=>i.source_resource_id===a.resource_id));
  const personal=await f.page(r.client);assert.ok(personal.items.some(i=>i.source.resource_id===comment.resource_id));
  const snapshot=async()=>{
    const names=(await f.observer.query(`SELECT tablename FROM pg_tables WHERE schemaname='loom' AND
      (tablename LIKE 'saved_%' OR tablename LIKE 'reading_%' OR tablename LIKE 'following_%' OR tablename LIKE 'attention_%'
       OR tablename IN ('revisions','revision_references','summary_declarations','summary_coverage_members','shared_activity','personal_deliveries','notification_claims'))
      ORDER BY tablename`)).rows.map(r=>r.tablename as string);
    const values:Record<string,unknown>={};for(const name of names)values[name]=(await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${name} t ORDER BY to_jsonb(t)::text`)).rows;
    return values;
  };
  const before=await snapshot();
  // Both workers now stop. Their persisted rows deliberately remain stale.
  await f.suppress(a.resource_id);await f.suppress(d.id);
  for(const id of [a.resource_id,comment.resource_id,summary.resource_id,d.opening.resource_id]){
    for(const suffix of ['', '/history']){
      const response=await r.client.call('/api/v1/resources/'+id+suffix);assert.equal(response.status,404);
      assert.doesNotMatch(JSON.stringify(response.body),/Nebulamoderation|Owned explanation|Opening material/);
    }
  }
  for(const path of [
    `/api/v1/resources/${a.resource_id}/revisions/${a.revision_id}`,notePath(newer),discover(a),
    outgoing(a),incoming(ref.target),`/api/v1/discussions/${d.id}`,`/api/v1/discussions/${d.id}/summary-sources`,
    `/api/v1/summaries/${summary.resource_id}/revisions/${summary.revision_id}/coverage`,
    `/api/v1/summary-preparations/${summary.preparation.preparation_id}/members`,
  ])assert.equal((await r.client.call(path)).status,404,path);
  assert.deepEqual((await r.client.call('/api/v1/search?q=Nebulamoderation')).body.items,[]);
  assert.ok(!(await r.client.call('/api/v1/summaries/maintenance')).body.items.some((i:any)=>i.discussion_id===d.id));
  assert.equal((await r.client.call('/api/v1/me/saved-items/lookup',saved)).body.source.state,'unavailable');
  const reading=(await r.client.call('/api/v1/me/reading/lookup',{targets:[{resource_id:a.resource_id,revision_id:a.revision_id}]})).body.items[0];
  assert.deepEqual(reading,{resource_id:a.resource_id,revision_id:a.revision_id,read:true,version:1,availability:'unavailable'});
  assert.equal((await r.client.call('/api/v1/me/following/lookup',{kind:'artifact',resource_id:a.resource_id})).body.source.state,'unavailable');
  assert.deepEqual((await f.page(r.client)).items,[]);
  assert.deepEqual((await f.allChanges(r.client)).items,[]);
  assert.deepEqual((await f.allGroups(r.client)).items,[]);
  assert.deepEqual((await f.readyRoutine(r.client,{selection:'complete'})).items,[]);
  const outgoingView=(await r.client.call(outgoing(independent))).body;
  assert.match(JSON.stringify(outgoingView),/unavailable/);assert.doesNotMatch(JSON.stringify(outgoingView),/Nebulamoderation/);
  assert.match(JSON.stringify((await r.client.call('/api/v1/resources/'+independent.resource_id)).body),/Independent quotation remains/);
  assert.deepEqual(await snapshot(),before,'suppression only changes lifecycle and visibility-derived state');
  await f.suppress(a.resource_id,false);await f.suppress(d.id,false);
  assert.deepEqual(await snapshot(),before,'restoration does not rewrite private choices, revisions or delivery identities');
  assert.equal((await r.client.call(notePath(newer))).status,200);
  assert.equal((await f.coverage(summary,r.client)).status,200);
  assert.equal((await r.client.call('/api/v1/me/saved-items/lookup',saved)).body.saved,true);
  assert.equal((await r.client.call('/api/v1/me/following/lookup',{kind:'artifact',resource_id:a.resource_id})).body.following,true);
  await f.drain();assert.deepEqual(await snapshot(),before,'worker replay must not duplicate existing claims/deliveries');
});

test('filtered shared, personal and both combined checkpoints explicitly recover restored historical material',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('moderation_checkpoints'),d=await f.discussion();
  const reply=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(r.id),change_note:null,change_account:null});
  await f.follow(r.client,f.settings('discussion',d.id,false,['replies']));await f.drain();
  const original=await f.page(r.client),delivery=original.items[0]!.delivery_id,event=await f.event(reply.revision_id);
  const initialShared=await f.allChanges(r.client);assert.equal(initialShared.items[0]!.event_id,event);
  await f.suppress(reply.resource_id);
  const shared=await f.allChanges(r.client),personal=await f.page(r.client,{reason:'mention'});
  const combined=await f.allGroups(r.client,{reason:'mention',selection:'complete'}),routine=await f.readyRoutine(r.client,{reason:'mention',selection:'complete'});
  for(const page of [shared.page,personal,combined.page,routine]){assert.deepEqual(page.items,[]);assert.ok(page.checkpoint);}
  await f.suppress(reply.resource_id,false);
  for(const [path,token,code] of [
    ['/api/v1/shared-changes/query',shared.page.checkpoint,'shared_visibility_replay_required'],
    ['/api/v1/me/notifications/query',personal.checkpoint,'visibility_replay_required'],
    ['/api/v1/me/updates/query',combined.page.checkpoint,'updates_visibility_replay_required'],
    ['/api/v1/me/routine-updates/query',routine.checkpoint,'updates_visibility_replay_required'],
  ] as const){
    const response=await r.client.call(path,{checkpoint:token});assert.equal(response.status,409,path);assert.equal(response.body.error.code,code,path);
  }
  const restoredShared=await f.allChanges(r.client,{recovery:{action:'replay',token:shared.page.checkpoint!}});
  assert.equal(restoredShared.items[0]!.event_id,event);
  const restoredPersonal=await f.page(r.client,{recovery:{action:'replay',token:personal.checkpoint!}});
  assert.equal(restoredPersonal.items[0]!.delivery_id,delivery);
  const restoredCombined=await f.allGroups(r.client,{recovery:{action:'replay',token:combined.page.checkpoint!}});
  const members=await f.allMembers(r.client,restoredCombined.page.records_cursor!);
  assert.equal(members.items[0]!.source.revision_id,reply.revision_id);
  const restoredRoutine=await f.readyRoutine(r.client,{recovery:{action:'replay',token:routine.checkpoint!},selection:'complete'});
  assert.ok((await f.allRoutineMembers(r.client,restoredRoutine.records_cursor!)).some(m=>m.source.revision_id===reply.revision_id));
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.personal_deliveries WHERE recipient_id=$1',[r.id])).rows[0].n,1);
  assert.equal((await f.observer.query("SELECT count(*)::int AS n FROM loom.shared_activity WHERE kind LIKE '%moderation%'")).rows[0].n,0);
});
