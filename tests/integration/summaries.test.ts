import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import type { QueryResultRow } from 'pg';
import { fixture } from '../helpers/summaries.js';
import { authored,reference,incoming,outgoing } from '../helpers/references.js';
import { CoverageDetail,MaintenancePage,SourcePage } from '../../src/contracts/summaries.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';

test('AC52: competing creators have one canonical publication/editor; exact retries converge',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('summary_alice','human'),b=await f.participant('summary_bob'),d=await f.discussion();
  assert.deepEqual((await f.admin.call(`/api/v1/discussions/${d.id}/summary`)).body,{state:'absent',can_create:true});
  const pa=await f.prepare(d.id,a.client),pb=await f.prepare(d.id,b.client),ba=f.createBody(d.id,pa.preparation_id),bb=f.createBody(d.id,pb.preparation_id);
  const [ra,rb]=await Promise.all([a.client.call('/api/v1/summaries',ba),b.client.call('/api/v1/summaries',bb)]);
  assert.deepEqual([ra.status,rb.status].sort(),[201,409]);const won=ra.status===201?{r:ra,actor:a,body:ba}:{r:rb,actor:b,body:bb},lost=ra.status===409?ra:rb;
  assert.equal(lost.body.error.code,'summary_already_exists');assert.ok(!JSON.stringify(lost.body).includes(won.r.body.resource_id));
  const s=won.r.body,editors=(await f.admin.call(`/api/v1/resources/${s.resource_id}/editors`)).body;
  assert.deepEqual(editors.editors.map((e:any)=>e.id),[won.actor.id]);
  const retries=await Promise.all([won.actor.client.call('/api/v1/summaries',won.body),won.actor.client.call('/api/v1/summaries',won.body)]);
  for(const r of retries)assert.deepEqual(r.body,{...s,idempotency:'replayed'});
  assert.deepEqual((await f.observer.query(`SELECT (SELECT count(*)::int FROM loom.summaries) AS summaries,
    (SELECT count(*)::int FROM loom.revisions WHERE resource_id=$1) AS revisions,
    (SELECT count(*)::int FROM loom.shared_activity WHERE resource_id=$1) AS events,
    (SELECT count(*)::int FROM loom.idempotency_records WHERE resource_id=$1) AS outcomes,
    (SELECT count(*)::int FROM loom.summary_coverage_sets WHERE summary_id=$1) AS coverage`,[s.resource_id])).rows,[{summaries:1,revisions:1,events:1,outcomes:1,coverage:1}]);
  assert.equal((await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:'Bypass',content:authored('Bypass')})).body.error.code,'summary_coverage_required');
  const current=(await f.admin.call(`/api/v1/discussions/${d.id}/summary`)).body;assert.equal(current.state,'available');assert.equal(current.summary.kind,'summary');
});

