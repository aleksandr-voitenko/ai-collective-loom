import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/attention.js';
import {editUpdatesToken} from '../helpers/updates-token.js';
import {mentioned} from '../helpers/notifications.js';
import {gates} from '../helpers/updates-gates.js';
import {bounded,blockedBy} from '../helpers/search-races.js';
import SwaggerParser from '@apidevtools/swagger-parser';

test('closed release discovery, private routes, retention ceilings and full Unicode JSON remain bounded',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_limits'),a=await f.artifact(f.admin,'文🌿'.repeat(50)),b=await f.artifact();
  const community=(await r.client.call('/api/v1/community')).body;assert.equal(community.guide_revision,'19');assert.equal(community.notes_contract,'owner-notes-1');assert.equal(community.notes_url,'/api/v1/me/notes/query');assert.equal(community.attention_contract,'attention-controls-1');assert.equal(community.updates_contract,'combined-updates-1');assert.equal(community.routine_updates_contract,'combined-updates-2');
  assert.equal(community.derived_effects,'search_personal_direct_attention_and_supported_file_text; other_projections_disabled');assert.equal(community.file_text_contract,'literal-utf8-v1');assert.equal(community.file_search_url,'/api/v1/search/files');
  const schema=(await f.admin.call('/api/v1/openapi.json')).body;await SwaggerParser.validate(structuredClone(schema));
  for(const path of ['/attention/mutes/lookup','/attention/mutes/state','/attention/dismissals/lookup','/attention/dismissals/state','/attention/status','/attention/list','/routine-updates/query','/routine-updates/members','/routine-updates/reasons','/routine-updates/selection'])assert.ok(schema.paths['/api/v1/me'+path]?.post);
  const accepted=await f.mute(r.client,'artifact',a.resource_id),base={target:{kind:'artifact',resource_id:b.resource_id},include_descendants:false,muted:true,expected_version:0};
  for(const [column,limit] of [['active_mutes',64],['mutes',500],['members',100000],['operations',50000]] as const){
    // Isolated counter boundary injection; this is not a claim to have retained
    // 50,000 actual operations or a supported production maintenance procedure.
    await f.observer.query(`UPDATE loom.attention_owners SET ${column}=$2 WHERE participant_id=$1`,[r.id,limit]);
    assert.equal((await r.client.call(f.endpoint+'/mutes/state',{...base,idempotency_key:randomUUID()})).body.error.code,'attention_limit_reached');
    assert.equal((await r.client.call(f.endpoint+'/mutes/state',accepted.body)).body.idempotency,'replayed');
    assert.equal((await r.client.call(f.endpoint+'/mutes/lookup',base.target)).status,200);
    await f.observer.query(`UPDATE loom.attention_owners SET ${column}=1 WHERE participant_id=$1`,[r.id]);
  }
  await f.observer.query('UPDATE loom.attention_owners SET inputs=10000 WHERE participant_id=$1',[r.id]);
  assert.equal((await r.client.call(f.endpoint+'/dismissals/state',{idempotency_key:randomUUID(),inputs:[{kind:'shared_event',id:await f.event(a.revision_id),dismissed:true,expected_version:0}]})).body.error.code,'attention_limit_reached');
  const list=await r.client.call(f.endpoint+'/list',{collection:'mutes',max_response_bytes:4096});assert.equal(list.status,200,JSON.stringify(list.body));assert.ok(Buffer.byteLength(JSON.stringify(list.body))<=4096);assert.equal(list.headers['cache-control'],'private, no-store');
  assert.equal((await r.client.call('/api/v1/me/routine-updates/query',{selection:'complete'})).headers['cache-control'],'private, no-store');
  const many=Array.from({length:101},()=>({kind:'shared_event',id:randomUUID(),dismissed:true,expected_version:0}));
  assert.equal((await r.client.call(f.endpoint+'/dismissals/state',{idempotency_key:randomUUID(),inputs:many})).status,400);
  assert.equal((await r.client.call(f.endpoint+'/mutes/state',{...base,idempotency_key:randomUUID(),private_note:'文'.repeat(30000)})).status,413);
  let parent=f.area;for(let n=0;n<7;n++)parent=await f.newArea('文'.repeat(160),parent);
  await f.mute(r.client,'area',parent);
  const tooSmall=await r.client.call(f.endpoint+'/list',{collection:'mutes',max_response_bytes:4096});assert.equal(tooSmall.body.error.code,'response_budget_too_small');
  const larger=await r.client.call(f.endpoint+'/list',{collection:'mutes'});assert.equal(larger.status,200);assert.equal(larger.body.mutes[0].target.resource_id,parent);
  t.diagnostic(JSON.stringify({unicode_title_utf8_bytes:Buffer.byteLength('文🌿'.repeat(50)),mute_list_utf8_bytes:Buffer.byteLength(JSON.stringify(list.body)),deep_list_utf8_bytes:Buffer.byteLength(JSON.stringify(larger.body)),minimum_refused_budget:4096}));
});

