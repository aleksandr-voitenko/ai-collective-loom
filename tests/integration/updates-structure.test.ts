import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../helpers/updates.js';
import { mentioned } from '../helpers/notifications.js';

test('overlapping ancestor follows retain all bounded reasons and distinct triggering revisions',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_overlap');let leaf=f.area;const areas=[leaf];
  for(let n=0;n<8;n++){leaf=await f.newArea('Ancestor '+n,leaf);areas.push(leaf);}
  for(const area of areas)await f.follow(reader.client,f.settings('area',area,true,['artifact_revisions','change_notes']));
  const source=await f.publish(f.admin,'/api/v1/artifacts',{area_id:leaf,title:'Overlapping exact source',content:mentioned(reader.id),
    change_note:{format:'loom-markdown-v2',text:'Editor [[mention:n]]',mentions:[{token:'n',participant_id:reader.id}],references:[]},change_account:null});
  await f.follow(reader.client,f.settings('artifact',source.resource_id));
  const next=await f.publish(f.admin,'/api/v1/revisions',{resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Overlapping R2',content:mentioned(reader.id),
    change_note:{format:'loom-markdown-v2',text:'Second revision [[mention:n]]',mentions:[{token:'n',participant_id:reader.id}],references:[]},change_account:null});await f.drain();
  const result=await f.allGroups(reader.client),group=result.items.find(g=>g.current.state==='available'&&g.current.title==='Overlapping R2')!;
  assert.equal(group.counts.source_records,2);assert.equal(group.counts.shared_changes,2);assert.equal(group.counts.personal_signals,2);
  const records=await f.allMembers(reader.client,group.members_cursor,1);
  assert.deepEqual(records.items.map(m=>m.source.revision_id).sort(),[source.revision_id,next.revision_id].sort());
  assert.equal(new Set(records.items.map(m=>m.personal!.delivery_id)).size,2);
  const r1=records.items.find(m=>m.source.revision_id===source.revision_id)!;
  assert.deepEqual(r1.personal!.reasons.map(r=>r.kind).sort(),['main_mention','note_mention']);assert.equal(r1.source.reasons.length,8);assert.equal(r1.source.reasons_complete,false);
  const remaining=await reader.client.call(r1.source.detail_url,{cursor:group.members_cursor,event_id:r1.source.event_id,reason_offset:r1.source.next_reason});
  assert.equal(remaining.status,200);assert.equal(remaining.body.reasons_complete,true);
  assert.deepEqual([...r1.source.reasons,...remaining.body.reasons].map(r=>r.target.resource_id).sort(),[...areas,source.resource_id].sort());
  const later=await f.artifact(f.admin,'After this bound');
  assert.equal((await reader.client.call('/api/v1/me/updates/reasons',{cursor:result.page.page_cursor,event_id:await f.event(later.revision_id)})).status,404);
});

test('direct moves and subtree notices preserve event-time union membership and separately current paths',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_moves'),parent=await f.newArea('Original parent',f.area),leaf=await f.newArea('Original leaf',parent);
  const a=await f.publish(f.admin,'/api/v1/artifacts',{area_id:leaf,title:'Moved artifact',content:{format:'loom-markdown-v1',text:'Before',mentions:[]}}),d=await f.discussion();
  await f.follow(reader.client,f.settings('artifact',a.resource_id));await f.follow(reader.client,f.settings('discussion',d.id));
  const initial=await f.ready(reader.client,{selection:'complete',limit:1});
  await f.move(parent,f.other,'area.move');await f.move(d.id,f.other,'discussion.move');await f.move(a.resource_id,f.area,'artifact.move');
  const newer=await f.revise(f.admin,a,'Moved R2',[]),reply=await f.reply(d);
  const tail=await f.allGroups(reader.client,{cursor:initial.next_cursor!});
  const oldRecords=await f.allMembers(reader.client,tail.page.records_cursor!);
  assert.deepEqual(oldRecords.items.map(m=>m.source.revision_id).sort(),[a.revision_id,d.opening.revision_id].sort());
  const following=await f.allGroups(reader.client,{checkpoint:tail.page.checkpoint!}),records=await f.allMembers(reader.client,following.page.records_cursor!);
  assert.deepEqual(records.items.filter(m=>m.source.revision_id).map(m=>m.source.revision_id).sort(),[newer.revision_id,reply.revision_id].sort());
  assert.deepEqual(records.items.filter(m=>!m.source.revision_id).map(m=>m.source.kind).sort(),['area.move','artifact.move','discussion.move']);
  assert.equal(following.items.filter(g=>g.kind==='structural').length,1);
  assert.equal(following.items.reduce((n,g)=>n+g.counts.structural_changes,0),3);
  const notice=records.items.find(m=>m.source.kind==='area.move')!;assert.equal(notice.source.resource_id,parent);assert.ok(notice.source.reasons.some(r=>r.relevance==='ancestor_impact'));
  const historical=await f.allGroups(reader.client,{scope:{kind:'explicit',definition:f.settings('area',f.area,true,['artifact_revisions','replies','new_discussions','structural'])}});
  const history=await f.allMembers(reader.client,historical.page.records_cursor!);
  assert.ok(history.items.some(m=>m.source.revision_id===a.revision_id));assert.ok(!history.items.some(m=>m.source.revision_id===reply.revision_id));
  assert.equal(history.items.find(m=>m.source.revision_id===d.opening.revision_id)!.source.current.state,'available');
  const discussion=following.items.find(g=>g.kind==='discussion')!;assert.equal(discussion.current.state,'available');
  if(discussion.current.state==='available')assert.equal(discussion.current.path.at(-1)!.id,f.other);
});
