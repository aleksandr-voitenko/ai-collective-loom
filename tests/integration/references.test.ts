import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { Value } from '@sinclair/typebox/value';
import { fixture,authored,plain,reference,incoming,outgoing } from '../helpers/references.js';
import { ReferencePage } from '../../src/contracts/references.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import { barrier,bounded } from '../helpers/search-races.js';

test('human and agent publications record exact directed references with no target effects', {timeout:90000}, async t=>{
  const f=await fixture(t),human=await f.participant('reference_human','human'),agent=await f.participant('reference_agent');
  const target=await f.artifact(human.client,'Target document');
  const before=(await f.observer.query('SELECT * FROM loom.resources WHERE id=$1',[target.resource_id])).rows;
  for(const author of [human,agent]){
    const ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'contradicts','The measurement differs.');
    const source=await f.artifact(author.client,'Independent interpretation',[ref]);
    const result=await author.client.call(outgoing(source));assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(Value.Check(ReferencePage,result.body));
    assert.deepEqual(result.body.items.map((row:any)=>({declaration:row.declaration,direction:row.direction,author:row.original_assertion.participant.id,
      editor:row.last_assertion_change.participant.id,publisher:row.source.publisher.id,membership:row.membership,source:row.source.resource_id,revision:row.source.revision_id,
      target:row.target.target,scope:row.target.scope,href:row.target.browser_url})),[{
      declaration:ref,direction:'source_to_target',author:author.id,editor:author.id,publisher:author.id,membership:'current',source:source.resource_id,revision:source.revision_id,
      target:ref.target,scope:'revision',href:`/loom/resource/${target.resource_id}/${target.revision_id}`}]);
    const exact=await author.client.call(incoming(ref.target));assert.equal(exact.status,200);
    assert.ok(exact.body.items.some((r:any)=>r.source.revision_id===source.revision_id));
    assert.deepEqual((await author.client.call(incoming({kind:'artifact',resource_id:target.resource_id}))).body.items,[]);
    const denied=await agent.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:target.resource_id,expected_revision_id:target.revision_id,title:'Unauthorized',content:authored('changed',[ref])});assert.equal(denied.status,403);
    const spoof=await author.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Spoof',content:authored('Text',[{...ref,asserting_participant_id:f.administratorId} as any])});assert.equal(spoof.status,400);
  }
  assert.deepEqual((await f.observer.query('SELECT * FROM loom.resources WHERE id=$1',[target.resource_id])).rows,before);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.shared_activity WHERE resource_id=$1',[target.resource_id])).rows[0].n,1);
  assert.deepEqual((await f.observer.query('SELECT participant_id FROM loom.resource_editors WHERE resource_id=$1',[target.resource_id])).rows,[{participant_id:human.id}]);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n,0);
  const ordinary=await f.artifact(agent.client,`Ordinary https://example.test/${target.resource_id}`);
  assert.deepEqual((await agent.client.call(outgoing(ordinary))).body.items,[]);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n,2);
  const schema=(await f.admin.call('/api/v1/openapi.json')).body;
  assert.ok(schema.paths['/api/v1/references/incoming']);assert.ok(schema.paths['/api/v1/references/target']);
});

