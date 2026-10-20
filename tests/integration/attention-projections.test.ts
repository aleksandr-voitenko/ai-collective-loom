import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Value} from '@sinclair/typebox/value';
import * as P from '../../src/contracts/private-controls.js';
import * as A from '../../src/contracts/attention.js';
import * as F from '../../src/contracts/following.js';
import {fixture} from '../helpers/attention.js';

test('private state, exact decisions and safe removal never hydrate sources; legacy commands keep their meaning',{timeout:90000},async t=>{
 let forbidSources=false,sourceQueries=0;
 const f=await fixture(t,{transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async(sql,values)=>{
   if(forbidSources&&/loom\.(resources|revisions|personal_deliveries|shared_activity)\b/.test(sql)){sourceQueries++;throw new Error('Private projection attempted source hydration');}
   return tx.query(sql,values);
 }}))})});
 const r=await f.participant('private_projection'),a=await f.artifact(f.admin,'Protected title'),target={kind:'artifact' as const,resource_id:a.resource_id};
 const follow=await f.follow(r.client,f.settings('artifact',a.resource_id)),mute=await f.mute(r.client,'artifact',a.resource_id);
 const input={kind:'shared_event' as const,id:await f.event(a.revision_id)},dismiss={idempotency_key:randomUUID(),inputs:[{...input,dismissed:true,expected_version:0}]};
 await f.dismiss(r.client,dismiss);
 await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]));
 forbidSources=true;
 const checks=[
   ['/api/v1/me/following/private/lookup',target,P.FollowItem],
   ['/api/v1/me/following/private',undefined,P.FollowPage],
   ['/api/v1/me/following/private/state',follow.body,P.FollowResult],
   ['/api/v1/me/following/private/status',{idempotency_key:follow.body.idempotency_key},P.FollowStatus],
   [f.endpoint+'/private/mutes/lookup',target,P.MuteItem],
   [f.endpoint+'/private/mutes/state',mute.body,P.AttentionResult],
   [f.endpoint+'/private/dismissals/lookup',{inputs:[input]},P.DismissPage],
   [f.endpoint+'/private/dismissals/state',dismiss,P.AttentionResult],
   [f.endpoint+'/private/status',{idempotency_key:mute.body.idempotency_key},P.AttentionStatus],
   [f.endpoint+'/private/status',{idempotency_key:dismiss.idempotency_key},P.AttentionStatus],
   [f.endpoint+'/private/list',{collection:'mutes'},P.AttentionList],
   [f.endpoint+'/private/list',{collection:'dismissals'},P.AttentionList],
 ] as const;
 for(const [path,body,schema] of checks){const response=await r.client.call(path,body);assert.equal(response.status,200,path);assert.ok(Value.Check(schema,response.body),path);
   assert.doesNotMatch(JSON.stringify(response.body),/"(source|availability|other_current_scope_mutes|title|path|browser_url)"/);}
 const removals=[
   ['/api/v1/me/following/private/state',{...follow.body,idempotency_key:randomUUID(),following:false,expected_version:1},P.FollowResult],
   [f.endpoint+'/private/mutes/state',{...mute.body,idempotency_key:randomUUID(),muted:false,expected_version:1},P.AttentionResult],
   [f.endpoint+'/private/dismissals/state',{idempotency_key:randomUUID(),inputs:[{...input,dismissed:false,expected_version:1}]},P.AttentionResult],
 ] as const;
 for(const [path,body,schema] of removals){const response=await r.client.call(path,body);assert.equal(response.status,200,JSON.stringify(response.body));assert.ok(Value.Check(schema,response.body));assert.equal(response.body.operation_state,'applied');}
 assert.equal(sourceQueries,0);forbidSources=false;
 const legacyFollow=await r.client.call('/api/v1/me/following/state',follow.body),legacyMute=await r.client.call(f.endpoint+'/mutes/state',mute.body),legacyDismiss=await r.client.call(f.endpoint+'/dismissals/state',dismiss);
 assert.ok(Value.Check(F.FollowResult,legacyFollow.body));assert.ok(Value.Check(A.MuteResult,legacyMute.body));assert.ok(Value.Check(A.DismissResult,legacyDismiss.body));
 assert.equal(legacyFollow.body.outcome.following,true);assert.equal(legacyFollow.body.current.following,false);assert.equal(legacyFollow.body.current.version,2);
 assert.equal(legacyMute.body.outcome.muted,true);assert.equal(legacyMute.body.current.muted,false);assert.equal(legacyMute.body.current.version,2);
 assert.equal(legacyDismiss.body.outcome.inputs[0]!.dismissed,true);assert.equal(legacyDismiss.body.current[0]!.dismissed,false);
 for(const key of [mute.body.idempotency_key,dismiss.idempotency_key])assert.deepEqual((await f.admin.call(f.endpoint+'/private/status',{idempotency_key:key})).body,{operation_state:'not_recorded'});
 assert.deepEqual((await f.admin.call('/api/v1/me/following/private/status',{idempotency_key:follow.body.idempotency_key})).body,{operation_state:'not_recorded'});
 assert.equal((await r.client.call(f.endpoint+'/private/mutes/state',{...mute.body,muted:false})).body.error.code,'idempotency_conflict');
});

test('protected previews batch mixed availability without granting private decisions source authority',{timeout:90000},async t=>{
 const f=await fixture(t),r=await f.participant('private_previews'),a=await f.artifact(f.admin,'Hidden title'),b=await f.artifact(f.admin,'Readable title');
 const targets=[a,b].map(v=>({kind:'artifact' as const,resource_id:v.resource_id}));
 await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]));
 const result=await r.client.call(f.endpoint+'/previews',{targets});assert.equal(result.status,200);assert.ok(Value.Check(P.PreviewPage,result.body));
 assert.deepEqual(result.body.items[0],{target:targets[0],source:{state:'unavailable'},other_current_scope_mutes:[]});
 assert.equal(result.body.items[1]!.source.state,'available');if(result.body.items[1]!.source.state==='available')assert.equal(result.body.items[1]!.source.title,'Readable title');assert.doesNotMatch(JSON.stringify(result.body),/Hidden title/);
 assert.equal((await r.client.call(f.endpoint+'/previews',{targets:Array(26).fill(targets[0])})).status,400);
 assert.equal((await r.client.call(f.endpoint+'/previews',{targets:[targets[0],targets[0]]})).status,400);
 const missing={kind:'artifact',resource_id:randomUUID()};
 for(const target of [targets[0],missing]){
   const lookup=await r.client.call(f.endpoint+'/private/mutes/lookup',target);assert.equal(lookup.status,200);assert.ok(Value.Check(P.MuteItem,lookup.body));assert.equal(lookup.body.version,0);
   const mute=await r.client.call(f.endpoint+'/private/mutes/state',{target,muted:true,include_descendants:false,expected_version:0,idempotency_key:randomUUID()});assert.equal(mute.status,404);
   const follow=await r.client.call('/api/v1/me/following/private/state',{...f.settings('artifact',target!.resource_id),following:true,expected_version:0,idempotency_key:randomUUID()});assert.equal(follow.status,404);
 }
 const denied=await r.client.call(f.endpoint+'/private/dismissals/state',{idempotency_key:randomUUID(),inputs:[{kind:'shared_event',id:await f.event(a.revision_id),dismissed:true,expected_version:0}]});assert.equal(denied.status,404);
});
