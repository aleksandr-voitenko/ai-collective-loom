import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from '../helpers/references.js';
import {prepareText,drainFiles,packageText} from '../helpers/file-text.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';

test('Files relevance windows, exact byte budgets, filter semantics, current replacement and cursor expiry stay bounded',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),member=await prepareText(f.admin,{kind:'area',resource_id:f.area},'shared.txt',Buffer.from('windowneedle lexical payload'));
  const published=[];
  for(let n=0;n<13;n++){
    const result=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Package '+n,content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:Array.from({length:16},(_,i)=>({...member,path:'entry-'+i+'.txt'}))}});assert.equal(result.status,201);published.push(result.body);
  }
  await drainFiles(f);
  let cursor='',count=0;const ids=new Set<string>();
  do{
    const response=await f.admin.call('/api/v1/search/files?'+new URLSearchParams({q:'windowneedle',limit:'25',max_response_bytes:'4096',...(cursor?{cursor}:{})}));assert.equal(response.status,200,JSON.stringify(response.body));assert.ok(response.bytes<=4096);assert.ok(response.body.items.length>0);assert.ok(response.body.items.length<=25);assert.equal(response.body.selection_limited,true);
    for(const row of response.body.items){assert.ok(!ids.has(row.file_id));ids.add(row.file_id);}count+=response.body.items.length;assert.ok(count<=200);cursor=response.body.next_cursor;
  }while(cursor);
  assert.equal(count,200);
  for(const filter of ['kind=comment','kind=summary','topic='+f.other,'from=2099-01-01T00:00:00Z','before=2000-01-01T00:00:00Z'])assert.equal((await f.admin.call('/api/v1/search/files?q=windowneedle&'+filter)).body.items.length,0);
  assert.equal((await f.admin.call('/api/v1/search/files?q=windowneedle&topic='+f.area+'&descendants=true')).body.items.length,12);
  for(const query of ['q=%26operator','q='+('long '.repeat(60)),'q=word&descendants=true','q=word&limit=0','q=word&explanation=revision_note'])assert.equal((await f.admin.call('/api/v1/search/files?'+query)).status,400);
  const first=(await f.admin.call('/api/v1/search/files?q=windowneedle&limit=1')).body;
  const now=Date.now();const clock=t.mock.method(Date,'now',()=>now+301000);assert.equal((await f.admin.call('/api/v1/search/files?q=windowneedle&cursor='+encodeURIComponent(first.next_cursor))).body.error.code,'search_changed');clock.mock.restore();
  const old=published[0]!,newMember=await prepareText(f.admin,{kind:'artifact',resource_id:old.resource_id},'replacement.txt',Buffer.from('replacementneedle'));
  const revised=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:old.resource_id,expected_revision_id:old.revision_id,title:'Replacement',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[newMember]}});assert.equal(revised.status,201);
  const current=(await f.admin.call('/api/v1/search/files?q=windowneedle&author='+f.administratorId)).body.items;assert.ok(!current.some((r:any)=>r.source_resource_id===old.resource_id));
  assert.equal((await f.admin.call('/api/v1/search/files?q=replacementneedle')).body.items.length,0,'Unprocessed R2 cannot borrow R1 output');
  assert.equal((await f.admin.call('/api/v1/search/files/status')).body.coverage,'incomplete');await drainFiles(f);assert.equal((await f.admin.call('/api/v1/search/files?q=replacementneedle')).body.items[0].revision_id,revised.body.revision_id);
});

test('derived job capacity reports an eligible missing context honestly without changing originals',{timeout:120000},async t=>{
  const f=await fixture(t,{files:true}),p=await packageText(f),original=(await f.observer.query('SELECT * FROM loom.file_contexts WHERE id=$1',[p.file.file_id])).rows[0];
  // Fixture-only older over-cap population: the new publication protocol still
  // refuses this many contexts. No production guard is bypassed or relaxed.
  await f.observer.query(`INSERT INTO loom.file_contexts(id,artifact_id,revision_id,path,upload_id)
    SELECT gen_random_uuid(),$1,$2,'older-'||n||'.txt',$3 FROM generate_series(1,65536) n`,[original.artifact_id,original.revision_id,original.upload_id]);
  await f.observer.query('INSERT INTO loom.file_text_jobs(file_id,generation) SELECT id,1 FROM loom.file_contexts WHERE id<>$1',[original.id]);
  const worker=new FileTextWorker(f.database,f.fileFixture!.storage);assert.equal(await worker.discover(),0);
  const response=await f.admin.call(p.base+'/text/status');assert.equal(response.status,200);assert.equal(response.body.processing,'not_discovered');assert.equal(response.body.reason,'job_capacity');assert.equal(response.body.text,null);
  assert.equal((await f.admin.call('/api/v1/search/files/status')).body.coverage,'incomplete');
  assert.equal((await f.admin.call(p.file.download_url)).body,'quartzneedle file content');
  await f.observer.query("UPDATE loom.file_text_jobs SET state='failed',reason='lease_expired' WHERE file_id IN (SELECT file_id FROM loom.file_text_jobs ORDER BY file_id LIMIT 26)");
  const page=(await f.admin.call('/api/v1/admin/file-text/health')).body;assert.equal(page.items.length,25);assert.ok(page.next_after);
  const next=await f.admin.call('/api/v1/admin/file-text/health?after='+page.next_after);assert.equal(next.status,200);assert.equal(next.body.items.length,1);assert.equal(next.body.next_after,null);
  // A missing lowest-ID context must not starve already retained jobs when a
  // rebuild meets the same finite capacity. This is older fixture data only.
  await f.observer.query(`INSERT INTO loom.file_contexts(id,artifact_id,revision_id,path,upload_id)
    VALUES('00000000-0000-0000-0000-000000000000',$1,$2,'blocked-capacity.txt',$3)`,[original.artifact_id,original.revision_id,original.upload_id]);
  assert.equal((await f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:1})).status,200);
  assert.equal(await worker.discover(),25,'Existing stale jobs progress past a missing context at capacity');
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_jobs WHERE generation=2')).rows[0].n,25);
  assert.equal((await f.admin.call(p.base+'/text/status')).body.reason,'job_capacity');
  const claim=(await worker.claim(1))[0]!;assert.ok(claim);assert.equal(claim.generation,2);assert.equal(await worker.process(claim),true);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_documents WHERE generation=2')).rows[0].n,1);
  assert.equal((await f.admin.call('/api/v1/admin/file-text/health')).body.reserved_bytes,0);
  assert.equal(await worker.discover(),25,'The next bounded batch advances beyond recovered jobs');
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_jobs WHERE generation=2')).rows[0].n,50);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_text_jobs')).rows[0].n,65536);
  assert.equal((await f.admin.call(p.file.download_url)).body,'quartzneedle file content');
});
