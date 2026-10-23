import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture,plain} from '../helpers/references.js';
import {barrier,bounded} from '../helpers/search-races.js';

test('attachment promotion has both real commit orders against source suppression, destination changes and acting authority',{timeout:120000},async t=>{
  type Gate={match:(sql:string,values:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier<void>>;release:ReturnType<typeof barrier<void>>;claimed:boolean};let gate:Gate|undefined;
  const f=await fixture(t,{files:true,transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values),g=gate;if(g&&!g.claimed&&g.match(sql,values)){g.claimed=true;g.entered.release();await g.release.promise;}return result;
  }}))})});
  async function race(match:Gate['match'],first:()=>Promise<any>,second:()=>Promise<any>){
    const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;
    const one=first();await bounded(Promise.race([g.entered.promise,one.then(r=>assert.fail('Missing first guard '+JSON.stringify(r)))]));
    const two=second();
    try{const end=Date.now()+3000;let blocked=false;while(Date.now()<end){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")).rowCount){blocked=true;break;}await delay(5);}assert.ok(blocked,'Observe an actual native waiter');}
    finally{gate=undefined;g.release.release();}return Promise.all([one,two]);
  }
  for(const restriction of ['comment','discussion','closure','move','revocation','suspension'] as const)for(const first of [true,false])await t.test(restriction+' restriction first='+first,async()=>{
    const alice=await f.participant('race_alice_'+restriction+'_'+first),bob=await f.participant('race_bob_'+restriction+'_'+first);
    const opening=(await alice.client.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Race source',content:plain('Opening')})).body;
    const discussion=(await alice.client.call('/api/v1/resources/'+opening.resource_id)).body.discussion_id;
    const bytes=Buffer.from('native race '+restriction),upload=(await alice.client.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'reply',resource_id:opening.resource_id},path:'selected.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain'})).body;
    await alice.client.call('/api/v1/file-uploads/'+upload.upload_id+'/bytes',undefined,{bytes});await alice.client.call('/api/v1/file-uploads/'+upload.upload_id+'/finalize',{});
    const reply=await alice.client.call('/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.resource_id,content:plain('Source'),attachment_set:{version:'contribution-attachments-v1',files:[{path:'selected.txt',source:{upload_id:upload.upload_id}}]}});assert.equal(reply.status,201);
    const page=(await bob.client.call(`/api/v1/contributions/${reply.body.resource_id}/revisions/${reply.body.revision_id}/attachments`)).body;
    const org=(await f.admin.call('/api/v1/organization/resources/'+f.other)).body;
    const created=await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.create',parent_id:null,title:'Destination',description:'Independent destination',expected_hierarchy_version:org.hierarchy_version});assert.equal(created.status,200);
    const area=created.body.outcome.resource_id;
    if(restriction==='move'){
      const state=(await f.admin.call('/api/v1/organization/resources/'+f.other)).body;
      assert.equal((await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.close',resource_id:f.other,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version})).status,200);
    }
    const destination=(await f.admin.call('/api/v1/organization/resources/'+area)).body;
    const lifecycle=(await f.admin.call('/api/v1/admin/moderation/resources/'+(restriction==='discussion'?discussion:reply.body.resource_id))).body;
    const input={idempotency_key:randomUUID(),source:{contribution_id:reply.body.resource_id,revision_id:reply.body.revision_id,file_id:page.items[0].file_id},area_id:area,title:'Independent result'};
    const promote=()=>bob.client.call('/api/v1/attachment-promotions',input);
    const restrict=()=>restriction==='comment'||restriction==='discussion'?f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:lifecycle.target,suppressed:true,expected_version:lifecycle.version}):
      restriction==='revocation'?f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:bob.id,credential_id:bob.credential}):
      restriction==='suspension'?f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:bob.id,state:'suspended',role:'participant'}):
      f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:restriction==='move'?'area.move':'area.close',resource_id:area,...restriction==='move'?{parent_id:f.other}:{},expected_version:destination.version,expected_hierarchy_version:destination.hierarchy_version});
    const match:Gate['match']=!first?sql=>sql.startsWith('INSERT INTO loom.attachment_promotions'):
      restriction==='revocation'?sql=>sql.startsWith('UPDATE loom.participant_credentials'):
      restriction==='suspension'?sql=>sql.startsWith('UPDATE loom.participants'):
      (sql,values)=>sql.includes('pg_advisory_xact_lock(')&&values[0]===0x4c4f4f4d&&values[1]===1;
    const results=await race(match,first?restrict:promote,first?promote:restrict),published=results[first?1:0];
    assert.equal(results[first?0:1].status,200,JSON.stringify(results));
    assert.equal(published.status,first?(restriction==='comment'||restriction==='discussion'?404:restriction==='revocation'||restriction==='suspension'?401:403):201,JSON.stringify(results));
    const rows=(await f.observer.query(`SELECT i.resource_id,i.revision_id,r.original_author_id,p.source_contribution_id,p.source_revision_id,p.source_file_id,p.promoter_id,
      (SELECT count(*)::int FROM loom.file_contexts c WHERE c.artifact_id=i.resource_id) AS contexts,
      (SELECT count(*)::int FROM loom.shared_activity e WHERE e.resource_id=i.resource_id AND e.kind='revision.published') AS events,
      (SELECT count(*)::int FROM loom.outbox_intents o WHERE o.source_event_id=i.source_event_id) AS intents,
      (SELECT count(*)::int FROM loom.resource_editors x WHERE x.resource_id=i.resource_id AND x.participant_id=$2) AS editors
      FROM loom.idempotency_records i JOIN loom.resources r ON r.id=i.resource_id JOIN loom.attachment_promotions p ON p.revision_id=i.revision_id
      WHERE i.idempotency_key=$1`,[input.idempotency_key,bob.id])).rows;
    if(first)assert.deepEqual(rows,[]);else{
      assert.deepEqual(rows,[{resource_id:published.body.resource_id,revision_id:published.body.revision_id,original_author_id:bob.id,source_contribution_id:input.source.contribution_id,source_revision_id:input.source.revision_id,source_file_id:input.source.file_id,promoter_id:bob.id,contexts:1,events:1,intents:1,editors:1}]);
      const file=(await f.admin.call(`/api/v1/artifacts/${published.body.resource_id}/revisions/${published.body.revision_id}/files`)).body.items[0];
      assert.equal((await f.admin.call(file.download_url)).body,bytes.toString());
    }
    assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.revisions WHERE resource_id=$1',[reply.body.resource_id])).rows[0].n,1);
    if(restriction==='move'){const state=(await f.admin.call('/api/v1/organization/resources/'+f.other)).body;
      await f.admin.call('/api/v1/organization/changes',{idempotency_key:randomUUID(),kind:'area.open',resource_id:f.other,expected_version:state.version,expected_hierarchy_version:state.hierarchy_version});}
  });
});

