import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fixture, plain, reference, incoming, outgoing, authored } from '../helpers/references.js';
import type { QueryResultRow } from 'pg';

test('a restarted standalone HTTPS client retains every reference field and reconciles the original publication', {timeout:60000}, async t => {
  const f=await fixture(t),agent=await f.participant('external_reference_agent');
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:agent.id,kind:'agent',purpose:null,label:'External client',replace_credential_id:null});
  assert.equal(credential.status,200);
  const discussion=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Client context',content:plain('Opening')});assert.equal(discussion.status,201);
  const target=await f.artifact(),refs=[reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id},'builds_on','Exact reason 🦉')];
  refs[0]!.reference_id=refs[0]!.reference_id.toUpperCase();
  await writeFile(f.directory+'/token',credential.body.secret,{mode:0o600});await writeFile(f.directory+'/reply.txt','External reply\r\nExact text',{mode:0o600});
  await writeFile(f.directory+'/references.json',JSON.stringify(refs),{mode:0o600});
  const run=(action:string)=>promisify(execFile)(process.execPath,['scripts/participation-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem',
    '--journal',f.directory+'/intent.json','--action',action,...(action==='prepare'?['--parent',discussion.body.resource_id,'--text-file',f.directory+'/reply.txt','--references-file',f.directory+'/references.json']:[])],{timeout:20000});
  await run('prepare');const initial=JSON.parse(await readFile(f.directory+'/intent.json','utf8'));
  assert.deepEqual(initial.body.content,authored('External reply\r\nExact text',refs));
  assert.ok(!(await readFile(f.directory+'/intent.json','utf8')).includes(credential.body.secret));
  await assert.rejects(run('lose-response'),(e:any)=>e.code===75);
  const uncertain=JSON.parse(await readFile(f.directory+'/intent.json','utf8'));assert.equal(uncertain.state,'uncertain');assert.deepEqual(uncertain.body,initial.body);
  await run('retry');await run('inspect');const confirmed=JSON.parse(await readFile(f.directory+'/intent.json','utf8'));
  assert.equal(confirmed.state,'committed');assert.deepEqual(confirmed.body,initial.body);
  const exact=(await agent.client.call(`/api/v1/resources/${confirmed.result.resource_id}/revisions/${confirmed.result.revision_id}`)).body;
  assert.equal(exact.publisher.id,agent.id);assert.deepEqual(exact.content.references,[{...refs[0],reference_id:refs[0]!.reference_id.toLowerCase()}]);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_references')).rows[0].n,1);
  assert.equal((await agent.client.call(incoming(refs[0]!.target))).body.items[0].source.revision_id,confirmed.result.revision_id);
});

test('ordinary human and agent editors both change and withdraw their own declarations without target editing', {timeout:60000}, async t => {
  const f=await fixture(t),target=await f.artifact();
  for(const kind of ['human','agent'] as const){
    const author=await f.participant(kind+'_editor',kind),ref=reference({kind:'artifact',resource_id:target.resource_id});
    const first=await f.artifact(author.client,kind+' source',[ref]),changed={...ref,relationship:'contradicts' as const,rationale:'Revised conclusion'};
    const second=await f.revise(author.client,first,kind+' revision',[changed]);
    const entry=(await author.client.call(outgoing(second))).body.items[0];
    assert.deepEqual(entry.declaration,changed);assert.equal(entry.original_assertion.participant.id,author.id);assert.equal(entry.last_assertion_change.revision_id,second.revision_id);
    await f.revise(author.client,second,kind+' withdrawal',[]);
    assert.deepEqual((await author.client.call(incoming(ref.target))).body.items,[]);
    assert.equal((await author.client.call(outgoing(first))).body.items[0].membership,'withdrawn');
  }
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.shared_activity WHERE resource_id=$1',[target.resource_id])).rows[0].n,1);
});

test('reference declaration, serialized response, candidate and timeout budgets are observable', {timeout:60000}, async t => {
  let timeout=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    if(timeout&&sql.startsWith('SELECT rr.* FROM loom.revision_references rr')){timeout=false;await tx.query('SELECT pg_sleep(3)',[]);}
    return tx.query<Row>(sql,values);
  }}))})});
  const refs=[];for(let i=0;i<16;i++){const target=await f.artifact(f.admin,'Boundary '+i);refs.push(reference({kind:'artifact',resource_id:target.resource_id},'related_to','\u0001'.repeat(512)));}
  const published=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Sixteen declarations',content:authored('\u0001'.repeat(8192),refs)});
  assert.equal(published.status,201);const source=published.body;
  const full=await f.admin.call(`/api/v1/resources/${source.resource_id}/revisions/${source.revision_id}`);
  assert.equal(full.status,200);assert.ok(full.bytes<=131072);assert.equal(full.body.content.text,'\u0001'.repeat(8192));assert.equal(full.body.content.references.length,16);
  const page=await f.admin.call(outgoing(source,{max_response_bytes:'12000',limit:'25'}));assert.equal(page.status,200);assert.ok(page.bytes<=12000);assert.ok(page.body.items.length>0&&page.body.items.length<16);assert.ok(page.body.next_cursor.length<=2048);
  const all=[...page.body.items];let cursor=page.body.next_cursor;
  while(cursor){const next=await f.admin.call(outgoing(source,{max_response_bytes:'12000',limit:'25',cursor}));assert.equal(next.status,200);assert.ok(next.bytes<=12000);all.push(...next.body.items);cursor=next.body.next_cursor;}
  assert.deepEqual(all.map(r=>r.declaration).sort((a,b)=>a.reference_id.localeCompare(b.reference_id)),[...refs].sort((a,b)=>a.reference_id.localeCompare(b.reference_id)));
  const tooSmall=await f.admin.call(outgoing(source,{max_response_bytes:'4096'}));assert.equal(tooSmall.body.error.code,'response_budget_too_small');assert.ok(tooSmall.body.error.minimum_response_bytes>4096);
  const seventeenth=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Too many',content:authored('Too many',[...refs,reference(refs[0]!.target)])});assert.equal(seventeenth.status,400);
  const requestLimit=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Too large',content:authored('x'.repeat(131073),refs)});assert.equal(requestLimit.status,413);
  const badCursor=await f.admin.call(incoming(refs[0]!.target,{cursor:'x'.repeat(2049)}));assert.equal(badCursor.status,400);
  timeout=true;const limited=await f.admin.call(incoming(refs[0]!.target));assert.equal(limited.status,429);assert.equal(limited.body.error.code,'reference_work_limit');
  assert.equal((await f.admin.call(incoming(refs[0]!.target))).body.items[0].source.revision_id,source.revision_id);
});
