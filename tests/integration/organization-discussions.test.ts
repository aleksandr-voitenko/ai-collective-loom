import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import type {QueryResultRow} from 'pg';
import SwaggerParser from '@apidevtools/swagger-parser';
import {fixture,organization} from '../helpers/organization.js';
import {reservationSnapshot as snapshot} from '../helpers/reservations.js';
import {prepareText,drainFiles} from '../helpers/file-text.js';
import {reference,incoming} from '../helpers/references.js';
import {createNote,accepted,readNote} from '../helpers/notes.js';
import {SearchWorker} from '../../src/server/modules/search/worker.js';

const change='/api/v1/organization/changes';
const v3=(text:string)=>({format:'loom-markdown-v3',text,mentions:[],references:[]});

test('DIS-07 administrator authority, independent local closure, inherited placement and suppression',{timeout:120000},async t=>{
 const f=await fixture(t),human=await f.participant('discussion_author','human'),agent=await f.participant('discussion_admin');
 await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:agent.id,state:'active',role:'administrator'});
 const d=await f.discussion(human.client),e=await f.discussion(),s=await f.create(d.id,human.client),a=await f.artifact(human.client);
 const body=await f.organizationCommand(d.id);
 for(const client of [human.client]){
   assert.equal((await client.call(change,body)).status,403,'Authorship and summary/artifact editing confer no organization authority');
   assert.equal((await client.call(organization+'/status',{kind:body.kind,idempotency_key:body.idempotency_key})).status,403);
 }
 for(const resource_id of [randomUUID(),d.opening.resource_id,s.resource_id,a.resource_id])assert.equal((await f.admin.call(change,{...body,resource_id})).status,404);
 assert.equal((await f.admin.call(change,{...body,kind:'artifact.close'})).status,400);
 assert.equal((await f.admin.call(change,{...body,extra:true})).status,400);
 await SwaggerParser.validate((await f.admin.call('/api/v1/openapi.json')).body);
 const k1=await f.organize(body,agent.client);assert.equal(k1.current.local_open,false);assert.equal(k1.current.publication_open,false);
 const detail=(await human.client.call('/api/v1/discussions/'+d.id)).body;assert.equal(detail.local_open,false);assert.equal(detail.publication_open,false);
 await f.reply(e,'Other discussion remains open',human.client);
 await f.organize(await f.organizationCommand(f.area,'area.close'));
 const opened=await f.closeDiscussion(d.id,false);assert.equal(opened.current.local_open,true);assert.equal(opened.current.publication_open,false);
 await f.closeDiscussion(d.id);await f.organize(await f.organizationCommand(f.area,'area.open'));
 assert.equal((await f.organizationState(d.id)).publication_open,false,'Reopening the area preserves local discussion closure');
 await f.move(d.id,f.other,'discussion.move');assert.equal((await f.organizationState(d.id)).local_open,false);
 await f.closeDiscussion(d.id,false);await f.organize(await f.organizationCommand(f.area,'area.close'));
 await f.move(d.id,f.area,'discussion.move');assert.equal((await f.organizationState(d.id)).local_open,true);assert.equal((await f.organizationState(d.id)).publication_open,false);
 await f.move(d.id,f.other,'discussion.move');assert.equal((await f.organizationState(d.id)).publication_open,true);
 await f.closeDiscussion(d.id);await f.suppress(d.id);
 const hidden={...await f.organizationCommand(e.id,'discussion.open'),resource_id:d.id};
 assert.equal((await f.admin.call(change,hidden)).status,404,'Reopening cannot restore suppressed content');
 assert.equal((await agent.client.call(organization+'/status',{kind:body.kind,idempotency_key:body.idempotency_key})).status,404);
 await f.suppress(d.id,false);assert.equal((await f.organizationState(d.id)).local_open,false);
 assert.equal((await human.client.call('/api/v1/discussions/'+d.id)).status,200);
 await f.closeDiscussion(d.id,false);const noOp=await f.closeDiscussion(d.id,false);assert.equal(noOp.current.version,noOp.outcome.version);assert.equal(noOp.current.local_open,true);
});