test('AC51/59: exact full/partial declarations preserve concurrent new and changed sources; bookkeeping is excluded',{timeout:90000},async t=>{
  const f=await fixture(t),d=await f.discussion(),c=await f.reply(d),p=await f.prepare(d.id),target=await f.artifact();
  const later=await f.reply(d,'A new comment while preparing');
  const changed=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:c.resource_id,expected_revision_id:c.revision_id,title:null,
    content:authored('Comment material',[reference({kind:'artifact',resource_id:target.resource_id})])});assert.equal(changed.status,201);
  const body=f.createBody(d.id,p.preparation_id),r=await f.admin.call('/api/v1/summaries',body);assert.equal(r.status,201,JSON.stringify(r.body));const s=r.body;
  const view=await f.coverage(s);assert.ok(Value.Check(CoverageDetail,view.body));
  assert.deepEqual(view.body.coverage,{scope:'full',uncovered_eligible:1,changed_eligible:1,unknown:false,comparison:'complete',claim:'author_declared; not_read_or_correctness_proof'});
  const members=await f.admin.call(view.body.members_url);assert.ok(Value.Check(SourcePage,members.body));
  assert.deepEqual(members.body.items.map((m:any)=>m.source.revision_id).sort(),[d.opening.revision_id,c.revision_id].sort());
  assert.ok(!JSON.stringify(members.body).includes(later.revision_id));
  const maintained=await f.admin.call('/api/v1/summaries/maintenance?filter=uncovered&editable=true');assert.ok(Value.Check(MaintenancePage,maintained.body));assert.equal(maintained.body.items[0]!.summary.resource_id,s.resource_id);
  const next=await f.prepare(d.id),r2=await f.reviseSummary(s,{preparation_id:next.preparation_id});
  assert.equal((await f.coverage(r2)).body.coverage.uncovered_eligible,0);assert.equal((await f.coverage(r2)).body.coverage.changed_eligible,0);
  await f.move(d.id,f.other,'discussion.move');
  assert.equal((await f.admin.call('/api/v1/summaries/editors',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_version:0,participant_ids:[]})).status,200);
  assert.equal((await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'discussion',resource_id:d.id},saved:true,expected_version:0})).status,200);
  assert.equal((await f.coverage(r2)).body.coverage.uncovered_eligible,0);
  const abandoned=(await f.admin.call('/api/v1/summaries/maintenance?filter=no_active_editor&editable=true')).body.items[0];assert.equal(abandoned.no_active_editor,true);assert.equal(abandoned.summary.area_id,f.other);
  const partial=await f.prepare(d.id,f.admin,[{contribution_id:d.opening.resource_id,revision_id:d.opening.revision_id}]);
  const r3=await f.reviseSummary(r2,{preparation_id:partial.preparation_id});assert.equal((await f.coverage(r3)).body.coverage.scope,'selected');
  const r4=await f.reviseSummary(r3,{carry_forward_revision_id:r3.revision_id});assert.deepEqual((await f.coverage(r3)).body.coverage,(await f.coverage(r4)).body.coverage);
  await f.reply(d,'I challenge this summary');assert.equal((await f.coverage(r4)).body.coverage.uncovered_eligible,3);
});

test('summary rights use explicit editors and live credentials; an archivist name and discussion authorship grant nothing',{timeout:90000},async t=>{
  const f=await fixture(t),author=await f.participant('discussion_author'),creator=await f.participant('summary_creator'),editor=await f.participant('listed_editor'),archivist=await f.participant('archivist');
  const d=await f.discussion(author.client),s=await f.create(d.id,creator.client);
  const update=(client:typeof f.admin)=>client.call('/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:'Unauthorized',content:authored('Proposed'),coverage:{carry_forward_revision_id:s.revision_id}});
  for(const participant of [author,editor,archivist])assert.equal((await update(participant.client)).status,403);
  assert.equal((await creator.client.call('/api/v1/summaries/editors',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_version:0,participant_ids:[archivist.id]})).status,403);
  assert.equal((await f.admin.call('/api/v1/summaries/editors',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_version:0,participant_ids:[editor.id]})).status,200);
  const p=await f.prepare(d.id,editor.client),r2=await f.reviseSummary(s,{preparation_id:p.preparation_id},editor.client);
  assert.equal((await creator.client.call('/api/v1/summaries/status',{operation_kind:'summary.create',idempotency_key:s.body.idempotency_key})).body.revision_id,s.revision_id);
  const prepared=await f.prepare(d.id,editor.client);
  await f.admin.call('/api/v1/summaries/editors',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_version:1,participant_ids:[]});
  const denied=await editor.client.call('/api/v1/summary-revisions',{...r2.body,idempotency_key:randomUUID(),expected_revision_id:r2.revision_id,coverage:{preparation_id:prepared.preparation_id}});assert.equal(denied.status,403);
  assert.equal((await f.admin.call(`/api/v1/resources/${s.resource_id}`)).body.author.id,creator.id);
  assert.equal((await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:archivist.id,credential_id:archivist.credential})).status,200);
  assert.equal((await archivist.client.call(`/api/v1/discussions/${d.id}/summary`)).status,401);
  const adminRevision=await f.reviseSummary(r2,{carry_forward_revision_id:r2.revision_id});assert.equal((await f.coverage(adminRevision)).status,200);
});