test('expired selection is not renewed implicitly; recorded recovery precedes expiry and lost grouping',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_expiry'),a=await f.artifact();await f.follow(r.client,f.settings('artifact',a.resource_id));
  const page=await f.readyRoutine(r.client),s=await f.selection(r.client,page.page_cursor,page.items[0]!.id);
  const key=(await f.observer.query('SELECT selection_key FROM loom.attention_state')).rows[0].selection_key;
  const expired=editUpdatesToken(s.selection,key,b=>b.expires=0,'attention-controls-1'),body=f.fromSelection({...s,selection:expired});
  assert.equal((await r.client.call(f.endpoint+'/dismissals/state',body)).body.error.code,'attention_selection_expired');
  assert.equal((await r.client.call(f.endpoint+'/status',{idempotency_key:body.idempotency_key})).body.operation_state,'not_recorded');
  const valid=f.fromSelection(s);await f.dismiss(r.client,valid);
  await f.observer.query('DELETE FROM loom.updates_views WHERE id=$1',[page.traversal.id]);
  assert.equal((await f.dismiss(r.client,valid)).idempotency,'replayed');
  const fresh=await f.readyRoutine(r.client),cursorKey=(await f.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0].cursor_key;
  const old=editUpdatesToken(fresh.page_cursor,cursorKey,b=>b.expires=0,'combined-updates-2');
  assert.equal((await r.client.call('/api/v1/me/routine-updates/query',{cursor:old})).body.error?.code,'updates_descriptor_expired');
  const renewed=await f.readyRoutine(r.client,{recovery:{action:'renew',token:old}});assert.equal(renewed.traversal.id,fresh.traversal.id);
  await f.mute(r.client,'artifact',a.resource_id);await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=1');
  assert.equal((await r.client.call('/api/v1/me/routine-updates/query',{cursor:renewed.page_cursor})).body.error.code,'updates_shared_history_gap','gap precedes changed attention policy');
  await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=0');await f.observer.query('UPDATE loom.updates_state SET recovery_epoch=$1',[randomUUID()]);
  assert.equal((await r.client.call('/api/v1/me/routine-updates/query',{cursor:renewed.page_cursor})).body.error.code,'updates_epoch_changed');
});

test('expired routine view with changed policy refreshes the same captured interval within its original custody',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_expired_policy'),a=await f.artifact();await f.follow(r.client,f.settings('artifact',a.resource_id));
  const page=await f.readyRoutine(r.client,{reason:'reply'}),key=(await f.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0].cursor_key;
  const expired=editUpdatesToken(page.page_cursor,key,b=>b.expires=0,'combined-updates-2');
  const custody=(await f.observer.query('SELECT retain_until FROM loom.updates_views WHERE id=$1',[page.traversal.id])).rows;
  await f.mute(r.client,'artifact',a.resource_id);await f.follow(r.client,f.settings('artifact',a.resource_id),false,1);await f.artifact();
  const query='/api/v1/me/routine-updates/query';
  assert.equal((await r.client.call(query,{cursor:expired})).body.error.code,'updates_descriptor_expired');
  assert.equal((await r.client.call(query,{recovery:{action:'renew',token:expired}})).body.error.code,'updates_attention_refresh_required');
  const refreshed=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:expired}});
  assert.deepEqual(refreshed.items,[]);assert.ok(Date.parse(refreshed.traversal.expires_at)>Date.now());
  for(const field of ['id','scope','definitions','reason','shared','personal'] as const)assert.deepEqual(refreshed.traversal[field],page.traversal[field],field);
  assert.equal(refreshed.traversal.settings_current,false);
  assert.deepEqual((await f.observer.query('SELECT retain_until FROM loom.updates_views WHERE id=$1',[page.traversal.id])).rows,custody);
  const complete=await f.readyRoutine(r.client,{switch:{selection:'complete',token:refreshed.page_cursor}});
  assert.deepEqual((await f.allRoutineMembers(r.client,complete.records_cursor!)).map(v=>v.source.revision_id),[a.revision_id]);
  await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=1');
  assert.equal((await r.client.call(query,{recovery:{action:'attention_refresh',token:expired}})).body.error.code,'updates_shared_history_gap');
  await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=0');
  await f.observer.query("UPDATE loom.updates_views SET retain_until=clock_timestamp()-interval '1 second' WHERE id=$1",[page.traversal.id]);
  assert.equal((await r.client.call(query,{recovery:{action:'attention_refresh',token:expired}})).body.error.code,'updates_state_unavailable');
});