test('closure preserves exact content, files, references, coverage and personal state; independent promotion remains eligible',{timeout:150000},async t=>{
 const f=await fixture(t,{files:true}),p=await f.participant('closure_reader'),d=await f.discussion(p.client),a=await f.artifact();
 const member=await prepareText(p.client,{kind:'reply',resource_id:d.opening.resource_id},'retained.txt');
 const refs=[reference({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id})];
 const input={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:{...v3('Exact attached change account'),references:refs},change_note:null,change_account:{revisions:[{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]},attachment_set:{version:'contribution-attachments-v1',files:[member]}};
 const r=await p.client.call('/api/v1/replies',input);assert.equal(r.status,201,JSON.stringify(r.body));const c=r.body;
 const s=await f.create(d.id,p.client),coverage=(await f.coverage(s)).body;
 const manifest=(await p.client.call(`/api/v1/contributions/${c.resource_id}/revisions/${c.revision_id}/attachments`)).body;
 const file=manifest.items[0],bytes=(await p.client.call(file.download_url)).body;
 const target={kind:'revision',resource_id:c.resource_id,revision_id:c.revision_id};
 assert.equal((await p.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target,saved:true,expected_version:0})).status,200);
 await f.follow(p.client,f.settings('discussion',d.id));
 assert.equal((await p.client.call('/api/v1/me/reading/state',{idempotency_key:randomUUID(),targets:[{resource_id:c.resource_id,revision_id:c.revision_id,read:true,expected_version:0}],basis:'manual',episode_id:null})).status,200);
 const note=createNote([{kind:'discussion',resource_id:d.id}]);await accepted(p.client,'create',note);
 const intent=(await p.client.call('/api/v1/editing-intent/announce',{idempotency_key:randomUUID(),resource_id:c.resource_id,base_revision_id:c.revision_id,purpose:'Prepared revision',scope:{kind:'whole'}})).body;
 await drainFiles(f);await new SearchWorker(f.database).tick();await f.drain();
 const before=await snapshot(f);const close=await f.closeDiscussion(d.id);const after=await snapshot(f);
 const changed=new Set(['resources','organization_state','organization_operations','organization_audit','community_clocks','shared_activity','outbox_intents']);
 for(const table of Object.keys(before))if(!changed.has(table))assert.deepEqual(after[table],before[table],table);
 const strip=(rows:any)=>rows.map((r:any)=>{const {publication_open,organization_version,...rest}=JSON.parse(r.row);return rest;});
 assert.deepEqual(strip(after.resources),strip(before.resources));
 assert.equal((after.shared_activity as any[]).length,(before.shared_activity as any[]).length+1);
 assert.deepEqual((await f.coverage(s)).body,coverage);
 for(const path of ['/api/v1/discussions/'+d.id,`/api/v1/resources/${c.resource_id}/revisions/${c.revision_id}`,`/api/v1/resources/${c.resource_id}/history`,incoming({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}),'/api/v1/me/saved-items','/api/v1/me/following','/api/v1/me/notes/'+note.note_id+'/sources',file.download_url,file.download_url.replace('/download','/text')])assert.equal((await p.client.call(path)).status,200,path);
 assert.equal((await p.client.call(file.download_url)).body,bytes);assert.equal((await readNote(p.client,note.note_id)).state,'active');
 assert.ok((await p.client.call('/api/v1/search?q=attached')).body.items.some((x:any)=>x.source_resource_id===c.resource_id));
 const refused=await p.client.call('/api/v1/replies',{...input,idempotency_key:randomUUID()});assert.equal(refused.status,403);assert.equal(refused.body.error.forbidden_reason,'publication_closed');
 const replay=await p.client.call('/api/v1/replies',input);assert.equal(replay.status,403,'Mutation replay retains current action authority');
 const status=await p.client.call('/api/v1/operations/status',{operation_kind:'reply.create',idempotency_key:input.idempotency_key});assert.equal(status.body.revision_id,c.revision_id);
 assert.equal((await p.client.call('/api/v1/editing-intent/release',{idempotency_key:randomUUID(),notice_id:intent.current.notice_id,expected_version:intent.current.version})).status,200);
 const promotion=await p.client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:c.resource_id,revision_id:c.revision_id,file_id:file.file_id},area_id:f.other,title:'Independent retained bytes'});assert.equal(promotion.status,201,JSON.stringify(promotion.body));
 await f.suppress(d.id);assert.equal((await p.client.call('/api/v1/resources/'+promotion.body.resource_id)).status,200);await f.suppress(d.id,false);
 await f.closeDiscussion(d.id,false);const old=await f.organize(await f.organizationCommand(d.id,'discussion.close'));assert.equal(old.current.local_open,false);assert.equal(close.outcome.local_open,false);
});

