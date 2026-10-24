import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/moderation.js';
const base='/api/v1/editing-intent';
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
test('native waiters order renewal, release, replacement, authority and lifecycle without long-lived locks',{timeout:120000},async t=>{
  let gate:{match:(sql:string,v:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier>;release:ReturnType<typeof barrier>;claimed:boolean}|undefined;
  const f=await fixture(t,{transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values),g=gate;if(g&&!g.claimed&&g.match(sql,values)){g.claimed=true;g.entered.release();await g.release.promise;}return result;
  }}))})});
  async function blocked(){for(let n=0;n<160;n++){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")).rowCount)return;await delay(5);}assert.fail('No PostgreSQL waiter');}
  async function race(match:(sql:string,v:readonly unknown[])=>boolean,first:()=>Promise<any>,second:()=>Promise<any>,wait=0){
    const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;const one=first();
    await Promise.race([g.entered.promise,one.then(r=>assert.fail('Guard not reached '+JSON.stringify(r)))]);const two=second();
    try{await blocked();if(wait)await delay(wait);}finally{g.release.release();gate=undefined;}return Promise.all([one,two]);
  }
  const custody=(sql:string,v:readonly unknown[])=>sql.includes('pg_advisory_xact_lock(')&&v[1]===17;
  const announce=(a:any)=>({idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Race intent',scope:{kind:'whole'}});
  const command=(r:any)=>({idempotency_key:randomUUID(),notice_id:r.notice_id,expected_version:r.version});
  for(const renewalFirst of [true,false])await t.test('renew/release order '+renewalFirst,async()=>{
    const a=await f.artifact(),one=(await f.admin.call(base+'/announce',announce(a))).body;
    const renew=()=>f.admin.call(base+'/renew',command(one.current)),release=()=>f.admin.call(base+'/release',command(one.current));
    const results=await race(custody,renewalFirst?renew:release,renewalFirst?release:renew);
    assert.equal(results[0].status,200);assert.equal(results[1].body.error.code,'editing_intent_conflict');
    assert.equal((await f.admin.call(base+'/resources/'+a.resource_id)).body.items[0].state,renewalFirst?'active':'released');
  });
  for(const oldFirst of [true,false])await t.test('expired old renewal cannot affect replacement '+oldFirst,async()=>{
    const a=await f.artifact(),body=announce(a),one=(await f.admin.call(base+'/announce',body)).body;
    await f.observer.query("UPDATE loom.editing_notices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[one.current.notice_id]);
    const old=()=>f.admin.call(base+'/renew',command(one.current)),replacement=()=>f.admin.call(base+'/announce',announce(a));
    const results=await race(custody,oldFirst?old:replacement,oldFirst?replacement:old);
    assert.equal(results[oldFirst?0:1].body.error.code,'editing_intent_conflict');assert.equal(results[oldFirst?1:0].status,200);
    const next=results[oldFirst?1:0].body.current;
    assert.notEqual(next.notice_id,one.current.notice_id);assert.equal(next.version,1);
    await f.admin.call(base+'/release',command(one.current));
    assert.equal((await f.admin.call(base+'/resources/'+a.resource_id)).body.items.find((r:any)=>r.notice_id===next.notice_id).state,'active');
  });
  for(const kind of ['editors','suppression','closure','suspension','credential'] as const)for(const intentFirst of [true,false])await t.test(kind+' authority order '+intentFirst,async()=>{
    const p=await f.participant('race_'+kind+'_'+intentFirst),a=await f.artifact(p.client),body=announce(a);
    const editors=(await f.admin.call('/api/v1/resources/'+a.resource_id+'/editors')).body,mod=await f.command(a.resource_id);
    const org=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;
    const intent=()=>p.client.call(base+'/announce',body);
    const withdraw=()=>kind==='editors'?f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_version:editors.version,participant_ids:[]}):
      kind==='suppression'?f.admin.call('/api/v1/admin/moderation/state',mod):kind==='closure'?f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.close',resource_id:f.area,expected_version:org.version,expected_hierarchy_version:org.hierarchy_version}):
      kind==='suspension'?f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:'suspended',role:'participant'}):f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:p.id,credential_id:p.credential});
    const match=(sql:string,v:readonly unknown[])=>intentFirst?sql.includes('FROM loom.resources WHERE id = $1 FOR SHARE')&&v[0]===a.resource_id:
      kind==='credential'?sql.startsWith('UPDATE loom.participant_credentials'):kind==='suspension'?sql.startsWith('UPDATE loom.participants SET'):
        kind==='closure'||kind==='suppression'?sql.includes('pg_advisory_xact_lock(')&&v[1]===1:
        sql.includes('FROM loom.resources WHERE id = $1 FOR UPDATE')&&v[0]===a.resource_id;
    const results=await race(match,intentFirst?intent:withdraw,intentFirst?withdraw:intent);
    assert.equal(results[intentFirst?1:0].status,200,JSON.stringify(results));
    assert.equal(results[intentFirst?0:1].status,intentFirst?200:kind==='suppression'?404:kind==='suspension'||kind==='credential'?401:403,JSON.stringify(results));
    if(kind==='closure'){const current=(await f.admin.call('/api/v1/organization/resources/'+f.area)).body;assert.equal((await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.open',resource_id:f.area,expected_version:current.version,expected_hierarchy_version:current.hierarchy_version})).status,200);}
  });
  await t.test('validity uses time after unchanged custody wait',async()=>{
    const a=await f.artifact(),one=(await f.admin.call(base+'/announce',announce(a))).body;
    await f.observer.query("UPDATE loom.editing_notices SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",[one.current.notice_id]);
    const results=await race(custody,()=>f.admin.call(base+'/status',{action:'announce',idempotency_key:randomUUID()}),()=>f.admin.call(base+'/renew',command(one.current)),250);
    assert.equal(results[0].status,200);assert.equal(results[1].body.error.code,'editing_intent_conflict');
  });
});
