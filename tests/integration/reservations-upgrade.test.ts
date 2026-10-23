import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/moderation.js';
import {prepareText} from '../helpers/file-text.js';
import {reservationSnapshot as sourceSnapshot} from '../helpers/reservations.js';
import {plain,authored} from '../helpers/references.js';
const base='/api/v1/editing-intent';
test('populated 0021 upgrade preserves every old table, file manifest, summary declaration and retry identity',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true,throughMigration:21}),d=await f.discussion(),comment=await f.reply(d),summary=await f.create(d.id);
  const member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'retained.md');
  const body={idempotency_key:randomUUID(),area_id:f.area,title:'File baseline',content:{format:'loom-markdown-v3',text:'Baseline',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}};
  const a=(await f.admin.call('/api/v1/artifacts',body)).body;
  await f.follow(f.admin,f.settings('discussion',d.id));
  await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:a.resource_id},saved:true,expected_version:0});
  const before=await sourceSnapshot(f);await f.migrate();const after=await sourceSnapshot(f);
  for(const name of Object.keys(before))assert.deepEqual(after[name],before[name],name);
  assert.equal((await f.admin.call('/api/v1/artifacts',body)).body.revision_id,a.revision_id);
  for(const source of [d.opening,comment,summary,a])assert.equal((await f.admin.call(base+'/announce',{idempotency_key:randomUUID(),resource_id:source.resource_id,base_revision_id:source.revision_id,purpose:'Upgrade intent',scope:{kind:'whole'}})).status,200);
  const final=await sourceSnapshot(f);for(const name of Object.keys(before))assert.deepEqual(final[name],before[name],name);
});

test('actual resource population limit, escaped byte pagination and hidden exact bases preserve disclosure and continuation',{timeout:120000},async t=>{
  const f=await fixture(t),a=await f.artifact();let first:any;
  for(let i=0;i<100;i++){
    const body={idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'a'+'\u0001'.repeat(383),scope:{kind:'described',description:'b'+'\u0002'.repeat(127)}};
    const r=await f.admin.call(base+'/announce',body);assert.equal(r.status,200,JSON.stringify(r.body));first??={body,result:r.body};
    assert.equal((await f.admin.call(base+'/release',{idempotency_key:randomUUID(),notice_id:r.body.current.notice_id,expected_version:1})).status,200);
  }
  const denied=await f.admin.call(base+'/announce',{...first.body,idempotency_key:randomUUID()});assert.equal(denied.body.error.code,'editing_intent_limit');
  let cursor='',seen=new Set<string>(),pages=0;
  do{const r=await f.admin.call(base+'/resources/'+a.resource_id+'?limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Buffer.byteLength(JSON.stringify(r.body))<=32768);
    for(const notice of r.body.items){assert.ok(!seen.has(notice.notice_id));seen.add(notice.notice_id);assert.equal(notice.purpose,first.body.purpose);}
    cursor=r.body.next_cursor??'';pages++;
  }while(cursor);assert.equal(seen.size,100);assert.ok(pages>4,'JSON escaping, not only raw input bytes, limits pages');
  const page=(await f.admin.call(base+'/resources/'+a.resource_id+'?limit=1')).body;
  assert.equal((await f.admin.call(base+'/resources/'+a.resource_id+'?cursor=invalid')).body.error.code,'invalid_cursor');
  const next=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'New current',content:plain('New current')});assert.equal(next.status,201);
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[a.revision_id]);
  const hidden=await f.admin.call(base+'/resources/'+a.resource_id);assert.deepEqual(hidden.body.items,[]);assert.equal(hidden.body.next_cursor,null);assert.equal(hidden.body.complete,true);
  assert.equal((await f.admin.call(base+'/resources/'+a.resource_id+'?cursor='+encodeURIComponent(page.next_cursor))).body.error.code,'invalid_cursor');
  assert.equal((await f.admin.call(base+'/announce',first.body)).body.current.state,'released');
});