test('whole-card cardinality refuses truncation; explicit 100-member subset has measured bounded bytes and durable restoration',{timeout:120000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_card_bound'),d=await f.discussion();await f.follow(r.client,f.settings('discussion',d.id));
  for(let i=0;i<100;i++)await f.reply(d);
  const page=await f.readyRoutine(r.client),group=page.items[0]!,records=await f.allRoutineMembers(r.client,group.members_cursor);
  assert.equal(records.length,101);
  const refusal=await r.client.call('/api/v1/me/routine-updates/selection',{cursor:page.page_cursor,group_id:group.id});
  assert.equal(refusal.body.error.code,'attention_selection_too_large');
  const inputs=records.slice(0,100).map(v=>({kind:'shared_event',id:v.source.event_id}));
  const selected=await r.client.call('/api/v1/me/routine-updates/selection',{cursor:page.page_cursor,group_id:group.id,inputs});assert.equal(selected.status,200,JSON.stringify(selected.body));
  const body=f.fromSelection(selected.body),started=performance.now(),result=await f.dismiss(r.client,body);
  assert.equal(result.current.length,100);assert.ok(Buffer.byteLength(JSON.stringify(body))<65536);assert.ok(Buffer.byteLength(JSON.stringify(result))<131072);
  const refreshed=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:page.page_cursor}});
  assert.deepEqual((await f.allRoutineMembers(r.client,refreshed.items[0]!.members_cursor)).map(v=>v.source.event_id),[records[100]!.source.event_id]);
  let list=await r.client.call(f.endpoint+'/list',{collection:'dismissals',limit:25}),found=[...list.body.dismissals];
  const firstCursor=list.body.next_cursor;while(list.body.next_cursor){list=await r.client.call(f.endpoint+'/list',{collection:'dismissals',limit:25,cursor:list.body.next_cursor});found.push(...list.body.dismissals);}
  assert.deepEqual(found.map(v=>v.id).sort(),inputs.map(v=>v.id).sort());
  await f.dismiss(r.client,{idempotency_key:randomUUID(),inputs:result.current.map(({kind,id,version})=>({kind,id,dismissed:false,expected_version:version}))});
  assert.equal((await r.client.call(f.endpoint+'/list',{collection:'dismissals',cursor:firstCursor})).body.error.code,'attention_collection_changed');
  const sizes=(await f.observer.query('SELECT pg_column_size(outcome) bytes FROM loom.attention_operations WHERE participant_id=$1 ORDER BY pg_column_size(outcome) DESC LIMIT 1',[r.id])).rows[0];
  t.diagnostic(JSON.stringify({members:100,request_utf8_bytes:Buffer.byteLength(JSON.stringify(body)),response_utf8_bytes:Buffer.byteLength(JSON.stringify(result)),selection_utf8_bytes:Buffer.byteLength(selected.body.selection),outcome_storage_bytes:sizes.bytes,mutation_ms:Math.round(performance.now()-started)}));
});

