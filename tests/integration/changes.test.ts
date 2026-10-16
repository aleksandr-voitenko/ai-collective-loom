import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import type { QueryResultRow } from 'pg';
import { fixture,content,note,exactPair,revisionBody,notePath,coveragePath,discover } from '../helpers/changes.js';
import { reference, incoming, outgoing, authored } from '../helpers/references.js';
import { NoteDetail, ChangeCoverage, ChangeDiscovery } from '../../src/contracts/changes.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';

// Real cookie/bearer transports, immutable rows and independent author/editor roles.
test('Alice owns R2 note; Bob describes exact R1/R2 without artifact rights; fields and history remain independent',{timeout:90000},async t=>{
  const f=await fixture(t),alice=await f.participant('note_alice','human'),bob=await f.participant('account_bob'),carol=await f.participant('mentioned_carol'),dave=await f.participant('mentioned_dave');
  const r1=await f.artifact(alice.client,'R1 original'),d=await f.discussion();
  const body=revisionBody(r1,'Main [[mention:same]]',note('Note [[mention:same]]; `@raw` and > quoted names are inert.'));
  body.content.mentions.push({token:'same',participant_id:dave.id});
  body.change_note!.mentions=[{token:'same',participant_id:carol.id}];
  const ref=reference(exactPair(r1),'builds_on','Exact support');body.content.references=[ref];body.change_note!.references=[ref];
  const published=await alice.client.call('/api/v1/revisions',body);assert.equal(published.status,201,JSON.stringify(published.body));const r2=published.body;
  const detail=(await bob.client.call(`/api/v1/resources/${r2.resource_id}/revisions/${r2.revision_id}`)).body;
  assert.equal(detail.publisher.id,alice.id);assert.equal(detail.change_note.state,'available');assert.equal(detail.content.mentions[0].participant_id,dave.id);
  const ownNote=await bob.client.call(notePath(r2));assert.ok(Value.Check(NoteDetail,ownNote.body));
  assert.deepEqual(ownNote.body.content,body.change_note);assert.equal(ownNote.body.mentioned_participants[0]!.id,carol.id);
  assert.deepEqual((await f.observer.query('SELECT source_field,token,participant_id FROM loom.revision_mentions WHERE revision_id=$1 ORDER BY source_field',[r2.revision_id])).rows,
    [{source_field:'change_note',token:'same',participant_id:carol.id},{source_field:'main',token:'same',participant_id:dave.id}]);
  const refs=(await bob.client.call(outgoing(r2))).body.items;assert.equal(refs.length,2);assert.deepEqual(refs.map((r:any)=>r.source_field).sort(),['change_note','main']);
  for(const row of refs){assert.equal(row.original_assertion.participant.id,alice.id);assert.equal(row.source.revision_id,r2.revision_id);}
  const before=(await f.observer.query('SELECT current_revision_id FROM loom.resources WHERE id=$1',[r1.resource_id])).rows;
  const accountBody={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,
    content:{...content('Bob explains the changes [[mention:carol]]',[reference(exactPair(r1)),reference(exactPair(r2))]),mentions:[{token:'carol',participant_id:carol.id}]},
    change_note:null,change_account:{revisions:[exactPair(r1),exactPair(r2)]}};
  const account=await bob.client.call('/api/v1/replies',accountBody);assert.equal(account.status,201,JSON.stringify(account.body));
  assert.deepEqual((await f.observer.query('SELECT current_revision_id FROM loom.resources WHERE id=$1',[r1.resource_id])).rows,before);
  assert.equal((await bob.client.call('/api/v1/revisions',revisionBody(r2,'Forbidden note edit',note('Impersonation')))).status,403);
  assert.equal((await bob.client.call(notePath(r2),{text:'Cannot mutate'})).status,404);
  const coverage=await alice.client.call(coveragePath(account.body));assert.ok(Value.Check(ChangeCoverage,coverage.body));
  assert.deepEqual(coverage.body.items.map((m:any)=>m.target.revision_id).sort(),[r1.revision_id,r2.revision_id].sort());
  assert.equal(coverage.body.source.author.id,bob.id);assert.equal(coverage.body.source.discussion_id,d.id);
  const r3Body=revisionBody(r2,'R3 main without a note'),r3=await alice.client.call('/api/v1/revisions',r3Body);assert.equal(r3.status,201);
  assert.equal((await bob.client.call(notePath(r3.body))).body.state,'absent');assert.deepEqual((await bob.client.call(notePath(r2))).body.content,body.change_note);
  assert.deepEqual((await bob.client.call(coveragePath(account.body))).body.items.map((m:any)=>m.target.revision_id).sort(),[r1.revision_id,r2.revision_id].sort());
  assert.deepEqual((await alice.client.call('/api/v1/revisions',body)).body,{...r2,idempotency:'replayed'});
  const discovery=await bob.client.call(discover(r2,{history:'all'}));assert.ok(Value.Check(ChangeDiscovery,discovery.body),JSON.stringify(discovery.body));
  assert.deepEqual(discovery.body.items.map((m:any)=>[m.form,m.source.publisher.id,m.described.revision_id]).sort(),
    [['change_account',bob.id,r2.revision_id],['revision_note',alice.id,r2.revision_id]].sort());
  const current=(await bob.client.call(discover(r2))).body;assert.deepEqual(current.items.map((m:any)=>m.form),['change_account']);
  await f.move(r1.resource_id,f.other);assert.equal((await bob.client.call(notePath(r2))).body.source.area_id,f.other);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.shared_activity WHERE resource_id=$1',[account.body.resource_id])).rows[0].n,1);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.notification_signals',[])).rows[0].n,0);
});

