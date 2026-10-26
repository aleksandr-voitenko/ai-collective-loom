import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import SwaggerParser from '@apidevtools/swagger-parser';
import { syntheticServer } from '../helpers/participation-server.js';
import { httpClient } from '../helpers/participation-http.js';
import { NativeSearchWorker } from '../../scripts/lib/native-search-worker.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';

const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
test('current scoped lexical search through HTTPS and native worker recovery',{timeout:240000},async t=>{
  const server=await syntheticServer({workloadRates:true});const worker=new NativeSearchWorker(server.configuration);
  t.after(async()=>{await worker.stop();await server.close();});
  const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert);await admin.enroll(server.ticket);
  async function account(nickname:string,kind:'human'|'agent'){
    const created=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname,kind,role:'participant'});assert.equal(created.status,200);
    const issued=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:created.body.participant_id,kind:kind==='agent'?'agent':'enrollment',purpose:kind==='agent'?null:'enroll',label:'Search trial',replace_credential_id:null});assert.equal(issued.status,200);
    const client=httpClient(server.origin,cert,kind==='agent'?issued.body.secret:undefined);if(kind==='human')await client.enroll(issued.body.secret);
    return {client,id:created.body.participant_id as string,credential:issued.body.credential_id as string};
  }
  const human=await account('search_human','human'),agent=await account('search_agent','agent');
  assert.equal((await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Search trial',ordinary_area_name:'General',proposal_area_name:'Feedback',overview:content('Synthetic overview')})).status,201);
  const areas=(await admin.call('/api/v1/areas')).body.items,general=areas.find((a:any)=>a.title==='General').id,feedback=areas.find((a:any)=>a.title==='Feedback').id;
  const version=async()=> (await admin.call('/api/v1/organization/children?limit=1')).body.hierarchy_version;
  const created=await admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.create',title:'Nested',description:'Nested sources',parent_id:general,expected_hierarchy_version:await version()});assert.equal(created.status,200);const nested=created.body.current.resource_id;
  const publish=async(kind:string,fields:Record<string,unknown>,client=human.client)=>{const response=await client.call('/api/v1/'+kind,{idempotency_key:randomUUID(),...fields});assert.equal(response.status,201,JSON.stringify(response.body));return response.body;};
  const opening=await publish('discussions',{area_id:nested,title:'Zephyr common discussion',content:content('Zephyr opening with Alice O’Connor and running runners.')});
  const discussion=(await human.client.call('/api/v1/resources/'+opening.resource_id)).body.discussion_id;
  const comment=await publish('replies',{discussion_id:discussion,parent_id:opening.resource_id,content:content('Zephyr common comment with naïve café Привет мир 東京 foo_bar foo.bar C++ C#.')},agent.client);
  const reply=await publish('replies',{discussion_id:discussion,parent_id:comment.resource_id,content:content('Zephyr common independent quotation of its parent.')});
  const artifact=await publish('artifacts',{area_id:feedback,title:'Zephyr common artifact',content:content('Zephyr manuscript exact revision. <script>alert(1)</script> ' + '界'.repeat(600))});
  const q=(text:string,extra:Record<string,string>={})=>'/api/v1/search?'+new URLSearchParams({q:text,...extra});
  const search=async(text='zephyr',extra:Record<string,string>={},client=human.client)=>{const r=await client.call(q(text,extra));assert.equal(r.status,200,JSON.stringify(r.body));return r;};
  const ids=(r:any)=>r.body.items.map((i:any)=>i.source_resource_id).sort();
  const ready=()=>worker.observeUntil(async()=> (await human.client.call('/api/v1/search/status')).body.indexing==='ready');
  const move=async(id:string,kind:string,parent_id:string)=>{const source=(await admin.call('/api/v1/organization/resources/'+id)).body;
    const result=await admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind,resource_id:id,parent_id,expected_version:source.version,expected_hierarchy_version:source.hierarchy_version});assert.equal(result.status,200);};
  await t.test('stopped worker preserves committed publication intents and honest unavailable status',async()=>{
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.search_documents')).rows[0].n,0);
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.outbox_intents')).rows[0].n,6);
    const result=await search();assert.deepEqual(result.body.items,[]);assert.equal(result.body.indexing.indexing,'unavailable');assert.equal(result.body.indexing.coverage,'not_established');
    assert.equal((await human.client.call('/api/v1/resources/'+artifact.resource_id+'/revisions/'+artifact.revision_id)).body.content.text.includes('exact revision'),true);
    await worker.start();await ready();await worker.stop('SIGKILL');await worker.start();await ready();
    assert.equal((await server.observer.query("SELECT count(*)::int AS n FROM loom.search_documents")).rows[0].n,5);
    assert.equal((await server.observer.query("SELECT count(*)::int AS n FROM loom.search_jobs WHERE kind='organization' AND outcome='not_applicable'")).rows[0].n,1);
    await worker.stop();
  });
  await t.test('human and agent parity, discussion identity, original author and revision time filters',async()=>{
    const one=await search(),two=await search('zephyr',{},agent.client);assert.deepEqual(one.body.items,two.body.items);
    assert.equal(one.body.items.length,4);assert.equal(one.body.items.filter((i:any)=>i.result_id===discussion).length,1);
    assert.deepEqual(ids(await search('zephyr',{topic:general})),[]);
    assert.deepEqual(ids(await search('zephyr',{topic:general,descendants:'true'})),[opening.resource_id,comment.resource_id,reply.resource_id].sort());
    assert.deepEqual(ids(await search('zephyr',{kind:'artifact'})),[artifact.resource_id]);
    assert.deepEqual(ids(await search('zephyr',{author:agent.id})),[comment.resource_id]);
    const row=one.body.items.find((i:any)=>i.source_resource_id===artifact.resource_id);
    assert.deepEqual(ids(await search('zephyr',{kind:'artifact',from:row.published_at})),[artifact.resource_id]);
    assert.deepEqual(ids(await search('zephyr',{kind:'artifact',before:row.published_at})),[]);
    assert.equal(row.revision_id,artifact.revision_id);assert.equal(row.excerpt.representation,'excerpt');assert.ok(row.excerpt.text.includes('exact revision'));
    assert.equal((await human.client.call(row.full_content_url)).body.revision_id,row.revision_id);
    assert.equal(row.browser_url,`/loom/resource/${artifact.resource_id}/${artifact.revision_id}`);
    await SwaggerParser.validate((await admin.call('/api/v1/openapi.json')).body);
  });
  await t.test('actual simple parser behavior and strict bounded query shapes',async()=>{
    for(const term of ['running','Alice','café','Привет','東京','foo_bar','foo.bar','C++'])assert.ok((await search(term)).body.items.length,term);
    for(const term of ['run','runn','caf','京'])assert.equal((await search(term)).body.items.length,0,term);
    for(const term of ['', '   ','---','"phrase"','a | b','foo:*','x'.repeat(257),'界'.repeat(86),'a b c d e f g h i j k l m n o p q'])assert.equal((await human.client.call(q(term))).status,400,term);
    for(const extra of [{unknown:'x'},{kind:'file'},{historical:'true'},{descendants:'true'},{descendants:'false'},{from:'2026-02-30T00:00:00Z'},{from:'2026-10-10T00:00:00Z',before:'2026-10-01T00:00:00Z'},{limit:'26'},{max_response_bytes:'4095'}])assert.equal((await human.client.call(q('zephyr',extra))).status,400);
  });
  await t.test('current R2 without index never returns R1; original author differs from revision publisher',async()=>{
    const cursor=(await search('zephyr',{limit:'1'})).body.next_cursor;
    const next=await publish('revisions',{resource_id:artifact.resource_id,expected_revision_id:artifact.revision_id,title:'Zephyr revised artifact',content:content('Zephyr replacement by administrator')},admin);
    assert.deepEqual(ids(await search('zephyr',{kind:'artifact'})),[]);assert.equal((await search()).body.indexing.coverage,'not_established');
    assert.equal((await human.client.call(q('zephyr',{limit:'1',cursor}))).status,409);
    await worker.start();await ready();await worker.stop();
    const row=(await search('zephyr',{kind:'artifact',author:human.id})).body.items[0];assert.equal(row.revision_id,next.revision_id);assert.equal(row.author.id,human.id);assert.equal(row.publisher.id,server.administratorId);
    assert.deepEqual(ids(await search('zephyr',{kind:'artifact',author:server.administratorId})),[]);
    artifact.revision_id=next.revision_id;
  });
  await t.test('synchronous containment, revision suppression, restoration and independent quotations',async()=>{
    const cursor=(await search('zephyr',{limit:'1'})).body.next_cursor;
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[comment.resource_id]));
    assert.deepEqual(ids(await search()),[opening.resource_id,reply.resource_id,artifact.resource_id].sort());
    assert.equal((await human.client.call(q('zephyr',{limit:'1',cursor}))).status,409);
    assert.ok((await search('independent')).body.items[0].excerpt.text.includes('independent quotation'));
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[discussion]));
    assert.deepEqual(ids(await search()),[artifact.resource_id]);
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[discussion]));
    assert.deepEqual(ids(await search()),[opening.resource_id,reply.resource_id,artifact.resource_id].sort());
    await server.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[artifact.revision_id]));
    assert.deepEqual(ids(await search()),[opening.resource_id,reply.resource_id].sort());
    await server.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[comment.resource_id]));
    await server.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='available' WHERE id=$1",[artifact.revision_id]));
    assert.equal((await search()).body.items.length,4);
    await admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:agent.id,state:'suspended',role:'participant'});
    assert.deepEqual(ids(await search('zephyr',{author:agent.id})),[comment.resource_id]);assert.equal((await agent.client.call(q('zephyr'))).status,401);
    await admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:agent.id,state:'active',role:'participant'});
  });
  await t.test('moves update fresh scope without reindexing and preserve historical events and Saved references',async()=>{
    const target={kind:'revision',resource_id:artifact.resource_id,revision_id:artifact.revision_id};
    assert.equal((await human.client.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target,saved:true,expected_version:0})).status,200);
    const before=(await server.observer.query("SELECT * FROM loom.shared_activity WHERE kind='revision.published' ORDER BY id")).rows;
    const saved=(await server.observer.query('SELECT * FROM loom.saved_items')).rows;
    const cursor=(await search('zephyr',{limit:'1'})).body.next_cursor;
    await move(discussion,'discussion.move',general);await move(artifact.resource_id,'artifact.move',nested);await move(nested,'area.move',feedback);
    assert.deepEqual(ids(await search('zephyr',{topic:general,descendants:'true'})),[opening.resource_id,comment.resource_id,reply.resource_id].sort());
    assert.deepEqual(ids(await search('zephyr',{topic:feedback,descendants:'true'})),[artifact.resource_id]);
    assert.equal((await human.client.call(q('zephyr',{limit:'1',cursor}))).status,409);
    assert.deepEqual((await server.observer.query("SELECT * FROM loom.shared_activity WHERE kind='revision.published' ORDER BY id")).rows,before);
    assert.deepEqual((await server.observer.query('SELECT * FROM loom.saved_items')).rows,saved);
    const source=(await admin.call('/api/v1/organization/resources/'+general)).body;
    assert.equal((await admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.close',resource_id:general,expected_version:source.version,expected_hierarchy_version:source.hierarchy_version})).status,200);
    assert.deepEqual(ids(await search('zephyr',{topic:general})),[opening.resource_id,comment.resource_id,reply.resource_id].sort());
  });
  await t.test('bounded selected window, Unicode response bytes, private filters and owner-bound continuation',async()=>{
    for(let i=0;i<210;i++)await publish('artifacts',{area_id:feedback,title:'Common sample '+String(i).padStart(3,'0'),content:content('common corpus '+ '界'.repeat(400))});
    await worker.start();await ready();await worker.stop();
    const first=await search('common',{limit:'25',max_response_bytes:'4096'});assert.ok(first.bytes<=4096);assert.ok(first.body.items.length>0&&first.body.items.length<25);assert.equal(first.body.selection_limited,true);
    assert.equal((await agent.client.call(q('common',{cursor:first.body.next_cursor}))).status,409);
    assert.equal((await human.client.call(q('zephyr',{cursor:first.body.next_cursor}))).status,409);
    const found=new Set<string>();let page=first;
    while(true){for(const row of page.body.items){assert.ok(!found.has(row.result_id));found.add(row.result_id);}if(!page.body.next_cursor)break;page=await search('common',{cursor:page.body.next_cursor,limit:'25'});}
    assert.equal(found.size,200);assert.equal(page.body.window_exhausted,true);assert.equal(page.body.corpus_exhaustive,false);
    assert.equal((await human.client.call('/api/v1/admin/search/health')).status,403);assert.equal((await human.client.call('/api/v1/admin/search/failures')).status,403);
    assert.equal((await human.client.call('/api/v1/admin/search/rebuild',{expected_generation:1})).status,403);
    assert.deepEqual(Object.keys((await human.client.call('/api/v1/search/status')).body).sort(),['coverage','direct_retrieval','indexing']);
    const before=(await server.observer.query('SELECT * FROM loom.saved_items')).rows;
    const observations:{query:string;p50_ms:number;p95_ms:number}[]=[];
    for(const [label,filters] of [['common',{}],['common filtered',{topic:feedback,kind:'artifact'}]] as const){const times:number[]=[];for(let i=0;i<10;i++){const start=performance.now();await search('common',filters);times.push(performance.now()-start);}times.sort((a,b)=>a-b);observations.push({query:label,p50_ms:Math.round(times[5]!),p95_ms:Math.round(times[9]!)});}
    console.log(JSON.stringify({synthetic_search_measurement:{sources:215,samples_per_query:10,transport:'same-machine HTTPS',observations}}));
    assert.deepEqual((await server.observer.query('SELECT * FROM loom.saved_items')).rows,before);
  });
  await t.test('rebuild while publications continue and interrupted scan resumes from retained sources',async()=>{
    const before=(await server.observer.query('SELECT * FROM loom.revisions ORDER BY id')).rows;
    const saved=(await server.observer.query('SELECT * FROM loom.saved_items ORDER BY id')).rows;
    const events=(await server.observer.query('SELECT * FROM loom.shared_activity ORDER BY id')).rows;
    const intents=(await server.observer.query('SELECT * FROM loom.outbox_intents ORDER BY id')).rows;
    const generation=(await admin.call('/api/v1/admin/search/health')).body.generation;
    const req={expected_generation:generation};
    const results=await Promise.all([admin.call('/api/v1/admin/search/rebuild',req),admin.call('/api/v1/admin/search/rebuild',req)]);assert.ok(results.every(r=>r.status===200&&r.body.generation===generation+1));
    assert.equal((await search('zephyr')).body.indexing.coverage,'not_established');
    const internal=new SearchWorker(server.database);await internal.discover();await internal.discover();
    const progress=(await server.observer.query('SELECT source_after,scan_complete FROM loom.search_state')).rows[0];
    assert.equal(progress.scan_complete,false);
    // Choose a source already passed by the UUID scan deterministically. Its
    // new revision must arrive through event discovery, not a lucky scan order.
    const earlier=(await server.observer.query("SELECT id,current_revision_id FROM loom.resources WHERE kind='artifact' AND owner_resource_id=$1 AND id<=$2 ORDER BY id LIMIT 1",[feedback,progress.source_after])).rows[0];
    assert.ok(earlier);
    const edited=await publish('revisions',{resource_id:earlier.id,expected_revision_id:earlier.current_revision_id,title:'Revised during rebuild',content:content('quasar behind the scan cursor')},admin);
    const next=await publish('artifacts',{area_id:feedback,title:'Concurrent nebula',content:content('Nebula while scanning')});
    await worker.start();await ready();await worker.stop('SIGKILL');await worker.start();await ready();await worker.stop();
    assert.deepEqual(ids(await search('nebula')),[next.resource_id]);
    assert.deepEqual(ids(await search('quasar')),[earlier.id]);
    assert.deepEqual((await server.observer.query('SELECT * FROM loom.revisions WHERE id<>ALL($1::uuid[]) ORDER BY id',[[next.revision_id,edited.revision_id]])).rows,before);
    assert.deepEqual((await server.observer.query('SELECT * FROM loom.saved_items ORDER BY id')).rows,saved);
    assert.deepEqual((await server.observer.query('SELECT * FROM loom.shared_activity WHERE revision_id IS NULL OR revision_id<>ALL($1::uuid[]) ORDER BY id',[[next.revision_id,edited.revision_id]])).rows,events);
    assert.deepEqual((await server.observer.query('SELECT * FROM loom.outbox_intents WHERE source_event_id=ANY($1::uuid[]) ORDER BY id',[intents.map(row=>row.source_event_id)])).rows,intents);
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.search_documents')).rows[0].n,216);
    assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs WHERE generation=$1 AND state<>\'succeeded\'',[generation+1])).rows[0].n,0);
  });
  await t.test('revoked bearer credentials cannot reuse search selections or indexing status',async()=>{
    const cursor=(await search('common',{limit:'1'},agent.client)).body.next_cursor;
    assert.ok(cursor);
    assert.equal((await admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:agent.id,credential_id:agent.credential})).status,200);
    assert.equal((await agent.client.call(q('common',{cursor}))).status,401);
    assert.equal((await agent.client.call('/api/v1/search/status')).status,401);
    assert.deepEqual(ids(await search('zephyr',{author:agent.id})),[comment.resource_id]);
  });
});