test('unprepared routine projections refuse membership and whole-card selection until all 101 inputs are filtered',{timeout:120000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_partial_projection'),d=await f.discussion();
  for(let i=0;i<101;i++)await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(r.id),change_note:null,change_account:null});
  await f.drain();
  const complete=await f.readyRoutine(r.client,{scope:{kind:'personal'},selection:'complete'}),group=complete.items[0]!;
  const original=await f.allRoutineMembers(r.client,group.members_cursor),event=original[0]!.source.event_id;
  assert.equal(original.length,101);assert.ok(complete.direct_cursor);
  async function refused(cursor:string){
    for(const [route,body] of [['members',{cursor,group_id:group.id}],['selection',{cursor,group_id:group.id}],['reasons',{cursor,event_id:event}]] as const){
      const response=await r.client.call('/api/v1/me/routine-updates/'+route,body);
      assert.equal(response.status,409,route+' must not expose partial membership');
      assert.equal(response.body.error.code,'updates_attention_preparing');assert.equal(response.body.error.recovery.action,'refresh_attention_selection');
    }
  }
  await refused(complete.direct_cursor!);
  const preparing=await f.routine(r.client,{switch:{token:complete.page_cursor,selection:'direct'}});
  assert.equal(preparing.stage,'preparing');assert.ok(preparing.direct_cursor);
  assert.deepEqual((await f.observer.query('SELECT scanned,ready FROM loom.attention_views WHERE view_id=$1',[complete.traversal.id])).rows,[{scanned:100,ready:false}]);
  await refused(preparing.direct_cursor!);
  assert.deepEqual((await f.allRoutineMembers(r.client,complete.records_cursor!)).map(v=>v.source.event_id),original.map(v=>v.source.event_id),'Complete remains independent of routine preparation');
  const ready=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:preparing.direct_cursor!}});
  assert.equal(ready.traversal.id,complete.traversal.id);assert.deepEqual(ready.traversal.personal,complete.traversal.personal);
  const filtered=await f.allRoutineMembers(r.client,ready.items[0]!.members_cursor);assert.equal(filtered.length,101);
  const tooLarge=await r.client.call('/api/v1/me/routine-updates/selection',{cursor:ready.page_cursor,group_id:group.id});
  assert.equal(tooLarge.body.error.code,'attention_selection_too_large');
  const inputs=filtered.slice(0,100).map(v=>({kind:'personal_delivery',id:v.personal!.delivery_id}));
  const subset=await r.client.call('/api/v1/me/routine-updates/selection',{cursor:ready.page_cursor,group_id:group.id,inputs});
  assert.equal(subset.status,200,JSON.stringify(subset.body));assert.deepEqual(subset.body.inputs.map(({kind,id}:any)=>({kind,id})).sort((a:any,b:any)=>a.id.localeCompare(b.id)),inputs.sort((a,b)=>a.id.localeCompare(b.id)));
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.attention_operations WHERE participant_id=$1',[r.id])).rows[0].n,0);
  await f.mute(r.client,'discussion',d.id);
  const changed=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:complete.page_cursor}});
  assert.equal(changed.traversal.selection,'complete');assert.equal(changed.attention.policy_version,1);
  assert.deepEqual((await f.observer.query('SELECT policy_version,ready FROM loom.attention_views WHERE view_id=$1',[complete.traversal.id])).rows,[{policy_version:0,ready:true}]);
  await refused(changed.direct_cursor!);
  const current=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:changed.direct_cursor!}});
  assert.equal((await f.allRoutineMembers(r.client,current.items[0]!.members_cursor)).length,101,'muting the discussion preserves all direct inputs');
});

test('unexpanded direct inputs remain exact and paged; muted unfollowed parent replies and note mentions arrive',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_direct'),d=await f.discussion();await f.mute(r.client,'discussion',d.id);
  const own=await f.publish(r.client,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:{format:'loom-markdown-v1',text:'Own parent',mentions:[]}}),expected=[];
  for(let i=0;i<5;i++)expected.push(await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:own.resource_id,content:mentioned(r.id),change_note:null,change_account:null}));
  await f.drain();const page=await f.readyRoutine(r.client,{scope:{kind:'personal'}}),g=page.items[0]!;
  assert.equal(g.direct_sources.length,2);assert.equal(g.counts.personal_signals,5);
  const all=await f.allRoutineMembers(r.client,g.direct_cursor!);assert.deepEqual(all.map(v=>v.source.revision_id).sort(),expected.map(v=>v.revision_id).sort());
  assert.deepEqual(all.map(v=>v.personal!.reasons.map(r=>r.kind).sort()),expected.map(()=>['direct_reply','main_mention']));
  const s=await f.selection(r.client,page.page_cursor,g.id);assert.equal(s.personal_signals,5);assert.equal(s.shared_events,0);
  await f.dismiss(r.client,f.fromSelection(s));assert.deepEqual((await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:page.page_cursor}})).items,[]);
  const artifact=await f.artifact();await f.mute(r.client,'artifact',artifact.resource_id);
  const note=await f.publish(f.admin,'/api/v1/revisions',{resource_id:artifact.resource_id,expected_revision_id:artifact.revision_id,title:'Independent note',content:{format:'loom-markdown-v3',text:'New independent revision',mentions:[],references:[]},
    change_note:{format:'loom-markdown-v2',text:'Note [[mention:n]]',mentions:[{token:'n',participant_id:r.id}],references:[]},change_account:null});await f.drain();
  const next=await f.readyRoutine(r.client,{scope:{kind:'personal'}});assert.deepEqual(next.items[0]!.direct_sources.map(v=>v.source.revision_id),[note.revision_id]);assert.equal((await f.page(r.client)).items.length,6);
});

