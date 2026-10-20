import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture,moderation} from '../helpers/moderation.js';
import {plain} from '../helpers/references.js';

function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
test('real PostgreSQL guards serialize lifecycle against publication, revision, editor, movement, reads and authority',{timeout:120000},async t=>{
  let gate:{match:(sql:string,values:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier>;release:ReturnType<typeof barrier>;claimed:boolean}|undefined;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values),g=gate;
    if(g&&!g.claimed&&g.match(sql,values)){g.claimed=true;g.entered.release();await g.release.promise;}
    return result;
  }}))})});
  async function blocked(){
    const start=Date.now();
    while(Date.now()-start<1000){
      if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()")).rowCount)return;
      await delay(5);
    }
    assert.fail('Competing transaction did not block on the PostgreSQL guard');
  }
  async function race(match:(sql:string,values:readonly unknown[])=>boolean,first:()=>Promise<any>,second:()=>Promise<any>){
    const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;
    const one=first();await Promise.race([g.entered.promise,one.then(result=>assert.fail('First transaction finished before its guard: '+JSON.stringify(result)))]);
    const two=second();
    try{await blocked();}finally{g.release.release();gate=undefined;}
    return Promise.all([one,two]);
  }
  const structure=(sql:string,values:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')&&values[0]===0x4c4f4f4d&&values[1]===1;
  for(const suppressionFirst of [true,false])await t.test('publication order: suppression first='+suppressionFirst,async()=>{
    const d=await f.discussion(),command=await f.command(d.id),body={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content:plain('Racing publication')};
    const suppress=()=>f.admin.call(moderation+'/state',command),publish=()=>f.admin.call('/api/v1/replies',body);
    const results=await race(structure,suppressionFirst?suppress:publish,suppressionFirst?publish:suppress);
    assert.equal(results[suppressionFirst?0:1].status,200);
    assert.equal(results[suppressionFirst?1:0].status,suppressionFirst?404:201);
    const replies=(await f.observer.query('SELECT id,parent_id FROM loom.contributions WHERE discussion_id=$1 AND parent_id IS NOT NULL',[d.id])).rows;
    assert.equal(replies.length,suppressionFirst?0:1);if(replies[0])assert.equal(replies[0].parent_id,d.opening.resource_id);
  });
  for(const other of ['revision','editors','move','read'] as const)for(const suppressionFirst of [true,false])await t.test(other+' order: suppression first='+suppressionFirst,async()=>{
    const a=await f.artifact(),command=await f.command(a.resource_id),org=(await f.admin.call('/api/v1/organization/resources/'+a.resource_id)).body;
    const edits=(await f.admin.call('/api/v1/resources/'+a.resource_id+'/editors')).body;
    const suppress=()=>f.admin.call(moderation+'/state',command);
    const competing=()=>other==='revision'?f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Racing revision',content:plain('New bytes')}):
      other==='editors'?f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_version:edits.version,participant_ids:[]}):
      other==='move'?f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'artifact.move',resource_id:a.resource_id,parent_id:f.other,expected_version:org.version,expected_hierarchy_version:org.hierarchy_version}):
      f.admin.call('/api/v1/resources/'+a.resource_id);
    const results=await race(structure,suppressionFirst?suppress:competing,suppressionFirst?competing:suppress);
    assert.equal(results[suppressionFirst?0:1].status,200);
    assert.equal(results[suppressionFirst?1:0].status,suppressionFirst?404:other==='revision'?201:200,JSON.stringify(results));
    assert.equal((await f.inspect(a.resource_id)).owner_id,other==='move'&&!suppressionFirst?f.other:f.area);
  });
  await t.test('opposite choices at the same lifecycle version cannot overwrite each other',async()=>{
    const a=await f.artifact(),first=await f.command(a.resource_id),second={...first,idempotency_key:randomUUID(),suppressed:false};
    const results=await race(structure,()=>f.admin.call(moderation+'/state',first),()=>f.admin.call(moderation+'/state',second));
    assert.equal(results[0].status,200);assert.equal(results[1].body.error.code,'moderation_conflict');
    assert.equal((await f.inspect(a.resource_id)).version,2);
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.moderation_operations WHERE resource_id=$1',[a.resource_id])).rows[0].n,1);
  });
  for(const kind of ['demotion','suspension','revocation'] as const)for(const moderationFirst of [true,false])await t.test(kind+' order: moderation first='+moderationFirst,async()=>{
    const p=await f.participant('authority_'+kind+'_'+moderationFirst),a=await f.artifact();
    await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:'active',role:'administrator'});
    const body=await f.command(a.resource_id,true,p.client),command=()=>p.client.call(moderation+'/state',body);
    const revoke=()=>kind==='revocation'?f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:p.id,credential_id:p.credential}):
      f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:kind==='suspension'?'suspended':'active',role:kind==='demotion'?'participant':'administrator'});
    const match=(sql:string,values:readonly unknown[])=>moderationFirst?structure(sql,values):
      kind==='revocation'?sql.startsWith('UPDATE loom.participant_credentials'):sql.startsWith('UPDATE loom.participants SET');
    const results=await race(match,moderationFirst?command:revoke,moderationFirst?revoke:command);
    assert.equal(results[moderationFirst?1:0].status,200);
    if(moderationFirst)assert.equal(results[0].status,200);else assert.ok([401,403,404].includes(results[1].status));
    assert.equal((await f.inspect(a.resource_id)).version,moderationFirst?2:1);
    for(const [path,input] of [[moderation+'/status',{idempotency_key:body.idempotency_key}],[moderation+'/targets',undefined],[moderation+'/audit',undefined],[moderation+'/resources/'+a.resource_id,undefined]] as const)
      assert.ok([401,403].includes((await p.client.call(path,input)).status));
  });
});
