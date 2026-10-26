import test from 'node:test';
import {PutObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture,plain,reference,incoming,outgoing} from '../helpers/references.js';
import {prepareText,packageText,suppressFileOwner,sourceSnapshot} from '../helpers/file-text.js';
import type {ReferenceValue,ReferenceTargetValue} from '../../src/contracts/participation.js';
const content=(references:ReferenceValue[]=[],text='File citation')=>({format:'loom-markdown-v4' as const,text,mentions:[],references});
const fields={change_note:null,change_account:null};
type F=Awaited<ReturnType<typeof fixture>>;
const target=(p:any,kind:'artifact'|'contribution'='artifact'):ReferenceTargetValue=>({kind,resource_id:p.resource_id,revision_id:p.revision_id,file_id:p.file.file_id,path:p.file.path});
async function publish(f:F,refs:ReferenceValue[],client=f.admin,note:ReferenceValue[]=[]){
 const input={idempotency_key:randomUUID(),area_id:f.area,title:'Citing source',content:content(refs),...fields,change_note:note.length?content(note,'Exact note'):null};
 const result=await client.call('/api/v1/artifacts',input);assert.equal(result.status,201,JSON.stringify(result.body));return {...result.body,input};
}
async function revision(f:F,source:any,refs:ReferenceValue[],client=f.admin){
 const input={idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Revised citation',content:content(refs),...fields};
 const result=await client.call('/api/v1/revisions',input);assert.equal(result.status,201,JSON.stringify(result.body));return {...result.body,input};
}

test('exact artifact and attachment citations keep distinct scopes, bytes, fields, provenance and independent promoted contexts',async t=>{
 const f=await fixture(t,{files:true}),reader=await f.participant('file_citer');
 const bytes=Buffer.from('Original exact bytes\n'),member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'one.bin',bytes,'application/octet-stream');
 const packageInput={idempotency_key:randomUUID(),area_id:f.area,title:'Files R1',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},...fields,file_set:{version:'artifact-files-v1',files:[member,{...member,path:'two.bin'}]}};
 const result=await f.admin.call('/api/v1/artifacts',packageInput);assert.equal(result.status,201);
 const p=result.body,page=(await reader.client.call(`/api/v1/artifacts/${p.resource_id}/revisions/${p.revision_id}/files`)).body;
 const one=target({...p,file:page.items[0]}),two=target({...p,file:page.items[1]});
 const attached=await prepareText(f.admin,{kind:'opening',resource_id:f.area},'attachment.bin',bytes,'application/octet-stream');
 const opening=(await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Attachment context',content:plain('Opening'),attachment_set:{version:'contribution-attachments-v1',files:[attached]}})).body;
 const view=(await f.admin.call('/api/v1/resources/'+opening.resource_id)).body;
 const attachment=(await f.admin.call(view.attachment_set.manifest_url)).body.items[0],attachmentTarget=target({...opening,file:attachment},'contribution');
 const promoted=await reader.client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:opening.resource_id,revision_id:opening.revision_id,file_id:attachment.file_id},area_id:f.other,title:'Independent bytes'});assert.equal(promoted.status,201);
 const promotionPage=(await reader.client.call(`/api/v1/artifacts/${promoted.body.resource_id}/revisions/${promoted.body.revision_id}/files`)).body;
 const independent=target({...promoted.body,file:promotionPage.items[0]});
 const whole={kind:'artifact' as const,resource_id:p.resource_id,revision_id:p.revision_id};
 const before=await sourceSnapshot(f),refs=[one,two,whole,attachmentTarget,independent].map(r=>reference(r));
 const source=await publish(f,refs,reader.client,[reference(one,'builds_on','Exact bytes support this note')]);
 const after=await sourceSnapshot(f);
 // Only source publication tables change. Citation does not mutate file custody,
 // editors of the target, private state or target-side notifications.
 for(const table of Object.keys(before))if(!['resources','revisions','revision_references','revision_change_notes','resource_editors','editor_sets','artifacts','idempotency_records','shared_activity','outbox_intents','community_clocks','search_state','summary_state'].includes(table))assert.deepEqual(after[table],before[table],table);
 assert.deepEqual((await f.observer.query('SELECT resource_id FROM loom.shared_activity WHERE resource_id=$1',[p.resource_id])).rows,[{resource_id:p.resource_id}]);
 for(const [selected,count] of [[one,2],[two,1],[whole,1],[attachmentTarget,1],[independent,1]] as const){
  const incomingPage=await reader.client.call(incoming(selected));assert.equal(incomingPage.status,200,JSON.stringify(incomingPage.body));assert.equal(incomingPage.body.items.length,count);assert.equal(incomingPage.body.scope,'file_id' in selected?'file':'revision');
  assert.ok(incomingPage.body.items.every((entry:any)=>entry.source.resource_id===source.resource_id));
 }
 assert.equal((await reader.client.call(outgoing(source))).body.items.length,6);
 const exact=(await reader.client.call(`/api/v1/resources/${source.resource_id}/revisions/${source.revision_id}`)).body;
 assert.equal(exact.content.format,'loom-markdown-v4');assert.deepEqual(exact.content.references.map((r:any)=>r.target),[...refs].sort((a,b)=>a.reference_id.localeCompare(b.reference_id)).map(r=>r.target));
 const note=await reader.client.call(exact.change_note.full_content_url);assert.equal(note.body.content.format,'loom-markdown-v4');assert.deepEqual(note.body.content.references[0].target,one);
 const resolved=await reader.client.call('/api/v1/references/target?'+new URLSearchParams({kind:one.kind,resource_id:one.resource_id,revision_id:one.revision_id!,file_id:one.file_id!}));assert.equal(resolved.status,200);assert.deepEqual(resolved.body.target,one);assert.equal(resolved.body.browser_url,`/loom/file/artifact/${p.resource_id}/${p.revision_id}/${one.file_id}`);
 // Replace, rename and omit current membership; exact references keep R1.
 const replacement=await prepareText(f.admin,{kind:'artifact',resource_id:p.resource_id},'renamed.bin',Buffer.from('Replacement'));
 let current=await f.admin.call('/api/v1/revisions',{...packageInput,idempotency_key:randomUUID(),area_id:undefined,resource_id:p.resource_id,expected_revision_id:p.revision_id,title:'Files R2',file_set:{version:'artifact-files-v1',files:[replacement]}});assert.equal(current.status,201,JSON.stringify(current.body));
 current=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:p.resource_id,expected_revision_id:current.body.revision_id,title:'Files omitted',content:{format:'loom-markdown-v3',text:'Retained history',mentions:[],references:[]},...fields,file_set:{version:'artifact-files-v1',files:[]}});assert.equal(current.status,201);
 await f.move(p.resource_id,f.other);assert.equal((await reader.client.call(page.items[0].download_url)).body,bytes.toString());
 assert.deepEqual((await reader.client.call(incoming(one))).body.items.map((e:any)=>e.declaration.target),[one,one]);
 await suppressFileOwner(f,view.discussion_id);
 assert.equal((await reader.client.call(incoming(attachmentTarget))).status,404);
 assert.equal((await reader.client.call(attachment.download_url)).status,404);
 assert.equal((await reader.client.call(promotionPage.items[0].download_url)).body,bytes.toString());
 assert.equal((await reader.client.call(incoming(independent))).body.items.length,1);
 const hidden=(await reader.client.call(outgoing(source))).body.items.find((e:any)=>e.declaration.target.file_id===attachment.file_id);assert.deepEqual(hidden.target,{state:'unavailable'});assert.deepEqual(hidden.declaration.target,attachmentTarget);
 const carry=await revision(f,source,refs,reader.client);assert.equal((await reader.client.call(incoming(independent,{history:'all'}))).body.items.find((e:any)=>e.source.revision_id===source.revision_id).membership,'carried_forward');
 const changed=await reader.client.call('/api/v1/revisions',{...carry.input,idempotency_key:randomUUID(),expected_revision_id:carry.revision_id,content:content(refs.map(r=>r.target.file_id===attachment.file_id?{...r,rationale:'changed'}:r))});assert.equal(changed.status,404);
 const editor=await f.participant('file_assertion_editor');
 assert.equal((await f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:source.resource_id,expected_version:0,participant_ids:[reader.id,editor.id]})).status,200);
 const altered=await revision(f,carry,refs.map(r=>r.target.file_id===independent.file_id?{...r,relationship:'related_to',rationale:'Reviewed independent file'}:r),editor.client);
 const changedEntry=(await editor.client.call(outgoing(altered))).body.items.find((e:any)=>e.declaration.target.file_id===independent.file_id);
 assert.equal(changedEntry.original_assertion.participant.id,reader.id);assert.equal(changedEntry.last_assertion_change.participant.id,editor.id);
 assert.equal((await reader.client.call(outgoing(source))).body.items.find((e:any)=>e.declaration.target.file_id===independent.file_id).membership,'changed');
 const withdrawn=await revision(f,altered,[],reader.client);
 const history=(await reader.client.call(incoming(independent,{history:'all'}))).body;assert.deepEqual(history.items.map((e:any)=>e.source.revision_id).sort(),[source.revision_id,carry.revision_id,altered.revision_id].sort());assert.ok(history.items.every((e:any)=>e.membership==='withdrawn'&&e.withdrawal.revision_id===withdrawn.revision_id));
 const replay=await reader.client.call('/api/v1/artifacts',source.input);assert.equal(replay.body.revision_id,source.revision_id);assert.deepEqual((await reader.client.call(incoming(independent))).body.items,[]);
 const snapshots=await sourceSnapshot(f);await reader.client.call(outgoing(source));await reader.client.call(incoming(one,{history:'all'}));assert.deepEqual(await sourceSnapshot(f),snapshots);
 // Remove only the exact native version with alternatives still present: no fallback.
 const row=(await f.observer.query('SELECT u.* FROM loom.file_uploads u JOIN loom.file_contexts c ON c.upload_id=u.id WHERE c.id=$1',[one.file_id])).rows[0];
 const storage=f.fileFixture!.storage;
 await storage.client.send(new PutObjectCommand({Bucket:storage.configuration.finalBucket,Key:storage.key(row.id),Body:Buffer.from('Wrong latest bytes')}));
 await storage.client.send(new DeleteObjectCommand({Bucket:storage.configuration.finalBucket,Key:storage.key(row.id),VersionId:row.final_version}));
 assert.equal((await reader.client.call(page.items[0].download_url)).body.error.code,'file_storage_unavailable');
 assert.deepEqual((await reader.client.call('/api/v1/references/target?'+new URLSearchParams(one))).body.target,one);
});