test('discussion decisions recover after COMMIT loss and restart without reapplication; every tail stage rolls back',{timeout:120000},async t=>{
 let fail='',lose=false;
 const f=await fixture(t,{transactionWrapper:db=>({transaction:async work=>{
   let wrote=false;const result=await db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{const r=await tx.query<Row>(sql,v);if(sql.startsWith('INSERT INTO loom.organization_operations'))wrote=true;if(fail&&sql.startsWith(fail))throw new Error('Injected closure rollback');return r;}}));
   if(lose&&wrote){lose=false;throw new Error('Lost closure acknowledgement');}return result;
 }})}),d=await f.discussion();
 const k1=await f.organizationCommand(d.id);assert.equal((await f.admin.call(organization+'/status',{kind:k1.kind,idempotency_key:k1.idempotency_key})).body.operation_state,'not_recorded');
 lose=true;assert.equal((await f.admin.call(change,k1)).status,503);await f.restart();
 const original=(await f.admin.call(organization+'/status',{kind:k1.kind,idempotency_key:k1.idempotency_key})).body;assert.equal(original.outcome.local_open,false);
 await f.closeDiscussion(d.id,false);const before=await snapshot(f);
 const retried=await f.organize(k1);assert.deepEqual(retried.outcome,original.outcome);assert.equal(retried.current.local_open,true);assert.deepEqual(await snapshot(f),before);
 assert.equal((await f.admin.call(change,{...k1,expected_version:0})).body.error.code,'idempotency_conflict');
 assert.equal((await f.admin.call(change,{...k1,idempotency_key:randomUUID()})).body.error.code,'organization_conflict');
 const concurrent=await f.organizationCommand(d.id);const pair=await Promise.all([f.organize(concurrent),f.organize(concurrent)]);assert.equal(pair[0].operation_id,pair[1].operation_id);
 const rows=(await f.observer.query('SELECT count(*)::int n FROM loom.organization_operations o JOIN loom.organization_audit a ON a.operation_id=o.id JOIN loom.shared_activity e ON e.id=o.source_event_id JOIN loom.outbox_intents i ON i.source_event_id=e.id WHERE o.idempotency_key=$1',[concurrent.idempotency_key])).rows;assert.equal(rows[0].n,1);
 for(const stage of ['UPDATE loom.resources SET publication_open','UPDATE loom.organization_state','UPDATE loom.community_clocks','INSERT INTO loom.shared_activity','INSERT INTO loom.outbox_intents','INSERT INTO loom.organization_operations','INSERT INTO loom.organization_audit']){
   const command=await f.organizationCommand(d.id,'discussion.open'),snapshotBefore=await snapshot(f);fail=stage;assert.equal((await f.admin.call(change,command)).status,503,stage);fail='';assert.deepEqual(await snapshot(f),snapshotBefore,stage);
   assert.equal((await f.admin.call(organization+'/status',{kind:command.kind,idempotency_key:command.idempotency_key})).body.operation_state,'not_recorded');
 }
 await f.closeDiscussion(d.id,false);const eligible=await f.discussion();
 const decision=(await f.observer.query('SELECT * FROM loom.organization_operations WHERE idempotency_key=$1',[k1.idempotency_key])).rows[0];
 const capacity=(await f.observer.query('SELECT 10000-count(*)::int AS remaining FROM loom.organization_operations')).rows[0].remaining;
 const position=(await f.observer.query('SELECT shared_position::text position FROM loom.community_clocks')).rows[0].position;
 // Populate only this disposable observer fixture, as in the existing organization cap test.
 await f.observer.query(`WITH events AS (
   INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids)
   SELECT gen_random_uuid(),$1::bigint+n,'organization.changed',$2,NULL,$3,ARRAY[$4::uuid],ARRAY[$4::uuid],ARRAY[$4::uuid]
   FROM generate_series(1,$5::int) AS n RETURNING id
 ) INSERT INTO loom.organization_operations(id,actor_id,operation_kind,idempotency_key,semantic_version,request_digest,resource_id,original_parent_id,result_version,hierarchy_version,local_open,source_event_id)
   SELECT gen_random_uuid(),$3,'discussion.open',gen_random_uuid(),'organization-v1',$6,$2,$4,2,2,true,id FROM events`,[position,d.id,decision.actor_id,f.area,capacity,decision.request_digest]);
 await f.observer.query('UPDATE loom.community_clocks SET shared_position=shared_position+$1',[capacity]);
 const capped=await snapshot(f);
 for(const [id,kind] of [[eligible.id,'discussion.close'],[d.id,'discussion.open']] as const)assert.equal((await f.admin.call(change,await f.organizationCommand(id,kind))).body.error.code,'organization_limit');
 const recovered=await f.organize(k1);assert.equal(recovered.outcome.local_open,false);assert.equal(recovered.current.local_open,true);assert.deepEqual(await snapshot(f),capped);

});

