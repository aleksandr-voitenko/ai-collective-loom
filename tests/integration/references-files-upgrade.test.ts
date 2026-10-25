import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {QueryResultRow} from 'pg';
import {fixture,reference,incoming,outgoing} from '../helpers/references.js';
import {packageText} from '../helpers/file-text.js';

test('0026 preserves every populated legacy column, exact uncertain retries and native manifests before accepting v4',{timeout:90000},async t=>{
  let lose='';
  const f=await fixture(t,{files:true,throughMigration:25,transactionWrapper:database=>({transaction:async work=>{
    let key='';const result=await database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const result=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.idempotency_records'))key=String(values[3]);return result;
    }}));if(key&&key===lose){lose='';throw new Error('Synthetic acknowledgement lost after commit');}return result;
  }})});
  const target=await packageText(f),ref=reference({kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id});
  const attempts=[];
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3']){
    const input={idempotency_key:randomUUID(),area_id:f.area,title:format,content:{format,text:'Retained exact request',mentions:[],...(format==='loom-markdown-v1'?{}:{references:[ref]})},...(format==='loom-markdown-v3'?{change_note:{format:'loom-markdown-v2',text:'Retained explanation',mentions:[],references:[ref]},change_account:null}:{})};
    lose=input.idempotency_key;assert.equal((await f.admin.call('/api/v1/artifacts',input)).status,503);
    const row=(await f.observer.query('SELECT * FROM loom.idempotency_records WHERE idempotency_key=$1',[input.idempotency_key])).rows[0];attempts.push({input,row});
  }
  assert.equal((await f.admin.call(incoming(ref.target))).body.items.length,3);
  const columns=(await f.observer.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='loom' ORDER BY table_name,ordinal_position")).rows;
  const tables=new Map<string,string[]>();for(const {table_name,column_name} of columns)tables.set(table_name,[...(tables.get(table_name)??[]),column_name]);
  const rows=async(table:string,columns:string[])=>JSON.stringify((await f.observer.query(`SELECT jsonb_build_array(${columns.map(c=>'"'+c+'"').join(',')}) row FROM loom."${table}" ORDER BY 1`)).rows);
  const before=new Map<string,string>();for(const [table,columns] of tables)before.set(table,await rows(table,columns));
  await f.migrate();await f.migrate();await f.restart();
  for(const [table,columns] of tables)assert.equal(await rows(table,columns),before.get(table),table+' old values changed');
  const targetFile={...ref.target,file_id:target.file.file_id,path:target.file.path};
  for(const {input,row} of attempts){
    const replay=await f.admin.call('/api/v1/artifacts',input);assert.equal(replay.status,201);assert.equal(replay.body.revision_id,row.revision_id);assert.equal(replay.body.operation_id,row.id);
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.idempotency_records WHERE id=$1',[row.id])).rows[0],row);
    const revision=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:row.resource_id,expected_revision_id:row.revision_id,title:'V4 base',content:{format:'loom-markdown-v4',text:'Exact new file citation',mentions:[],references:[reference(targetFile)]},change_note:null,change_account:null});assert.equal(revision.status,201,JSON.stringify(revision.body));
    assert.equal((await f.admin.call('/api/v1/artifacts',input)).body.revision_id,row.revision_id,'Original replay precedes new base checks');
    assert.equal((await f.admin.call(outgoing(revision.body))).body.items[0].declaration.target.file_id,target.file.file_id);
  }
  assert.equal((await f.admin.call(target.file.download_url)).body,'quartzneedle file content');
  assert.equal((await f.admin.call('/api/v1/artifacts',target.input)).body.revision_id,target.revision_id);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revision_references WHERE target_file_id IS NULL AND target_path IS NOT NULL')).rows[0].n,0);
});
