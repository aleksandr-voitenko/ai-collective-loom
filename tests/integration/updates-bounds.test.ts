import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/updates.js';
import { mentioned } from '../helpers/notifications.js';
import { editUpdatesToken as editToken } from '../helpers/updates-token.js';
test('suppressed ordering events explicitly invalidate both returned and pending groups; restoration replays behind completed bounds',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_visibility'),sources:{resource_id:string;revision_id:string}[]=[];
  for(let i=0;i<4;i++){const a=await f.artifact(f.admin,'Ordered '+i);sources.push(a);await f.follow(reader.client,f.settings('artifact',a.resource_id));}
  const first=await f.ready(reader.client,{selection:'complete',limit:1});
  for(const source of [sources[3]!,sources[0]!]){
    await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[source.revision_id]));
    const denied=await reader.client.call('/api/v1/me/updates/query',{cursor:first.next_cursor});assert.equal(denied.body.error.code,'updates_visibility_replay_required');
    assert.ok(!JSON.stringify(denied.body).includes(source.resource_id));
  }
  const hidden=await f.allGroups(reader.client);assert.equal(hidden.items.length,2);
  const later=await f.allGroups(reader.client,{checkpoint:hidden.page.checkpoint!});assert.equal(later.items.length,0);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='available' WHERE id=$1",[sources[0]!.revision_id]));
  const replay=await f.allGroups(reader.client,{recovery:{action:'replay',token:later.page.checkpoint!}});
  const records=await f.allMembers(reader.client,replay.page.records_cursor!);
  assert.deepEqual(records.items.map(m=>m.source.revision_id).sort(),sources.slice(0,3).map(s=>s.revision_id).sort());
  const d=await f.discussion(),parent=await f.reply(d),child=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:parent.resource_id,content:mentioned(reader.id),change_note:null,change_account:null});await f.drain();
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=ANY($1::uuid[])",[[parent.resource_id,d.id]]));
  const closed=await f.allGroups(reader.client,{scope:{kind:'personal'},reason:'mention'});assert.equal(closed.items.length,0);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[parent.resource_id]));
  assert.equal((await f.allGroups(reader.client,{recovery:{action:'replay',token:closed.page.checkpoint!}})).items.length,0);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[parent.resource_id]));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[d.id]));
  const restored=await f.allGroups(reader.client,{recovery:{action:'replay',token:closed.page.checkpoint!}});
  assert.equal(restored.items[0]!.direct_sources[0]!.source.revision_id,child.revision_id);assert.equal(restored.items[0]!.direct_sources[0]!.personal!.parent!.state,'unavailable');
});

test('descriptor expiry, independent gaps, epoch, missing custody and purpose/owner checks remain explicit',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_tokens'),other=await f.participant('updates_token_other'),a=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',a.resource_id));const page=await f.ready(reader.client,{selection:'complete',limit:1});
  const key=(await f.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0].cursor_key;
  const expired=editToken(page.page_cursor,key,b=>b.expires=0);
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:expired})).body.error.code,'updates_descriptor_expired');
  const renewed=await f.ready(reader.client,{recovery:{action:'renew',token:expired},limit:1});assert.equal(renewed.items[0]!.id,page.items[0]!.id);
  const expiredMembers=editToken(page.items[0]!.members_cursor,key,b=>b.expires=0);
  assert.equal((await reader.client.call('/api/v1/me/updates/members',{cursor:expiredMembers})).body.error.code,'updates_descriptor_expired');
  assert.equal((await f.members(reader.client,{cursor:expiredMembers,renew:true})).items[0]!.source.revision_id,a.revision_id);
  assert.equal((await other.client.call('/api/v1/me/updates/query',{cursor:page.page_cursor})).body.error.code,'updates_token_invalid');
  const personal=await f.page(reader.client),shared=await f.changes(reader.client);
  for(const cursor of [personal.page_cursor,shared.page_cursor,'malformed'])assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor})).body.error.code,'updates_token_invalid');
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:'x'.repeat(16385)})).status,400);
  assert.equal((await reader.client.call('/api/v1/shared-changes/query',{cursor:page.page_cursor})).body.error.code,'shared_token_invalid');
  await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=1');
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:page.page_cursor})).body.error.code,'updates_shared_history_gap');
  await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=0');
  await f.observer.query('INSERT INTO loom.participant_delivery_clocks(participant_id,position,retained_after) VALUES($1,1,1)',[reader.id]);
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:page.page_cursor})).body.error.code,'updates_personal_history_gap');
  await f.observer.query('UPDATE loom.participant_delivery_clocks SET position=0,retained_after=0 WHERE participant_id=$1',[reader.id]);
  await f.observer.query('DELETE FROM loom.updates_views WHERE id=$1',[page.traversal.id]);
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:page.page_cursor})).body.error.code,'updates_state_unavailable');
  const baseline=await f.ready(reader.client,{recovery:{action:'resynchronize',token:page.page_cursor}});assert.equal(baseline.baseline_established,true);assert.equal(baseline.grouped_interval_complete,false);assert.equal(baseline.inventory.length,3);
  await f.observer.query('UPDATE loom.updates_state SET recovery_epoch=$1',[randomUUID()]);
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{checkpoint:baseline.checkpoint})).body.error.code,'updates_epoch_changed');
});

