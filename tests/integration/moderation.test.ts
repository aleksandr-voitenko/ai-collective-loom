import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import SwaggerParser from '@apidevtools/swagger-parser';
import {fixture,moderation} from '../helpers/moderation.js';
import {plain,reference,outgoing} from '../helpers/references.js';
import {httpClient} from '../helpers/participation-http.js';
import type {QueryResultRow} from 'pg';

test('four HTTPS scopes preserve containment, selective restoration, history and independent publications',{timeout:120000},async t=>{
  const f=await fixture(t),d=await f.discussion(),c=await f.reply(d,'Suppressed comment'),reply=await f.publish(f.admin,'/api/v1/replies',{
    discussion_id:d.id,parent_id:c.resource_id,content:plain('Independent authored quotation of Suppressed comment')});
  const summary=await f.create(d.id),a=await f.artifact(f.admin,'Independent artifact',[reference({kind:'contribution',resource_id:c.resource_id,revision_id:c.revision_id})]);
  const read=(id:string,suffix='')=>f.admin.call('/api/v1/resources/'+id+suffix);
  const frozen=async()=>(await f.observer.query('SELECT id,resource_id,content_text,created_at FROM loom.revisions ORDER BY id')).rows;
  const before=await frozen();
  await f.suppress(c.resource_id);
  assert.equal((await read(c.resource_id)).status,404);assert.equal((await read(c.resource_id,'/history')).status,404);
  assert.equal((await read(reply.resource_id)).body.parent_id,c.resource_id);
  assert.equal((await read(reply.resource_id)).body.content.text,'Independent authored quotation of Suppressed comment');
  assert.equal((await f.admin.call(`/api/v1/contributions/${c.resource_id}/context`)).body.state,'unavailable');
  assert.equal((await f.admin.call(`/api/v1/contributions/${c.resource_id}/children`)).body.items[0].resource_id,reply.resource_id);
  assert.equal((await read(summary.resource_id)).status,200);
  assert.equal((await f.admin.call(outgoing(a))).body.items[0].target.state,'unavailable');
  await f.suppress(d.id);
  for(const id of [d.opening.resource_id,c.resource_id,reply.resource_id,summary.resource_id]){
    assert.equal((await read(id)).status,404);assert.equal((await read(id,'/history')).status,404);
  }
  assert.equal((await read(a.resource_id)).status,200);
  await f.suppress(d.id,false);
  assert.equal((await read(reply.resource_id)).status,200);assert.equal((await read(c.resource_id)).status,404);
  await f.suppress(d.id);await f.suppress(c.resource_id,false);
  assert.deepEqual(await f.inspect(c.resource_id),{target:{kind:'comment',resource_id:c.resource_id},local_state:'active',version:3,owner_id:d.id,ordinary_read_available:false});
  assert.equal((await read(c.resource_id)).status,404);
  await f.suppress(d.id,false);assert.equal((await read(c.resource_id)).status,200);
  await f.suppress(summary.resource_id);
  assert.equal((await read(summary.resource_id)).status,404);assert.equal((await read(d.opening.resource_id)).status,200);
  await f.suppress(summary.resource_id,false);
  await f.suppress(a.resource_id);assert.equal((await read(a.resource_id)).status,404);
  assert.equal((await read(c.resource_id)).status,200);
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[a.revision_id]));
  await f.suppress(a.resource_id,false);
  assert.equal((await f.inspect(a.resource_id)).ordinary_read_available,false);
  assert.equal((await read(a.resource_id,'/revisions/'+a.revision_id)).status,404);
  const area=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;
  await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.close',resource_id:f.area,expected_version:area.version,expected_hierarchy_version:area.hierarchy_version});
  await f.suppress(c.resource_id);await f.suppress(c.resource_id,false);
  assert.equal((await read(c.resource_id)).body.publication_open,false);
  assert.deepEqual(await frozen(),before);
  const list=await f.admin.call(moderation+'/targets'),audit=await f.admin.call(moderation+'/audit');
  for(const r of [list,audit,await f.admin.call(moderation+'/resources/'+a.resource_id)]){
    const json=JSON.stringify(r.body);assert.ok(!json.includes('Independent artifact'));assert.ok(!json.includes('Suppressed comment'));
  }
  assert.ok(audit.body.items.length>0);
  await SwaggerParser.validate((await f.admin.call('/api/v1/openapi.json')).body);
  assert.equal((await f.admin.call('/api/v1/community')).body.moderation_contract,'moderation-state-1');
});