test('file declarations reject ambiguous paths, wrong membership, private uploads and legacy formats; v4 bases require explicit correction',async t=>{
 const f=await fixture(t,{files:true}),p=await packageText(f),selected=target(p),other=await packageText(f);
 const base={idempotency_key:randomUUID(),area_id:f.area,title:'Invalid citation',content:content([reference(selected)]),...fields};
 // Real private custody in every unpublished state has no contextual file identity.
 const pending=await f.admin.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:p.resource_id},path:'pending.txt',size:0,sha256:createHash('sha256').update('').digest('hex'),media_type:'text/plain'});assert.equal(pending.status,201);
 const privateMember=await prepareText(f.admin,{kind:'artifact',resource_id:p.resource_id},'private.txt');
 const assertPrivate=async(file_id:string,path:string)=>{
  const privateTarget={...selected,file_id,path};
  assert.equal((await f.admin.call('/api/v1/artifacts',{...base,idempotency_key:randomUUID(),content:content([reference(privateTarget)])})).status,404);
  assert.equal((await f.admin.call('/api/v1/references/target?'+new URLSearchParams(privateTarget))).status,404);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.file_contexts WHERE upload_id=$1',[file_id])).rows[0].n,0);
 };
 await assertPrivate(pending.body.upload_id,'pending.txt');await assertPrivate(privateMember.source.upload_id,privateMember.path);
 // Controlled synthetic quarantine of an unpublished upload; published custody forbids this transition.
 await f.observer.query("UPDATE loom.file_uploads SET state='quarantined' WHERE id=$1",[privateMember.source.upload_id]);
 await assertPrivate(privateMember.source.upload_id,privateMember.path);
 for(const wrong of [{...selected,path:'../chapter.txt'},{...selected,path:'CHAPTER.txt'},{...selected,file_id:other.file.file_id},{...selected,revision_id:other.revision_id},{...selected,path:undefined},{...selected,file_id:undefined},{...selected,kind:'summary'},{...selected,revision_id:undefined},{...selected,file_id:p.input.file_set.files[0].source.upload_id}]){
  const refused=await f.admin.call('/api/v1/artifacts',{...base,idempotency_key:randomUUID(),content:content([reference(wrong as ReferenceTargetValue)])});assert.ok([400,404].includes(refused.status),JSON.stringify(refused.body));
 }
 for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3']){const old=await f.admin.call('/api/v1/artifacts',{...base,content:{...base.content,format}});assert.equal(old.status,400);}
 const two=reference(selected);assert.equal((await f.admin.call('/api/v1/artifacts',{...base,content:content([base.content.references[0]!,two])})).status,400);
 const source=await publish(f,[reference(selected)]);
 for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3']){
  const input={idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Legacy edit',content:{format,text:'Preserve draft',mentions:[],...(format==='loom-markdown-v1'?{}:{references:[]})},...(format==='loom-markdown-v3'?fields:{})};
  const refusal=await f.admin.call('/api/v1/revisions',input);assert.equal(refusal.status,409);assert.equal(refusal.body.error.code,'file_reference_format_required');
 }
 await suppressFileOwner(f,p.resource_id);assert.equal((await f.admin.call('/api/v1/artifacts',{...base,idempotency_key:randomUUID()})).status,404);
 assert.equal((await f.admin.call('/api/v1/references/target?'+new URLSearchParams(selected))).status,404);
 // Notes intentionally retain their earlier target schema; no private file backlinks are introduced.
 assert.equal((await f.admin.call('/api/v1/me/notes/create',{idempotency_key:randomUUID(),note_id:randomUUID(),title:'Private',body:'Private',links:[selected]})).status,400);
});

