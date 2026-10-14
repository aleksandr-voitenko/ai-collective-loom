import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { QueryResultRow } from 'pg';
import SwaggerParser from '@apidevtools/swagger-parser';
import { syntheticServer } from '../helpers/participation-server.js';
import { httpClient } from '../helpers/participation-http.js';
import { createApplication } from '../../src/server/http/app.js';
import type { SavedTargetView } from '../../src/contracts/saved-items.js';

const text=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
const path='/api/v1/me/saved-items';
test('private Saved items over real HTTPS and isolated PostgreSQL', {timeout:180000}, async t=>{
  let loseKey='', rollback=false;
  const server=await syntheticServer({transactionWrapper:database=>({transaction:async work=>{
    let key='';
    const result=await database.transaction(tx=>work({query:async <Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);
      if(sql.startsWith('INSERT INTO loom.saved_operations')) {key=String(values[2]);if(rollback) throw new Error('injected rollback');}
      return result;
    }}));
    if(key && key===loseKey){loseKey='';throw new Error('lost acknowledgement after COMMIT');}
    return result;
  }})});
  t.after(server.close);
  const cert=await readFile(server.directory+'/cert.pem','utf8'), admin=httpClient(server.origin,cert);
  await admin.enroll(server.ticket);
  async function account(nickname:string,kind:'human'|'agent') {
    const created=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname,kind,role:'participant'});
    assert.equal(created.status,200);
    const id=created.body.participant_id;
    const issued=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:id,
      kind:kind==='agent'?'agent':'enrollment',purpose:kind==='agent'?null:'enroll',label:'Saved test',replace_credential_id:null});
    assert.equal(issued.status,200);
    const client=httpClient(server.origin,cert,kind==='agent'?issued.body.secret:undefined);
    if(kind==='human') await client.enroll(issued.body.secret);
    return {id,client,secret:issued.body.secret as string,credential:issued.body.credential_id as string};
  }
  const human=await account('saved_human','human'), agent=await account('saved_agent','agent');
  const setup=await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Saved trial',
    ordinary_area_name:'Research',proposal_area_name:'Organization',overview:text('Synthetic overview')});
  assert.equal(setup.status,201);
  const area=(await admin.call('/api/v1/areas')).body.items.find((r:{title:string})=>r.title==='Research').id;
  const publication=await human.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:area,title:'Saved source',content:text('Opening')});
  const opening=publication.body.resource_id as string, r1=publication.body.revision_id as string;
  const discussion=(await human.client.call('/api/v1/resources/'+opening)).body.discussion_id as string;
  const artifact=await human.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Protected artifact title',content:text('Private bookmark does not copy this body')});
  const target:SavedTargetView={kind:'contribution',resource_id:opening};
  const command=(target:SavedTargetView,saved:boolean,expected_version:number)=>({idempotency_key:randomUUID(),target,saved,expected_version});
  const lookup=async(client:typeof admin,target:SavedTargetView)=>{
    const response=await client.call(path+'/lookup',target);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;
  };
  const set=async(client:typeof admin,input:ReturnType<typeof command>)=>{
    const response=await client.call(path+'/state',input);assert.equal(response.status,200,JSON.stringify(response.body));return response.body;
  };
  async function sharedState(){return (await server.observer.query(`SELECT
    (SELECT shared_position::text FROM loom.community_clocks WHERE id=1) AS position,
    (SELECT count(*)::integer FROM loom.revisions) AS revisions,
    (SELECT count(*)::integer FROM loom.shared_activity) AS activity,
    (SELECT count(*)::integer FROM loom.outbox_intents) AS outbox,
    (SELECT count(*)::integer FROM loom.idempotency_records) AS publication_outcomes,
    (SELECT count(*)::integer FROM loom.administrative_audit) AS identity_audit`)).rows;}

  await t.test('strict owner-only contracts and human/agent parity, with no shared side effects',async()=>{
    const before=await sharedState();
    for(const client of [human.client,agent.client]){
      assert.equal((await lookup(client,target)).version,0);
      const first=await set(client,command(target,true,0));
      assert.equal(first.operation_state,'applied');assert.equal(first.current.saved,true);assert.equal(first.current.version,1);
      const list=await client.call(path);assert.equal(list.body.items.length,1);assert.equal(list.body.scope,'own_saved_items');
      const off=await set(client,command(target,false,1));assert.equal(off.current.saved,false);
      assert.equal((await client.call(path)).body.items.length,0);
    }
    assert.deepEqual(await sharedState(),before);
    assert.equal((await admin.call(path)).body.items.length,0);
    for(const client of [agent.client,admin]){
      assert.equal((await client.call(path+'?owner_id='+human.id)).status,400);
      assert.equal((await client.call(path+'/state',{...command(target,true,0),participant_id:human.id})).status,400);
    }
    const second=httpClient(server.origin,cert,agent.secret);
    await set(agent.client,command(target,true,2));
    assert.deepEqual((await second.call(path)).body,(await agent.client.call(path)).body);
    assert.equal((await admin.call(path)).body.items.length,0);
    assert.equal((await human.client.call(path)).body.items.length,0);
    assert.equal((await agent.client.call(path+'/lookup',{kind:'area',resource_id:area})).status,400);
    assert.equal((await agent.client.call(path+'/state',{...command(target,true,3),saved:'true'})).status,400);
    assert.equal((await agent.client.call(path+'?limit=26')).status,400);
    await SwaggerParser.validate((await admin.call('/api/v1/openapi.json')).body);
  });
  await t.test('same and distinct concurrent keys create one logical target; original replay never reapplies',async()=>{
    const wanted:SavedTargetView={kind:'discussion',resource_id:discussion}, k1=command(wanted,true,0);
    const outcomes=await Promise.all(Array.from({length:6},()=>set(agent.client,k1)));
    assert.equal(new Set(outcomes.map(o=>o.operation_id)).size,1);
    assert.equal(outcomes.filter(o=>o.idempotency==='created').length,1);
    const k2=command(wanted,false,1), off=await set(agent.client,k2);
    assert.equal(off.current.saved,false);
    const replay=await set(agent.client,k1);
    assert.equal(replay.outcome.saved,true);assert.equal(replay.outcome.result_version,1);
    assert.equal(replay.current.saved,false);assert.equal(replay.current.version,2);
    assert.equal((await agent.client.call(path+'/state',{...k1,saved:false})).status,409);
    const exact:SavedTargetView={kind:'revision',resource_id:opening,revision_id:r1};
    const distinct=await Promise.all(Array.from({length:5},()=>set(agent.client,command(exact,true,0))));
    assert.equal(distinct.filter(o=>o.operation_state==='applied').length,1);
    assert.equal(distinct.filter(o=>o.operation_state==='version_conflict').length,4);
    const persisted=await server.observer.query('SELECT count(*)::integer AS n FROM loom.saved_items WHERE participant_id=$1 AND resource_id=$2 AND target_kind=$3',[agent.id,opening,'revision']);
    assert.equal(persisted.rows[0].n,1);
  });
  await t.test('initial Unsave tombstone fences delayed Save; confirmed Save fences delayed Unsave',async()=>{
    const wanted:SavedTargetView={kind:'artifact',resource_id:artifact.body.resource_id};
    const delayedSave=command(wanted,true,0);
    assert.equal((await set(agent.client,command(wanted,false,0))).current.version,1);
    const rejected=await set(agent.client,delayedSave);
    assert.equal(rejected.operation_state,'version_conflict');assert.equal(rejected.current.saved,false);
    const delayedUnsave=command(wanted,false,1);
    assert.equal((await set(agent.client,command(wanted,true,1))).current.version,2);
    const converse=await set(agent.client,delayedUnsave);
    assert.equal(converse.operation_state,'version_conflict');assert.equal(converse.current.saved,true);
    const recovered=await agent.client.call(path+'/status',{idempotency_key:delayedSave.idempotency_key});
    assert.equal(recovered.body.operation_state,'version_conflict');assert.equal(recovered.body.outcome.result_version,1);
    assert.equal(recovered.body.current.version,2);assert.equal(recovered.body.current.saved,true);
    assert.equal((await admin.call(path+'/status',{idempotency_key:delayedSave.idempotency_key})).body.operation_state,'not_recorded');
  });
  await t.test('resource and exact R1 remain distinct after R2; SQL enforces membership and immutability',async()=>{
    const exact:SavedTargetView={kind:'revision',resource_id:artifact.body.resource_id,revision_id:artifact.body.revision_id};
    await set(agent.client,command(exact,true,0));
    const edited=await human.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:artifact.body.resource_id,
      expected_revision_id:artifact.body.revision_id,title:'Revised artifact title',content:text('R2')});
    assert.equal(edited.status,201);
    const resource=await lookup(agent.client,{kind:'artifact',resource_id:artifact.body.resource_id});
    assert.equal(resource.source.resource.revision_id,edited.body.revision_id);
    assert.equal(resource.source.observed_revision_id,artifact.body.revision_id);
    assert.equal((await lookup(agent.client,exact)).source.resource.revision_id,artifact.body.revision_id);
    await server.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[edited.body.revision_id]);
    assert.deepEqual((await lookup(agent.client,{kind:'artifact',resource_id:artifact.body.resource_id})).source,{state:'unavailable'});
    assert.equal((await lookup(agent.client,exact)).source.resource.revision_id,artifact.body.revision_id);
    await server.observer.query("UPDATE loom.revisions SET availability='available' WHERE id=$1",[edited.body.revision_id]);
    const wrong=command({kind:'revision',resource_id:artifact.body.resource_id,revision_id:r1},true,0);
    assert.equal((await agent.client.call(path+'/state',wrong)).status,404);
    await assert.rejects(server.database.transaction(tx=>tx.query(`INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id,revision_id)
      VALUES ($1,$2,'revision',$3,$3,$4)`,[randomUUID(),human.id,artifact.body.resource_id,r1])),/foreign key/);
    await assert.rejects(server.database.transaction(tx=>tx.query(`INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id)
      VALUES ($1,$2,'discussion',$3,$4)`,[randomUUID(),human.id,discussion,artifact.body.resource_id])),/invalid saved target/);
    await assert.rejects(server.database.transaction(tx=>tx.query(`INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id)
      VALUES ($1,$2,'contribution',$3,$3)`,[randomUUID(),human.id,opening])),/duplicate key/);
    await assert.rejects(server.database.transaction(tx=>tx.query(`INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id,revision_id)
      VALUES ($1,$2,'revision',$3,$3,$4)`,[randomUUID(),agent.id,artifact.body.resource_id,artifact.body.revision_id])),/duplicate key/);
    await assert.rejects(server.database.transaction(tx=>tx.query('UPDATE loom.saved_items SET participant_id=$1',[human.id])),/permission denied/);
    await assert.rejects(server.database.transaction(tx=>tx.query('DELETE FROM loom.saved_operations',[])),/permission denied/);
  });
  await t.test('suppression removes metadata, exact targets do not redirect, owner may unsave unavailable entries',async()=>{
    const before=await sharedState();
    const wanted:SavedTargetView={kind:'artifact',resource_id:artifact.body.resource_id};
    await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[artifact.body.resource_id]);
    const hidden=await agent.client.call(path);
    assert.doesNotMatch(JSON.stringify(hidden.body),/Protected artifact title|Revised artifact title|Private bookmark/);
    const selected=hidden.body.items.filter((r:{target:SavedTargetView})=>r.target.resource_id===artifact.body.resource_id);
    assert.equal(selected.length,2);
    for(const row of selected) assert.deepEqual(row.source,{state:'unavailable'});
    const retained=(await server.observer.query(`SELECT o.idempotency_key FROM loom.saved_operations o
      JOIN loom.saved_items b ON b.id=o.bookmark_id WHERE o.participant_id=$1 AND b.resource_id=$2 LIMIT 1`,[agent.id,artifact.body.resource_id])).rows[0];
    const recovered=await agent.client.call(path+'/status',{idempotency_key:retained.idempotency_key});
    assert.equal(recovered.status,200);assert.deepEqual(recovered.body.current.source,{state:'unavailable'});
    assert.doesNotMatch(JSON.stringify(recovered.body),/Protected artifact title|Revised artifact title/);
    assert.equal((await human.client.call(path+'/lookup',wanted)).status,404);
    const state=await lookup(agent.client,wanted);
    assert.equal((await set(agent.client,command(wanted,false,state.version))).current.saved,false);
    assert.equal((await agent.client.call(path+'/state',command(wanted,true,state.version+1))).status,404);
    await server.observer.query("UPDATE loom.resources SET state='removed' WHERE id=$1",[artifact.body.resource_id]);
    const exact=selected.find((r:{target:SavedTargetView})=>r.target.kind==='revision');
    assert.equal((await set(agent.client,command(exact.target,false,exact.version))).current.saved,false);
    assert.deepEqual(await sharedState(),before);
    await server.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1",[artifact.body.resource_id]);
  });
  await t.test('bounded pages, owner-bound cursors, source changes and collection changes are explicit',async()=>{
    for(let n=0;n<8;n++){
      const created=await human.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Paging '+n,content:text('bounded')});
      await set(agent.client,command({kind:'artifact',resource_id:created.body.resource_id},true,0));
    }
    const first=await agent.client.call(path+'?limit=2&max_response_bytes=4096');
    assert.equal(first.status,200);assert.equal(first.body.items.length,2);assert.ok(first.bytes<=4096);assert.equal(first.body.complete,false);
    assert.equal((await admin.call(path+'?cursor='+first.body.next_cursor)).body.error.code,'invalid_cursor');
    const seen=new Set<string>();let page=first;
    do {
      assert.ok(page.bytes<=4096);assert.ok(page.body.items.length<=2);
      for(const item of page.body.items){const id=JSON.stringify(item.target);assert.equal(seen.has(id),false);seen.add(id);}
      if(page.body.complete)break;
      page=await agent.client.call(path+'?limit=2&max_response_bytes=4096&cursor='+page.body.next_cursor);
      assert.equal(page.status,200);
    }while(true);
    assert.ok(seen.size>=8);
    const byteBound=await agent.client.call(path+'?limit=25&max_response_bytes=4096');
    assert.equal(byteBound.status,200);assert.ok(byteBound.bytes<=4096);
    assert.ok(byteBound.body.items.length>0 && byteBound.body.items.length<seen.size);
    assert.equal(byteBound.body.complete,false);assert.ok(byteBound.body.next_cursor);
    const state=await lookup(agent.client,target);
    await set(agent.client,command(target,false,state.version));
    const changed=await agent.client.call(path+'?cursor='+first.body.next_cursor);
    assert.equal(changed.status,409);assert.equal(changed.body.error.code,'saved_collection_changed');assert.equal(changed.body.items,undefined);
    assert.equal((await agent.client.call(path+'?max_response_bytes=4095')).status,400);
  });
  await t.test('synthetic retained-state quotas and bounded owner traversal fail explicitly, never as empty completion',async()=>{
    const limited=await account('saved_limits','agent');
    const original=command(target,true,0);const accepted=await set(limited.client,original);
    // Prefill synthetic retained tombstones using the real application role.
    await server.database.transaction(tx=>tx.query(`WITH resources AS (
      INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id)
      SELECT gen_random_uuid(),'contribution',$1,$2 FROM generate_series(1,499) RETURNING id
    ), contributions AS (
      INSERT INTO loom.contributions(id,discussion_id,parent_id) SELECT id,$1,$3 FROM resources RETURNING id
    ) INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id,version)
      SELECT gen_random_uuid(),$2,'contribution',id,id,1 FROM contributions`,[discussion,limited.id,opening]));
    const over=await limited.client.call(path+'/state',command({kind:'discussion',resource_id:discussion},true,0));
    assert.equal(over.status,429);assert.equal(over.body.error.code,'saved_limit_reached');
    assert.equal((await set(limited.client,command(target,false,1))).current.saved,false);
    const bookmark=(await server.observer.query('SELECT bookmark_id FROM loom.saved_operations WHERE id=$1',[accepted.operation_id])).rows[0].bookmark_id;
    await server.database.transaction(tx=>tx.query(`INSERT INTO loom.saved_operations(id,participant_id,idempotency_key,bookmark_id,
      semantic_version,request_digest,desired_saved,expected_version,result_version,decision)
      SELECT gen_random_uuid(),$1,gen_random_uuid(),$2,'saved-state-v1',repeat('0',64),true,0,1,'version_conflict'
      FROM generate_series(1,9998)`,[limited.id,bookmark]));
    assert.equal((await limited.client.call(path+'/state',command(target,true,2))).status,429);
    const replay=await set(limited.client,original);assert.equal(replay.operation_id,accepted.operation_id);assert.equal(replay.current.saved,false);
    assert.equal((await limited.client.call(path)).body.complete,true);

    const deep=await human.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Bounded owner path',content:text('test')});
    const wanted:SavedTargetView={kind:'artifact',resource_id:deep.body.resource_id};
    await set(human.client,command(wanted,true,0));
    let parent=area;
    for(let n=0;n<33;n++){
      const id=randomUUID(),previous=parent;
      await server.database.transaction(async tx=>{
        await tx.query("INSERT INTO loom.resources(id,kind,owner_resource_id) VALUES ($1,'area',$2)",[id,previous]);
        await tx.query("INSERT INTO loom.areas(id,title,description) VALUES ($1,'Depth fixture','')",[id]);
      });parent=id;
    }
    await server.observer.query('UPDATE loom.resources SET owner_resource_id=$1 WHERE id=$2',[parent,deep.body.resource_id]);
    const bounded=await human.client.call(path);assert.equal(bounded.status,503);assert.equal(bounded.body.items,undefined);
    await server.observer.query('UPDATE loom.resources SET owner_resource_id=$1 WHERE id=$2',[area,deep.body.resource_id]);
    assert.equal((await human.client.call(path)).body.items.length,1);
  });
  await t.test('atomic rollback, lost acknowledgement, replacement credentials, revoked authority and restart',async()=>{
    const state=await lookup(agent.client,target), input=command(target,true,state.version);
    rollback=true;assert.equal((await agent.client.call(path+'/state',input)).status,503);rollback=false;
    assert.equal((await lookup(agent.client,target)).version,state.version);
    assert.equal((await agent.client.call(path+'/status',{idempotency_key:input.idempotency_key})).body.operation_state,'not_recorded');
    loseKey=input.idempotency_key;assert.equal((await agent.client.call(path+'/state',input)).status,503);
    const restart=httpClient(server.origin,cert,agent.secret);
    const found=(await restart.call(path+'/status',{idempotency_key:input.idempotency_key})).body;
    assert.equal(found.operation_state,'applied');assert.equal((await set(restart,input)).operation_id,found.operation_id);
    const replacement=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:agent.id,kind:'agent',purpose:null,label:'Replacement',replace_credential_id:agent.credential});
    assert.equal(replacement.status,200);const next=httpClient(server.origin,cert,replacement.body.secret);
    assert.equal((await restart.call(path)).status,401);
    assert.equal((await next.call(path+'/status',{idempotency_key:input.idempotency_key})).body.operation_id,found.operation_id);
    await admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:agent.id,state:'suspended',role:'participant'});
    assert.equal((await next.call(path)).status,401);
    await admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:agent.id,state:'active',role:'participant'});
    agent.secret=replacement.body.secret;agent.client=next;
    const cursor=(await next.call(path+'?limit=1')).body.next_cursor;
    await server.app.close();
    const restarted=await createApplication({database:{isReady:()=>server.database.isReady(),close:async()=>{}},logger:false,
      tls:{key:await readFile(server.directory+'/key.pem','utf8'),cert},participation:{database:server.database,authentication:server.authentication,administration:server.administration}});
    await restarted.listen({host:'127.0.0.1',port:Number(new URL(server.origin).port)});t.after(()=>restarted.close());
    assert.equal((await next.call(path+'/status',{idempotency_key:input.idempotency_key})).body.operation_id,found.operation_id);
    assert.equal((await next.call(path+'?cursor='+cursor)).body.error.code,'invalid_cursor');
    assert.equal((await next.call(path)).status,200);
  });
  await t.test('standalone process journal survives discarded response and opposite action before exact retry',async()=>{
    const credential=server.directory+'/agent-token', journal=server.directory+'/saved-intent.json';
    await writeFile(credential,agent.secret,{mode:0o600});
    const args=['scripts/saved-items-client.mjs','--origin',server.origin,'--credential-file',credential,'--ca',server.directory+'/cert.pem','--journal',journal];
    const run=(action:string,extra:string[]=[])=>promisify(execFile)(process.execPath,[...args,'--action',action,...extra]);
    await run('prepare',['--kind','discussion','--resource',discussion,'--saved','true']);
    await assert.rejects(run('lose-response'),(e:any)=>e.code===75);
    const original=JSON.parse(await readFile(journal,'utf8'));
    const state=await lookup(agent.client,original.body.target);
    await set(agent.client,command(original.body.target,false,state.version));
    const status=JSON.parse((await run('status')).stdout), retry=JSON.parse((await run('retry')).stdout);
    assert.equal(status.result.operation_state,'applied');assert.equal(retry.result.operation_id,status.result.operation_id);
    assert.equal(retry.result.outcome.saved,true);assert.equal(retry.result.current.saved,false);
    assert.deepEqual(JSON.parse(await readFile(journal,'utf8')),original);
    assert.doesNotMatch(JSON.stringify(original),new RegExp(agent.secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    await assert.rejects(run('prepare',['--kind','discussion','--resource',discussion,'--saved','false']));
  });
});
