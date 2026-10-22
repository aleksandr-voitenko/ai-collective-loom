import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,plain} from '../helpers/references.js';
import type {UploadInputValue} from '../../src/contracts/files.js';

type Fixture=Awaited<ReturnType<typeof fixture>>;
async function prepare(client:Fixture['admin'],target:UploadInputValue['target'],path:string,bytes=Buffer.from('exact original attachment\n')){
  const input={idempotency_key:randomUUID(),target,path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/html'};
  const admitted=await client.call('/api/v1/file-uploads',input);assert.equal(admitted.status,201,JSON.stringify(admitted.body));
  const id=admitted.body.upload_id;
  assert.equal((await client.call(`/api/v1/file-uploads/${id}/bytes`,undefined,{bytes})).status,200);
  assert.equal((await client.call(`/api/v1/file-uploads/${id}/finalize`,{})).status,200);
  return {path,source:{upload_id:id}};
}
const set=(files:unknown[])=>({version:'contribution-attachments-v1',files});
async function snapshot(f:Fixture){const state:Record<string,unknown>={};
  for(const table of ['resources','discussions','contributions','artifacts','revisions','resource_editors','revision_mentions','revision_references','shared_activity','outbox_intents','community_clocks','idempotency_records','artifact_file_sets','contribution_attachment_sets','file_contexts','attachment_promotions'])
    state[table]=(await f.observer.query(`SELECT to_jsonb(t) AS row FROM loom.${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return state;
}
async function suppress(f:Fixture,id:string,suppressed=true){const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+id)).body;
  const r=await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed,expected_version:state.version});assert.equal(r.status,200,JSON.stringify(r.body));}

test('opening and nested attachment snapshots promote independently with exact bytes, attribution, containment and recovery',async t=>{
  const f=await fixture(t,{files:true}),alice=await f.participant('attachment_alice'),bob=await f.participant('attachment_bob');
  const member=await prepare(alice.client,{kind:'opening',resource_id:f.area},'draft/chapter.md');
  const openingInput={idempotency_key:randomUUID(),area_id:f.area,title:'Attached opening',content:plain('Opening text'),attachment_set:set([member])};
  const opening=await alice.client.call('/api/v1/discussions',openingInput);assert.equal(opening.status,201,JSON.stringify(opening.body));
  const first=opening.body,view=(await bob.client.call('/api/v1/resources/'+first.resource_id)).body,discussion=view.discussion_id;
  const openingPage=await bob.client.call(view.attachment_set.manifest_url+'?prefix=draft');assert.equal(openingPage.status,200);
  assert.equal(openingPage.body.discussion_id,discussion);assert.equal(openingPage.body.contributor_id,alice.id);
  const attachment=openingPage.body.items[0],source={contribution_id:first.resource_id,revision_id:first.revision_id,file_id:attachment.file_id};
  const downloaded=await bob.client.call(attachment.download_url);assert.equal(downloaded.body,'exact original attachment\n');
  assert.equal(downloaded.headers['x-content-type-options'],'nosniff');assert.match(String(downloaded.headers['content-disposition']),/^attachment/);
  const revised=await alice.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:first.resource_id,expected_revision_id:first.revision_id,title:'Attached opening',content:plain('Opening text'),attachment_set:set([])});
  assert.equal(revised.status,201,JSON.stringify(revised.body));assert.equal((await bob.client.call(attachment.download_url)).body,downloaded.body);
  const privateBefore=await snapshot(f);
  assert.equal((await bob.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:first.resource_id,expected_revision_id:revised.body.revision_id,title:'Not mine',content:plain('No'),attachment_set:set([])})).status,403);
  assert.equal((await bob.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Cannot adopt',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[member]}})).status,404);
  assert.deepEqual(await snapshot(f),privateBefore);
  const promotion={idempotency_key:randomUUID(),source,area_id:f.other,title:'Independent artifact'};
  const [one,two]=await Promise.all([bob.client.call('/api/v1/attachment-promotions',promotion),bob.client.call('/api/v1/attachment-promotions',promotion)]);
  assert.equal(one.status,201,JSON.stringify(one.body));assert.equal(two.status,201);assert.equal(one.body.resource_id,two.body.resource_id);
  const artifact=one.body,manifest=(await bob.client.call(`/api/v1/artifacts/${artifact.resource_id}/revisions/${artifact.revision_id}/files?prefix=draft`)).body;
  assert.equal((await bob.client.call(manifest.items[0].download_url)).body,downloaded.body);
  assert.deepEqual((await f.observer.query('SELECT participant_id FROM loom.resource_editors WHERE resource_id=$1',[artifact.resource_id])).rows,[{participant_id:bob.id}]);
  const provenance=(await bob.client.call(`/api/v1/artifacts/${artifact.resource_id}/revisions/${artifact.revision_id}/provenance`)).body;
  assert.deepEqual(provenance,{artifact_id:artifact.resource_id,revision_id:artifact.revision_id,promoter_id:bob.id,source:{state:'available',...source,discussion_id:discussion,contributor_id:alice.id,revision_publisher_id:alice.id,uploader_id:alice.id}});
  const replyMember=await prepare(alice.client,{kind:'reply',resource_id:first.resource_id},'reply.txt');
  const reply=(await alice.client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:first.resource_id,content:plain('Reply'),attachment_set:set([replyMember])}));assert.equal(reply.status,201);
  const nestedMember=await prepare(bob.client,{kind:'reply',resource_id:reply.body.resource_id},'nested.txt');
  const nested=await bob.client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:reply.body.resource_id,content:plain('Nested'),attachment_set:set([nestedMember])});assert.equal(nested.status,201);
  await suppress(f,reply.body.resource_id);await suppress(f,discussion);await suppress(f,discussion,false);
  assert.equal((await bob.client.call(`/api/v1/contributions/${reply.body.resource_id}/revisions/${reply.body.revision_id}/attachments`)).status,404);
  const visible=(await bob.client.call('/api/v1/contributions/'+nested.body.resource_id+'/context')).body;assert.equal(visible.parent_id,reply.body.resource_id);assert.ok(visible.attachment_set);
  await suppress(f,discussion);
  assert.equal((await bob.client.call(attachment.download_url)).status,404);
  assert.equal((await bob.client.call(manifest.items[0].download_url)).body,downloaded.body);
  assert.deepEqual((await bob.client.call(`/api/v1/artifacts/${artifact.resource_id}/revisions/${artifact.revision_id}/provenance`)).body.source,{state:'unavailable'});
  await f.restart();
  const recovered=await bob.client.call('/api/v1/operations/status',{operation_kind:'attachment.promote',idempotency_key:promotion.idempotency_key});assert.equal(recovered.body.resource_id,artifact.resource_id);
  const replay=await bob.client.call('/api/v1/attachment-promotions',promotion);assert.equal(replay.body.revision_id,artifact.revision_id);
  assert.equal((await bob.client.call('/api/v1/attachment-promotions',{...promotion,title:'Changed'})).body.error.code,'idempotency_conflict');
  const reused=await bob.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:artifact.resource_id,expected_revision_id:artifact.revision_id,title:'Diverged',content:{format:'loom-markdown-v3',text:'Independent description',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'renamed.txt',source:{revision_id:artifact.revision_id,file_id:manifest.items[0].file_id}}]}});assert.equal(reused.status,201,JSON.stringify(reused.body));
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second'");
  assert.deepEqual((await alice.client.call('/api/v1/file-uploads/cleanup',{})).body,{removed:0,quarantined:0});
  assert.equal((await bob.client.call(manifest.items[0].download_url)).body,downloaded.body);
  await suppress(f,artifact.resource_id);assert.equal((await bob.client.call('/api/v1/operations/status',{operation_kind:'attachment.promote',idempotency_key:promotion.idempotency_key})).status,404);
});

for(const kind of ['discussion.create','reply.create','revision.publish'] as const)test(kind+' attachment expiry refusal binds the key even after envelope omission and restart',async t=>{
  const f=await fixture(t,{files:true});
  const opening=(await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Parent',content:plain('Parent')})).body;
  const discussion=(await f.admin.call('/api/v1/resources/'+opening.resource_id)).body.discussion_id;
  const target:UploadInputValue['target']=kind==='discussion.create'?{kind:'opening',resource_id:f.area}:kind==='reply.create'?{kind:'reply',resource_id:opening.resource_id}:{kind:'contribution',resource_id:opening.resource_id};
  const member=await prepare(f.admin,target,'expired.txt');
  await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[member.source.upload_id]);
  const input={idempotency_key:randomUUID(),...(kind==='discussion.create'?{area_id:f.area,title:'New'}:kind==='reply.create'?{discussion_id:discussion,parent_id:opening.resource_id}:{resource_id:opening.resource_id,expected_revision_id:opening.revision_id,title:'Parent'}),content:plain('Retained attempt'),attachment_set:set([member])};
  const route=kind==='discussion.create'?'/api/v1/discussions':kind==='reply.create'?'/api/v1/replies':'/api/v1/revisions';
  const before=await snapshot(f);
  const refused=await f.admin.call(route,input);assert.equal(refused.status,409,JSON.stringify(refused.body));assert.equal(refused.body.error.operation_outcome,'rejected');
  const {attachment_set:_,...legacy}=input;
  for(const restart of [false,true]){
    if(restart)await f.restart();
    assert.equal((await f.admin.call(route,input)).body.error.operation_outcome,'rejected');
    assert.equal((await f.admin.call(route,legacy)).body.error.code,'idempotency_conflict');
    assert.equal((await f.admin.call(route,{...input,attachment_set:set([])})).body.error.code,'idempotency_conflict');
    assert.equal((await f.admin.call('/api/v1/operations/status',{operation_kind:kind,idempotency_key:input.idempotency_key})).body.error.operation_outcome,'rejected');
    assert.deepEqual(await snapshot(f),before);
  }
  assert.equal((await f.admin.call(route,{...legacy,idempotency_key:randomUUID()})).status,201);
});

test('source contributor, revision publisher and uploader attribution survive suspension and exact historical visibility',async t=>{
  const f=await fixture(t,{files:true}),alice=await f.participant('history_alice'),bob=await f.participant('history_bob');
  const member=await prepare(alice.client,{kind:'opening',resource_id:f.area},'original.txt');
  const first=(await alice.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Attribution',content:plain('Original'),attachment_set:set([member])})).body;
  const one=(await bob.client.call(`/api/v1/contributions/${first.resource_id}/revisions/${first.revision_id}/attachments`)).body,original=one.items[0];
  const replacement=await prepare(f.admin,{kind:'contribution',resource_id:first.resource_id},'admin.txt',Buffer.from('Administrator replacement'));
  const second=(await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:first.resource_id,expected_revision_id:first.revision_id,title:'Attribution',content:plain('Edited'),attachment_set:set([replacement])})).body;assert.ok(second.revision_id);
  const two=(await bob.client.call(`/api/v1/contributions/${first.resource_id}/revisions/${second.revision_id}/attachments`)).body;
  assert.equal(two.contributor_id,alice.id);assert.equal(two.revision_publisher_id,f.administratorId);
  assert.equal((await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:alice.id,state:'suspended',role:'participant'})).status,200);
  assert.equal((await bob.client.call(original.download_url)).body,'exact original attachment\n');
  const promote=async(revision:string,file:string)=>bob.client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:first.resource_id,revision_id:revision,file_id:file},area_id:f.other,title:'Attributed independently'});
  const p=await promote(second.revision_id,two.items[0].file_id);assert.equal(p.status,201);
  const provenance=(await bob.client.call(`/api/v1/artifacts/${p.body.resource_id}/revisions/${p.body.revision_id}/provenance`)).body;
  assert.deepEqual(provenance.source,{state:'available',discussion_id:one.discussion_id,contribution_id:first.resource_id,revision_id:second.revision_id,file_id:two.items[0].file_id,contributor_id:alice.id,revision_publisher_id:f.administratorId,uploader_id:f.administratorId});
  // Fixture-only exact-revision unavailability: no new moderation endpoint is introduced.
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[first.revision_id]));
  assert.equal((await promote(first.revision_id,original.file_id)).status,404);assert.equal((await bob.client.call(original.download_url)).status,404);
  assert.equal((await bob.client.call(two.items[0].download_url)).body,'Administrator replacement');
  const reply=(await f.admin.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:one.discussion_id,parent_id:first.resource_id,content:plain('Parent comment'),attachment_set:set([])})).body;
  const childFile=await prepare(bob.client,{kind:'reply',resource_id:reply.resource_id},'child.txt');
  const child=(await bob.client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:one.discussion_id,parent_id:reply.resource_id,content:plain('Child'),attachment_set:set([childFile])})).body;
  await suppress(f,reply.resource_id);await suppress(f,one.discussion_id);await suppress(f,reply.resource_id,false);
  assert.equal((await bob.client.call(`/api/v1/contributions/${child.resource_id}/revisions/${child.revision_id}/attachments`)).status,404);
  assert.equal((await f.admin.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'reply',resource_id:reply.resource_id},path:'denied',size:0,sha256:createHash('sha256').update('').digest('hex'),media_type:'text/plain'})).status,404);
  await suppress(f,one.discussion_id,false);
  assert.equal((await bob.client.call(`/api/v1/contributions/${child.resource_id}/revisions/${child.revision_id}/attachments`)).status,200);
  const childView=(await bob.client.call('/api/v1/resources/'+child.resource_id)).body;assert.equal(childView.parent_id,reply.resource_id);
});