test('file incoming traversal compares complete expected sets under independent byte/work bounds, expiry, restoration and restart',async t=>{
 const f=await fixture(t,{files:true}),p=await packageText(f),selected=target(p),sources=[];
 for(let i=0;i<105;i++)sources.push(await publish(f,[reference(selected,i%2?'related_to':null,'"\\'.repeat(100))]));
 const expected=sources.map(source=>({source_id:source.resource_id,revision_id:source.revision_id,relationship:source.input.content.references[0]!.relationship})).sort((a,b)=>a.revision_id.localeCompare(b.revision_id));
 const tooSmall=await f.admin.call(incoming(selected,{max_response_bytes:'4096'}));
 if(tooSmall.status!==200)assert.equal(tooSmall.body.error.code,'response_budget_too_small');
 const all=[];let cursor:string|undefined;
 do{const response=await f.admin.call(incoming(selected,{limit:'2',max_response_bytes:'8192',...(cursor?{cursor}:{})}));assert.equal(response.status,200,JSON.stringify(response.body));assert.ok(response.bytes<=8192);all.push(...response.body.items.map((e:any)=>e.source.revision_id));cursor=response.body.next_cursor;assert.equal(response.body.complete,!cursor);}while(cursor);
 assert.deepEqual(all,expected.map(r=>r.revision_id));
 const hidden=expected.slice(0,100).map(r=>r.source_id);await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=ANY($1::uuid[])",[hidden]));
 const empty=await f.admin.call(incoming(selected,{max_response_bytes:'4096'}));assert.equal(empty.status,200);assert.deepEqual(empty.body.items,[]);assert.equal(empty.body.complete,false);assert.equal(empty.body.work_budget_reached,true);
 const rest=await f.admin.call(incoming(selected,{cursor:empty.body.next_cursor}));assert.deepEqual(rest.body.items.map((e:any)=>e.source.revision_id),expected.slice(100).map(r=>r.revision_id));
 const first=await f.admin.call(incoming(selected,{limit:'1'}));assert.ok(first.body.next_cursor);
 for(const extra of [{path:'other'},{file_id:randomUUID()},{history:'all'},{relationship:'related_to'}])assert.equal((await f.admin.call(incoming(selected,{cursor:first.body.next_cursor,...extra}))).body.error.code,'references_changed');
 const real=Date.now;Date.now=()=>real()+301000;try{assert.equal((await f.admin.call(incoming(selected,{cursor:first.body.next_cursor}))).body.error.code,'references_changed');}finally{Date.now=real;}
 await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[hidden[0]]));assert.equal((await f.admin.call(incoming(selected,{cursor:first.body.next_cursor}))).body.error.code,'references_changed');
 const renewed=await f.admin.call(incoming(selected,{limit:'1'}));await f.restart();assert.equal((await f.admin.call(incoming(selected,{cursor:renewed.body.next_cursor}))).body.error.code,'references_changed');
 const filteredIds:string[]=[];cursor=undefined;
 do{const filtered=await f.admin.call(incoming(selected,{relationship:'related_to',...(cursor?{cursor}:{})}));assert.equal(filtered.status,200);filteredIds.push(...filtered.body.items.map((e:any)=>e.source.revision_id));cursor=filtered.body.next_cursor;assert.equal(filtered.body.complete,!cursor);}while(cursor);
 assert.deepEqual(filteredIds,[expected[0]!,...expected.slice(100)].filter(row=>row.relationship==='related_to').map(row=>row.revision_id));
});