test('carry-forward, changes, withdrawal and moves preserve identity and distinct editor attribution', {timeout:60000}, async t=>{
  const f=await fixture(t),alice=await f.participant('asserting_alice'),bob=await f.participant('editing_bob');
  const target=await f.artifact(f.admin,'Exact target R1'),ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'builds_on','Retained reason');
  const r1=await f.artifact(alice.client,'Synthesis',[ref]);
  assert.equal((await f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:r1.resource_id,expected_version:0,participant_ids:[alice.id,bob.id]})).status,200);
  const r2=await f.revise(bob.client,r1,'Synthesis edited',[ref]);
  const carry=(await bob.client.call(outgoing(r2))).body.items[0];assert.equal(carry.original_assertion.participant.id,alice.id);assert.equal(carry.last_assertion_change.participant.id,alice.id);assert.equal(carry.source.publisher.id,bob.id);
  assert.equal((await bob.client.call(outgoing(r1))).body.items[0].membership,'carried_forward');
  const changed={...ref,relationship:'contradicts' as const,rationale:'A new conclusion'};
  const r3=await f.revise(bob.client,r2,'Synthesis changed',[changed]);
  const entry=(await bob.client.call(outgoing(r3))).body.items[0];assert.equal(entry.original_assertion.participant.id,alice.id);assert.equal(entry.last_assertion_change.participant.id,bob.id);
  assert.equal((await bob.client.call(outgoing(r1))).body.items[0].membership,'changed');
  const targetR2=await f.revise(f.admin,target,'Target R2',[]);
  await f.move(target.resource_id,f.other);await f.move(r1.resource_id,f.other);
  const exact=(await bob.client.call(incoming(ref.target))).body;
  assert.equal(exact.items.length,1);assert.equal(exact.items[0].source.area_id,f.other);assert.equal(exact.items[0].target.representation.revision_id,target.revision_id);
  assert.equal(exact.items[0].target.representation.area_id,f.other);
  assert.deepEqual((await bob.client.call(incoming({...ref.target,revision_id:targetR2.revision_id}))).body.items,[]);
  const r4=await f.revise(bob.client,r3,'Synthesis withdrawn',[]);
  assert.deepEqual((await bob.client.call(incoming(ref.target))).body.items,[]);
  const history=(await bob.client.call(incoming(ref.target,{history:'all'}))).body.items;
  assert.equal(history.length,3);assert.ok(history.every((r:any)=>r.membership==='withdrawn'&&r.direction==='source_to_target'));
  assert.ok(history.every((r:any)=>r.withdrawal.participant.id===bob.id&&r.withdrawal.revision_id===r4.revision_id));
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reference_withdrawals WHERE source_id=$1',[r1.resource_id])).rows[0].n,1);
  const later=await f.revise(alice.client,r4,'Unrelated edit after withdrawal',[]);
  assert.equal((await bob.client.call(outgoing(r1))).body.items[0].withdrawal.revision_id,r4.revision_id);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[r4.revision_id]));
  assert.equal((await bob.client.call(outgoing(r1))).body.items[0].withdrawal,null);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='available' WHERE id=$1",[r4.revision_id]));
  const r5=await f.revise(bob.client,later,'Reasserted',[ref]);
  const reasserted=(await bob.client.call(outgoing(r5))).body.items[0];assert.equal(reasserted.original_assertion.participant.id,alice.id);assert.equal(reasserted.last_assertion_change.participant.id,bob.id);assert.equal(reasserted.last_assertion_change.revision_id,r5.revision_id);
  const old=await bob.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:r5.resource_id,expected_revision_id:r5.revision_id,title:'Old client',content:plain('Would strip references')});
  assert.equal(old.status,409);assert.equal(old.body.error.code,'reference_format_required');
  assert.equal((await bob.client.call('/api/v1/resources/'+r5.resource_id)).body.revision_id,r5.revision_id);
  const resourceScope={...ref,target:{kind:'artifact' as const,resource_id:target.resource_id}};
  const r6=await f.revise(bob.client,r5,'Deliberately changed target scope',[resourceScope]);
  assert.deepEqual((await bob.client.call(incoming(ref.target))).body.items,[]);
  const retargeted=(await bob.client.call(incoming(resourceScope.target))).body.items[0];
  assert.deepEqual(retargeted.declaration,resourceScope);assert.equal(retargeted.original_assertion.participant.id,alice.id);
  assert.equal(retargeted.last_assertion_change.revision_id,r6.revision_id);assert.equal(retargeted.target.scope,'resource');
  assert.equal((await bob.client.call(outgoing(r5))).body.items[0].membership,'changed');
});