test('cleanup and attachment publication or promotion compete on native custody in both orders',{timeout:120000},async t=>{
  type Gate={entered:ReturnType<typeof barrier<void>>;release:ReturnType<typeof barrier<void>>;claimed:boolean};let gate:Gate|undefined;
  const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const r=await tx.query<Row>(sql,values);const g=gate;if(g&&!g.claimed&&sql.includes('pg_advisory_xact_lock(')&&values[1]===15){g.claimed=true;g.entered.release();await g.release.promise;}return r;
  }}))})});
  for(const promote of [false,true])for(const cleanupFirst of [false,true]){
    const bytes=Buffer.from('retained through cleanup'),upload=(await f.admin.call('/api/v1/file-uploads',{idempotency_key:randomUUID(),target:{kind:'opening',resource_id:f.area},path:'retained.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),media_type:'text/plain'})).body;
    await f.admin.call(`/api/v1/file-uploads/${upload.upload_id}/bytes`,undefined,{bytes});await f.admin.call(`/api/v1/file-uploads/${upload.upload_id}/finalize`,{});
    const body={idempotency_key:randomUUID(),area_id:f.area,title:'Custody race',content:plain('Opening'),attachment_set:{version:'contribution-attachments-v1',files:[{path:'retained.txt',source:{upload_id:upload.upload_id}}]}};
    let source:any,file:any;if(promote){source=(await f.admin.call('/api/v1/discussions',body)).body;file=(await f.admin.call(`/api/v1/contributions/${source.resource_id}/revisions/${source.revision_id}/attachments`)).body.items[0];await f.observer.query("UPDATE loom.file_uploads SET prepared_expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[upload.upload_id]);}
    const publish=()=>f.admin.call(promote?'/api/v1/attachment-promotions':'/api/v1/discussions',promote?{idempotency_key:randomUUID(),source:{contribution_id:source.resource_id,revision_id:source.revision_id,file_id:file.file_id},area_id:f.other,title:'Custody promotion'}:body),clean=()=>f.admin.call('/api/v1/file-uploads/cleanup',{});
    const g={entered:barrier(),release:barrier(),claimed:false};gate=g;const first=cleanupFirst?clean():publish();await bounded(g.entered.promise);const second=cleanupFirst?publish():clean();
    try{let blocked=false;const end=Date.now()+3000;while(Date.now()<end){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")).rowCount){blocked=true;break;}await delay(5);}assert.ok(blocked);}
    finally{gate=undefined;g.release.release();}
    const results=await Promise.all([first,second]),published=results[cleanupFirst?1:0];assert.equal(published.status,201);assert.deepEqual(results[cleanupFirst?0:1].body,{removed:0,quarantined:0});
    const manifest=(await f.admin.call(`/api/v1/${promote?'artifacts':'contributions'}/${published.body.resource_id}/revisions/${published.body.revision_id}/${promote?'files':'attachments'}`)).body;
    assert.equal((await f.admin.call(manifest.items[0].download_url)).body,bytes.toString());assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.file_contexts WHERE upload_id=$1',[upload.upload_id])).rows[0].n,promote?2:1);
  }
});