test('v4 opening, comment and summary sources preserve coverage boundaries, note field identity and NFC file intent',async t=>{
 const {fixture:summaryFixture}=await import('../helpers/summaries.js');
 const f=await summaryFixture(t,{files:true}),p=await packageText(f,f.admin,'café.txt'),selected=target(p);
 const decomposed={...selected,path:'cafe\u0301.txt'},ref=reference(decomposed,'related_to','Fixed context');
 const d=await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'V4 opening',content:content([ref]),...fields});assert.equal(d.status,201);
 const discussion=(await f.admin.call('/api/v1/resources/'+d.body.resource_id)).body.discussion_id;
 const attached=await prepareText(f.admin,{kind:'reply',resource_id:d.body.resource_id},'comment.txt');
 const reply=await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:d.body.resource_id,content:content([reference(selected)]),...fields,attachment_set:{version:'contribution-attachments-v1',files:[attached]}});assert.equal(reply.status,201,JSON.stringify(reply.body));
 const attachment=(await f.admin.call(`/api/v1/contributions/${reply.body.resource_id}/revisions/${reply.body.revision_id}/attachments`)).body.items[0];
 const commentTarget=target({...reply.body,file:attachment},'contribution'),prepared=await f.prepare(discussion);
 const summary=await f.admin.call('/api/v1/summaries',{idempotency_key:randomUUID(),discussion_id:discussion,title:'V4 synthesis',content:content([reference(commentTarget)]),change_note:content([reference(selected)],'Exact summary note'),change_account:null,coverage:{preparation_id:prepared.preparation_id}});assert.equal(summary.status,201,JSON.stringify(summary.body));
 assert.deepEqual((await f.admin.call(outgoing(d.body))).body.items[0].declaration.target,selected);
 assert.equal((await f.admin.call(incoming(commentTarget))).body.items[0].source.revision_id,summary.body.revision_id);
 const before=(await f.coverage(summary.body)).body.coverage;
 await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:p.resource_id,expected_revision_id:p.revision_id,title:'Target replaced',content:{format:'loom-markdown-v3',text:'Different target only',mentions:[],references:[]},...fields,file_set:{version:'artifact-files-v1',files:[]}});
 assert.deepEqual((await f.coverage(summary.body)).body.coverage,before,'Linked-file edits do not recursively change declared discussion coverage');
 const note=(await f.admin.call(`/api/v1/resources/${summary.body.resource_id}/revisions/${summary.body.revision_id}/change-note`)).body;assert.equal(note.content.format,'loom-markdown-v4');
 assert.equal((await f.admin.call('/api/v1/me/reading/state',{idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{resource_id:summary.body.resource_id,revision_id:summary.body.revision_id,read:true,expected_version:0}]})).status,200,'New format preserves ordinary exact main-text eligibility');
 // Escaping overhead, not item count, can exhaust a complete response envelope.
 const oversized=await publish(f,[reference(selected,'related_to','\u0001'.repeat(512))]);
 const budget=await f.admin.call(outgoing(oversized,{max_response_bytes:'4096'}));assert.equal(budget.body.error.code,'response_budget_too_small');assert.ok(budget.body.error.minimum_response_bytes>4096);
 assert.equal((await f.admin.call(outgoing(oversized,{max_response_bytes:'16384'}))).body.items.length,1);
});