test('administrator authority, exact canonical replay, no-op fences and safe capacity recovery',{timeout:120000},async t=>{
  const f=await fixture(t),human=await f.participant('human_mod','human'),agent=await f.participant('agent_mod'),a=await f.artifact(agent.client,'Editor-owned material');
  const k1=await f.command(a.resource_id);
  for(const client of [human.client,agent.client]){
    for(const [path,body] of [[moderation+'/state',k1],[moderation+'/status',{idempotency_key:k1.idempotency_key}],[moderation+'/targets',undefined],[moderation+'/audit',undefined],[moderation+'/resources/'+a.resource_id,undefined]] as const)
      assert.equal((await client.call(path,body)).status,403);
  }
  for(const person of [human,agent]){
    assert.equal((await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:person.id,state:'active',role:'administrator'})).status,200);
    const own=await f.command(a.resource_id,true,person.client);await f.apply(own,person.client);await f.suppress(a.resource_id,false,person.client);
    assert.equal((await person.client.call(moderation+'/audit')).status,200);
  }
  const negative=await f.command(a.resource_id,false);
  const noop=await f.apply(negative);assert.equal(noop.outcome.version,negative.expected_version+1);
  assert.equal((await f.admin.call(moderation+'/state',{...negative,idempotency_key:randomUUID(),suppressed:true})).body.error.code,'moderation_conflict');
  const first=await f.command(a.resource_id),[one,two]=await Promise.all([f.apply(first),f.apply({...first,idempotency_key:first.idempotency_key.toUpperCase(),target:{...first.target,resource_id:first.target.resource_id.toUpperCase()}})]);
  assert.equal(one.operation_id,two.operation_id);
  const restored=await f.suppress(a.resource_id,false),replayed=await f.apply(first);
  assert.equal(replayed.outcome.suppressed,true);assert.equal(replayed.current.local_state,'active');assert.equal(replayed.current.version,restored.current.version);
  for(const changed of [{suppressed:false},{expected_version:first.expected_version+1},{target:{kind:'discussion',resource_id:a.resource_id}}])
    assert.equal((await f.admin.call(moderation+'/state',{...first,...changed})).body.error.code,'idempotency_conflict');
  await f.database.transaction(tx=>tx.query('UPDATE loom.moderation_state SET decisions=10000 WHERE id=1',[]));
  assert.equal((await f.admin.call(moderation+'/state',await f.command(a.resource_id))).body.error.code,'moderation_limit');
  assert.equal((await f.apply(first)).operation_id,one.operation_id);
  assert.equal((await f.admin.call(moderation+'/status',{idempotency_key:first.idempotency_key})).body.outcome.suppressed,true);
  assert.equal((await f.admin.call(moderation+'/status',{idempotency_key:randomUUID()})).body.operation_state,'not_recorded');
  for(const id of [f.area,(await f.discussion()).opening.resource_id])
    assert.equal((await f.admin.call(moderation+'/resources/'+id)).body.error.code,'moderation_target_unsupported');
  assert.equal((await f.admin.call(moderation+'/resources/'+randomUUID())).status,404);
  await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:agent.id,state:'active',role:'participant'});
  for(const [path,body] of [[moderation+'/state',first],[moderation+'/status',{idempotency_key:first.idempotency_key}],[moderation+'/audit',undefined],[moderation+'/targets',undefined]] as const)
    assert.equal((await agent.client.call(path,body)).status,403);
  await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:human.id,state:'suspended',role:'administrator'});
  assert.equal((await human.client.call(moderation+'/targets')).status,401);
});

test('state, lifecycle fence, outcome, audit and invalidation rollback together; committed response loss recovers',{timeout:90000},async t=>{
  let fail=false,lose=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    let wrote=false;
    const result=await database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);
      if(sql.startsWith('INSERT INTO loom.moderation_audit')){wrote=true;if(fail)throw new Error('injected atomic rollback');}
      return result;
    }}));
    if(wrote&&lose){lose=false;throw new Error('post-COMMIT reply lost');}return result;
  }})});
  const a=await f.artifact(),body=await f.command(a.resource_id);
  const snapshot=async()=>{
    const result:Record<string,unknown>={};
    for(const table of ['resources','moderation_state','moderation_operations','moderation_audit','search_state','notification_state','shared_retrieval_state'])
      result[table]=(await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows;
    return result;
  };
  const before=await snapshot();fail=true;
  assert.equal((await f.admin.call(moderation+'/state',body)).status,503);
  assert.deepEqual(await snapshot(),before);fail=false;lose=true;
  assert.equal((await f.admin.call(moderation+'/state',body)).status,503);
  await f.restart();
  const status=await f.admin.call(moderation+'/status',{idempotency_key:body.idempotency_key});
  assert.equal(status.body.operation_state,'recorded');assert.equal(status.body.current.local_state,'suppressed');
  assert.equal((await f.apply(body)).operation_id,status.body.operation_id);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.moderation_operations')).rows[0].n,1);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.moderation_audit')).rows[0].n,1);
});

