import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/following.js';
import { mentioned } from '../helpers/notifications.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';

test('populated 0012 upgrade preserves existing data and personal custody; historical publication and structural coverage is explicit',{timeout:120000},async t=>{
  const f=await fixture(t,{throughMigration:12}),a=await f.participant('upgrade_shared');
  const sources=[];
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'] as const)sources.push(await f.publish(f.admin,'/api/v1/artifacts',{
    area_id:f.area,title:format,content:mentioned(a.id,format),...(format==='loom-markdown-v3'?{change_note:{format:'loom-markdown-v2',text:'Retained exact revision note',mentions:[],references:[]},change_account:null}:{})}));
  const d=await f.discussion(),reply=await f.reply(d),summary=await f.create(d.id);
  const account=await f.publish(f.admin,'/api/v1/discussions',{area_id:f.area,title:'Retained account',content:{format:'loom-markdown-v3',text:'Independent explanation',mentions:[],references:[{reference_id:randomUUID(),target:{kind:'artifact',resource_id:sources[0]!.resource_id,revision_id:sources[0]!.revision_id},relationship:null,rationale:null}]},change_note:null,change_account:{revisions:[{kind:'artifact',resource_id:sources[0]!.resource_id,revision_id:sources[0]!.revision_id}]}});
  const oldArea=await f.newArea('Historical ancestor',f.area),oldChild=await f.newArea('Historical child',oldArea);
  await f.move(oldArea,f.other,'area.move');
  assert.equal((await a.client.call('/api/v1/me/saved-items/state',{target:{kind:'artifact',resource_id:sources[0]!.resource_id},saved:true,expected_version:0,idempotency_key:randomUUID()})).status,200);
  await f.drain();await new SearchWorker(f.database).tick();
  const personal=await f.page(a.client);
  // Leave committed publications with undispatched consumer work alongside completed work.
  const pending=await f.artifact();
  const tables=['participants','participant_credentials','resources','revisions','revision_mentions','revision_references','revision_change_notes','change_account_sets','change_account_members','summary_coverage_sets','summary_coverage_members',
    'shared_activity','outbox_intents','idempotency_records','participation_audit','saved_items','saved_operations','saved_collections',
    'organization_operations','organization_audit','search_jobs','search_documents','search_state','notification_state','notification_jobs','notification_claims','notification_projection_heads','notification_gaps','notification_reply_facts',
    'notification_signals','personal_deliveries','participant_delivery_clocks'];
  const snapshots=new Map<string,string>();
  const digest=async(table:string)=>{
    // Add only expected migration defaults; actual values override them, so every old column and new null is checked.
    const rows=(await f.observer.query(`SELECT ${table==='resources'?"'{\"lifecycle_version\":1}'::jsonb || ":''}${table==='shared_activity'?"'{\"affected_target_ids\":null}'::jsonb || ":''}${table==='revision_references'?"'{\"target_file_id\":null,\"target_path\":null}'::jsonb || ":''}to_jsonb(t) AS row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  };
  for(const table of tables)snapshots.set(table,await digest(table));
  await f.migrate();for(const [table,before] of snapshots)assert.equal(await digest(table),before,table+' changed during additive upgrade');
  assert.deepEqual((await f.page(a.client,{cursor:personal.page_cursor})).items,personal.items);
  await f.restart();assert.deepEqual((await f.page(a.client,{cursor:personal.page_cursor})).items,personal.items);
  const scope={kind:'explicit' as const,definition:f.settings('area',f.area,true,['new_discussions','replies','artifact_revisions','summaries'])};
  const retained=await f.allChanges(a.client,{scope});
  for(const source of [...sources,d.opening,reply,summary,account,pending])assert.ok(retained.items.some(i=>i.revision_id===source.revision_id));
  assert.equal(retained.page.interval_complete,true);
  const historical=await f.allChanges(a.client,{scope:{kind:'explicit',definition:f.settings('area',oldChild,false,['structural'])}});
  assert.equal(historical.page.coverage,'unknown');assert.equal(historical.page.interval_complete,false);assert.equal(historical.page.checkpoint,null);
  assert.ok(historical.items.some(i=>i.resource_id===oldChild));
  const before=(await f.observer.query('SELECT area_scope_ids,before_area_scope_ids,after_area_scope_ids FROM loom.shared_activity ORDER BY position')).rows;
  await f.changes(a.client,{recovery:{action:'resynchronize',token:historical.page.page_cursor}});
  assert.deepEqual((await f.observer.query('SELECT area_scope_ids,before_area_scope_ids,after_area_scope_ids FROM loom.shared_activity ORDER BY position')).rows,before);
});
