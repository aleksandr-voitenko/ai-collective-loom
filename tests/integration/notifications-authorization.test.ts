import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { QueryResultRow } from 'pg';
import { fixture,mentioned } from '../helpers/notifications.js';
import { httpClient } from '../helpers/participation-http.js';
import { barrier,bounded,blockedBy } from '../helpers/search-races.js';

test('projection health includes eligible historical revisions beneath an unavailable current revision',{timeout:60000},async t=>{
  const f=await fixture(t),a=await f.participant('historical_coverage');await f.drain();
  const original=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Eligible original',content:mentioned(a.id),change_note:null,change_account:null});
  const current=await f.publish(f.admin,'/api/v1/revisions',{resource_id:original.resource_id,expected_revision_id:original.revision_id,title:'Unavailable current',content:mentioned(a.id),change_note:null,change_account:null});
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[current.revision_id]));
  assert.equal((await a.client.call(`/api/v1/resources/${original.resource_id}/revisions/${original.revision_id}`)).status,200);
  const pending=await f.page(a.client);assert.deepEqual(pending.items,[]);
  assert.equal(pending.projection.state,'incomplete','a hidden current revision cannot make pending eligible history look complete');
  await f.drain();const completed=await f.page(a.client);
  assert.equal(completed.projection.state,'complete');assert.equal(completed.items.length,1);
  assert.equal(completed.items[0]!.source.revision_id,original.revision_id);assert.equal(completed.items[0]!.current.state,'unavailable');
  assert.ok(!JSON.stringify(completed).includes(current.revision_id));
});

test('publication-time eligibility survives publisher loss; recipient lifecycle and parent policies remain current',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('lifecycle_attention'),b=await f.participant('lifecycle_author'),c=await f.participant('no_broadcast');
  const d=await f.discussion(c.client),parent=await f.reply(d,'Independent parent',a.client);
  const reply=await f.publish(b.client,'/api/v1/replies',{discussion_id:d.id,parent_id:parent.resource_id,content:mentioned(a.id),change_note:null,change_account:null});
  assert.equal((await f.admin.call('/api/v1/identity/rename',{idempotency_key:randomUUID(),participant_id:b.id,nickname:'renamed_author'})).status,200);
  assert.equal((await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:b.id,credential_id:b.credential})).status,200);
  for(const id of [a.id,b.id])assert.equal((await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:id,state:'suspended',role:'participant'})).status,200);
  const inactiveReply=await f.publish(f.admin,'/api/v1/replies',{discussion_id:d.id,parent_id:parent.resource_id,content:{format:'loom-markdown-v1',text:'Recipient was inactive at publication',mentions:[]}});
  assert.deepEqual((await f.observer.query('SELECT recipient_id,eligible FROM loom.notification_reply_facts WHERE reply_id=$1',[inactiveReply.resource_id])).rows,[{recipient_id:a.id,eligible:false}]);
  await f.drain();assert.equal((await a.client.call('/api/v1/me/notifications/query',{})).status,401);
  assert.equal((await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:a.id,state:'active',role:'participant'})).status,200);
  const initial=await f.page(a.client);assert.equal(initial.items.length,1);assert.equal(initial.items[0]!.source.publisher.nickname,'renamed_author');assert.equal(initial.items[0]!.source.revision_id,reply.revision_id);
  assert.ok(!(await f.page(c.client)).items.some(i=>i.source.resource_id===reply.resource_id));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[parent.resource_id]));
  const independent=(await f.page(a.client)).items[0]!;assert.equal(independent.source.resource_id,reply.resource_id);assert.deepEqual(independent.parent,{state:'unavailable',resource_id:parent.resource_id});
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));assert.deepEqual((await f.page(a.client)).items,[]);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[d.id]));
  assert.deepEqual((await f.page(a.client)).items[0]!.parent,{state:'unavailable',resource_id:parent.resource_id});
  assert.equal((await f.admin.call('/api/v1/identity/rename',{idempotency_key:randomUUID(),participant_id:a.id,nickname:'renamed_recipient'})).status,200);
  const issued=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:a.id,kind:'agent',purpose:null,label:'Replacement reader',replace_credential_id:a.credential});assert.equal(issued.status,200);
  assert.equal((await a.client.call('/api/v1/me/notifications/query',{})).status,401);
  const replacement=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),issued.body.secret);
  const retained=await f.page(replacement,{recovery:{action:'replay',token:initial.page_cursor}});assert.equal(retained.items[0]!.delivery_id,initial.items[0]!.delivery_id);
  for(const endpoint of ['/api/v1/admin/notifications/health','/api/v1/admin/notifications/failures'])assert.equal((await replacement.call(endpoint)).status,403);
});

test('source, owner and exact-trigger suppression serialize with page guards in both commit orders',{timeout:120000},async t=>{
  type Match=(sql:string,values:readonly unknown[])=>boolean;
  let gate:{match:Match;phase:'before'|'after';entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>}|undefined;
  const pause=(match:Match,phase:'before'|'after')=>{const g={match,phase,entered:barrier<number>(),release:barrier()};gate=g;return g;};
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const g=gate?.match(sql,values)?gate:undefined;if(g)gate=undefined;
    const wait=async()=>{g!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(g!.release.promise);};
    if(g?.phase==='before')await wait();const result=await tx.query<Row>(sql,values);if(g?.phase==='after')await wait();return result;
  }}))})}),a=await f.participant('guard_attention');
  const source=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Protected exact text',content:mentioned(a.id),change_note:null,change_account:null});await f.drain();
  const initial=(await f.page(a.client)).items;
  for(const kind of ['source','revision','owner'] as const){
    const id=kind==='source'?source.resource_id:kind==='revision'?source.revision_id:f.area,table=kind==='revision'?'revisions':'resources',column=kind==='revision'?'availability':'state',restore=kind==='revision'?'available':'active';
    const first=pause(sql=>sql.includes('SELECT d.id,d.signal_id,d.position'),'after');
    const pending=a.client.call('/api/v1/me/notifications/query',{});
    try{await bounded(first.entered.promise);await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]));}finally{first.release.release();}
    const denied=await pending;assert.equal(denied.status,409);for(const value of [source.resource_id,source.revision_id,'Protected exact text'])assert.ok(!JSON.stringify(denied.body).includes(value));
    assert.deepEqual((await f.page(a.client)).items,[]);
    await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]));
    const held=pause((sql,values)=>sql.includes('SELECT v.title,v.revision_number')&&values[0]===source.resource_id,'after');
    const allowed=a.client.call('/api/v1/me/notifications/query',{}),reader=await bounded(held.entered.promise),writer=barrier<number>();
    const mutation=f.database.transaction(async tx=>{writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await tx.query(`UPDATE loom.${table} SET ${column}='suppressed' WHERE id=$1`,[id]);});
    try{await blockedBy(f.observer,await bounded(writer.promise),reader);}finally{held.release.release();}
    assert.deepEqual((await allowed).body.items,initial);await mutation;assert.deepEqual((await f.page(a.client)).items,[]);
    assert.equal((await a.client.call(initial[0]!.detail_url)).status,404);
    await f.database.transaction(tx=>tx.query(`UPDATE loom.${table} SET ${column}=$2 WHERE id=$1`,[id,restore]));
  }
  const g=pause(sql=>sql==="SET LOCAL statement_timeout='2500ms'",'after'),pending=a.client.call('/api/v1/me/notifications/query',{});
  try{await bounded(g.entered.promise);assert.equal((await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:a.id,credential_id:a.credential})).status,200);}finally{g.release.release();}
  assert.ok([401,404,409].includes((await pending).status));
});