test('suppression preserves independent prose and hides coverage IDs/counts across every summary surface',{timeout:90000},async t=>{
  const f=await fixture(t),d=await f.discussion(),c=await f.reply(d,'Protected source wording'),s=await f.create(d.id);
  const prepared=await f.prepare(d.id);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[c.resource_id]));
  const detail=(await f.admin.call(`/api/v1/resources/${s.resource_id}`)).body;assert.equal(detail.content.text,'Independent synthesis');
  assert.ok(!JSON.stringify(detail).includes(c.resource_id));assert.ok(!JSON.stringify(detail).includes(c.revision_id));
  const coverage=(await f.coverage(s)).body;assert.equal(coverage.coverage.unknown,true);assert.equal(coverage.coverage.uncovered_eligible,0);
  for(const path of [coverage.members_url,coverage.sources_url,`/api/v1/summary-preparations/${prepared.preparation_id}`,prepared.members_url,'/api/v1/summaries/maintenance?filter=unknown']){
    const r=await f.admin.call(path);assert.equal(r.status,200,JSON.stringify(r.body));for(const secret of [c.resource_id,c.revision_id,'Protected source wording'])assert.ok(!JSON.stringify(r.body).includes(secret),path);
  }
  const fresh=await f.admin.call('/api/v1/summary-revisions',{idempotency_key:randomUUID(),resource_id:s.resource_id,expected_revision_id:s.revision_id,title:'New set',content:authored('Text'),coverage:{preparation_id:prepared.preparation_id}});assert.equal(fresh.status,404);
  const r2=await f.reviseSummary(s,{carry_forward_revision_id:s.revision_id});assert.equal((await f.coverage(r2)).body.coverage.unknown,true);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.summary_coverage_members WHERE revision_id=$1',[r2.revision_id])).rows[0].n,2);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[s.resource_id]));
  assert.equal((await f.admin.call(`/api/v1/resources/${s.resource_id}/history`)).status,404);assert.equal((await f.admin.call(`/api/v1/discussions/${d.id}/summary`)).body.state,'unavailable');
  assert.equal((await f.admin.call(`/api/v1/resources/${d.opening.resource_id}`)).status,200);assert.equal((await f.coverage(r2)).status,404);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[d.id]));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[s.resource_id]));assert.equal((await f.admin.call(`/api/v1/resources/${s.resource_id}`)).status,404);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[d.id]));assert.equal((await f.admin.call(`/api/v1/resources/${s.resource_id}`)).status,200);assert.equal((await f.admin.call(`/api/v1/resources/${c.resource_id}`)).status,404);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[s.revision_id]));assert.equal((await f.coverage(s)).status,404);assert.equal((await f.coverage(r2)).status,200);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[c.resource_id]));assert.equal((await f.coverage(r2)).body.coverage.unknown,false);
});

test('publication rollback stages, concurrent exact retries and lost acknowledgement preserve independent coverage',{timeout:90000},async t=>{
  let fault='',lose='';const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    let key='';const result=await database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.idempotency_records'))key=String(values[3]);
      if(fault&&sql.startsWith(fault)){fault='';throw new Error('Synthetic summary rollback');}return result;
    }}));if(key===lose&&lose){lose='';throw new Error('Lost summary acknowledgement');}return result;
  }})});
  const d=await f.discussion(),p=await f.prepare(d.id),body=f.createBody(d.id,p.preparation_id);
  for(const stage of ['INSERT INTO loom.summaries','INSERT INTO loom.summary_coverage_sets','INSERT INTO loom.summary_coverage_members','UPDATE loom.community_clocks','INSERT INTO loom.outbox_intents','INSERT INTO loom.idempotency_records']){
    fault=stage;assert.equal((await f.admin.call('/api/v1/summaries',body)).status,503);
    assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.summaries')).rows[0].n,0);
    assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.summary_coverage_sets')).rows[0].n,0);
  }
  lose=body.idempotency_key;assert.equal((await f.admin.call('/api/v1/summaries',body)).status,503);
  const status=await f.admin.call('/api/v1/summaries/status',{operation_kind:'summary.create',idempotency_key:body.idempotency_key});assert.equal(status.status,200);assert.equal(status.body.publication_state,'committed');
  await f.observer.query("UPDATE loom.summary_preparations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[p.preparation_id]);
  assert.equal((await f.admin.call('/api/v1/summary-preparations/cleanup',{})).status,200);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.summary_preparation_members')).rows[0].n,0);
  const repeats=await Promise.all([f.admin.call('/api/v1/summaries',body),f.admin.call('/api/v1/summaries',body)]);
  for(const r of repeats)assert.deepEqual(r.body,status.body);
  assert.equal((await f.coverage(status.body)).body.coverage.uncovered_eligible,0);
  assert.equal((await f.admin.call('/api/v1/summaries',{...body,title:'Changed key semantics'})).body.error.code,'idempotency_conflict');
});

