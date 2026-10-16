import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from '../helpers/updates.js';
import { gates } from '../helpers/updates-gates.js';
import { barrier, bounded, blockedBy } from '../helpers/search-races.js';
import { mentioned } from '../helpers/notifications.js';

for(const scope of ['owner','global'] as const)test(`concurrent new views enforce the ${scope} custody limit against older snapshots`,{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('updates_quota_reader');
  let competing=reader;
  if(scope==='owner'){
    for(let n=0;n<15;n++)await f.updates(reader.client,{});
  }else{
    // Valid retained populations: seven owners at sixteen views, one at fifteen.
    const owners:string[]=[];
    for(let n=0;n<8;n++)owners.push((await f.participant('updates_quota_owner_'+n)).id);
    await f.observer.query(`INSERT INTO loom.updates_views(id,participant_id,shared_after,personal_after)
      SELECT gen_random_uuid(),owner,0,0 FROM unnest($1::uuid[]) WITH ORDINALITY AS owners(owner,n)
      CROSS JOIN LATERAL generate_series(1,CASE WHEN n=8 THEN 15 ELSE 16 END)`,[owners]);
    competing=await f.participant('updates_quota_competitor');
  }
  const held=g.pause(sql=>sql.includes('WHERE u.id=1'),'after');
  const stale=reader.client.call('/api/v1/me/updates/query',{});
  let winner;
  try{await bounded(held.entered.promise);winner=await competing.client.call('/api/v1/me/updates/query',{});}
  finally{held.release.release();}
  assert.equal(winner.status,200);
  const result=await stale;
  assert.equal(result.body.error?.code,'updates_view_changed','An older quota snapshot must retry, not reserve another view');
  const count=await f.observer.query(`SELECT count(*)::int n FROM loom.updates_views${scope==='owner'?' WHERE participant_id=$1':''}`,scope==='owner'?[reader.id]:[]);
  assert.equal(count.rows[0].n,scope==='owner'?16:128);
  const retry=await reader.client.call('/api/v1/me/updates/query',{});
  assert.equal(retry.body.error.code,'updates_capacity');
  assert.equal((await f.ready(competing.client,{cursor:winner.body.next_cursor})).traversal.id,winner.body.traversal.id);
});

test('combined group authorization linearizes source, owner, exact revision and current metadata in both PostgreSQL guard orders',{timeout:120000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('updates_race'),d=await f.discussion();
  const source=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:mentioned(reader.id),change_note:null,change_account:null});
  await f.follow(reader.client,f.settings('discussion',d.id));await f.drain();
  for(const kind of ['source','owner','revision'] as const){
    const id=kind==='source'?source.resource_id:kind==='owner'?d.id:source.revision_id,table=kind==='revision'?'revisions':'resources',column=kind==='revision'?'availability':'state',restore=kind==='revision'?'available':'active';
    const page=await f.ready(reader.client,{selection:'complete'});
    const before=g.pause(sql=>sql.startsWith('SELECT e.*,e.position'));
    const stale=reader.client.call('/api/v1/me/updates/query',{cursor:page.page_cursor});
    try{await bounded(before.entered.promise);await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]));}
    finally{before.release.release();}
    const denied=await stale;assert.equal(denied.body.error.code,'updates_view_changed');assert.ok(!JSON.stringify(denied.body).includes(source.resource_id));
    const hidden=await f.ready(reader.client,{selection:'complete'});assert.ok(hidden.items.every(i=>i.counts.personal_signals===0));
    await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]));
    const allowedPage=await f.ready(reader.client,{selection:'complete'}),held=g.pause(sql=>sql.startsWith('SELECT title,availability'));
    const allowed=reader.client.call('/api/v1/me/updates/query',{cursor:allowedPage.page_cursor});const readerPid=await bounded(held.entered.promise),writerPid=barrier<number>();
    const mutation=f.database.transaction(async tx=>{writerPid.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]);});
    try{await blockedBy(f.observer,await bounded(writerPid.promise),readerPid);}finally{held.release.release();}
    const result=await allowed;assert.equal(result.status,200);assert.equal(result.body.items[0].counts.personal_signals,1);await mutation;
    assert.equal((await reader.client.call('/api/v1/me/updates/members',{cursor:allowedPage.items[0]!.members_cursor})).body.error.code,'updates_visibility_replay_required');
    await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]));
  }
  const initial=await f.ready(reader.client,{selection:'complete'}),held=g.pause(sql=>sql.startsWith('SELECT title,availability'));
  const allowed=reader.client.call('/api/v1/me/updates/query',{cursor:initial.page_cursor}),readerPid=await bounded(held.entered.promise),writerPid=barrier<number>();
  const revoke=f.database.transaction(async tx=>{writerPid.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[reader.credential]);});
  try{await blockedBy(f.observer,await bounded(writerPid.promise),readerPid);}finally{held.release.release();}
  assert.equal((await allowed).status,200);await revoke;assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:initial.page_cursor})).status,401);
  const other=await f.participant('updates_revoke_first'),before=g.pause(sql=>sql==="SET LOCAL statement_timeout='2500ms'");
  const denied=other.client.call('/api/v1/me/updates/query',{});
  try{await bounded(before.entered.promise);assert.equal((await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:other.id,credential_id:other.credential})).status,200);}
  finally{before.release.release();}assert.ok([401,404,409].includes((await denied).status));
});

