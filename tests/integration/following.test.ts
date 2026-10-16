import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/following.js';
import { content,note,revisionBody } from '../helpers/changes.js';
import { mentioned } from '../helpers/notifications.js';

test('owner-private desired settings preserve parents, same-name leaves, old decisions and absent-target concurrency',{timeout:90000},async t=>{
  const f=await fixture(t),human=await f.participant('following_human','human'),agent=await f.participant('following_agent');
  const p=await f.newArea('Parent'),c=await f.newArea('Same name',p),other=await f.newArea('Same name',f.other);
  for(const client of [human.client,agent.client]){
    for(const d of [f.settings('area',p,true),f.settings('area',c),f.settings('area',other)])assert.equal((await f.follow(client,d)).result.operation_state,'applied');
    const list=(await client.call('/api/v1/me/following')).body;
    assert.deepEqual(list.items.map((i:any)=>i.target.resource_id).sort(),[p,c,other].sort());
    assert.deepEqual(list.items.find((i:any)=>i.target.resource_id===c).source.path.map((x:any)=>x.title),['Parent','Same name']);
  }
  assert.deepEqual((await f.admin.call('/api/v1/me/following')).body.items,[]);
  assert.equal((await f.admin.call('/api/v1/me/following?participant_id='+agent.id)).status,400);
  const d=f.settings('area',p,true),first=(await f.follow(agent.client,d,false,1)).body;
  const replay=await agent.client.call('/api/v1/me/following/state',first);assert.equal(replay.body.current.following,false);
  const target=f.settings('artifact',(await f.artifact()).resource_id);
  const k1={...target,idempotency_key:randomUUID(),following:true,expected_version:0},k2={...target,idempotency_key:randomUUID(),following:false,expected_version:0};
  const opposite=await Promise.all([agent.client.call('/api/v1/me/following/state',k1),agent.client.call('/api/v1/me/following/state',k2)]);
  assert.deepEqual(opposite.map(r=>r.body.operation_state).sort(),['applied','version_conflict']);
  const current=(await agent.client.call('/api/v1/me/following/lookup',target.target)).body;
  await f.follow(agent.client,target,false,current.version);
  assert.equal((await agent.client.call('/api/v1/me/following/state',k1)).body.current.following,false);
  assert.equal((await agent.client.call('/api/v1/me/following/state',{...k1,preferences:['change_notes']})).body.error.code,'idempotency_conflict');
  const absent=f.settings('artifact',(await f.artifact()).resource_id);
  await f.follow(agent.client,absent,false);
  assert.equal((await f.follow(agent.client,absent,true)).result.operation_state,'version_conflict');
  const before=(await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows;
  const noOp=await f.follow(agent.client,absent,false,1);assert.equal(noOp.result.current.version,2);
  assert.deepEqual((await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows,before);
  await f.restart();assert.equal((await agent.client.call('/api/v1/me/following/status',{idempotency_key:noOp.body.idempotency_key})).body.current.version,2);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[absent.target.resource_id]));
  assert.deepEqual((await agent.client.call('/api/v1/me/following/lookup',absent.target)).body.source,{state:'unavailable'});
  assert.equal((await f.follow(agent.client,absent,false,2)).result.operation_state,'applied');
});