test('unavailable targets carry unchanged without metadata leaks; exact history does not depend on current availability', {timeout:60000},async t=>{
  const f=await fixture(t),target=await f.artifact(f.admin,'Hidden target title'),ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'related_to','Independent authored rationale');
  const source=await f.artifact(f.admin,'Independent source',[ref]);const newer=await f.revise(f.admin,target,'Suppressed current title',[]);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[newer.revision_id]));
  const usable=await f.admin.call('/api/v1/references/target?'+new URLSearchParams(ref.target));assert.equal(usable.status,200);assert.equal(usable.body.representation.revision_id,target.revision_id);
  assert.equal((await f.admin.call('/api/v1/references/target?'+new URLSearchParams({kind:'artifact',resource_id:target.resource_id}))).status,404);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[target.resource_id]));
  const carried=await f.revise(f.admin,source,'Unrelated source edit',[ref]);
  const output=await f.admin.call(outgoing(carried));assert.equal(output.status,200);assert.deepEqual(output.body.items[0].target,{state:'unavailable'});
  assert.equal(output.body.items[0].declaration.rationale,ref.rationale);
  assert.ok(!JSON.stringify(output.body).includes('Hidden target title'));assert.ok(!JSON.stringify(output.body).includes('Suppressed current title'));
  const create=(targetId:string)=>f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'New assertion',content:authored('New',[reference({kind:'artifact',resource_id:targetId})])});
  const unavailable=await create(target.resource_id),absent=await create(randomUUID());assert.equal(unavailable.status,404);assert.equal(absent.status,404);
  const safe=(r:any)=>{const {request_id:_,...error}=r.body.error;return error;};assert.deepEqual(safe(unavailable),safe(absent));
  const change=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:carried.resource_id,expected_revision_id:carried.revision_id,title:'Changed assertion',content:authored('Edit',[{...ref,rationale:'Changed reason'}])});assert.equal(change.status,404);
  assert.equal((await f.admin.call(incoming(ref.target))).status,404);
  assert.equal((await f.admin.call('/api/v1/resources/'+carried.resource_id)).body.content.text,'Unrelated source edit');
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[target.resource_id]));
  assert.equal((await f.admin.call(incoming(ref.target))).body.items.length,1);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[carried.revision_id]));
  assert.deepEqual((await f.admin.call(incoming(ref.target))).body.items,[]);
  assert.equal((await f.admin.call(incoming(ref.target,{history:'all'}))).body.items[0].membership,'current_unavailable');
});

test('discussion containers, opening contributions and independently eligible nested replies have separate backlink scopes',{timeout:60000},async t=>{
  const f=await fixture(t),target=await f.artifact(),ref=reference({kind:'artifact',resource_id:target.resource_id});
  const opening=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Nested references',content:authored('Opening',[ref])});assert.equal(opening.status,201);
  const discussion=(await f.admin.call('/api/v1/resources/'+opening.body.resource_id)).body.discussion_id;
  const parent=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.body.resource_id,content:authored('Parent',[reference(ref.target)])});assert.equal(parent.status,201);
  const reply=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:parent.body.resource_id,content:authored('Eligible reply',[reference(ref.target)])});assert.equal(reply.status,201);
  const cites=await f.artifact(f.admin,'Distinct scopes',[reference({kind:'discussion',resource_id:discussion}),reference({kind:'contribution',resource_id:opening.body.resource_id}),reference({kind:'contribution',resource_id:reply.body.resource_id,revision_id:reply.body.revision_id})]);
  assert.equal((await f.admin.call(incoming({kind:'discussion',resource_id:discussion}))).body.items[0].source.resource_id,cites.resource_id);
  assert.equal((await f.admin.call(incoming({kind:'contribution',resource_id:opening.body.resource_id}))).body.items.length,1);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[parent.body.resource_id]));
  assert.deepEqual((await f.admin.call(incoming(ref.target))).body.items.map((r:any)=>r.source.resource_id).sort(),[opening.body.resource_id,reply.body.resource_id].sort());
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[discussion]));
  assert.deepEqual((await f.admin.call(incoming(ref.target,{history:'all'}))).body.items,[]);
  assert.equal((await f.admin.call('/api/v1/resources/'+cites.resource_id)).status,200);
});