test('populated pre-feature upgrade preserves exact content, restrictions, operations and private state',{timeout:120000},async t=>{
  const f=await fixture(t,{throughMigration:17}),d=await f.discussion(),c=await f.reply(d),s=await f.create(d.id),a=await f.artifact();
  await f.follow(f.admin,f.settings('discussion',d.id));
  await f.mute(f.admin,'artifact',a.resource_id);
  await f.admin.call('/api/v1/me/saved-items/state',{idempotency_key:randomUUID(),target:{kind:'revision',resource_id:c.resource_id,revision_id:c.revision_id},saved:true,expected_version:0});
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=ANY($1::uuid[])",[[c.resource_id,s.resource_id]]));
  const snapshot=async()=>{
    const result:Record<string,unknown>={};
    for(const table of ['revisions','idempotency_records','resource_editors','saved_items','following_targets','attention_mutes','community_settings'])
      result[table]=(await f.observer.query(`SELECT * FROM loom.${table} ORDER BY 1`)).rows;
    result.resources=(await f.observer.query('SELECT id,state,current_revision_id,owner_resource_id,editors_version,organization_version FROM loom.resources ORDER BY id')).rows;
    return result;
  };
  const before=await snapshot();await f.migrate();await f.migrate();assert.deepEqual(await snapshot(),before);
  assert.equal((await f.inspect(c.resource_id)).version,1);assert.equal((await f.admin.call(moderation+'/audit')).body.items.length,0);
  const page=await f.admin.call(moderation+'/targets?limit=1');assert.equal(page.body.items.length,1);assert.ok(page.body.next_cursor);
  const next=await f.admin.call(moderation+'/targets?cursor='+encodeURIComponent(page.body.next_cursor));assert.equal(next.body.items.length,1);
  await f.suppress(c.resource_id,false);
  assert.equal((await f.admin.call(moderation+'/targets?cursor='+encodeURIComponent(page.body.next_cursor))).body.error.code,'invalid_cursor');
  assert.equal((await f.inspect(s.resource_id)).local_state,'suppressed');
});

test('durable direct HTTPS client retains exact intent across API/client restart and credential replacement',{timeout:120000},async t=>{
  const f=await fixture(t),person=await f.participant('native_admin'),a=await f.artifact();
  await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:person.id,state:'active',role:'administrator'});
  const issue=async(replace:string|null)=>(await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:person.id,kind:'agent',purpose:null,label:'Recovery client',replace_credential_id:replace})).body;
  const credential=await issue(person.credential),credentialFile=f.directory+'/moderation-token',journal=f.directory+'/moderation.json';
  await writeFile(credentialFile,credential.secret,{mode:0o600});
  const run=async(action:string,extra:string[]=[])=>promisify(execFile)(process.execPath,['scripts/moderation-client.mjs','--origin',f.origin,'--credential-file',credentialFile,'--ca',f.directory+'/cert.pem','--journal',journal,'--action',action,...extra]);
  await run('prepare',['--resource',a.resource_id,'--suppressed','true']);
  const bytes=await readFile(journal,'utf8');await assert.rejects(run('lose-response'));
  await f.restart();const replacement=await issue(credential.credential_id);await writeFile(credentialFile,replacement.secret,{mode:0o600});
  const status=JSON.parse((await run('status')).stdout);assert.equal(status.operation_state,'recorded');assert.equal(status.outcome.suppressed,true);
  await f.suppress(a.resource_id,false);
  const retry=JSON.parse((await run('retry')).stdout);assert.equal(retry.current.local_state,'active');assert.equal(retry.operation_id,status.operation_id);
  assert.equal(await readFile(journal,'utf8'),bytes);
  const b=await f.artifact();await f.suppress(a.resource_id);await f.suppress(b.resource_id);
  for(const action of ['list','audit']){
    const items:any[]=[];let cursor:string|undefined,complete=false;
    for(let page=0;page<10&&!complete;page++){
      const result=JSON.parse((await run(action,['--limit','1',...(cursor?['--cursor',cursor]:[])])).stdout);
      assert.equal(result.items.length,1);items.push(...result.items);
      complete=result.complete;cursor=result.next_cursor;
    }
    assert.equal(complete,true,'the example must reach every bounded page');
    const actual=items.map(item=>action==='list'?item.target.resource_id:item.operation_id).sort();
    const expected=action==='list'?[a.resource_id,b.resource_id].sort():
      (await f.observer.query('SELECT id FROM loom.moderation_operations ORDER BY id')).rows.map(row=>row.id);
    assert.deepEqual(actual,expected);
  }
  for(const options of [['--limit','26'],['--cursor','x'.repeat(2049)]])
    await assert.rejects(run('list',options));
  assert.equal(await readFile(journal,'utf8'),bytes,'control traversal must not replace immutable recovery custody');
  const revoked=httpClient(f.origin,await readFile(f.directory+'/cert.pem','utf8'),credential.secret);
  assert.equal((await revoked.call(moderation+'/status',{idempotency_key:JSON.parse(bytes).command.idempotency_key})).status,401);
});
