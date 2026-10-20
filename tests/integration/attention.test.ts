import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/attention.js';
import { mentioned } from '../helpers/notifications.js';
import { gates } from '../helpers/updates-gates.js';
import type { AttentionInputView,DismissUpdateInput } from '../../src/contracts/attention.js';

const command=(inputs:AttentionInputView[],dismissed=true,expected_version=0):DismissUpdateInput=>({idempotency_key:randomUUID(),inputs:inputs.map(v=>({...v,dismissed,expected_version}))});
const shared=(id:string):AttentionInputView=>({kind:'shared_event',id});

test('negative mute fences, overlap, retained original/current outcomes and private owner survive restart',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_mutes'),a=await f.artifact(),target={kind:'artifact',resource_id:a.resource_id};
  const negative=await f.mute(r.client,'artifact',a.resource_id,false),stale=await f.mute(r.client,'artifact',a.resource_id);
  assert.equal(negative.result.current.version,1);assert.equal(stale.result.operation_state,'version_conflict');
  const first=await f.mute(r.client,'artifact',a.resource_id,true,1);await f.mute(r.client,'area',f.area,true,0,true);
  const removed=await f.mute(r.client,'artifact',a.resource_id,false,2);assert.equal(removed.result.current.other_current_scope_mutes[0]!.target.resource_id,f.area);
  await f.restart();const retry=await r.client.call(f.endpoint+'/mutes/state',first.body);
  assert.equal(retry.body.outcome.muted,true);assert.equal(retry.body.current.muted,false);assert.equal(retry.body.current.version,3);
  assert.equal((await f.admin.call(f.endpoint+'/mutes/lookup',target)).body.muted,false);
  assert.equal((await f.admin.call(f.endpoint+'/status',{idempotency_key:first.body.idempotency_key})).body.operation_state,'not_recorded');
  assert.equal((await r.client.call(f.endpoint+'/mutes/state',{...first.body,include_descendants:true})).status,400);
  assert.equal((await r.client.call(f.endpoint+'/mutes/state',{...first.body,muted:false})).body.error.code,'idempotency_conflict');
  assert.equal((await f.admin.call(f.endpoint+'/mutes/lookup',{...target,owner:r.id})).status,400);
  assert.deepEqual((await r.client.call('/api/v1/me/following')).body.items,[]);
});

test('routine mute preserves mixed direct inputs; filtering before highlights and complete paths return exact independent sets',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_mixed'),d=await f.discussion();
  await f.follow(r.client,f.settings('discussion',d.id));
  const routine=await f.reply(d),direct=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(r.id),change_note:null,change_account:null});
  await f.drain();await f.mute(r.client,'discussion',d.id);
  const view=await f.readyRoutine(r.client),g=view.items[0]!;
  assert.equal(g.counts.shared_changes,0);assert.equal(g.counts.personal_signals,1);assert.equal(g.counts.source_records,1);
  assert.equal(g.direct_sources[0]!.source.revision_id,direct.revision_id);
  const directId=g.direct_sources[0]!.personal!.delivery_id;
  const complete=await f.readyRoutine(r.client,{switch:{token:view.page_cursor,selection:'complete'}});
  assert.deepEqual((await f.allRoutineMembers(r.client,complete.records_cursor!)).map(m=>m.source.revision_id).sort(),[d.opening.revision_id,routine.revision_id,direct.revision_id].sort());
  assert.equal((await f.page(r.client)).items[0]!.delivery_id,directId);
  assert.equal((await f.allChanges(r.client)).items.length,3);
  const selected=await f.selection(r.client,view.page_cursor,g.id);assert.equal(selected.shared_events,0);assert.equal(selected.personal_signals,1);
  await f.dismiss(r.client,f.fromSelection(selected));
  const stale=await r.client.call('/api/v1/me/routine-updates/query',{cursor:view.page_cursor});assert.equal(stale.body.error.code,'updates_attention_refresh_required');
  const hidden=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:view.page_cursor}});assert.deepEqual(hidden.items,[]);assert.ok(hidden.complete_cursor);
  assert.equal((await f.page(r.client)).items[0]!.delivery_id,directId,'all-retained personal route is unchanged');
  assert.equal((await f.readyRoutine(r.client,{cursor:complete.page_cursor})).items[0]!.counts.personal_signals,1,'complete traversal ignores policy changes');
  assert.deepEqual((await f.allRoutineMembers(r.client,complete.items[0]!.members_cursor)).map(m=>m.source.revision_id).sort(),[d.opening.revision_id,routine.revision_id,direct.revision_id].sort(),'complete group members also bypass attention');
  const a=[];for(let i=0;i<7;i++){const item=await f.artifact(f.admin,'Routine '+i);a.push(item);await f.follow(r.client,f.settings('artifact',item.resource_id));}
  for(const item of a.slice(-4))await f.mute(r.client,'artifact',item.resource_id);
  const highlights=await f.readyRoutine(r.client);assert.equal(highlights.items.length,3);
  assert.deepEqual((await Promise.all(highlights.items.map(async group=>(await f.allRoutineMembers(r.client,group.members_cursor))[0]!.source.resource_id))).sort(),a.slice(0,3).map(v=>v.resource_id).sort());
});