test('independent expected event set: overlap, exact notes, direct discussions, summaries and citing accounts',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('shared_reader'),d=await f.discussion();
  const a=await f.artifact(),reply=await f.reply(d),summary=await f.create(d.id);
  const r2=(await f.admin.call('/api/v1/revisions',revisionBody(a,'New artifact',note('Exact R2 note')))).body;
  const r3=(await f.admin.call('/api/v1/revisions',revisionBody(r2,'Current artifact'))).body;
  const account=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:content('An independent account'),change_note:null,
    change_account:{revisions:[{kind:'artifact',resource_id:a.resource_id,revision_id:r2.revision_id}]}});
  const definitions=[f.settings('area',f.area,true),f.settings('discussion',d.id),f.settings('artifact',a.resource_id)];
  for(const def of definitions)await f.follow(reader.client,def);
  const overview=(await f.observer.query('SELECT r.current_revision_id AS revision_id FROM loom.community_settings c JOIN loom.resources r ON r.id=c.overview_id')).rows[0];
  const expected:string[]=[];
  for(const source of [overview,d.opening,reply,summary,a,r2,r3,account])expected.push(await f.event(source.revision_id));
  const result=await f.allChanges(reader.client,{limit:2});
  // Setup's real overview is also in General; it is part of retained shared history.
  assert.deepEqual(result.items.map(i=>i.event_id).sort(),expected.sort());
  assert.equal(new Set(result.items.map(i=>i.event_id)).size,expected.length);assert.equal(result.page.interval_complete,true);
  const n=result.items.find(i=>i.revision_id===r2.revision_id)!;assert.ok(n.change_note_url);assert.equal(n.current.state,'available');
  assert.deepEqual(n.reasons.map(r=>r.preferences),[['artifact_revisions','change_notes'],['artifact_revisions','change_notes']]);
  assert.equal(result.items.find(i=>i.revision_id===r3.revision_id)!.change_note_url,null);
  const discussion=await f.allChanges(reader.client,{scope:{kind:'explicit',definition:f.settings('discussion',d.id)}});
  assert.deepEqual(discussion.items.map(i=>i.resource_id).sort(),[d.opening.resource_id,reply.resource_id,summary.resource_id,account.resource_id].sort());
  const direct=await f.allChanges(reader.client,{scope:{kind:'explicit',definition:f.settings('artifact',a.resource_id)}});
  assert.deepEqual(direct.items.map(i=>i.revision_id),[a.revision_id,r2.revision_id,r3.revision_id]);
  assert.equal((await f.admin.call('/api/v1/me/following')).body.items.length,0);
});

test('bound settings and upper intervals survive moves, subtree impacts, publication and subscription changes',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('shared_moves'),parent=await f.newArea('Parent',f.area),leaf=await f.newArea('Leaf',parent);
  const a=await f.publish(f.admin,'/api/v1/artifacts',{area_id:leaf,title:'In leaf',content:{format:'loom-markdown-v1',text:'Old',mentions:[]}});
  const d=f.settings('area',f.area,true,['artifact_revisions','structural']);await f.follow(reader.client,d);
  const first=await f.changes(reader.client,{limit:1});assert.ok(first.next_cursor);
  await f.move(parent,f.other,'area.move');
  const newer=await f.publish(f.admin,'/api/v1/revisions',{resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'In leaf',content:{format:'loom-markdown-v1',text:'New',mentions:[]}});
  await f.follow(reader.client,{...d,include_descendants:false},true,1);
  const rest=await f.allChanges(reader.client,{cursor:first.next_cursor!});
  assert.equal(rest.page.traversal.settings_current,false);assert.ok(rest.items.some(i=>i.revision_id===a.revision_id));assert.ok(!rest.items.some(i=>i.revision_id===newer.revision_id));
  assert.equal((await reader.client.call('/api/v1/shared-changes/query',{checkpoint:rest.page.checkpoint})).body.error.code,'shared_definition_changed');
  const direct=await f.allChanges(reader.client,{scope:{kind:'explicit',definition:f.settings('artifact',a.resource_id)}});
  assert.equal(direct.items.filter(i=>i.kind==='area.move').length,1);assert.equal(direct.items.find(i=>i.kind==='area.move')!.reasons[0]!.relevance,'ancestor_impact');
  const ownLeaf=await f.allChanges(reader.client,{scope:{kind:'explicit',definition:f.settings('area',leaf,false)}});
  assert.ok(ownLeaf.items.some(i=>i.kind==='area.move'));assert.ok(ownLeaf.items.some(i=>i.revision_id===a.revision_id));
  const oldArea=await f.allChanges(reader.client,{scope:{kind:'explicit',definition:d}});
  assert.ok(oldArea.items.some(i=>i.revision_id===a.revision_id));assert.ok(!oldArea.items.some(i=>i.revision_id===newer.revision_id));
});

test('restoration reaches before completed checkpoints; suppressed current and parent metadata remain independent',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('shared_visibility'),d=await f.discussion(),reply=await f.reply(d);
  await f.follow(reader.client,f.settings('discussion',d.id,false,['replies']));
  const old=await f.changes(reader.client);assert.equal(old.items[0]!.revision_id,reply.revision_id);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[reply.resource_id]));
  const hidden=await f.changes(reader.client);assert.deepEqual(hidden.items,[]);
  const completed=await f.changes(reader.client,{checkpoint:hidden.checkpoint!});
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[reply.resource_id]));
  assert.equal((await reader.client.call('/api/v1/shared-changes/query',{checkpoint:completed.checkpoint})).body.error.code,'shared_visibility_replay_required');
  const replay=await f.changes(reader.client,{recovery:{action:'replay',token:completed.checkpoint!}});
  assert.equal(replay.items[0]!.event_id,old.items[0]!.event_id);
  const child=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:reply.resource_id,content:{format:'loom-markdown-v1',text:'Eligible child',mentions:[]}});
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[reply.resource_id]));
  assert.deepEqual((await f.changes(reader.client)).items.map(i=>i.resource_id),[child.resource_id]);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));
  assert.deepEqual((await f.changes(reader.client)).items,[]);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[d.id]));
  assert.deepEqual((await f.changes(reader.client)).items.map(i=>i.resource_id),[child.resource_id]);
});

