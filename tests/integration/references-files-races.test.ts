import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture,reference,incoming,outgoing} from '../helpers/references.js';
import {packageText,suppressFileOwner,prepareText} from '../helpers/file-text.js';
import {barrier,bounded} from '../helpers/search-races.js';

test('exact file membership shares complete publication guards with source/target suppression and current authority in both orders',{timeout:120000},async t=>{
  let gate:{match:(sql:string,values:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier<void>>;release:ReturnType<typeof barrier<void>>;claimed:boolean}|undefined;
  const f=await fixture(t,{files:true,transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    const result=await tx.query<Row>(sql,values),g=gate;if(g&&!g.claimed&&g.match(sql,values)){g.claimed=true;g.entered.release();await bounded(g.release.promise);}return result;
  }}))})});
  const structure=(sql:string,values:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')&&values[0]===0x4c4f4f4d&&values[1]===1;
  async function race(match:typeof structure,first:()=>Promise<any>,second:()=>Promise<any>){
    const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;
    const one=first();await bounded(Promise.race([g.entered.promise,one.then(r=>assert.fail('Guard not reached: '+JSON.stringify(r)))]));const two=second();
    try{const deadline=Date.now()+3000;while(!(await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()")).rowCount){assert.ok(Date.now()<deadline,'Actual competing transaction must block');await delay(5);}}finally{g.release.release();gate=undefined;}
    return Promise.all([one,two]);
  }
  const target=await packageText(f),targetFile={kind:'artifact' as const,resource_id:target.resource_id,revision_id:target.revision_id,file_id:target.file.file_id,path:target.file.path};
  for(const side of ['source','target'] as const)for(const firstSuppression of [true,false]){
    const person=await f.participant('file_race_'+side+'_'+firstSuppression),source=await f.artifact(person.client);
    const id=side==='source'?source.resource_id:target.resource_id;
    const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+id)).body;
    const suppress=()=>f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:true,expected_version:state.version});
    const ref=reference(targetFile),body={idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Race',content:{format:'loom-markdown-v4',text:'Shared exact citation',mentions:[],references:[ref]},change_note:null,change_account:null};
    const publish=()=>person.client.call('/api/v1/revisions',body);
    assert.equal((await person.client.call('/api/v1/references/target?'+new URLSearchParams(targetFile))).status,200,'Picker validation reserves no rights');
    const results=await race(structure,firstSuppression?suppress:publish,firstSuppression?publish:suppress);
    assert.equal(results[firstSuppression?0:1].status,200);assert.equal(results[firstSuppression?1:0].status,firstSuppression?404:201,JSON.stringify(results));
    if(!firstSuppression&&side==='target')assert.deepEqual((await person.client.call(outgoing(results[0].body))).body.items[0].target,{state:'unavailable'});
    await suppressFileOwner(f,id,false);
    assert.equal((await person.client.call(incoming(targetFile))).body.items.some((r:any)=>r.source.resource_id===source.resource_id),!firstSuppression);
  }
  for(const revokeFirst of [true,false]){
    const person=await f.participant('file_authority_'+revokeFirst),ref=reference(targetFile);
    const publish=()=>person.client.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Authority',content:{format:'loom-markdown-v4',text:'Exact authority',mentions:[],references:[ref]},change_note:null,change_account:null});
    const revoke=()=>f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:person.id,credential_id:person.credential});
    const results=await race(revokeFirst?(sql)=>sql.startsWith('UPDATE loom.participant_credentials'):structure,revokeFirst?revoke:publish,revokeFirst?publish:revoke);
    assert.equal(results[revokeFirst?0:1].status,200);assert.equal(results[revokeFirst?1:0].status,revokeFirst?401:201);
  }
  const member=await prepareText(f.admin,{kind:'opening',resource_id:f.area});
  const opening=(await f.admin.call('/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Independent original',content:{format:'loom-markdown-v1',text:'Original',mentions:[]},attachment_set:{version:'contribution-attachments-v1',files:[member]}})).body;
  const attachment=(await f.admin.call(`/api/v1/contributions/${opening.resource_id}/revisions/${opening.revision_id}/attachments`)).body.items[0];
  const promoted=await f.admin.call('/api/v1/attachment-promotions',{idempotency_key:randomUUID(),source:{contribution_id:opening.resource_id,revision_id:opening.revision_id,file_id:attachment.file_id},area_id:f.area,title:'Independent promoted artifact'});
  assert.equal(promoted.status,201,JSON.stringify(promoted.body));
  await suppressFileOwner(f,(await f.admin.call('/api/v1/resources/'+opening.resource_id)).body.discussion_id);
  const file=(await f.admin.call(`/api/v1/artifacts/${promoted.body.resource_id}/revisions/${promoted.body.revision_id}/files`)).body.items[0];
  const cite=await f.admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Promoted citation',content:{format:'loom-markdown-v4',text:'Independent context',mentions:[],references:[reference({kind:'artifact',resource_id:promoted.body.resource_id,revision_id:promoted.body.revision_id,file_id:file.file_id,path:file.path})]},change_note:null,change_account:null});assert.equal(cite.status,201);
  assert.equal((await f.admin.call('/api/v1/references/target?'+new URLSearchParams({kind:'contribution',resource_id:opening.resource_id,revision_id:opening.revision_id,file_id:attachment.file_id}))).status,404);
});