test('file-aware main and note fields remain worker-readable without turning citations or uploaded tokens into notifications or search text',async t=>{
 const {fixture:notifications}=await import('../helpers/notifications.js');
 const {SearchWorker}=await import('../../src/server/modules/search/worker.js');
 const f=await notifications(t,{files:true}),owner=await f.participant('file_target_owner'),recipient=await f.participant('explicit_recipient');
 const p=await packageText(f,owner.client,'literal.txt',Buffer.from('[[mention:raw]] privateuploadneedle')),selected=target(p);
 const ref=reference(selected,'related_to','rationaleonlyneedle');
 const source=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'File-aware source',content:{...content([ref],'vfourmainneedle [[mention:a]]'),mentions:[{token:'a',participant_id:recipient.id}]},change_note:{...content([ref],'vfournoteonlyneedle [[mention:n]]'),mentions:[{token:'n',participant_id:recipient.id}]},change_account:null});
 await f.drain();const notices=await f.page(recipient.client);assert.deepEqual(notices.items.map(row=>[row.source.resource_id,row.reasons.map(r=>r.kind)]),[[source.resource_id,['main_mention','note_mention']]]);
 assert.deepEqual((await f.page(owner.client)).items,[],'File owner gets no citation alert');
 const worker=new SearchWorker(f.database);for(let i=0;i<5;i++)await worker.tick();
 for(const q of ['vfourmainneedle','vfournoteonlyneedle'])assert.deepEqual((await f.admin.call('/api/v1/search?q='+q)).body.items.map((r:any)=>r.source_resource_id),[source.resource_id]);
 for(const q of ['rationaleonlyneedle','privateuploadneedle'])assert.deepEqual((await f.admin.call('/api/v1/search?q='+q)).body.items,[]);
 assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.file_text_jobs')).rows[0].n,0,'References never need or schedule file text');
});
