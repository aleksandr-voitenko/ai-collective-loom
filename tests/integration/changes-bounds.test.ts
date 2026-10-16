import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture,content,note,exactPair,revisionBody,notePath,coveragePath,discover } from '../helpers/changes.js';
import { reference } from '../helpers/references.js';

test('discovery bounds candidates and complete JSON, keeps empty continuation and binds scope, owner and lifecycle',{timeout:120000},async t=>{
  const f=await fixture(t),target=await f.artifact(),d=await f.discussion(),reader=await f.participant('changes_reader');
  const sources:{resource_id:string;revision_id:string}[]=[];for(let i=0;i<103;i++){
    const r=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Bounded account '+i),change_note:null,change_account:{revisions:[exactPair(target)]}});
    assert.equal(r.status,201);sources.push(r.body);
  }
  sources.sort((a,b)=>a.revision_id.localeCompare(b.revision_id));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=ANY($1::uuid[])",[sources.slice(0,100).map(s=>s.resource_id)]));
  const first=await f.admin.call(discover(target,{max_response_bytes:'4096'}));assert.equal(first.status,200);assert.deepEqual(first.body.items,[]);assert.equal(first.body.complete,false);assert.equal(first.body.work_budget_reached,true);assert.ok(first.body.next_cursor.length<=2048);assert.ok(first.bytes<=4096);
  assert.ok(!JSON.stringify(first.body).includes(sources[0]!.resource_id));assert.equal(Object.hasOwn(first.body,'total'),false);
  const cursor=first.body.next_cursor;
  for(const options of [{history:'all'}, {form:'change_account'}, {revision_id:''}])assert.equal((await f.admin.call(discover(target,{...options,cursor}))).status,options.revision_id===''?400:409);
  assert.equal((await reader.client.call(discover(target,{cursor}))).status,409);
  const second=await f.admin.call(discover(target,{cursor,max_response_bytes:'4096'}));assert.equal(second.status,200);assert.ok(second.bytes<=4096);assert.ok(second.body.items.length>0);
  const all=[];let page=second;while(true){all.push(...page.body.items);if(!page.body.next_cursor)break;page=await f.admin.call(discover(target,{cursor:page.body.next_cursor,max_response_bytes:'4096'}));assert.equal(page.status,200);assert.ok(page.bytes<=4096);}
  assert.deepEqual(all.map(i=>i.source.revision_id),sources.slice(100).map(s=>s.revision_id));
  const resource=await f.admin.call(discover({resource_id:target.resource_id},{max_response_bytes:'4096'}));assert.equal(resource.body.scope,'resource_described_revisions');
  assert.equal((await f.admin.call(discover({resource_id:target.resource_id},{cursor}))).status,409);
  const now=Date.now(),clock=t.mock.method(Date,'now',()=>now+301000);try{assert.equal((await f.admin.call(discover(target,{cursor}))).status,409);}finally{clock.mock.restore();}
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[sources[0]!.resource_id]));assert.equal((await f.admin.call(discover(target,{cursor}))).status,409);
  t.diagnostic(JSON.stringify({candidate_bound:100,first_page_bytes:first.bytes,second_page_bytes:second.bytes,visible_members:all.length}));
});

test('combined authored budgets, field-local references, exact note response and coverage pages preserve complete bytes',{timeout:90000},async t=>{
  const f=await fixture(t),first=await f.artifact(),main='\u0001'.repeat(12288),ownNote=note('\u0001'.repeat(4096));
  const r2=await f.admin.call('/api/v1/revisions',revisionBody(first,main,ownNote));assert.equal(r2.status,201,JSON.stringify(r2.body));
  const body=await f.admin.call(`/api/v1/resources/${r2.body.resource_id}/revisions/${r2.body.revision_id}`),detail=await f.admin.call(notePath(r2.body));
  assert.equal(body.status,200);assert.equal(detail.status,200);assert.equal(body.body.content.text,main);assert.deepEqual(detail.body.content,ownNote);assert.ok(body.bytes<=131072&&detail.bytes<=131072);
  assert.equal((await f.admin.call(notePath(r2.body)+'?max_response_bytes=4096')).body.error.code,'response_budget_too_small');
  assert.equal((await f.admin.call('/api/v1/revisions',revisionBody(r2.body,main+'x',ownNote))).status,400);
  assert.equal((await f.admin.call('/api/v1/revisions',revisionBody(r2.body,'Main',note('🦉'.repeat(1025))))).status,400);
  const targets=[first,r2.body];let current=r2.body;for(let i=0;i<14;i++){const next=await f.admin.call('/api/v1/revisions',revisionBody(current,'Target revision '+i));assert.equal(next.status,201);current=next.body;targets.push(current);}
  const d=await f.discussion(),accountBody={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:content('Sixteen exact revisions'),change_note:null,change_account:{revisions:targets.map(s=>exactPair(s))}};
  const account=await f.admin.call('/api/v1/replies',accountBody);assert.equal(account.status,201);
  let cursor='',count=0;do{const page=await f.admin.call(coveragePath(account.body)+'?'+new URLSearchParams({limit:'3',max_response_bytes:'8192',...(cursor?{cursor}:{})}));assert.equal(page.status,200);assert.ok(page.bytes<=8192);assert.equal(page.body.unknown,false);count+=page.body.items.length;cursor=page.body.next_cursor??'';}while(cursor);assert.equal(count,16);
  const refs=targets.map(s=>reference(exactPair(s))),tooMany=revisionBody(current,'Main',note('Note'));
  tooMany.content.references=refs;tooMany.change_note!.references=[reference(exactPair(first))];assert.equal((await f.admin.call('/api/v1/revisions',tooMany)).status,400);
  const referenceId=randomUUID(),withNote=revisionBody(current,'Main',note('Note [[mention:m]]'));
  withNote.change_note!.mentions=[{token:'m',participant_id:f.administratorId}];withNote.change_note!.references=[{...reference(exactPair(first)),reference_id:referenceId}];
  const last=await f.admin.call('/api/v1/revisions',withNote);assert.equal(last.status,201);
  const other=await f.participant('digest_other');
  for(const changed of [{...withNote.change_note!,mentions:[{token:'m',participant_id:other.id}]},{...withNote.change_note!,references:[{...withNote.change_note!.references[0]!,reference_id:randomUUID()}]}])assert.equal((await f.admin.call('/api/v1/revisions',{...withNote,change_note:changed})).body.error.code,'idempotency_conflict');
  await assert.rejects(f.database.transaction(tx=>tx.query('UPDATE loom.revision_change_notes SET content_text=$1 WHERE revision_id=$2',['changed',last.body.revision_id])),(e:any)=>e.code==='42501');
  await assert.rejects(f.database.transaction(tx=>tx.query('DELETE FROM loom.change_account_members WHERE revision_id=$1',[account.body.revision_id])),(e:any)=>e.code==='42501');
  t.diagnostic(JSON.stringify({main_json_bytes:body.bytes,note_json_bytes:detail.bytes,coverage_members:count}));
});
