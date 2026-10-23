import test from 'node:test';
import assert from 'node:assert/strict';
import type {QueryResultRow} from 'pg';
import type {Transactions} from '../../src/server/db/postgres.js';
import {fixture} from '../helpers/references.js';
import {packageText,drainFiles} from '../helpers/file-text.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';
import {barrier,bounded} from '../helpers/search-races.js';
import {randomUUID} from 'node:crypto';

test('real native waiters serialize file projections and processing with suppression, authority withdrawal and rebuild',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier<void>>;release:ReturnType<typeof barrier<void>>;claimed:boolean;pid:number};let gate:Gate|undefined,wrapped!:Transactions;
  const f=await fixture(t,{files:true,transactionWrapper:db=>{
    wrapped={transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values),g=gate;
      if(g&&!g.claimed&&g.match(sql,values)){g.claimed=true;g.pid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid',[])).rows[0]!.pid;g.entered.release();await g.release.promise;}
      return result;
    }}))};return wrapped;
  }});
  async function race(match:Gate['match'],first:()=>Promise<any>,second:()=>Promise<any>){
    const g={match,entered:barrier(),release:barrier(),claimed:false,pid:0};gate=g;
    const one=first();await bounded(Promise.race([g.entered.promise,one.then(()=>assert.fail('Expected first transaction guard'))]));const two=second();
    try{const end=Date.now()+3000;let blocked=false;while(Date.now()<end){if((await f.observer.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[g.pid])).rowCount){blocked=true;break;}}assert.ok(blocked,'Observe an actual waiter on the held transaction');}
    finally{gate=undefined;g.release.release();}
    return Promise.all([one,two]);
  }
  for(const operation of ['preview','status','search','processing'] as const)for(const restrictionFirst of [false,true])await t.test(operation+' suppression first='+restrictionFirst,async()=>{
    const p=await packageText(f);const worker=new FileTextWorker(wrapped,f.fileFixture!.storage);let claim:any,prepared:any;
    if(operation==='processing'){await worker.discover();claim=(await worker.claim(1))[0]!;prepared=await worker.prepare(claim);}else await drainFiles(f);
    const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+p.resource_id)).body;
    const restrict=()=>f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:true,expected_version:state.version});
    const read=()=>operation==='processing'?worker.finalize(claim,prepared):f.admin.call(operation==='search'?'/api/v1/search/files?q=quartzneedle':p.base+'/text'+(operation==='status'?'/status':''));
    const match:Gate['match']=restrictionFirst?sql=>sql.startsWith('UPDATE loom.resources SET state'):(sql,values)=>sql.includes('FROM loom.resources WHERE id')&&sql.includes('FOR SHARE')&&values[0]===p.resource_id;
    const result=await race(match,restrictionFirst?restrict:read,restrictionFirst?read:restrict);assert.equal(result[restrictionFirst?0:1].status,200);
    const projection=result[restrictionFirst?1:0];
    if(operation==='processing')assert.equal(projection,true,'Nonpublic completion does not claim participant authority');
    else if(restrictionFirst&&operation!=='search')assert.equal(projection.status,404);
    else {assert.equal(projection.status,200);if(restrictionFirst)assert.ok(!projection.body.items.some((r:any)=>r.source_resource_id===p.resource_id));}
    assert.equal((await f.admin.call(p.base+'/text')).status,404);
    assert.ok(!(await f.admin.call('/api/v1/search/files?q=quartzneedle')).body.items.some((r:any)=>r.source_resource_id===p.resource_id));
  });
  for(const restrictionFirst of [false,true])await t.test('credential withdrawal first='+restrictionFirst,async()=>{
    const p=await packageText(f),person=await f.participant('file_race_'+restrictionFirst);await drainFiles(f);
    const read=()=>person.client.call(p.base+'/text'),restrict=()=>f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:person.id,credential_id:person.credential});
    const match:Gate['match']=restrictionFirst?sql=>sql.startsWith('UPDATE loom.participant_credentials'):(sql,values)=>sql.includes('FROM loom.resources WHERE id')&&sql.includes('FOR SHARE')&&values[0]===p.resource_id;
    const result=await race(match,restrictionFirst?restrict:read,restrictionFirst?read:restrict);assert.equal(result[restrictionFirst?0:1].status,200);assert.equal(result[restrictionFirst?1:0].status,restrictionFirst?401:200);
    assert.equal((await person.client.call(p.base+'/text')).status,401);
  });
  for(const rebuildFirst of [false,true])await t.test('rebuild first='+rebuildFirst,async()=>{
    const p=await packageText(f),worker=new FileTextWorker(wrapped,f.fileFixture!.storage);await worker.discover();const claims=await worker.claim(2),claim=claims.find(c=>c.file_id===p.file.file_id)!;assert.ok(claim);const prepared=await worker.prepare(claim);
    const generation=(await f.admin.call('/api/v1/admin/file-text/health')).body.generation;
    const rebuild=()=>f.admin.call('/api/v1/admin/file-text/rebuild',{expected_generation:generation}),finish=()=>worker.finalize(claim,prepared);
    const match:Gate['match']=rebuildFirst?sql=>sql.startsWith('UPDATE loom.file_text_state SET generation='):sql=>sql.startsWith('INSERT INTO loom.file_text_documents');
    const result=await race(match,rebuildFirst?rebuild:finish,rebuildFirst?finish:rebuild);assert.equal(result[rebuildFirst?0:1].status,200);assert.equal(result[rebuildFirst?1:0],!rebuildFirst);
    assert.equal((await f.admin.call(p.base+'/text')).body.processing,'not_discovered');await drainFiles(f);
  });
});
