import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,plain} from '../helpers/references.js';
import {packageText,prepareText,drainFiles,suppressFileOwner,sourceSnapshot} from '../helpers/file-text.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';

test('file-only search, exact historical previews, independent promotion and current context authority',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),alice=await f.participant('text_alice'),bob=await f.participant('text_bob');
  const artifact=await packageText(f,alice.client);
  const attached=await prepareText(alice.client,{kind:'opening',resource_id:f.area},'opening.md',Buffer.from('quartzneedle opening payload'),'text/markdown');
  const opening=(await alice.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Opening',content:plain('Authored introduction'),attachment_set:{version:'contribution-attachments-v1',files:[attached]}})).body;
  const discussion=(await alice.client.call('/api/v1/resources/'+opening.resource_id)).body.discussion_id;
  const a=(await bob.client.call(`/api/v1/contributions/${opening.resource_id}/revisions/${opening.revision_id}/attachments`)).body.items[0];
  const promoted=(await bob.client.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:opening.resource_id,revision_id:opening.revision_id,file_id:a.file_id},area_id:f.other,title:'Independent copy'})).body;
  const p=(await bob.client.call(`/api/v1/artifacts/${promoted.resource_id}/revisions/${promoted.revision_id}/files`)).body.items[0];
  const pending=await bob.client.call(artifact.base+'/text');assert.equal(pending.status,200);assert.equal(pending.body.processing,'not_discovered');assert.equal(pending.body.worker,'unknown');assert.equal(pending.body.text,null);
  const worker=new FileTextWorker(f.database,f.fileFixture!.storage);await worker.discover();
  assert.equal((await bob.client.call(artifact.base+'/text/status')).body.processing,'queued');
  const claims=await worker.claim(1);assert.equal((await f.observer.query('SELECT state FROM loom.file_text_jobs WHERE file_id=$1',[claims[0]!.file_id])).rows[0].state,'running');
  await worker.process(claims[0]!);await drainFiles(f);
  const before=await sourceSnapshot(f);
  for(const client of [f.admin,bob.client]){
    const results=await client.call('/api/v1/search/files?q=quartzneedle');assert.equal(results.status,200,JSON.stringify(results.body));
    assert.deepEqual(new Set(results.body.items.map((r:any)=>r.file_id)),new Set([artifact.file.file_id,a.file_id,p.file_id]));
    const only=results.body.items.find((r:any)=>r.file_id===p.file_id);assert.equal(only.author.id,bob.id);assert.equal(only.publisher.id,bob.id);assert.equal(only.area_id,f.other);assert.equal(only.matching_field,'file_contents');
    for(const item of results.body.items){const preview=await client.call(item.preview_url);assert.equal(preview.status,200);assert.match(preview.body.text,/quartzneedle/);assert.equal(preview.body.file_id,item.file_id);assert.equal(preview.body.revision_id,item.revision_id);assert.equal((await client.call(item.download_url)).status,200);assert.equal(preview.headers['cache-control'],'no-store');assert.equal(preview.headers['x-content-type-options'],'nosniff');const context=await client.call(preview.body.context_url);assert.equal(context.status,200);assert.equal(context.body.revision_id,item.revision_id);}
    assert.equal((await client.call('/api/v1/search?q=quartzneedle')).body.items.length,0,'Authored search remains independent');
  }
  assert.deepEqual(await sourceSnapshot(f),before,'Processing and reads do not publish, mention, mark read or change private/delivery state');
  const page=(await bob.client.call('/api/v1/search/files?q=quartzneedle&limit=1')).body;assert.ok(page.next_cursor);
  const next=await bob.client.call('/api/v1/search/files?q=quartzneedle&limit=2&cursor='+encodeURIComponent(page.next_cursor));assert.equal(next.status,200);assert.equal(next.body.items.length,2);
  assert.equal((await alice.client.call('/api/v1/search/files?q=quartzneedle&cursor='+encodeURIComponent(page.next_cursor))).body.error.code,'search_changed');
  assert.equal((await bob.client.call('/api/v1/search?q=quartzneedle&cursor='+encodeURIComponent(page.next_cursor))).body.error.code,'search_changed');
  assert.equal((await bob.client.call('/api/v1/search/files?q=quartzneedle&author='+bob.id)).body.items.length,1);
  await f.move(promoted.resource_id,f.area);assert.equal((await bob.client.call('/api/v1/search/files?q=quartzneedle&cursor='+encodeURIComponent(page.next_cursor))).body.error.code,'search_changed');
  assert.equal((await bob.client.call('/api/v1/search/files?q=quartzneedle&topic='+f.other)).body.items.length,0);
  assert.equal((await bob.client.call('/api/v1/search/files?q=quartzneedle&topic='+f.area)).body.items.length,3);
  const newer=await alice.client.call('/api/v1/revisions',{...artifact.input,idempotency_key:randomUUID(),resource_id:artifact.resource_id,expected_revision_id:artifact.revision_id,area_id:undefined,content:{format:'loom-markdown-v3',text:'New current main text',mentions:[],references:[]},file_set:{version:'artifact-files-v1',files:[]}});assert.equal(newer.status,201,JSON.stringify(newer.body));
  assert.equal((await bob.client.call(artifact.base+'/text')).body.text,'quartzneedle file content');
  assert.ok(!(await bob.client.call('/api/v1/search/files?q=quartzneedle')).body.items.some((r:any)=>r.file_id===artifact.file.file_id));
  await suppressFileOwner(f,discussion);
  assert.equal((await bob.client.call(a.download_url.replace('/download','/text'))).status,404);
  const independent=(await bob.client.call('/api/v1/search/files?q=quartzneedle')).body.items;assert.deepEqual(independent.map((r:any)=>r.file_id),[p.file_id]);
  assert.equal((await bob.client.call(p.download_url.replace('/download','/text'))).body.text,'quartzneedle opening payload');
  assert.equal((await bob.client.call(p.download_url)).body,'quartzneedle opening payload');
  await suppressFileOwner(f,promoted.resource_id);assert.equal((await bob.client.call(p.download_url.replace('/download','/text/status'))).status,404);
  assert.equal((await bob.client.call('/api/v1/search/files?q=quartzneedle')).body.items.length,0);
  await suppressFileOwner(f,discussion,false);assert.equal((await bob.client.call(a.download_url.replace('/download','/text'))).status,200);
  await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[opening.revision_id]);assert.equal((await bob.client.call(a.download_url.replace('/download','/text'))).status,404);
  const wrong=await bob.client.call(artifact.base.replace(artifact.file.file_id,a.file_id)+'/text');assert.equal(wrong.status,404);
  await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:bob.id,state:'suspended',role:'participant'});
  assert.equal((await bob.client.call('/api/v1/search/files?q=quartzneedle')).status,401);
});