test('certified closure does not mask independent current-revision suppression during file preparation',{timeout:120000},async t=>{
 const f=await fixture(t,{files:true}),d=await f.discussion();await f.closeDiscussion(d.id);
 for(const kind of ['contribution','reply'] as const){
  const input={idempotency_key:randomUUID(),target:{kind,resource_id:d.opening.resource_id},path:'prepared.txt',size:0,sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',media_type:'text/plain'};
  const closed=await f.admin.call('/api/v1/file-uploads',input);assert.equal(closed.status,403);assert.equal(closed.body.error.forbidden_reason,'publication_closed');
  // Revision-only suppression is an existing lifecycle fixture capability; it
  // must remain a source denial, even with an independent discussion closure.
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[d.opening.revision_id]);
  const hidden=await f.admin.call('/api/v1/file-uploads',{...input,idempotency_key:randomUUID()});assert.equal(hidden.status,404);assert.equal(hidden.body.error.forbidden_reason,undefined);
  await f.observer.query("UPDATE loom.revisions SET availability='available' WHERE id=$1",[d.opening.revision_id]);
 }
});

test('closure certification preserves independent source denials in reply, summary and promotion workflows',{timeout:150000},async t=>{
 const f=await fixture(t,{files:true});
 const unavailable=(response:any)=>{assert.equal(response.status,404,JSON.stringify(response.body));assert.equal(response.body.error.code,'unavailable');assert.equal(response.body.error.forbidden_reason,undefined);};
 await t.test('reply parent exact revision',async()=>{
  const d=await f.discussion();await f.closeDiscussion(d.id);
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[d.opening.revision_id]);
  const before=await snapshot(f);
  unavailable(await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:v3('Retained draft'),change_note:null,change_account:null}));
  assert.deepEqual(await snapshot(f),before);
 });
 for(const kind of ['prepare','create','revise'] as const)await t.test('summary '+kind+' with an independently suppressed declared member',async()=>{
  const d=await f.discussion(),c=await f.reply(d),s=kind==='revise'?await f.create(d.id):undefined;
  const members=[{contribution_id:c.resource_id,revision_id:c.revision_id}],prepared=await f.prepare(d.id,f.admin,members);
  const input=kind==='prepare'?{idempotency_key:randomUUID(),discussion_id:d.id,scope:'selected',members}:kind==='create'?f.createBody(d.id,prepared.preparation_id):{idempotency_key:randomUUID(),resource_id:s!.resource_id,expected_revision_id:s!.revision_id,title:'Retained summary draft',content:{format:'loom-markdown-v2',text:'Retained synthesis',mentions:[],references:[]},coverage:{preparation_id:prepared.preparation_id}};
  await f.closeDiscussion(d.id);await f.suppress(c.resource_id);
  const before=await snapshot(f);
  unavailable(await f.admin.call(kind==='prepare'?'/api/v1/summary-preparations':kind==='create'?'/api/v1/summaries':'/api/v1/summary-revisions',input));
  assert.deepEqual(await snapshot(f),before);
  if(s){
   const carried=await f.admin.call('/api/v1/summary-revisions',{...input,idempotency_key:randomUUID(),coverage:{carry_forward_revision_id:s.revision_id}});
   assert.equal(carried.status,403);assert.equal(carried.body.error.forbidden_reason,'publication_closed','Unchanged coverage may retain hidden history');
   await f.closeDiscussion(d.id,false);await f.reviseSummary(s,{carry_forward_revision_id:s.revision_id});
  }
 });
 await t.test('promotion exact source revision before destination closure',async()=>{
  const d=await f.discussion(),member=await prepareText(f.admin,{kind:'reply',resource_id:d.opening.resource_id},'source.txt');
  const c=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:v3('Exact attachment'),change_note:null,change_account:null,attachment_set:{version:'contribution-attachments-v1',files:[member]}});
  const file=(await f.admin.call(`/api/v1/contributions/${c.resource_id}/revisions/${c.revision_id}/attachments`)).body.items[0];
  await f.organize(await f.organizationCommand(f.other,'area.close'));
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[c.revision_id]);
  const before=await snapshot(f);
  unavailable(await f.admin.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:c.resource_id,revision_id:c.revision_id,file_id:file.file_id},area_id:f.other,title:'Prepared promotion'}));
  assert.deepEqual(await snapshot(f),before);
 });
});