test('file-bearing edits and attachment/summary drafts keep complete manifests and coverage across advisory conflicts',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),d=await f.discussion(),summary=await f.create(d.id);
  const member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'chapter.md');
  const create={idempotency_key:randomUUID(),area_id:f.area,title:'Full file draft',content:{format:'loom-markdown-v3',text:'Original',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}};
  const a=(await f.admin.call('/api/v1/artifacts',create)).body;
  const intent={idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'File edit',scope:{kind:'described',description:'chapter.md'}};
  assert.equal((await f.admin.call(base+'/announce',intent)).status,200);
  const files=(await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${a.revision_id}/files`)).body.items;
  const edit={idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Complete proposed set',content:create.content,change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'renamed.md',source:{revision_id:a.revision_id,file_id:files[0].file_id}}]}};
  const raw=JSON.stringify(edit);const published=await f.admin.call('/api/v1/revisions',edit);assert.equal(published.status,201,JSON.stringify(published.body));
  const stale={...edit,idempotency_key:randomUUID()};assert.equal((await f.admin.call('/api/v1/revisions',stale)).status,409);assert.equal(JSON.stringify(edit),raw);
  assert.equal((await f.admin.call('/api/v1/revisions',edit)).body.revision_id,published.body.revision_id,'Old publication digest and replay remain unchanged');
  const attachment=await prepareText(f.admin,{kind:'contribution',resource_id:d.opening.resource_id},'opening.txt');
  const attached={idempotency_key:randomUUID(),resource_id:d.opening.resource_id,expected_revision_id:d.opening.revision_id,title:'Attached opening',content:authored('Complete opening draft'),attachment_set:{version:'contribution-attachments-v1',files:[attachment]}};
  const withFile=await f.admin.call('/api/v1/revisions',attached);assert.equal(withFile.status,201,JSON.stringify(withFile.body));
  const attachmentNotice={...intent,idempotency_key:randomUUID(),resource_id:d.opening.resource_id,base_revision_id:withFile.body.revision_id};assert.equal((await f.admin.call(base+'/announce',attachmentNotice)).status,200);
  const attachmentManifest=(await f.admin.call(`/api/v1/contributions/${d.opening.resource_id}/revisions/${withFile.body.revision_id}/attachments`)).body.items;
  const attachmentEdit={...attached,idempotency_key:randomUUID(),expected_revision_id:withFile.body.revision_id,attachment_set:{version:'contribution-attachments-v1',files:[{path:'renamed-opening.txt',source:{revision_id:withFile.body.revision_id,file_id:attachmentManifest[0].file_id}}]}};
  const attachmentRaw=JSON.stringify(attachmentEdit);assert.equal((await f.admin.call('/api/v1/revisions',attachmentEdit)).status,201);
  assert.equal((await f.admin.call('/api/v1/revisions',{...attachmentEdit,idempotency_key:randomUUID()})).status,409);assert.equal(JSON.stringify(attachmentEdit),attachmentRaw);
  const summaryIntent={...intent,idempotency_key:randomUUID(),resource_id:summary.resource_id,base_revision_id:summary.revision_id};await f.admin.call(base+'/announce',summaryIntent);
  const revision={idempotency_key:randomUUID(),resource_id:summary.resource_id,expected_revision_id:summary.revision_id,title:'Carried coverage',content:authored('Summary remains exact'),coverage:{carry_forward_revision_id:summary.revision_id}};
  const saved=JSON.stringify(revision),next=await f.admin.call('/api/v1/summary-revisions',revision);assert.equal(next.status,201,JSON.stringify(next.body));
  assert.equal((await f.admin.call('/api/v1/summary-revisions',{...revision,idempotency_key:randomUUID()})).status,409);assert.equal(JSON.stringify(revision),saved);
  assert.equal((await f.admin.call('/api/v1/summary-revisions',revision)).body.revision_id,next.body.revision_id);
});