test('summary references and search use summary identity, exact versions and current discussion placement',{timeout:90000},async t=>{
  const f=await fixture(t),d=await f.discussion(),target=await f.artifact(),ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'builds_on','Exact support');
  const s=await f.create(d.id,f.admin,[ref]);assert.equal((await f.admin.call(incoming(ref.target))).body.items[0].source.kind,'summary');
  const cite=await f.artifact(f.admin,'Citing summary',[reference({kind:'summary',resource_id:s.resource_id,revision_id:s.revision_id})]);
  assert.equal((await f.admin.call(outgoing(cite))).body.items[0].target.target.kind,'summary');
  const worker=new NativeSearchWorker(f.configuration);t.after(()=>worker.stop());await worker.start();
  const deadline=Date.now()+15000;let search:any;
  do {search=await f.admin.call('/api/v1/search?q=Independent&kind=summary');if(search.body.items?.length)break;if(Date.now()>deadline)throw new Error('Summary indexing deadline');}while(true);
  const match=search.body.items[0];assert.equal(match.kind,'summary');assert.equal(match.result_id,s.resource_id);assert.equal(match.revision_id,s.revision_id);assert.equal(match.discussion_id,d.id);
  assert.equal(match.browser_context_url,`/loom/resource/${s.resource_id}`);assert.equal(match.context_url,`/api/v1/discussions/${d.id}/summary`);
  await worker.stop();await f.move(d.id,f.other,'discussion.move');
  const moved=(await f.admin.call('/api/v1/search?q=Independent&kind=summary')).body.items[0];assert.equal(moved.area_id,f.other);
  assert.equal((await f.coverage(s)).status,200);assert.equal((await f.admin.call('/api/v1/summaries/maintenance')).body.items.length,1);
  const generation=(await f.admin.call('/api/v1/admin/search/health')).body.generation;
  await f.admin.call('/api/v1/admin/search/rebuild',{expected_generation:generation});await worker.start();
  const rebuilt=Date.now()+15000;while(!(await f.admin.call('/api/v1/search?q=Independent&kind=summary')).body.items?.length){if(Date.now()>rebuilt)throw new Error('Summary rebuild deadline');}
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[s.revision_id]));
  assert.deepEqual((await f.admin.call('/api/v1/search?q=Independent&kind=summary')).body.items,[]);assert.equal((await f.admin.call(incoming({kind:'summary',resource_id:s.resource_id,revision_id:s.revision_id}))).status,404);
});

test('summary reference changes retain attribution and withdrawal; linked target edits do not create source gaps',{timeout:60000},async t=>{
  const f=await fixture(t),d=await f.discussion(),target=await f.artifact(),ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'builds_on','Original support'),s=await f.create(d.id,f.admin,[ref]);
  const before=(await f.coverage(s)).body.coverage;
  await f.revise(f.admin,target,'Independent target R2',[]);assert.deepEqual((await f.coverage(s)).body.coverage,before);
  const changed={...ref,relationship:'contradicts' as const,rationale:'Changed claim'},r2=await f.reviseSummary(s,{carry_forward_revision_id:s.revision_id},f.admin,[changed]);
  const entry=(await f.admin.call(outgoing(r2))).body.items[0];assert.deepEqual(entry.declaration,changed);assert.equal(entry.original_assertion.revision_id,s.revision_id);assert.equal(entry.last_assertion_change.revision_id,r2.revision_id);
  const r3=await f.reviseSummary(r2,{carry_forward_revision_id:r2.revision_id});assert.deepEqual((await f.admin.call(incoming(ref.target))).body.items,[]);
  const old=(await f.admin.call(outgoing(s))).body.items[0];assert.equal(old.membership,'withdrawn');assert.equal(old.withdrawal.revision_id,r3.revision_id);assert.deepEqual((await f.coverage(r3)).body.coverage,before);
});
