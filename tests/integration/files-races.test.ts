import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture} from '../helpers/references.js';
import {barrier,bounded} from '../helpers/search-races.js';

test('native file publication and exact downloads serialize both authority orderings without partial effects',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier<void>>;release:ReturnType<typeof barrier<void>>;claimed:boolean};let gate:Gate|undefined;
  const f=await fixture(t,{files:true,transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values),g=gate;
    if(g&&!g.claimed&&g.match(sql,values)){g.claimed=true;g.entered.release();await g.release.promise;}return result;
  }}))})});
  const structure=(sql:string,values:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')&&values[0]===0x4c4f4f4d&&values[1]===1;
  async function race(match:Gate['match'],first:()=>Promise<any>,second:()=>Promise<any>){
    const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;
    const one=first();await bounded(Promise.race([g.entered.promise,one.then(result=>assert.fail('First operation missed guard: '+JSON.stringify(result)))]));
    const two=second();let blocked=false;
    try{const deadline=Date.now()+3000;while(Date.now()<deadline){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()")).rowCount){blocked=true;break;}await delay(5);}assert.ok(blocked,'Native competing transaction must block');}
    finally{g.release.release();gate=undefined;}
    return Promise.all([one,two]);
  }
  for(const restriction of ['suppression','revocation','editors','closure','move'] as const)for(const restrictionFirst of [true,false])await t.test(restriction+' first='+restrictionFirst,async()=>{
    const person=await f.participant('files_'+restriction+'_'+restrictionFirst),a=await f.artifact(person.client),bytes=Buffer.from('immutable '+restriction);
    const upload=await person.client.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:a.resource_id},path:'nested/file',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain'});
    assert.equal(upload.status,201);const id=upload.body.upload_id;
    assert.equal((await person.client.call('/api/v1/file-uploads/'+id+'/bytes',undefined,{bytes})).status,200);
    assert.equal((await person.client.call('/api/v1/file-uploads/'+id+'/finalize',{})).status,200);
    const body={idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Racing package',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'nested/file',source:{upload_id:id}}]}};
    const org=(await f.admin.call('/api/v1/organization/resources/'+(restriction==='closure'?f.area:a.resource_id))).body;
    const lifecycle=(await f.admin.call('/api/v1/admin/moderation/resources/'+a.resource_id)).body;
    const editors=(await f.admin.call('/api/v1/resources/'+a.resource_id+'/editors')).body;
    // Movement into a closed destination must recheck the new containment chain.
    if(restriction==='move'){const destination=(await f.admin.call('/api/v1/organization/resources/'+f.other)).body;
      assert.equal((await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.close',resource_id:f.other,expected_version:destination.version,expected_hierarchy_version:destination.hierarchy_version})).status,200);
      Object.assign(org,(await f.admin.call('/api/v1/organization/resources/'+a.resource_id)).body);
    }
    const restrict=()=>restriction==='suppression'?f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:lifecycle.target,suppressed:true,expected_version:lifecycle.version}):
      restriction==='revocation'?f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:person.id,credential_id:person.credential}):
      restriction==='editors'?f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_version:editors.version,participant_ids:[]}):
      f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:restriction==='move'?'artifact.move':'area.close',resource_id:restriction==='move'?a.resource_id:f.area,...restriction==='move'?{parent_id:f.other}:{},expected_version:org.version,expected_hierarchy_version:org.hierarchy_version});
    const publish=()=>person.client.call('/api/v1/revisions',body);
    const match=!restrictionFirst?(sql:string)=>sql.startsWith('INSERT INTO loom.revisions'):
      restriction==='revocation'?(sql:string)=>sql.startsWith('UPDATE loom.participant_credentials'):
      restriction==='editors'?(sql:string)=>sql.startsWith('DELETE FROM loom.resource_editors'):structure;
    const before=(await f.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity WHERE resource_id=$1',[a.resource_id])).rows[0].n;
    const results=await race(match,restrictionFirst?restrict:publish,restrictionFirst?publish:restrict);
    assert.equal(results[restrictionFirst?0:1].status,200,JSON.stringify(results));
    const publication=results[restrictionFirst?1:0];assert.equal(publication.status,restrictionFirst?(restriction==='suppression'?404:restriction==='revocation'?401:403):201,JSON.stringify(results));
    const revisions=(await f.observer.query('SELECT id FROM loom.revisions WHERE resource_id=$1',[a.resource_id])).rows;
    assert.equal(revisions.length,restrictionFirst?1:2);
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_contexts WHERE artifact_id=$1',[a.resource_id])).rows[0].n,restrictionFirst?0:1);
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.shared_activity WHERE resource_id=$1',[a.resource_id])).rows[0].n,before+(restrictionFirst?0:1)+(restriction==='move'?1:0));
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.idempotency_records WHERE idempotency_key=$1',[body.idempotency_key])).rows[0].n,restrictionFirst?0:1);
    // Reopen local fixture areas using the supported lifecycle for the next case.
    if(restriction==='closure'||restriction==='move'){const resource=restriction==='closure'?f.area:f.other,state=(await f.admin.call('/api/v1/organization/resources/'+resource)).body;
      assert.equal((await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.open',resource_id:resource,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version})).status,200);}
  });
  for(const suppressionFirst of [true,false])await t.test('exact download authorization, suppression first='+suppressionFirst,async()=>{
    const a=await f.artifact(),bytes=Buffer.from('download');
    const upload=(await f.admin.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'artifact',resource_id:a.resource_id},path:'file',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain'})).body;
    await f.admin.call('/api/v1/file-uploads/'+upload.upload_id+'/bytes',undefined,{bytes});await f.admin.call('/api/v1/file-uploads/'+upload.upload_id+'/finalize',{});
    const revision=(await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Download',content:{format:'loom-markdown-v3',text:'',mentions:[],references:[]},change_note:null,change_account:null,file_set:{version:'artifact-files-v1',files:[{path:'file',source:{upload_id:upload.upload_id}}]}})).body;
    const file=(await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${revision.revision_id}/files`)).body.items[0];
    const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+a.resource_id)).body;
    const suppress=()=>f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:true,expected_version:state.version});
    const download=()=>f.admin.call(file.download_url);
    const results=await race(structure,suppressionFirst?suppress:download,suppressionFirst?download:suppress);
    assert.equal(results[suppressionFirst?0:1].status,200);
    // A request already reading storage is checked again before any bytes leave.
    assert.equal(results[suppressionFirst?1:0].status,404);
    const hidden=await f.admin.call(`/api/v1/artifacts/${a.resource_id}/revisions/${revision.revision_id}/files`);assert.equal(hidden.status,404);assert.ok(!JSON.stringify(hidden.body).includes(upload.sha256));
  });
});