test('one-stream and count failures rollback preparation and never produce a combined checkpoint',{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('updates_fail'),a=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',a.resource_id));
  for(const match of [(sql:string)=>sql.includes('FROM loom.personal_deliveries d JOIN'),(sql:string)=>sql.includes('count(*)::int AS n FROM loom.updates_members')]){
    const before=(await f.observer.query('SELECT count(*)::int n FROM loom.updates_views')).rows;
    const fail=g.pause(match,'after',true),pending=reader.client.call('/api/v1/me/updates/query',{});
    await bounded(fail.entered.promise);fail.release.release();const result=await pending;assert.equal(result.status,503);assert.equal(result.body.checkpoint,undefined);
    assert.deepEqual((await f.observer.query('SELECT count(*)::int n FROM loom.updates_views')).rows,before);
  }
  const repaired=await f.allGroups(reader.client);assert.ok(repaired.page.checkpoint);assert.equal(repaired.items[0]!.counts.shared_changes,1);
});

test('current metadata publishers and group readers linearize in both guard orders',{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('updates_pointer'),source=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',source.resource_id));const initial=await f.ready(reader.client,{selection:'complete'});
  const held=g.pause(sql=>sql.startsWith('SELECT title,availability')),pending=reader.client.call('/api/v1/me/updates/query',{cursor:initial.page_cursor}),readerPid=await bounded(held.entered.promise);
  const writerGate=g.pause(sql=>sql.includes('FROM loom.resources')&&sql.includes('FOR UPDATE'),'before');
  const publishing=f.revise(f.admin,source,'R2 current title',[]),writerPid=await bounded(writerGate.entered.promise);writerGate.release.release();
  try{await blockedBy(f.observer,writerPid,readerPid);}finally{held.release.release();}
  const page=await pending;assert.equal(page.status,200);assert.notEqual(page.body.items[0].current.title,'R2 current title');const second=await publishing;
  const before=g.pause(sql=>sql.startsWith('SELECT e.*,e.position')),stale=reader.client.call('/api/v1/me/updates/query',{cursor:initial.page_cursor});
  try{await bounded(before.entered.promise);await f.revise(f.admin,second,'R3 current title',[]);}finally{before.release.release();}
  assert.equal((await stale).body.error.code,'updates_view_changed');
  const same=await f.ready(reader.client,{cursor:initial.page_cursor});assert.equal(same.items[0]!.current.state,'available');
  if(same.items[0]!.current.state==='available')assert.equal(same.items[0]!.current.title,'R3 current title');
  assert.equal(same.items[0]!.counts.source_records,1);assert.equal(same.items[0]!.explanation,null);
});

test('independent explanation owners are in the complete guard plan before disclosure',{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('updates_explanation_race'),bob=await f.participant('updates_account_author'),a=await f.artifact(),d=await f.discussion();
  const account=await f.publish(bob.client,'/api/v1/replies',{discussion_id:d.id,parent_id:d.opening.resource_id,content:{format:'loom-markdown-v3',text:'Independent explanation',mentions:[],references:[]},change_note:null,change_account:{revisions:[{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]}});
  await f.follow(reader.client,f.settings('artifact',a.resource_id));const first=await f.ready(reader.client,{selection:'complete'});assert.equal(first.items[0]!.explanation!.resource_id,account.resource_id);
  const before=g.pause(sql=>sql.includes('ORDER BY note DESC')),stale=reader.client.call('/api/v1/me/updates/query',{cursor:first.page_cursor});
  try{await bounded(before.entered.promise);await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));}finally{before.release.release();}
  assert.equal((await stale).body.error.code,'updates_view_changed');assert.equal((await f.ready(reader.client,{selection:'complete'})).items[0]!.explanation,null);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[d.id]));const restored=await f.ready(reader.client,{selection:'complete'});
  const held=g.pause(sql=>sql.startsWith('SELECT title,availability')),allowed=reader.client.call('/api/v1/me/updates/query',{cursor:restored.page_cursor}),readerPid=await bounded(held.entered.promise),writerPid=barrier<number>();
  const suppress=f.database.transaction(async tx=>{writerPid.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]);});
  try{await blockedBy(f.observer,await bounded(writerPid.promise),readerPid);}finally{held.release.release();}
  assert.equal((await allowed).body.items[0].explanation.resource_id,account.resource_id);await suppress;
  assert.equal((await reader.client.call('/api/v1/me/updates/query',{cursor:restored.page_cursor})).body.error.code,'updates_visibility_replay_required');
});