test('restore and Unmute behind a completed checkpoint require deliberate retained selection without publishing or rewinding',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_retained'),a=await f.artifact();await f.follow(r.client,f.settings('artifact',a.resource_id));
  const page=await f.readyRoutine(r.client),s=await f.selection(r.client,page.page_cursor,page.items[0]!.id);await f.dismiss(r.client,f.fromSelection(s));
  const complete=await f.readyRoutine(r.client,{switch:{token:page.page_cursor,selection:'complete'}});assert.ok(complete.checkpoint);
  const clocks=(await f.observer.query('SELECT * FROM loom.community_clocks')).rows;await f.mute(r.client,'artifact',a.resource_id);
  await f.dismiss(r.client,{idempotency_key:randomUUID(),inputs:s.inputs.map(({kind,id})=>({kind,id,dismissed:false,expected_version:1}))});
  assert.deepEqual((await f.readyRoutine(r.client,{checkpoint:complete.checkpoint!})).items,[]);
  const muted=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:page.page_cursor}});assert.deepEqual(muted.items,[],'restoration does not also unmute');
  await f.mute(r.client,'artifact',a.resource_id,false,1);
  const restored=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:muted.page_cursor}});assert.equal(restored.items[0]!.id,page.items[0]!.id);
  assert.deepEqual((await f.allRoutineMembers(r.client,restored.items[0]!.members_cursor)).map(v=>v.source.revision_id),[a.revision_id]);
  assert.deepEqual((await f.readyRoutine(r.client,{checkpoint:complete.checkpoint!})).items,[],'old material is not newly published');
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.community_clocks')).rows,clocks);
});

test('dismiss E before delayed N; frozen group excludes later revisions and delivery and retained retries outlive custody',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_delayed'),d=await f.discussion();await f.follow(r.client,f.settings('discussion',d.id));
  const source=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(r.id),change_note:null,change_account:null});
  const view=await f.readyRoutine(r.client),selected=await f.selection(r.client,view.page_cursor,view.items[0]!.id),body=f.fromSelection(selected);
  assert.equal(selected.personal_signals,0);await f.dismiss(r.client,body);
  const complete=await f.readyRoutine(r.client,{switch:{token:view.page_cursor,selection:'complete'}});assert.ok(complete.checkpoint);
  const later=await f.reply(d);await f.drain();
  const next=await f.readyRoutine(r.client,{checkpoint:complete.checkpoint!});assert.equal(next.items[0]!.counts.personal_signals,1);assert.equal(next.items[0]!.counts.shared_changes,1);
  const members=await f.allRoutineMembers(r.client,next.items[0]!.members_cursor);
  assert.deepEqual(members.map(v=>v.source.revision_id).sort(),[source.revision_id,later.revision_id].sort());
  assert.equal(members.find(v=>v.source.revision_id===source.revision_id)!.shared_in_interval,false);
  await f.observer.query('DELETE FROM loom.updates_views WHERE id=$1',[view.traversal.id]);await f.restart();
  const replay=await f.dismiss(r.client,body);assert.equal(replay.idempotency,'replayed');assert.deepEqual(replay.outcome.inputs.map(v=>v.id).sort(),selected.inputs.map(v=>v.id).sort());
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.attention_dismissals WHERE participant_id=$1',[r.id])).rows[0].n,selected.inputs.length);
});