test('summary note-only revisions exclude themselves; ordinary accounts are eligible new and revised sources',{timeout:60000},async t=>{
  const f=await fixture(t),d=await f.discussion(),s=await f.create(d.id),target=await f.artifact();
  const body={idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:s.body.title,
    content:content(s.body.content.text),coverage:{carry_forward_revision_id:s.revision_id},change_note:note('Explains this summary revision'),change_account:null};
  const r2=await f.admin.call('/api/v1/summary-revisions',body);assert.equal(r2.status,201,JSON.stringify(r2.body));
  assert.equal((await f.coverage(r2.body)).body.coverage.uncovered_eligible,0);
  assert.equal((await f.admin.call(notePath(r2.body))).body.content.text,body.change_note.text);
  const accountBody={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Ordinary account',[reference(exactPair(target))]),change_note:null,change_account:{revisions:[exactPair(target)]}};
  const account=await f.admin.call('/api/v1/replies',accountBody);assert.equal(account.status,201);assert.equal((await f.coverage(r2.body)).body.coverage.uncovered_eligible,1);
  const prepared=await f.prepare(d.id),s3=await f.admin.call('/api/v1/summary-revisions',{...body,idempotency_key:randomUUID(),expected_revision_id:r2.body.revision_id,coverage:{preparation_id:prepared.preparation_id},change_note:null});assert.equal(s3.status,201);
  const edit=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:account.body.resource_id,expected_revision_id:account.body.revision_id,title:null,
    content:content('Revised ordinary account',accountBody.content.references),change_note:null,change_account:{carry_forward_revision_id:account.body.revision_id}});assert.equal(edit.status,201);
  assert.equal((await f.coverage(s3.body)).body.coverage.changed_eligible,1);
  await f.reply(d);assert.equal((await f.coverage(s3.body)).body.coverage.uncovered_eligible,1);
});

test('hidden described revisions keep prose and safe carry-forward; owner/exact restrictions govern notes and recovery',{timeout:60000},async t=>{
  const f=await fixture(t),target=await f.artifact(),d=await f.discussion(),r2=await f.admin.call('/api/v1/revisions',revisionBody(target,'Available main',note('Protected note')));assert.equal(r2.status,201);
  const body={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Independent explanation'),change_note:null,change_account:{revisions:[exactPair(target),exactPair(r2.body)]}};
  const post=await f.admin.call('/api/v1/replies',body);assert.equal(post.status,201);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[target.resource_id]));
  const covered=await f.admin.call(coveragePath(post.body));assert.equal(covered.status,200);assert.equal(covered.body.state,'declared');assert.equal(covered.body.unknown,true);assert.deepEqual(covered.body.items,[]);
  for(const secret of [target.resource_id,target.revision_id,r2.body.revision_id,'Protected note'])assert.ok(!JSON.stringify(covered.body).includes(secret));
  assert.equal((await f.admin.call('/api/v1/resources/'+post.body.resource_id)).body.content.text,'Independent explanation');
  for(const path of [notePath(r2.body),discover(r2.body,{history:'all'}),`/api/v1/resources/${target.resource_id}/history`])assert.equal((await f.admin.call(path)).status,404);
  const update={idempotency_key:randomUUID(),resource_id:post.body.resource_id,expected_revision_id:post.body.revision_id,title:null,content:content('Unrelated edit'),change_note:null,change_account:{carry_forward_revision_id:post.body.revision_id}};
  const kept=await f.admin.call('/api/v1/revisions',update);assert.equal(kept.status,201);assert.equal((await f.admin.call(coveragePath(kept.body))).body.unknown,true);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.change_account_members WHERE revision_id=$1',[kept.body.revision_id])).rows[0].n,2);
  const removed=await f.admin.call('/api/v1/revisions',{...update,idempotency_key:randomUUID(),expected_revision_id:kept.body.revision_id,change_account:null});assert.equal(removed.status,201);assert.equal((await f.admin.call(coveragePath(removed.body))).body.state,'absent');
  assert.equal((await f.admin.call('/api/v1/replies',{...body,idempotency_key:randomUUID()})).status,404);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[r2.body.revision_id]));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[target.resource_id]));
  assert.equal((await f.admin.call(notePath(r2.body))).status,404);assert.equal((await f.admin.call(notePath(target))).body.state,'absent');
  const status=await f.admin.call('/api/v1/operations/status',{operation_kind:'revision.publish',idempotency_key:(await f.observer.query('SELECT idempotency_key FROM loom.idempotency_records WHERE revision_id=$1',[r2.body.revision_id])).rows[0].idempotency_key});assert.equal(status.status,404);
  const safe=(await f.admin.call(coveragePath(post.body))).body;assert.equal(safe.unknown,true);assert.equal(safe.items.length,1);assert.ok(!JSON.stringify(safe).includes(r2.body.revision_id));
  const history=await f.admin.call(discover({resource_id:target.resource_id},{history:'all'}));assert.equal(history.status,200);assert.ok(history.body.items.every((i:any)=>i.described.revision_id===target.revision_id));assert.ok(!JSON.stringify(history.body).includes(r2.body.revision_id));
});