test('validation, logical uniqueness, revision ownership and Unicode budgets fail before durable publication',{timeout:60000},async t=>{
  const f=await fixture(t),a=await f.artifact(),b=await f.artifact(),ref=reference({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id});
  const before=(await f.observer.query('SELECT count(*)::int n FROM loom.revisions')).rows[0].n;
  const invalid=[
    authored('duplicate logical',[ref,{...ref,target:{kind:'artifact' as const,resource_id:b.resource_id}}]),
    authored('duplicate target',[ref,{...ref,reference_id:randomUUID(),relationship:'related_to' as const}]),
    authored('rationale missing',[{...ref,relationship:'builds_on' as const}]),
    authored('rationale blank',[{...ref,relationship:'contradicts' as const,rationale:' \n\t '}]),
    authored('Unicode rationale',[{...ref,rationale:'🦉'.repeat(129)}]),
    authored('x'.repeat(16384),[{...ref,rationale:'x'}]),
    authored('NUL',[{...ref,rationale:'\0'}]),
    authored('surrogate',[{...ref,rationale:'\ud800'}]),
    authored('unsupported',[{...ref,target:{kind:'file' as any,resource_id:a.resource_id}}]),
    authored('discussion revision',[{...ref,target:{kind:'discussion' as const,resource_id:a.resource_id,revision_id:a.revision_id}}]),
  ];
  for(const content of invalid){const r=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Invalid reference',content});assert.equal(r.status,400,JSON.stringify(r.body));}
  const ownership=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Wrong revision',content:authored('wrong',[{...ref,target:{...ref.target,revision_id:b.revision_id}}])});assert.equal(ownership.status,404);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revisions')).rows[0].n,before);
  const max=await f.artifact(f.admin,'Max');
  const escaped=await f.revise(f.admin,max,'Budget',[{...ref,rationale:'\u0001'.repeat(512)}]);
  const body=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:escaped.resource_id,expected_revision_id:escaped.revision_id,title:'Budget',content:authored('\u0001'.repeat(15872),[{...ref,rationale:'\u0001'.repeat(512)}])});assert.equal(body.status,201,JSON.stringify(body.body));
  const full=await f.admin.call(`/api/v1/resources/${body.body.resource_id}/revisions/${body.body.revision_id}`);assert.equal(full.status,200);assert.ok(full.bytes<=131072);assert.equal(full.body.content.text.length,15872);
  assert.equal((await f.admin.call(`/api/v1/resources/${body.body.resource_id}/revisions/${body.body.revision_id}?max_response_bytes=4096`)).body.error.code,'response_budget_too_small');
  const stored=(await f.observer.query('SELECT * FROM loom.revision_references WHERE revision_id=$1',[body.body.revision_id])).rows[0];
  await assert.rejects(f.database.transaction(tx=>tx.query('UPDATE loom.revision_references SET rationale=$1 WHERE revision_id=$2',['mutated',body.body.revision_id])),(e:any)=>e.code==='42501');
  await assert.rejects(f.database.transaction(tx=>tx.query(`INSERT INTO loom.revision_references(source_id,revision_id,reference_id,target_kind,target_id,target_revision_id,origin_revision_id,assertion_revision_id)
    VALUES ($1,$2,$3,'artifact',$4,$5,$2,$2)`,[stored.source_id,stored.revision_id,randomUUID(),a.resource_id,b.revision_id])),(e:any)=>e.code==='23503');
});

test('rollback, concurrent retries, changed semantics and lost acknowledgements retain a single membership',{timeout:90000},async t=>{
  let fault='',lose='';
  const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    let key='';const result=await database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.idempotency_records'))key=String(values[3]);
      if(fault&&sql.startsWith(fault)){fault='';throw new Error('Synthetic membership rollback');}return result;
    }}));if(key&&key===lose){lose='';throw new Error('Synthetic response loss after COMMIT');}return result;
  }})});
  const target=await f.artifact(),ref=reference({kind:'artifact',resource_id:target.resource_id}),input={idempotency_key:randomUUID(),area_id:f.area,title:'Retry source',content:authored('Original',[ref])};
  for(const stage of ['INSERT INTO loom.revision_references','UPDATE loom.resources SET current_revision_id','INSERT INTO loom.shared_activity','INSERT INTO loom.idempotency_records']){
    const before=(await f.observer.query('SELECT count(*)::int n FROM loom.revisions')).rows[0].n;fault=stage;
    const r=await f.admin.call('/api/v1/artifacts',input);assert.equal(r.status,503);assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revisions')).rows[0].n,before);
    assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n,0);
  }
  lose=input.idempotency_key;const lost=await f.admin.call('/api/v1/artifacts',input);assert.equal(lost.status,503);
  const outcomes=await Promise.all(Array.from({length:4},()=>f.admin.call('/api/v1/artifacts',input)));assert.ok(outcomes.every(r=>r.status===201));
  assert.equal(new Set(outcomes.map(r=>r.body.revision_id)).size,1);const source=outcomes[0]!.body;
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n,1);
  for(const changed of [{...ref,rationale:'Changed'},{...ref,relationship:'related_to' as const},{...ref,target:{...ref.target,revision_id:target.revision_id}},
    {...ref,reference_id:randomUUID()},{...ref,target:{...ref.target,resource_id:randomUUID()}},{...ref,target:{...ref.target,kind:'contribution' as const}}]){
    const r=await f.admin.call('/api/v1/artifacts',{...input,content:authored('Original',[changed])});assert.equal(r.status,409);assert.equal(r.body.error.code,'idempotency_conflict');
  }
  fault='INSERT INTO loom.reference_withdrawals';
  const interrupted=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Withdrawn',content:authored('Withdrawn',[])});
  assert.equal(interrupted.status,503);assert.equal((await f.admin.call('/api/v1/resources/'+source.resource_id)).body.revision_id,source.revision_id);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reference_withdrawals')).rows[0].n,0);
  const newer=await f.revise(f.admin,source,'Withdrawn',[]);
  const retry=await f.admin.call('/api/v1/artifacts',input);assert.equal(retry.body.revision_id,source.revision_id);
  assert.equal((await f.admin.call('/api/v1/resources/'+source.resource_id)).body.revision_id,newer.revision_id);
  assert.deepEqual((await f.admin.call(incoming(ref.target))).body.items,[]);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.reference_withdrawals')).rows[0].n,1);
});

