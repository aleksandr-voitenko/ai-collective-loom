import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../helpers/updates.js';
import { mentioned } from '../helpers/notifications.js';
import { content, note, revisionBody } from '../helpers/changes.js';

test('AC07: twenty replies and summary coalesce with one exact signal; empty Following includes only personal sources',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_reader'),unfollowed=await f.participant('updates_personal'),d=await f.discussion();
  await f.follow(reader.client,f.settings('discussion',d.id));
  const base=await f.allGroups(reader.client),expected:string[]=[];
  let direct:{resource_id:string;revision_id:string}|undefined;
  for(let i=0;i<20;i++){
    const body=i===9?{...mentioned(reader.id),text:'Exact direct source [[mention:a]] and [[mention:b]].',
      mentions:[{token:'a',participant_id:reader.id},{token:'b',participant_id:unfollowed.id}]}:content('Routine reply '+i);
    const r=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:body,change_note:null,change_account:null});
    expected.push(await f.event(r.revision_id));if(i===9)direct=r;
  }
  const summary=await f.create(d.id);expected.push(await f.event(summary.revision_id));await f.drain();
  const before=(await f.observer.query(`SELECT (SELECT shared_position FROM loom.community_clocks) AS shared,
    (SELECT count(*) FROM loom.personal_deliveries) AS deliveries,(SELECT count(*) FROM loom.following_targets) AS follows,
    (SELECT count(*) FROM loom.saved_items) AS saved`)).rows;
  const result=await f.allGroups(reader.client,{checkpoint:base.page.checkpoint!,selection:'complete'});
  assert.equal(result.items.length,1);const group=result.items[0]!;
  assert.deepEqual(group.counts,{certainty:'exact',source_records:21,shared_changes:21,personal_signals:1,reply_publications:20,
    reply_revisions:0,summary_changes:1,artifact_changes:0,opening_changes:0,structural_changes:0});
  assert.equal(group.direct_sources[0]!.source.revision_id,direct!.revision_id);
  assert.equal(group.direct_sources[0]!.personal!.source_event_id,await f.event(direct!.revision_id));
  const all=await f.allMembers(reader.client,group.members_cursor,3);
  assert.deepEqual(all.items.map(m=>m.source.event_id).sort(),expected.sort());
  assert.equal(all.items.find(m=>m.source.revision_id===summary.revision_id)!.source.context_url,`/loom/discussion/${d.id}`);
  const own=await f.allGroups(unfollowed.client);assert.equal(own.items.length,1);assert.equal(own.items[0]!.counts.source_records,1);
  assert.equal(own.items[0]!.counts.shared_changes,0);assert.equal(own.page.grouped_interval_complete,true);
  assert.deepEqual((await unfollowed.client.call('/api/v1/me/following')).body.items,[]);
  assert.deepEqual((await f.observer.query(`SELECT (SELECT shared_position FROM loom.community_clocks) AS shared,
    (SELECT count(*) FROM loom.personal_deliveries) AS deliveries,(SELECT count(*) FROM loom.following_targets) AS follows,
    (SELECT count(*) FROM loom.saved_items) AS saved`)).rows,before);
});

test('bounded preparation, direct-first highlights and complete members preserve independent expected identities',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_large'),d=await f.discussion(),expected:string[]=[];
  await f.follow(reader.client,f.settings('discussion',d.id,false,['replies']));
  for(let i=0;i<112;i++){
    const r=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,
      content:i<7?mentioned(reader.id):content('Bounded routine '+i),change_note:null,change_account:null});expected.push(await f.event(r.revision_id));
  }
  for(let i=0;i<8;i++){
    const a=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Direct group '+i,content:mentioned(reader.id),change_note:null,change_account:null});
    expected.push(await f.event(a.revision_id));
  }
  await f.drain();
  const first=await f.updates(reader.client,{limit:2});assert.equal(first.stage,'preparing');assert.equal(first.grouped_interval_complete,false);assert.equal(first.items.length,0);
  const result=await f.allGroups(reader.client,{cursor:first.next_cursor!,limit:2});
  assert.equal(result.items.length,9);assert.equal(result.page.selection_exhausted,true);assert.equal(result.page.checkpoint,null);
  const busy=result.items.find(g=>g.kind==='discussion')!;assert.equal(busy.counts.source_records,112);assert.equal(busy.counts.personal_signals,7);
  assert.equal(busy.direct_sources.length,2);assert.equal(busy.direct_sources_complete,false);
  assert.equal((await f.allMembers(reader.client,busy.direct_cursor!,2)).items.length,7);
  const full=await f.allMembers(reader.client,result.page.records_cursor!,13);
  assert.deepEqual(full.items.map(m=>m.source.event_id).sort(),expected.sort());assert.equal(full.page.complete,true);
  assert.equal(new Set(full.items.map(m=>m.source.event_id)).size,120);
});

test('highlights switch retains definitions and both fixed boundaries across new Following and arrivals',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_switch');await f.follow(reader.client,f.settings('area',f.area));
  const expected:string[]=[];
  for(let i=0;i<7;i++)expected.push((await f.artifact(f.admin,'Routine artifact '+i)).revision_id);
  const highlights=await f.allGroups(reader.client,{selection:'highlights',limit:2});
  assert.equal(highlights.items.length,3);assert.equal(highlights.page.selection_exhausted,true);assert.equal(highlights.page.checkpoint,null);
  await f.follow(reader.client,f.settings('area',f.area),false,1);
  const newer=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Later direct',content:mentioned(reader.id),change_note:null,change_account:null});await f.drain();
  const full=await f.allGroups(reader.client,{switch:{token:highlights.page.page_cursor,selection:'complete'},limit:2});
  assert.equal(full.page.traversal.settings_current,false);assert.equal(full.items.length,8); // retained setup overview
  assert.deepEqual(full.page.traversal.definitions,highlights.page.traversal.definitions);
  for(const c of ['shared','personal'] as const)assert.deepEqual(full.page.traversal[c],highlights.page.traversal[c]);
  const records=await f.allMembers(reader.client,full.page.records_cursor!);
  assert.ok(expected.every(id=>records.items.some(m=>m.source.revision_id===id)));
  assert.ok(!records.items.some(m=>m.source.revision_id===newer.revision_id));assert.ok(full.page.checkpoint);
});

