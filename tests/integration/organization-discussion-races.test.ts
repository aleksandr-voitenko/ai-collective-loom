import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryResultRow} from 'pg';
import {fixture,organization} from '../helpers/organization.js';
import {prepareText} from '../helpers/file-text.js';
import {authored,reference} from '../helpers/references.js';

function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}
test('DIS-07 real PostgreSQL waiters order closure against every publication family, organization and authority',{timeout:180000},async t=>{
 let gate:{match:(sql:string,v:readonly unknown[])=>boolean;entered:ReturnType<typeof barrier>;release:ReturnType<typeof barrier>;claimed:boolean}|undefined;
 const f=await fixture(t,{files:true,transactionWrapper:db=>({transaction:work=>db.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,v:readonly unknown[])=>{
   const result=await tx.query<Row>(sql,v),g=gate;if(g&&!g.claimed&&g.match(sql,v)){g.claimed=true;g.entered.release();await g.release.promise;}return result;
 }}))})});
 const structure=(sql:string,v:readonly unknown[])=>sql.includes('pg_advisory_xact_lock')&&v[0]===0x4c4f4f4d&&v[1]===1;
 async function race(match:(sql:string,v:readonly unknown[])=>boolean,first:()=>Promise<any>,second:()=>Promise<any>){
   const g={match,entered:barrier(),release:barrier(),claimed:false};gate=g;const one=first();
   try{
     await Promise.race([g.entered.promise,one.then(r=>assert.fail('No guard barrier: '+JSON.stringify(r)))]);const two=second();
     try{
       const start=Date.now();let blocked=false;
       while(Date.now()-start<1000){if((await f.observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0")).rowCount){blocked=true;break;}await delay(5);}
       assert.equal(blocked,true,'The competing operation must actually wait in PostgreSQL');
     }finally{g.release.release();}
     return await Promise.all([one,two]);
   }finally{gate=undefined;g.release.release();}
 }
 for(const kind of ['reply.file','opening.file','comment','summary.create','summary.revise'] as const)for(const closeFirst of [true,false])await t.test(kind+' with close first='+closeFirst,async()=>{
   const p=await f.participant('race_'+kind.replace('.','_')+'_'+closeFirst),d=await f.discussion(p.client),a=await f.artifact();
   const refs=[reference({kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id})];
   const content={format:'loom-markdown-v3',text:'Prepared racing publication',mentions:[],references:refs};
   const changes={change_note:null,change_account:{revisions:[{kind:'artifact',resource_id:a.resource_id,revision_id:a.revision_id}]}};
   let path:string,body:Record<string,unknown>,source=d.opening;
   if(kind==='reply.file'){
     const member=await prepareText(p.client,{kind:'reply',resource_id:d.opening.resource_id});
     path='/api/v1/replies';body={idempotency_key:randomUUID(),discussion_id:d.id,parent_id:d.opening.resource_id,content,...changes,attachment_set:{version:'contribution-attachments-v1',files:[member]}};
   }else if(kind==='opening.file'||kind==='comment'){
     if(kind==='comment')source=await f.reply(d,'Existing comment',p.client);
     const member=kind==='opening.file'?await prepareText(p.client,{kind:'contribution',resource_id:source.resource_id}):undefined;
     path='/api/v1/revisions';body={idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:kind==='opening.file'?'Racing title':null,content,...changes,...(member?{attachment_set:{version:'contribution-attachments-v1',files:[member]}}:{})};
   }else if(kind==='summary.create'){
     const preparation=await f.prepare(d.id,p.client);path='/api/v1/summaries';body=f.createBody(d.id,preparation.preparation_id,refs);
   }else{
     source=await f.create(d.id,p.client);path='/api/v1/summary-revisions';body={idempotency_key:randomUUID(),resource_id:source.resource_id,expected_revision_id:source.revision_id,title:'Racing summary',content:authored('Revised synthesis',refs),coverage:{carry_forward_revision_id:source.revision_id}};
   }
   const command=await f.organizationCommand(d.id),close=()=>f.admin.call(organization+'/changes',command),publish=()=>p.client.call(path,body);
   const before=(await f.observer.query('SELECT count(*)::int n FROM loom.revisions')).rows[0].n;
   const result=await race(structure,closeFirst?close:publish,closeFirst?publish:close),publication=result[closeFirst?1:0];
   assert.equal(result[closeFirst?0:1].status,200);assert.equal(publication.status,closeFirst?403:201,JSON.stringify(publication.body));
   assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.revisions')).rows[0].n,before+(closeFirst?0:1));
   const op=kind==='reply.file'?'reply.create':kind.startsWith('summary')?kind==='summary.create'?'summary.create':'summary.revise':'revision.publish';
   const status=await p.client.call(op.startsWith('summary')?'/api/v1/summaries/status':'/api/v1/operations/status',{operation_kind:op,idempotency_key:body.idempotency_key});
   if(closeFirst){
     assert.equal(publication.body.error.forbidden_reason,'publication_closed');assert.equal(status.body.operation_state,'not_recorded');
     await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:'active',role:'administrator'});
     assert.equal((await p.client.call(path,{...body,idempotency_key:randomUUID()})).status,403,'Administrator publication has no exception');
     assert.equal((await p.client.call('/api/v1/resources/'+source.resource_id)).body.revision_id,source.revision_id);
     await f.closeDiscussion(d.id,false);
     assert.equal((await p.client.call(path,{...body,idempotency_key:randomUUID()})).status,201,'Explicit correction can publish after reopening');
   }else{
     assert.equal(status.body.revision_id,publication.body.revision_id);assert.equal((await p.client.call('/api/v1/resources/'+publication.body.resource_id)).body.revision_id,publication.body.revision_id);
     assert.equal((await p.client.call(path,body)).status,403,'Mutation replay still needs action authority');
     const events=(await f.observer.query('SELECT e.position::text FROM loom.shared_activity e WHERE e.revision_id=$1 OR e.id=(SELECT source_event_id FROM loom.organization_operations WHERE idempotency_key=$2) ORDER BY e.position',[publication.body.revision_id,command.idempotency_key])).rows;assert.equal(events.length,2);assert.ok(BigInt(events[0].position)<BigInt(events[1].position));
   }
 });
 for(const other of ['discussion.open','discussion.move','area.close'] as const)for(const closeFirst of [true,false])await t.test('competing '+other+' with close first='+closeFirst,async()=>{
   const d=await f.discussion(),closeBody=await f.organizationCommand(d.id),otherBody=await f.organizationCommand(other==='area.close'?f.area:d.id,other,other==='discussion.move'?{parent_id:f.other}:{});
   const close=()=>f.admin.call(organization+'/changes',closeBody),competing=()=>f.admin.call(organization+'/changes',otherBody);
   const result=await race(structure,closeFirst?close:competing,closeFirst?competing:close);assert.equal(result[0].status,200);assert.equal(result[1].body.error.code,'organization_conflict');
   assert.equal((await f.organizationState(d.id)).local_open,!closeFirst);
   if(other==='area.close'&&!closeFirst)await f.organize(await f.organizationCommand(f.area,'area.open'));
 });
 for(const withdrawal of ['role','credential','account'] as const)for(const closeFirst of [true,false])await t.test(withdrawal+' withdrawal with close first='+closeFirst,async()=>{
   // Guarantee the revoker holds the original author's row before waiting for
   // the closer. A second resource UPDATE used to reacquire that unchanged FK.
   const pair=[await f.participant('close_'+withdrawal+'_'+closeFirst),await f.participant('revoke_'+withdrawal+'_'+closeFirst)].sort((a,b)=>a.id.localeCompare(b.id));
   const [revoker,p]=pair as [typeof pair[number],typeof pair[number]];
   for(const actor of pair)await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:actor.id,state:'active',role:'administrator'});
   const d=await f.discussion(revoker.client);
   const body=await f.organizationCommand(d.id),close=()=>p.client.call(organization+'/changes',body);
   const revoke=()=>withdrawal==='credential'?revoker.client.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:p.id,credential_id:p.credential}):revoker.client.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:withdrawal==='account'?'suspended':'active',role:withdrawal==='role'?'participant':'administrator'});
   const match=(sql:string,v:readonly unknown[])=>closeFirst?structure(sql,v):sql.startsWith(withdrawal==='credential'?'UPDATE loom.participant_credentials':'UPDATE loom.participants SET');
   const result=await race(match,closeFirst?close:revoke,closeFirst?revoke:close);assert.equal(result[closeFirst?1:0].status,200,JSON.stringify(result));
   if(closeFirst)assert.equal(result[0].status,200);else assert.ok([401,403,404].includes(result[1].status));
   assert.equal((await f.organizationState(d.id)).local_open,!closeFirst);
   assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.organization_operations WHERE idempotency_key=$1',[body.idempotency_key])).rows[0].n,closeFirst?1:0);
   assert.ok([401,403].includes((await p.client.call(organization+'/status',{kind:body.kind,idempotency_key:body.idempotency_key})).status));
 });
});
