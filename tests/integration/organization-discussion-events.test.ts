import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixture} from '../helpers/organization.js';
import {mentioned} from '../helpers/notifications.js';
import {SearchWorker} from '../../src/server/modules/search/worker.js';

test('discussion closure is one structural change in Following and both Updates modes, never a new direct signal or summary source',{timeout:120000},async t=>{
 const f=await fixture(t),p=await f.participant('closure_observer'),d=await f.discussion();
 const c=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(p.id),change_note:null,change_account:null});
 const s=await f.create(d.id),coverage=(await f.coverage(s)).body;
 await f.follow(p.client,f.settings('discussion',d.id));await f.drain();
 const first=await f.changes(p.client,{limit:1});assert.ok(first.next_cursor);
 const retained=(await f.allChanges(p.client,{cursor:first.next_cursor!,limit:1})).items;
 const deliveries=(await f.observer.query('SELECT row_to_json(t)::text row FROM loom.personal_deliveries t ORDER BY 1')).rows;
 const command=await f.organizationCommand(d.id),closed=await f.organize(command);await f.organize(command);
 const opening=await f.closeDiscussion(d.id,false);await f.move(d.id,f.other,'discussion.move');await f.closeDiscussion(d.id);
 const events=(await f.observer.query("SELECT e.id,e.position,e.area_scope_ids,e.before_area_scope_ids,e.after_area_scope_ids,e.affected_target_ids,e.revision_id,o.operation_kind FROM loom.shared_activity e JOIN loom.organization_operations o ON o.source_event_id=e.id WHERE o.resource_id=$1 ORDER BY position",[d.id])).rows;
 assert.deepEqual(events.map(r=>r.operation_kind),['discussion.close','discussion.open','discussion.move','discussion.close']);
 assert.ok(events.every(r=>r.revision_id===null&&r.affected_target_ids.length===1&&r.affected_target_ids[0]===d.id));
 assert.deepEqual(events[0].area_scope_ids,[f.area]);assert.deepEqual(events[3].area_scope_ids,[f.other]);
 const continued=(await f.allChanges(p.client,{cursor:first.next_cursor!,limit:1})).items;
 assert.deepEqual(continued.map(({current,...event})=>event),retained.map(({current,...event})=>event),'Closure/move cannot extend a fixed interval or alter its historical relevance');
 const shared=await f.allChanges(p.client);for(const event of events)assert.equal(shared.items.filter(i=>i.event_id===event.id).length,1);
 assert.ok(shared.items.some(i=>i.revision_id===c.revision_id));
 const oldArea=await f.allChanges(p.client,{scope:{kind:'explicit',definition:f.settings('area',f.area,true)}});
 assert.ok(oldArea.items.some(i=>i.event_id===events[0].id));assert.ok(!oldArea.items.some(i=>i.event_id===events[3].id));
 for(const selection of ['highlights','complete'] as const){
   const v1=await f.ready(p.client,{selection}),v2=await f.readyRoutine(p.client,{selection});
   assert.ok(v1.items.some(i=>i.context_url==='/loom/discussion/'+d.id));assert.ok(v2.items.some(i=>i.context_url==='/loom/discussion/'+d.id));
   const members1=(await f.allMembers(p.client,v1.records_cursor!)).items,members2=await f.allRoutineMembers(p.client,v2.records_cursor!);
   for(const event of events){assert.equal(members1.filter(m=>m.source.event_id===event.id).length,1);assert.equal(members2.filter(m=>m.source.event_id===event.id).length,1);}
 }
 await f.drain();const search=new SearchWorker(f.database);for(let i=0;i<20;i++){await search.tick();if((await f.admin.call('/api/v1/search/status')).body.indexing==='ready')break;}
 assert.deepEqual((await f.observer.query('SELECT row_to_json(t)::text row FROM loom.personal_deliveries t ORDER BY 1')).rows,deliveries);
 assert.deepEqual((await f.coverage(s)).body,coverage);
 assert.ok((await p.client.call('/api/v1/search?q=inspect')).body.items.some((i:any)=>i.source_resource_id===c.resource_id));
 assert.equal(closed.current.local_open,false);assert.equal(opening.current.local_open,true);
});
