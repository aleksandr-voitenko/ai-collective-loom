import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import { fixture } from '../helpers/attention.js';

test('finishing base and attention preparation retain their own transaction before group projection',{timeout:90000},async t=>{
  let recording=false;
  const transactions:string[][]=[];
  const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>{
    const queries:string[]=[];
    if(recording)transactions.push(queries);
    return work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      if(recording)queries.push(sql);
      return tx.query<Row>(sql,values);
    }});
  })})});
  const reader=await f.participant('updates_phase_boundary'),artifact=await f.artifact();
  await f.follow(reader.client,f.settings('artifact',artifact.resource_id));
  async function capture<T>(read:()=>Promise<T>){
    transactions.length=0;recording=true;
    try{return await read();}finally{recording=false;}
  }
  function noSecondProjection(marker:string){
    const matching=transactions.filter(queries=>queries.some(sql=>sql.startsWith(marker)));
    assert.equal(matching.length,1,'one bounded preparation transaction');
    const queries=matching[0]!,after=queries.slice(queries.findLastIndex(sql=>sql.startsWith(marker))+1);
    assert.ok(queries.some(sql=>sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'),'preparation guarded its sources');
    assert.deepEqual(after.filter(sql=>sql.startsWith('SELECT g.* FROM loom.updates_groups')
      ||sql.startsWith('SELECT * FROM loom.updates_groups WHERE view_id=$1 AND ordinal>')
      ||sql==='SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)'
      ||sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'),[],
      'finishing must not begin group projection or a second resource plan');
  }
  function preparing(page:Awaited<ReturnType<typeof f.routine>>|Awaited<ReturnType<typeof f.updates>>){
    assert.deepEqual({stage:page.stage,items:page.items,checkpoint:page.checkpoint,work_budget_reached:page.work_budget_reached},
      {stage:'preparing',items:[],checkpoint:null,work_budget_reached:false});
    assert.ok(page.next_cursor);assert.ok(page.complete_cursor);assert.ok(page.direct_cursor);assert.ok(page.records_cursor);
  }
  const legacy=await capture(()=>f.updates(reader.client,{selection:'complete'}));preparing(legacy);
  noSecondProjection('INSERT INTO loom.updates_groups(');
  const legacyReady=await f.ready(reader.client,{cursor:legacy.next_cursor!});assert.equal(legacyReady.items.length,1);
  const base=await capture(()=>f.routine(reader.client,{}));preparing(base);
  noSecondProjection('INSERT INTO loom.updates_groups(');
  assert.deepEqual((await f.observer.query('SELECT scanned,ready FROM loom.attention_views WHERE view_id=$1',[base.traversal.id])).rows,[{scanned:0,ready:false}]);
  const selected=await capture(()=>f.routine(reader.client,{cursor:base.next_cursor!}));preparing(selected);
  noSecondProjection('INSERT INTO loom.attention_groups(');
  assert.deepEqual((await f.observer.query('SELECT scanned,ready FROM loom.attention_views WHERE view_id=$1',[base.traversal.id])).rows,[{scanned:1,ready:true}]);
  const ready=await capture(()=>f.routine(reader.client,{cursor:selected.next_cursor!}));assert.equal(ready.stage,'ready');
  assert.equal(ready.items.length,1);assert.equal(ready.items[0]!.current.state,'available');
  if(ready.items[0]!.current.state==='available')assert.equal(ready.items[0]!.current.browser_url,`/loom/resource/${artifact.resource_id}`);
  assert.ok(transactions.flat().some(sql=>sql.startsWith('SELECT g.* FROM loom.updates_groups')),'next request projects the completed view');
});