test('late personal repair is outside open bounds and newly discoverable after completed shared and combined bounds',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_repair'),d=await f.discussion();
  await f.follow(reader.client,f.settings('discussion',d.id));
  const r=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(reader.id),change_note:null,change_account:null});
  const shared=await f.allChanges(reader.client),completed=await f.allGroups(reader.client);
  const fixed=await f.updates(reader.client,{checkpoint:completed.page.checkpoint!});
  await f.drain();
  assert.deepEqual((await f.allGroups(reader.client,{cursor:fixed.next_cursor!})).items,[]);
  const repaired=await f.allGroups(reader.client,{checkpoint:completed.page.checkpoint!});
  assert.equal(repaired.items.length,1);assert.equal(repaired.items[0]!.counts.shared_changes,0);
  assert.equal(repaired.items[0]!.direct_sources[0]!.source.revision_id,r.revision_id);
  assert.deepEqual((await f.allChanges(reader.client,{checkpoint:shared.page.checkpoint!})).items,[]);
  await f.restart();const replay=await f.ready(reader.client,{cursor:repaired.page.page_cursor});
  const stable=(items:typeof replay.items)=>items.map(({members_cursor:_,direct_cursor:__,...item})=>item);
  assert.deepEqual(stable(replay.items),stable(repaired.page.items));
  const outside=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Delayed outside Following',content:mentioned(reader.id),change_note:null,change_account:null});
  const before=await f.allGroups(reader.client,{checkpoint:repaired.page.checkpoint!}),open=await f.updates(reader.client,{checkpoint:before.page.checkpoint!});await f.drain();
  assert.deepEqual((await f.allGroups(reader.client,{cursor:open.next_cursor!})).items,[]);
  const delivered=await f.allGroups(reader.client,{checkpoint:before.page.checkpoint!});assert.equal(delivered.items[0]!.counts.shared_changes,0);
  assert.equal(delivered.items[0]!.direct_sources[0]!.source.revision_id,outside.revision_id);
});

test('authored note and independent account explain exact included revisions with fixed provenance',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_notes'),bob=await f.participant('updates_bob'),d=await f.discussion(),a=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',a.resource_id));await f.follow(reader.client,f.settings('discussion',d.id));
  const r2=await f.publish(f.admin,'/api/v1/revisions',revisionBody(a,'R2',note('Only R2')));
  const r3=await f.publish(f.admin,'/api/v1/revisions',revisionBody(r2,'R3'));
  const account=await f.publish(bob.client,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(reader.id),change_note:null,
    change_account:{revisions:[{kind:'artifact',resource_id:a.resource_id,revision_id:r3.revision_id}]}});await f.drain();
  const view=await f.allGroups(reader.client),artifact=view.items.find(g=>g.kind==='artifact')!;
  assert.equal(artifact.explanation!.form,'revision_note');assert.deepEqual(artifact.explanation!.included_revisions,[{kind:'artifact',resource_id:a.resource_id,revision_id:r2.revision_id}]);
  const discussion=view.items.find(g=>g.kind==='discussion')!;assert.equal(discussion.direct_sources[0]!.source.resource_id,account.resource_id);
  const r4=await f.publish(f.admin,'/api/v1/revisions',revisionBody(r3,'R4',note('After upper bound')));
  const replay=await f.ready(reader.client,{cursor:view.page.page_cursor});assert.equal(replay.items.find(g=>g.kind==='artifact')!.explanation!.revision_id,r2.revision_id);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[r2.revision_id]));
  const restored=await f.allGroups(reader.client,{recovery:{action:'replay',token:view.page.page_cursor},selection:'complete'});
  assert.ok(restored.items.find(g=>g.kind==='artifact')!.explanation); // current R4 note is now explicitly in replay
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[r4.revision_id]));
  const independent=await f.allGroups(reader.client,{recovery:{action:'replay',token:restored.page.page_cursor}}),explained=independent.items.find(g=>g.kind==='artifact')!;
  assert.equal(explained.explanation!.form,'change_account');assert.equal(explained.explanation!.publisher.id,bob.id);assert.equal(explained.explanation!.resource_id,account.resource_id);
  assert.deepEqual(explained.explanation!.included_revisions,[{kind:'artifact',resource_id:a.resource_id,revision_id:r3.revision_id}]);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]));
  const targetHidden=await f.allGroups(reader.client,{recovery:{action:'replay',token:independent.page.page_cursor}});
  assert.equal(targetHidden.items.length,1);assert.equal(targetHidden.items[0]!.kind,'discussion');assert.equal((await bob.client.call(`/api/v1/resources/${account.resource_id}/revisions/${account.revision_id}`)).status,200);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[a.resource_id]));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));
  const fallback=await f.allGroups(reader.client,{recovery:{action:'replay',token:targetHidden.page.page_cursor}});assert.equal(fallback.items.length,1);assert.equal(fallback.items[0]!.explanation,null);
});