test('empty Following is explicit; shared reads work with both workers stopped and preserve delayed personal delivery',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('independent_reader');
  const empty=await f.changes(reader.client);assert.equal(empty.no_subscriptions,true);assert.equal(empty.interval_complete,false);assert.equal(empty.checkpoint,null);
  await f.follow(reader.client,f.settings('area',f.area));
  const a=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Attention independently',content:mentioned(reader.id),change_note:null,change_account:null});
  const shared=await f.changes(reader.client);assert.ok(shared.items.some(i=>i.revision_id===a.revision_id));assert.ok(shared.checkpoint);
  const personal=await f.page(reader.client);assert.deepEqual(personal.items,[]);
  await f.drain();assert.equal((await f.page(reader.client,{checkpoint:personal.checkpoint!})).items[0]!.source.revision_id,a.revision_id);
  assert.deepEqual((await f.changes(reader.client,{checkpoint:shared.checkpoint!})).items,[]);
  await f.restart();assert.deepEqual((await f.changes(reader.client,{checkpoint:shared.checkpoint!})).items,[]);
  assert.equal((await reader.client.call('/api/v1/shared-changes/query',{cursor:personal.page_cursor})).body.error.code,'shared_token_invalid');
  assert.equal((await reader.client.call('/api/v1/me/notifications/query',{cursor:shared.page_cursor})).body.error.code,'notification_token_invalid');
});

test('direct discussion and artifact moves preserve old scope membership while added and removed follows stay frozen',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('direct_moves'),d=await f.discussion(),a=await f.artifact();
  const area=f.settings('area',f.area,true),discussion=f.settings('discussion',d.id),artifact=f.settings('artifact',a.resource_id);
  await f.follow(reader.client,area);await f.follow(reader.client,discussion);
  const overview=(await f.observer.query('SELECT r.current_revision_id AS revision_id FROM loom.community_settings c JOIN loom.resources r ON r.id=c.overview_id')).rows[0];
  const expected:string[]=[];for(const id of [overview.revision_id,d.opening.revision_id,a.revision_id])expected.push(await f.event(id));
  const first=await f.changes(reader.client,{limit:1});assert.ok(first.next_cursor);
  await f.follow(reader.client,artifact);await f.follow(reader.client,area,false,1);
  await f.move(d.id,f.other,'discussion.move');await f.move(a.resource_id,f.other,'artifact.move');
  const reply=await f.reply(d),newer=await f.publish(f.admin,'/api/v1/revisions',{resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Moved artifact',content:{format:'loom-markdown-v1',text:'At new location',mentions:[]}});
  const tail=await f.allChanges(reader.client,{cursor:first.next_cursor!});
  assert.deepEqual([...first.items,...tail.items].map(i=>i.event_id).sort(),expected.sort());assert.equal(tail.page.traversal.settings_current,false);
  assert.equal((await reader.client.call('/api/v1/shared-changes/query',{checkpoint:tail.page.checkpoint})).body.error.code,'shared_definition_changed');
  const current=await f.allChanges(reader.client);assert.deepEqual(current.items.filter(i=>i.revision_id).map(i=>i.revision_id).sort(),[d.opening.revision_id,a.revision_id,reply.revision_id,newer.revision_id].sort());
  assert.deepEqual(current.items.filter(i=>!i.revision_id).map(i=>i.kind).sort(),['artifact.move','discussion.move']);
  for(const item of current.items){assert.equal(item.current.state,'available');if(item.current.state==='available')assert.equal(item.current.path.at(-1)!.id,f.other);}
  const oldArea=await f.allChanges(reader.client,{scope:{kind:'explicit',definition:area}});assert.ok(oldArea.items.some(i=>i.revision_id===d.opening.revision_id));assert.ok(!oldArea.items.some(i=>i.revision_id===reply.revision_id));assert.ok(!oldArea.items.some(i=>i.revision_id===newer.revision_id));
});