test('supported, unsupported, empty, hostile and partial native files retain bytes and bounded qualified previews',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true});
  const inputs=[
    {path:'valid.md',media:'text/markdown',bytes:Buffer.from('\ufeff雪\r\n<script src="https://invalid.test/x"></script> @synthetic_admin $(touch /tmp/no)')},
    {path:'empty.txt',media:'text/plain',bytes:Buffer.alloc(0)},
    {path:'bad.txt',media:'text/plain',bytes:Buffer.from([0xc0,0xaf])},
    {path:'nul.txt',media:'text/plain',bytes:Buffer.from('a\0b')},
    {path:'opaque.zip',media:'application/octet-stream',bytes:Buffer.from('PK zip')},
    {path:'active.html',media:'text/html',bytes:Buffer.from('<img src="https://invalid.test">')},
    {path:'conflict.txt',media:'text/html',bytes:Buffer.from('still original')},
    {path:'partial.ts',media:'text/plain',bytes:Buffer.from('prefixneedle '+'x'.repeat(65521)+'🙂 suffixneedle')},
    {path:'escaped.json',media:'application/json',bytes:Buffer.from(('\t"\\\r\n雪🙂').repeat(4000))},
  ];
  const files=[];for(const input of inputs)files.push(await prepareText(f.admin,{kind:'area',resource_id:f.area},input.path,input.bytes,input.media));
  const published=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Input matrix',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files}});assert.equal(published.status,201);
  await drainFiles(f);
  const list=(await f.admin.call(`/api/v1/artifacts/${published.body.resource_id}/revisions/${published.body.revision_id}/files`)).body.items;
  for(const input of inputs){
    const item=list.find((v:any)=>v.path===input.path),url=item.download_url.replace('/download','/text');
    const response=await f.admin.call(url);assert.equal(response.status,200,JSON.stringify(response.body));assert.ok(response.bytes<=32768);
    if(['bad.txt','nul.txt','opaque.zip','active.html','conflict.txt'].includes(input.path)){assert.equal(response.body.processing,'unsupported');assert.equal(response.body.text,null);assert.equal(response.body.indexing,'not_supported');}
    else {
      let page=response.body,text=page.text;while(page.next_cursor){const r=await f.admin.call(url+'?max_response_bytes=4096&cursor='+encodeURIComponent(page.next_cursor));assert.equal(r.status,200);assert.ok(r.bytes<=4096);page=r.body;text+=page.text;}
      const retained=(await f.observer.query('SELECT body FROM loom.file_text_documents WHERE file_id=$1',[item.file_id])).rows[0].body;assert.equal(text,retained);assert.ok(Buffer.byteLength(text)<=65536);
      if(input.path==='partial.ts'){assert.equal(page.processing,'partial');assert.equal(page.source_complete,false);assert.ok(!text.includes('suffixneedle'));}
      else if(input.path==='valid.md'||input.path==='empty.txt')assert.equal(text,input.bytes.toString());
    }
    const identity=(await f.observer.query('SELECT u.* FROM loom.file_contexts f JOIN loom.file_uploads u ON u.id=f.upload_id WHERE f.id=$1',[item.file_id])).rows[0];
    assert.deepEqual(await f.fileFixture!.storage.read(identity.id,true,identity.final_version,identity,AbortSignal.timeout(15000)),input.bytes);
    assert.equal((await f.admin.call(item.download_url)).status,200);
  }
  assert.equal((await f.admin.call('/api/v1/search/files?q=suffixneedle')).body.items.length,0);
  assert.equal((await f.admin.call('/api/v1/search/files?q=prefixneedle')).body.items[0].extraction,'partial');
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.revision_mentions WHERE revision_id=$1',[published.body.revision_id])).rows[0].n,0);
  const escaped=list.find((r:any)=>r.path==='escaped.json'),url=escaped.download_url.replace('/download','/text');
  assert.equal((await f.admin.call(url+'?max_response_bytes=65536')).status,400);
  assert.equal((await f.admin.call(url+'?cursor=bad')).body.error.code,'search_changed');
  const first=(await f.admin.call(url)).body;assert.ok(first.next_cursor);await f.restart();assert.equal((await f.admin.call(url+'?cursor='+encodeURIComponent(first.next_cursor))).body.error.code,'search_changed');
});