test('stale/semantic conflicts, concurrent retries, rollback stages and COMMIT response loss keep one complete publication',{timeout:90000},async t=>{
  let fault='',lose='';const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    let key='';const result=await database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.idempotency_records'))key=String(values[3]);
      if(fault&&sql.startsWith(fault)){fault='';throw new Error('Synthetic change-field rollback');}return result;
    }}));if(key===lose&&lose){lose='';throw new Error('Synthetic lost COMMIT acknowledgement');}return result;
  }})});
  const r1=await f.artifact(),body=revisionBody(r1,'Atomic main',note('Atomic note'));
  const tables=['revisions','revision_change_notes','revision_mentions','revision_references','change_account_sets','change_account_members','shared_activity','outbox_intents','idempotency_records'];
  const snapshot=async()=>{const rows=[];for(const table of tables)rows.push((await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows);return rows;};
  const before=await snapshot();
  for(const stage of ['INSERT INTO loom.revision_change_notes','UPDATE loom.resources SET current_revision_id','UPDATE loom.community_clocks','INSERT INTO loom.outbox_intents','INSERT INTO loom.idempotency_records']){
    fault=stage;assert.equal((await f.admin.call('/api/v1/revisions',body)).status,503);assert.deepEqual(await snapshot(),before);
  }
  lose=body.idempotency_key;assert.equal((await f.admin.call('/api/v1/revisions',body)).status,503);
  const result=await f.admin.call('/api/v1/operations/status',{operation_kind:'revision.publish',idempotency_key:body.idempotency_key});assert.equal(result.status,200);
  const retries=await Promise.all([f.admin.call('/api/v1/revisions',body),f.admin.call('/api/v1/revisions',body)]);for(const retry of retries)assert.deepEqual(retry.body,result.body);
  for(const changed of [{...body,change_note:note('Different note')},{...body,change_note:null},{...body,content:content('Different main')}])assert.equal((await f.admin.call('/api/v1/revisions',changed)).body.error.code,'idempotency_conflict');
  assert.equal((await f.admin.call('/api/v1/revisions',{...body,idempotency_key:randomUUID()})).body.error.code,'revision_conflict');
  const d=await f.discussion(),account={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Atomic account'),change_note:null,change_account:{revisions:[exactPair(r1)]}};
  const saved=await snapshot();for(const stage of ['INSERT INTO loom.change_account_sets','INSERT INTO loom.change_account_members']){
    fault=stage;assert.equal((await f.admin.call('/api/v1/replies',account)).status,503);assert.deepEqual(await snapshot(),saved);
  }
  const published=await Promise.all([f.admin.call('/api/v1/replies',account),f.admin.call('/api/v1/replies',account)]);assert.equal(published[0]!.body.revision_id,published[1]!.body.revision_id);
  assert.equal((await f.admin.call('/api/v1/replies',{...account,change_account:{revisions:[exactPair(result.body)]}})).body.error.code,'idempotency_conflict');
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revisions WHERE resource_id=$1',[r1.resource_id])).rows[0].n,2);
});