test('empty bounded scans reach later matching work; serialized Unicode budgets never skip an oversized first group',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_empty');
  for(let i=0;i<105;i++)await f.artifact(f.admin,'Outside '+i);
  const wanted=await f.artifact(f.admin,'Unicode 雨🌦️ "\\ '.repeat(8));await f.follow(reader.client,f.settings('artifact',wanted.resource_id));
  const started=performance.now(),first=await f.updates(reader.client,{selection:'complete'});
  assert.deepEqual(first.items,[]);assert.equal(first.stage,'preparing');assert.equal(first.checkpoint,null);assert.ok(first.next_cursor);
  const ready=await f.ready(reader.client,{cursor:first.next_cursor!});assert.equal(ready.items.length,1);
  const small=await reader.client.call('/api/v1/me/updates/query',{cursor:ready.page_cursor,max_response_bytes:4096});assert.equal(small.body.error.code,'response_budget_too_small');
  const same=await f.ready(reader.client,{cursor:ready.page_cursor,max_response_bytes:131072});assert.equal(same.items[0]!.id,ready.items[0]!.id);
  assert.equal((await f.allMembers(reader.client,same.items[0]!.members_cursor)).items[0]!.source.revision_id,wanted.revision_id);
  t.diagnostic(JSON.stringify({synthetic_candidates:106,elapsed_ms:Math.round(performance.now()-started),serialized_bytes:Buffer.byteLength(JSON.stringify(same)),group_count:same.items.length}));
});

test('custody limits refuse without evicting recoverable views; bounded expiry cleanup releases one slot',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_caps');
  const first=await f.ready(reader.client,{selection:'complete'});
  for(let n=1;n<16;n++)await f.updates(reader.client,{});
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{})).body.error.code,'updates_capacity');
  assert.equal((await f.ready(reader.client,{cursor:first.page_cursor})).traversal.id,first.traversal.id);
  await f.observer.query("UPDATE loom.updates_views SET retain_until=clock_timestamp()-interval '1 second' WHERE id=$1",[first.traversal.id]);
  await f.updates(reader.client,{});assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.updates_views')).rows[0].n,16);
});

test('oversized busy groups and too many groups stop preparation explicitly without a false checkpoint',{timeout:120000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_group_caps'),d=await f.discussion();await f.follow(reader.client,f.settings('discussion',d.id,false,['replies']));
  for(let n=0;n<501;n++)await f.reply(d,'Capacity reply '+n);
  async function capacity(options:Parameters<typeof f.updates>[1]){
    let page=await f.updates(reader.client,options),steps=0;
    while(steps++<20){assert.equal(page.checkpoint,null);const result=await reader.client.call('/api/v1/me/updates/query',{cursor:page.next_cursor});
      if(result.status!==200){assert.equal(result.body.error.code,'updates_capacity');assert.equal(result.body.checkpoint,undefined);return page;}
      page=result.body;
    }throw new Error('Capacity must refuse within bounded preparation');
  }
  const started=performance.now(),large=await capacity({selection:'complete'});
  assert.ok((await f.observer.query('SELECT count(*)::int n FROM loom.updates_members WHERE view_id=$1',[large.traversal.id])).rows[0].n<=500);
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:large.next_cursor})).body.error.code,'updates_capacity');
  for(let n=0;n<257;n++)await f.artifact(f.admin,'Capacity group '+n);
  await capacity({scope:{kind:'explicit',definition:f.settings('area',f.area,false,['artifact_revisions'])},selection:'complete'});
  t.diagnostic(JSON.stringify({synthetic_reply_members:501,synthetic_artifact_groups:257,elapsed_ms:Math.round(performance.now()-started),outcome:'explicit_capacity_no_checkpoint'}));
});
