import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/moderation.js';
import {notes,createNote,changeNote,deleteNote,accepted,readNote} from '../helpers/notes.js';
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
test('actual PostgreSQL waiters order same-version writes, update/delete, source suppression and current read/write credentials in both directions',{timeout:120000},async t=>{
  let gate:{match:(sql:string,v:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier>;release:ReturnType<typeof barrier>;claimed:boolean}|undefined;
  const f=await fixture(t,{transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{const result=await tx.query<Row>(sql,v),g=gate;if(g&&!g.claimed&&g.match(sql,v)){g.claimed=true;g.entered.release();await g.release.promise;}return result;}}))})});
  async function blocked(){for(let n=0;n<160;n++){if((await f.observer.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0')).rowCount)return;await delay(5);}assert.fail('No PostgreSQL waiter observed');}
  async function race(match:(sql:string,v:readonly unknown[])=>boolean,first:()=>Promise<any>,second:()=>Promise<any>){const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;const one=first();await Promise.race([g.entered.promise,one.then(r=>assert.fail('Guard not reached '+JSON.stringify(r)))]);const two=second();try{await blocked();}finally{g.release.release();gate=undefined;}return Promise.all([one,two]);}
  const owner=(sql:string,v:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')&&String(v[0]).includes('loom.notes.owner');
  const body=createNote();await accepted(f.admin,'create',body);
  const k1=changeNote(body,1,{body:'Winner proposed body'}),k2=changeNote(body,1,{body:'Loser proposed body'}),raw=JSON.stringify(k2);
  const winners=await race(owner,()=>f.admin.call(notes+'/update',k1),()=>f.admin.call(notes+'/update',k2));assert.equal(winners[0].body.operation_state,'applied');assert.equal(winners[1].body.operation_state,'version_conflict');assert.equal(JSON.stringify(k2),raw);
  const original=winners[1].body.outcome;await accepted(f.admin,'update',changeNote(k2,2));assert.deepEqual((await accepted(f.admin,'update',k2)).outcome,original);
  for(const updateFirst of [true,false]){
    const b=createNote();await accepted(f.admin,'create',b);const update=changeNote(b),del=deleteNote(b.note_id),write=()=>f.admin.call(notes+'/update',update),remove=()=>f.admin.call(notes+'/delete',del);
    const r=await race(owner,updateFirst?write:remove,updateFirst?remove:write);assert.equal(r[0].body.operation_state,'applied');
    if(updateFirst){assert.equal(r[1].body.operation_state,'version_conflict');await accepted(f.admin,'delete',deleteNote(b.note_id,2));}else assert.equal(r[1].body.error.code,'note_deleted');
    assert.equal((await readNote(f.admin,b.note_id)).state,'deleted');
  }
  const duplicate=createNote();const same=await race(owner,()=>f.admin.call(notes+'/create',duplicate),()=>f.admin.call(notes+'/create',duplicate));assert.equal(same[0].body.operation_id,same[1].body.operation_id);
  for(const sourceFirst of [true,false])for(const operation of ['create','preview'] as const){
    const a=await f.artifact(),b=createNote([{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]);if(operation==='preview')await accepted(f.admin,'create',b);
    const suppression=await f.command(a.resource_id),note=()=>operation==='create'?f.admin.call(notes+'/create',b):f.admin.call(notes+'/'+b.note_id+'/sources'),withdraw=()=>f.admin.call('/api/v1/admin/moderation/state',suppression);
    const match=(sql:string,v:readonly unknown[])=>sourceFirst?sql.includes('pg_advisory_xact_lock(')&&v[1]===1:sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&v[0]===a.resource_id;
    const r=await race(match,sourceFirst?withdraw:note,sourceFirst?note:withdraw),result=r[sourceFirst?1:0];
    assert.equal(result.status,sourceFirst&&operation==='create'?404:200);if(operation==='preview')assert.equal(result.body.items[0].source.state,sourceFirst?'unavailable':'available');
  }
  for(const kind of ['suspension','revocation'] as const)for(const op of ['read','write'] as const)for(const noteFirst of [true,false]){
    const p=await f.participant('notes_'+kind+'_'+op+'_'+noteFirst),b=createNote();await accepted(p.client,'create',b);
    const note=()=>p.client.call(op==='read'?notes+'/'+b.note_id:notes+'/update',op==='read'?undefined:changeNote(b));
    const withdraw=()=>f.admin.call('/api/v1/identity/'+(kind==='suspension'?'state':'revoke'),kind==='suspension'?{idempotency_key:randomUUID(),participant_id:p.id,state:'suspended',role:'participant'}:{idempotency_key:randomUUID(),participant_id:p.id,credential_id:p.credential});
    const match=(sql:string,v:readonly unknown[])=>noteFirst?owner(sql,v):sql.startsWith(kind==='suspension'?'UPDATE loom.participants SET':'UPDATE loom.participant_credentials');
    const r=await race(match,noteFirst?note:withdraw,noteFirst?withdraw:note);assert.equal(r[noteFirst?0:1].status,noteFirst?200:401);assert.equal(r[noteFirst?1:0].status,200);
    assert.equal((await p.client.call(notes+'/status',{action:'create',idempotency_key:b.idempotency_key})).status,401);
  }
});