test('coverage rejects malformed, duplicate, unsupported and wrong-owner revisions; legacy clients cannot strip v3 meaning',{timeout:60000},async t=>{
  const f=await fixture(t),r1=await f.artifact(),other=await f.artifact(),d=await f.discussion();
  const base={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Declared'),change_note:null,change_account:{revisions:[exactPair(r1)]}};
  for(const change_account of [{revisions:[]},{revisions:[exactPair(r1),exactPair(r1)]},{revisions:Array.from({length:17},()=>exactPair(r1))},
    {revisions:[{kind:'discussion',resource_id:d.id,revision_id:d.opening.revision_id}]},{revisions:[{...exactPair(r1),resource_id:other.resource_id}]},
    {revisions:[{...exactPair(r1),resource_id:randomUUID()}]}]){
    const refused=await f.admin.call('/api/v1/replies',{...base,idempotency_key:randomUUID(),change_account});assert.ok([400,404].includes(refused.status));assert.ok(!JSON.stringify(refused.body).includes(r1.revision_id));
  }
  for(const text of ['bad\ud800','bad\0', '\\'.repeat(4097)])assert.equal((await f.admin.call('/api/v1/revisions',revisionBody(r1,'Main',note(text)))).status,400);
  assert.equal((await f.admin.call('/api/v1/replies',{...base,change_note:note('Wrong owner')})).status,400);
  assert.equal((await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Wrong owner',content:content('Text'),change_note:null,change_account:base.change_account})).status,400);
  const r2=await f.admin.call('/api/v1/revisions',revisionBody(r1,'Version three',note('A note')));assert.equal(r2.status,201);
  const legacy={idempotency_key:randomUUID(),resource_id:r1.resource_id,expected_revision_id:r2.body.revision_id,title:'Artifact',content:authored('Legacy strips fields')};
  assert.equal((await f.admin.call('/api/v1/revisions',legacy)).body.error.code,'change_format_required');
  assert.equal((await f.admin.call('/api/v1/revisions',{...legacy,content:content('Missing explicit fields')})).status,400);
  assert.equal((await f.admin.call('/api/v1/revisions',{...legacy,change_note:null,change_account:null})).status,400);
});

test('current note text and explicit accounts are searchable with field provenance; stopped indexing and rebuild keep exact reads',{timeout:90000},async t=>{
  const f=await fixture(t),r1=await f.artifact(),r2=await f.admin.call('/api/v1/revisions',revisionBody(r1,'Main unrelated',note('Nebulachange finding'))),d=await f.discussion();assert.equal(r2.status,201);
  const post=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Nebulachange account'),change_note:null,change_account:{revisions:[exactPair(r2.body)]}});assert.equal(post.status,201);
  assert.equal((await f.admin.call(notePath(r2.body))).body.content.text,'Nebulachange finding');
  const worker=new NativeSearchWorker(f.configuration);t.after(()=>worker.stop());await worker.start();
  const deadline=Date.now()+15000;let matches:any;do{matches=(await f.admin.call('/api/v1/search?q=Nebulachange')).body;if(matches.items?.length===2)break;if(Date.now()>deadline)assert.fail('Note/account indexing did not complete');}while(true);
  const own=matches.items.find((i:any)=>i.source_resource_id===r1.resource_id);assert.deepEqual(own.matching_fields,['change_note']);assert.equal(own.excerpt.field,'change_note');assert.equal(own.full_content_url,notePath(r2.body));
  assert.equal((await f.admin.call('/api/v1/search?q=Nebulachange&explanation=change_account')).body.items[0].source_resource_id,post.body.resource_id);
  await worker.stop();const next=await f.admin.call('/api/v1/revisions',revisionBody(r2.body,'Later text without note'));assert.equal(next.status,201);
  assert.equal((await f.admin.call('/api/v1/search?q=Nebulachange&explanation=revision_note')).body.items.length,0);
  assert.equal((await f.admin.call(notePath(r2.body))).body.content.text,'Nebulachange finding');
  assert.equal((await f.admin.call(discover(r2.body,{history:'all'}))).body.items.length,2);
  const generation=(await f.admin.call('/api/v1/admin/search/health')).body.generation;assert.equal((await f.admin.call('/api/v1/admin/search/rebuild',{expected_generation:generation})).status,200);
  await worker.start();const end=Date.now()+15000;while((await f.admin.call('/api/v1/search/status')).body.indexing!=='ready'){if(Date.now()>end)assert.fail('Rebuild did not complete');}
  assert.equal((await f.admin.call('/api/v1/search?q=Nebulachange')).body.items.length,1);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_change_notes WHERE source_id=$1',[r1.resource_id])).rows[0].n,1);
  assert.equal((await f.admin.call(incoming(exactPair(r2.body)))).body.items.length,0,'Coverage is not a typed reference assertion');
});