test('atomic overlapping dismiss/restore in both orders rejects stale choices and never changes independent state',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_atomic'),a=await f.artifact(),b=await f.artifact(),x=shared(await f.event(a.revision_id)),y=shared(await f.event(b.revision_id));
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' AND tablename NOT LIKE 'attention_%' ORDER BY tablename")).rows.map(v=>v.tablename as string);
  const digest=async(name:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT to_jsonb(t) row FROM loom.${name} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const name of tables)before.set(name,await digest(name));
  const k1=command([x,y]);await f.dismiss(r.client,k1);await f.dismiss(r.client,command([x],false,1));
  assert.equal((await f.dismiss(r.client,command([x,y],false,1))).operation_state,'version_conflict');
  const states=(await r.client.call(f.endpoint+'/dismissals/lookup',{inputs:[x,y]})).body.items;
  assert.deepEqual(states.map((v:any)=>[v.id,v.dismissed,v.version]).sort(),[[x.id,false,2],[y.id,true,1]].sort());
  assert.equal((await f.dismiss(r.client,k1)).current.find(v=>v.id===x.id)!.dismissed,false);
  for(const first of [true,false]){
    const current=first?2:3;await f.dismiss(r.client,command([x],first,current));
    assert.equal((await f.dismiss(r.client,command([x],!first,current))).operation_state,'version_conflict');
  }
  assert.equal((await r.client.call(f.endpoint+'/dismissals/state',command([x,{...x,id:x.id.toUpperCase()}]))).status,400);
  assert.equal((await r.client.call(f.endpoint+'/dismissals/state',command([y,shared(randomUUID())],false,1))).status,404);
  for(const name of tables)assert.equal(await digest(name),before.get(name),name+' changed through attention commands');
});

test('source suppression withholds metadata and keeps known removal; parent-only suppression preserves independently owned replies',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_privacy'),d=await f.discussion(),parent=await f.reply(d),child=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:parent.resource_id,content:{format:'loom-markdown-v1',text:'Child remains readable',mentions:[]}});
  const x=shared(await f.event(child.revision_id));await f.mute(r.client,'discussion',d.id);const body=command([x]);await f.dismiss(r.client,body);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[parent.resource_id]));
  assert.equal((await r.client.call(f.endpoint+'/dismissals/lookup',{inputs:[x]})).body.items[0].availability,'available');
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));
  const list=await r.client.call(f.endpoint+'/list',{collection:'mutes'});assert.deepEqual(list.body.mutes[0].source,{state:'unavailable'});
  assert.equal((await f.dismiss(r.client,body)).current[0]!.availability,'unavailable');
  await f.dismiss(r.client,command([x],false,1));await f.mute(r.client,'discussion',d.id,false,1);
  assert.equal((await f.admin.call(f.endpoint+'/dismissals/lookup',{inputs:[x]})).status,404);
  assert.equal((await f.admin.call(f.endpoint+'/dismissals/lookup',{inputs:[shared(randomUUID())]})).status,404);
});

test('rollback includes choices, outcomes and counters; concurrent capacity and exact recovery retain bounds',{timeout:90000},async t=>{
  const control=gates(),f=await fixture(t,{transactionWrapper:control.wrapper}),r=await f.participant('attention_capacity'),a=await f.artifact(),x=shared(await f.event(a.revision_id)),body=command([x]);
  const fault=control.pause(sql=>sql.startsWith('INSERT INTO loom.attention_operations'),'after',true),request=r.client.call(f.endpoint+'/dismissals/state',body);
  await fault.entered.promise;fault.release.release();assert.equal((await request).status,503);
  for(const table of ['attention_owners','attention_dismissals','attention_operations'])assert.equal((await f.observer.query(`SELECT count(*)::int n FROM loom.${table} WHERE participant_id=$1`,[r.id])).rows[0].n,0);
  await f.dismiss(r.client,body);await f.observer.query('UPDATE loom.attention_owners SET operations=49999 WHERE participant_id=$1',[r.id]);
  const results=await Promise.all([r.client.call(f.endpoint+'/dismissals/state',command([x],false,1)),r.client.call(f.endpoint+'/dismissals/state',command([x],false,1))]);
  assert.deepEqual(results.map(v=>v.status).sort(),[200,429]);assert.equal((await f.dismiss(r.client,body)).idempotency,'replayed');
  assert.equal((await r.client.call(f.endpoint+'/status',{idempotency_key:body.idempotency_key})).body.operation_state,'applied');
  assert.equal((await r.client.call(f.endpoint+'/dismissals/lookup',{inputs:[x]})).status,200);
});