test('event-time area, discussion, artifact and subtree matching survives moves; old unknown impacts survive mute and refresh',{timeout:120000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_moves'),parent=await f.newArea('Same name',f.area),leaf=await f.newArea('Same name',parent);
  const a=await f.publish(f.admin,'/api/v1/artifacts',{area_id:leaf,title:'Moved',content:{format:'loom-markdown-v1',text:'Before',mentions:[]}}),d=await f.discussion();
  await f.follow(r.client,f.settings('artifact',a.resource_id));await f.follow(r.client,f.settings('discussion',d.id));
  await f.move(parent,f.other,'area.move');await f.move(d.id,f.other,'discussion.move');await f.move(a.resource_id,f.other,'artifact.move');
  const newer=await f.revise(f.admin,a,'After move',[]),reply=await f.reply(d);
  await f.mute(r.client,'area',f.area,true,0,true);
  const page=await f.readyRoutine(r.client),members=(await Promise.all(page.items.map(g=>f.allRoutineMembers(r.client,g.members_cursor)))).flat();
  assert.deepEqual(members.filter(v=>v.source.revision_id).map(v=>v.source.revision_id).sort(),[newer.revision_id,reply.revision_id].sort());
  assert.deepEqual(members.filter(v=>!v.source.revision_id).map(v=>v.source.kind),['artifact.move'],'the artifact moved between locations already outside the muted original ancestor');
  const complete=await f.allRoutineMembers(r.client,page.records_cursor!);assert.equal(complete.length,7);
  await f.mute(r.client,'artifact',a.resource_id);await f.mute(r.client,'discussion',d.id);
  const hidden=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:page.page_cursor}});assert.deepEqual(hidden.items,[]);
  await f.mute(r.client,'area',f.area,false,1,true);const overlap=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:hidden.page_cursor}});assert.deepEqual(overlap.items,[],'stable ID resource mutes also quiet ancestor impacts');
  const old=await fixture(t,{throughMigration:12}),owner=await old.participant('attention_unknown'),p=await old.newArea('Old parent',old.area),child=await old.newArea('Old child',p);await old.move(p,old.other,'area.move');await old.migrate();await old.mute(owner.client,'area',child);
  const unknown=await old.readyRoutine(owner.client,{scope:{kind:'explicit',definition:old.settings('area',child,false,['structural'])}});
  assert.equal(unknown.traversal.shared.coverage,'unknown');assert.equal(unknown.checkpoint,null);assert.equal(unknown.grouped_interval_complete,false);
  const refreshed=await old.readyRoutine(owner.client,{recovery:{action:'attention_refresh',token:unknown.page_cursor}});assert.equal(refreshed.traversal.shared.coverage,'unknown');assert.equal(refreshed.checkpoint,null);
});

for(const dismissed of [true,false])test(`competing atomic desired states serialize under the owner guard with ${dismissed?'dismiss':'restore'} first`,{timeout:90000},async t=>{
  const gatekeeper=gates(),f=await fixture(t,{transactionWrapper:gatekeeper.wrapper}),r=await f.participant('attention_overlap'),a=await f.artifact(),b=await f.artifact();
  const inputs=await Promise.all([a,b].map(async v=>({kind:'shared_event' as const,id:await f.event(v.revision_id),expected_version:0})));
  const gate=gatekeeper.pause((sql,values)=>sql.includes('pg_advisory_xact_lock(')&&String(values[0]).includes('loom.attention.owner'),'after');
  const firstBody={idempotency_key:randomUUID(),inputs:inputs.map(v=>({...v,dismissed}))},first=r.client.call(f.endpoint+'/dismissals/state',firstBody),pid=await bounded(gate.entered.promise);
  const secondGate=gatekeeper.pause((sql,values)=>sql.includes('pg_advisory_xact_lock(')&&String(values[0]).includes('loom.attention.owner'),'before');
  const second=r.client.call(f.endpoint+'/dismissals/state',{idempotency_key:randomUUID(),inputs:inputs.map(v=>({...v,dismissed:!dismissed}))});
  try{const competitor=await bounded(secondGate.entered.promise);secondGate.release.release();await blockedBy(f.observer,competitor,pid);}finally{gate.release.release();secondGate.release.release();}
  assert.equal((await first).body.operation_state,'applied');assert.equal((await second).body.operation_state,'version_conflict');
  assert.ok((await f.dismiss(r.client,firstBody)).current.every(v=>v.dismissed===dismissed&&v.version===1));
});