test('opposite cross-referencing source edits acquire complete ordered guards without lock upgrades',{timeout:60000},async t=>{
  const gate=barrier(),release=barrier();let active=false,entered=0;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    if(active&&sql==='SELECT opening_id FROM loom.discussions WHERE id=ANY($1::uuid[])'){if(++entered===2)gate.release();await bounded(release.promise);}
    return tx.query<Row>(sql,values);
  }}))})});
  const a=await f.artifact(f.admin,'Cross A'),b=await f.artifact(f.admin,'Cross B');
  active=true;const pending=Promise.all([
    f.revise(f.admin,a,'Cross A',[reference({kind:'artifact',resource_id:b.resource_id,revision_id:b.revision_id})]),
    f.revise(f.admin,b,'Cross B',[reference({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id})]),
  ]);
  try{await bounded(gate.promise);}finally{release.release();}
  const [ar,br]=await pending;
  assert.equal((await f.admin.call(incoming({kind:'artifact',resource_id:b.resource_id,revision_id:b.revision_id}))).body.items[0].source.revision_id,ar.revision_id);
  assert.equal((await f.admin.call(incoming({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}))).body.items[0].source.revision_id,br.revision_id);
});

test('both authored formats remain searchable through native worker restart and rebuild; backlinks need no index',{timeout:90000},async t=>{
  const f=await fixture(t),target=await f.artifact(f.admin,'Targetonlyneedle'),ref=reference({kind:'artifact',resource_id:target.resource_id},'related_to','Rationaleonlyneedle');
  const source=await f.artifact(f.admin,'Sourceonlyneedle',[ref]);
  assert.equal((await f.admin.call(incoming(ref.target))).body.items[0].source.resource_id,source.resource_id);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.search_documents')).rows[0].n,0);
  const worker=new NativeSearchWorker(f.configuration);t.after(()=>worker.stop());await worker.start();
  await worker.observeUntil(async()=> (await f.observer.query('SELECT count(*)::int n FROM loom.search_documents')).rows[0].n===3);await worker.stop();
  for(const [q,ids] of [['sourceonlyneedle',[source.resource_id]],['targetonlyneedle',[target.resource_id]],['rationaleonlyneedle',[]]] as const){
    const r=await f.admin.call('/api/v1/search?q='+q);assert.equal(r.status,200);assert.deepEqual(r.body.items.map((r:any)=>r.source_resource_id),ids);
  }
  const newer=await f.revise(f.admin,source,'Revisedneedle',[ref]);await worker.start();await worker.observeUntil(async()=> (await f.observer.query('SELECT revision_id FROM loom.search_documents WHERE resource_id=$1',[source.resource_id])).rows[0].revision_id===newer.revision_id);await worker.stop();
  const health=(await f.admin.call('/api/v1/admin/search/health')).body;
  const rebuild=await f.admin.call('/api/v1/admin/search/rebuild',{expected_generation:health.generation});assert.equal(rebuild.status,200,JSON.stringify(rebuild.body));
  await worker.start();await worker.observeUntil(async()=> (await f.observer.query('SELECT count(*)::int n FROM loom.search_documents WHERE generation=2')).rows[0].n===3);await worker.stop();
  assert.equal((await f.admin.call('/api/v1/search?q=revisedneedle')).body.items[0].revision_id,newer.revision_id);
  assert.equal((await f.admin.call(incoming(ref.target))).body.items[0].source.revision_id,newer.revision_id);
});
