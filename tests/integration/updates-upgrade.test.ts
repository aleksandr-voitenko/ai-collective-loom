import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/updates.js';
import { mentioned } from '../helpers/notifications.js';

test('0015 preserves populated grouping custody and grants only the required serialization-row update',{timeout:90000},async t=>{
  const f=await fixture(t,{throughMigration:14}),reader=await f.participant('updates_guard_upgrade'),source=await f.artifact(),view=randomUUID(),group=randomUUID();
  await f.follow(reader.client,f.settings('artifact',source.resource_id));
  const event=await f.event(source.revision_id);
  await f.database.transaction(async tx=>{
    await tx.query('INSERT INTO loom.updates_views(id,participant_id,shared_after,personal_after,ready) VALUES($1,$2,0,0,true)',[view,reader.id]);
    await tx.query(`INSERT INTO loom.updates_members(view_id,event_id,resource_id,revision_id,group_kind,group_key,shared,display_at)
      VALUES($1,$2,$3,$4,'artifact',$3,true,clock_timestamp())`,[view,event,source.resource_id,source.revision_id]);
    await tx.query("INSERT INTO loom.updates_groups(view_id,id,kind,group_key,ordinal,direct,highlighted) VALUES($1,$2,'artifact',$3,1,false,true)",[view,group,source.resource_id]);
  });
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename")).rows.map(r=>r.tablename);
  const digest=async(table:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const table of tables)before.set(table,await digest(table));
  await f.migrate();for(const [table,value] of before)assert.equal(await digest(table),value,table+' changed during guard upgrade');
  await f.restart();
  const page=await f.ready(reader.client,{selection:'complete'});assert.equal(page.items[0]!.counts.source_records,1);
  assert.equal((await f.observer.query('SELECT generation::text FROM loom.updates_custody_serialization')).rows[0].generation,'1');
  assert.equal((await f.observer.query('SELECT id FROM loom.updates_groups WHERE view_id=$1',[view])).rows[0].id,group);
  for(const sql of ['DELETE FROM loom.updates_custody_serialization','INSERT INTO loom.updates_custody_serialization(id) VALUES(1)'])
    await assert.rejects(f.database.transaction(tx=>tx.query(sql,[])),/permission denied/);
});

test('populated 0013 upgrade preserves every existing table, standalone tokens, Saved decisions and authored formats',{timeout:120000},async t=>{
  const f=await fixture(t,{throughMigration:13}),reader=await f.participant('updates_upgrade'),sources=[];
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'] as const){
    const source=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:format,content:mentioned(reader.id,format),
      ...(format==='loom-markdown-v3'?{change_note:{format:'loom-markdown-v2',text:'Exact editor note',mentions:[],references:[]},change_account:null}:{})});
    sources.push(source);await f.follow(reader.client,f.settings('artifact',source.resource_id));
  }
  await f.drain();
  assert.equal((await reader.client.call('/api/v1/me/saved-items/state',{target:{kind:'artifact',resource_id:sources[0]!.resource_id},saved:true,expected_version:0,idempotency_key:randomUUID()})).status,200);
  const shared=await f.changes(reader.client),personal=await f.page(reader.client);
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename")).rows.map(r=>r.tablename);
  const digest=async(table:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const table of tables)before.set(table,await digest(table));
  await f.migrate();for(const [table,value] of before)assert.equal(await digest(table),value,table+' changed during upgrade');
  await f.restart();
  assert.deepEqual((await f.changes(reader.client,{cursor:shared.page_cursor})).items,shared.items);
  assert.deepEqual((await f.page(reader.client,{cursor:personal.page_cursor})).items,personal.items);
  const combined=await f.allGroups(reader.client),members=await f.allMembers(reader.client,combined.page.records_cursor!);
  assert.deepEqual(members.items.map(m=>m.source.revision_id).sort(),sources.map(s=>s.revision_id).sort());
  assert.ok(members.items.every(m=>m.shared_in_interval&&m.personal));
  for(const source of sources)assert.equal((await reader.client.call(`/api/v1/resources/${source.resource_id}/revisions/${source.revision_id}`)).status,200);
  for(const table of tables)assert.equal(await digest(table),before.get(table),table+' changed merely by combined browsing');
});

test('combined structural coverage preserves the pre-0013 unknown-impact boundary',{timeout:90000},async t=>{
  const f=await fixture(t,{throughMigration:12}),reader=await f.participant('updates_old_structure');
  const parent=await f.newArea('Legacy parent',f.area),child=await f.newArea('Legacy child',parent);await f.move(parent,f.other,'area.move');
  await f.migrate();
  const page=await f.ready(reader.client,{scope:{kind:'explicit',definition:f.settings('area',child,false,['structural'])},selection:'complete'});
  assert.equal(page.traversal.shared.coverage,'unknown');assert.equal(page.grouped_interval_complete,false);assert.equal(page.checkpoint,null);
  assert.ok(page.items.some(g=>g.kind==='structural'));
  assert.ok(page.items.every(g=>g.counts.certainty==='known_sources_only'));
});
