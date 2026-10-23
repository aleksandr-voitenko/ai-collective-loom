import assert from 'node:assert/strict';
import type {QueryResultRow} from 'pg';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from '../helpers/moderation.js';
import {authored,plain} from '../helpers/references.js';
import {reservationSnapshot as sourceSnapshot} from '../helpers/reservations.js';
import {Value} from '@sinclair/typebox/value';
import * as C from '../../src/contracts/reservations.js';
const endpoint='/api/v1/editing-intent';
const announce=(a:{resource_id:string;revision_id:string},extra={})=>({idempotency_key:randomUUID(),resource_id:a.resource_id,base_revision_id:a.revision_id,purpose:'Shorten the opening',scope:{kind:'described',description:'chapters/01.md — introduction'},...extra});
const mutation=(notice:any,extra={})=>({idempotency_key:randomUUID(),notice_id:notice.notice_id,expected_version:notice.version,...extra});
async function accepted(client:any,action:string,body:unknown){const r=await client.call(endpoint+'/'+action,body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(C.IntentResult,r.body));return r.body;}

test('all concrete HTTPS kinds support advisory notices without source, coverage or private effects; overlap and exact bases remain independent',{timeout:120000},async t=>{
  const f=await fixture(t),d=await f.discussion(),comment=await f.reply(d),summary=await f.create(d.id),a=await f.artifact(),peer=await f.participant('intent_peer');
  const editors=(await f.admin.call('/api/v1/resources/'+a.resource_id+'/editors')).body;
  assert.equal((await f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_version:editors.version,participant_ids:[peer.id]})).status,200);
  const before=await sourceSnapshot(f);
  for(const source of [d.opening,comment,summary,a]){
    const body=announce(source),one=await accepted(f.admin,'announce',body);
    const read=await peer.client.call(endpoint+'/resources/'+source.resource_id);
    assert.equal(read.status,200);assert.equal(read.body.items[0].base_revision_id,source.revision_id);
    assert.equal(read.body.items[0].purpose,body.purpose);
    const renewed=await accepted(f.admin,'renew',mutation(one.current,{duration_minutes:1}));
    assert.equal(renewed.current.version,2);
    assert.equal(Date.parse(renewed.outcome.expires_at)-Date.parse(renewed.outcome.accepted_at),60000);
    await accepted(f.admin,'release',mutation(renewed.current));
    assert.equal((await accepted(f.admin,'announce',body)).current.state,'released');
  }
  const after=await sourceSnapshot(f);
  for(const key of Object.keys(before)) if(!key.startsWith('editing_'))assert.deepEqual(after[key],before[key],key);
  const one=await accepted(f.admin,'announce',announce(a)),two=await accepted(peer.client,'announce',announce(a));
  assert.equal((await f.admin.call(endpoint+'/resources/'+a.resource_id)).body.items.filter((r:any)=>r.state==='active').length,2);
  const draft={idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Peer revision',content:authored('Peer may publish with overlapping intent')};
  const published=await peer.client.call('/api/v1/revisions',draft);assert.equal(published.status,201,JSON.stringify(published.body));
  const notices=(await f.admin.call(endpoint+'/resources/'+a.resource_id)).body.items;
  assert.ok(notices.every((r:any)=>r.base_revision_id===a.revision_id&&r.older_base));
  const stale={...draft,idempotency_key:randomUUID(),content:authored('Full attempted draft remains owned by client')},copy=JSON.stringify(stale);
  const conflict=await f.admin.call('/api/v1/revisions',stale);assert.equal(conflict.status,409);assert.equal(JSON.stringify(stale),copy);
  await accepted(f.admin,'release',mutation(one.current));await accepted(peer.client,'release',mutation(two.current));
  const next=await f.admin.call('/api/v1/revisions',{...draft,idempotency_key:randomUUID(),expected_revision_id:published.body.revision_id});assert.equal(next.status,201);
  assert.equal((await f.admin.call(endpoint+'/resources/'+d.id)).status,404,'discussion is not opening');
});

test('lost announce/renew results, restart, released exact replay, replacement identities and changed input preserve immutable decisions',{timeout:120000},async t=>{
  let lose=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{
    let wrote=false;const result=await database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
      const r=await tx.query<Row>(sql,values);if(sql.startsWith('INSERT INTO loom.editing_intent_operations'))wrote=true;return r;
    }}));if(wrote&&lose){lose=false;throw new Error('lost after COMMIT');}return result;
  }})});
  const a=await f.artifact(),body=announce(a);lose=true;
  assert.equal((await f.admin.call(endpoint+'/announce',body)).status,503);await f.restart();
  const status=()=>f.admin.call(endpoint+'/status',{action:'announce',idempotency_key:body.idempotency_key});
  const first=(await status()).body;assert.equal(first.operation_state,'recorded');
  const renewal=mutation(first.current,{duration_minutes:120});lose=true;
  assert.equal((await f.admin.call(endpoint+'/renew',renewal)).status,503);await f.restart();
  const renewed=(await f.admin.call(endpoint+'/status',{action:'renew',idempotency_key:renewal.idempotency_key})).body;
  const released=await accepted(f.admin,'release',mutation(renewed.current));
  const original=await accepted(f.admin,'announce',body),retry=await accepted(f.admin,'renew',renewal);
  assert.deepEqual(original.outcome,first.outcome);assert.deepEqual(retry.outcome,renewed.outcome);
  assert.deepEqual(retry.current,released.current);assert.equal(retry.current.state,'released');
  for(const change of [{expected_version:2},{duration_minutes:1}])assert.equal((await f.admin.call(endpoint+'/renew',{...renewal,...change})).body.error.code,'idempotency_conflict');
  const replacement=await accepted(f.admin,'announce',announce(a));
  assert.notEqual(replacement.current.notice_id,first.current.notice_id);
  assert.equal((await f.admin.call(endpoint+'/renew',mutation(first.current))).body.error.code,'editing_intent_conflict');
  for(const change of [{purpose:'changed'},{scope:{kind:'whole'}},{duration_minutes:30},{base_revision_id:randomUUID()}])
    assert.equal((await f.admin.call(endpoint+'/announce',{...body,...change})).body.error.code,'idempotency_conflict');
  const same=await Promise.all([accepted(f.admin,'announce',body),accepted(f.admin,'announce',{...body,idempotency_key:body.idempotency_key.toUpperCase(),resource_id:body.resource_id.toUpperCase()})]);
  assert.equal(same[0].operation_id,same[1].operation_id);
  assert.equal((await f.admin.call(endpoint+'/status',{action:'release',idempotency_key:randomUUID()})).body.operation_state,'not_recorded');
});

test('owner cleanup and receipts survive source/editor withdrawal; readers and other owners cannot mutate intent',{timeout:120000},async t=>{
  const f=await fixture(t),p=await f.participant('intent_author'),other=await f.participant('intent_reader'),a=await f.artifact(p.client),body=announce(a);
  const one=await accepted(p.client,'announce',body);
  assert.equal((await other.client.call(endpoint+'/announce',announce(a))).status,403);
  assert.equal((await other.client.call(endpoint+'/release',mutation(one.current))).status,404);
  assert.equal((await other.client.call(endpoint+'/status',{action:'announce',idempotency_key:body.idempotency_key})).body.operation_state,'not_recorded');
  const editors=(await f.admin.call('/api/v1/resources/'+a.resource_id+'/editors')).body;
  await f.admin.call('/api/v1/editors',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_version:editors.version,participant_ids:[]});
  assert.equal((await p.client.call(endpoint+'/renew',mutation(one.current))).status,403);
  assert.equal((await p.client.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Refused',content:plain('No authority')})).status,403);
  assert.equal((await p.client.call(endpoint+'/resources/'+a.resource_id)).body.items[0].owner_may_edit,false);
  await f.suppress(a.resource_id);
  assert.equal((await p.client.call(endpoint+'/resources/'+a.resource_id)).status,404);
  const result=await accepted(p.client,'release',mutation(one.current));assert.equal(result.current.state,'released');
  const receipt=await p.client.call(endpoint+'/status',{action:'announce',idempotency_key:body.idempotency_key});
  for(const text of [body.purpose,body.scope.description,a.resource_id,a.revision_id])assert.ok(!JSON.stringify(receipt.body).includes(text));
  assert.equal((await accepted(p.client,'announce',body)).current.state,'released');
  await f.admin.call('/api/v1/identity/revoke',{idempotency_key:randomUUID(),participant_id:p.id,credential_id:p.credential});
  assert.equal((await p.client.call(endpoint+'/status',{action:'announce',idempotency_key:body.idempotency_key})).status,401);
});

test('natural one-minute expiry needs no worker or client and replay never renews; current-base publication succeeds',{timeout:120000},async t=>{
  const f=await fixture(t),p=await f.participant('crashed_editor'),a=await f.artifact(p.client),body=announce(a,{duration_minutes:1});
  const one=await accepted(p.client,'announce',body);
  const renew=mutation(one.current,{duration_minutes:1}),renewed=await accepted(p.client,'renew',renew);
  // The API is stopped, no worker is started, and no client calls run during
  // this real duration wait. Other tests use explicitly injected fixture time.
  await f.app.close();
  // Database and client wall clocks need not agree. Use the server's remaining
  // duration while the API is stopped; a skewed client cannot extend the wait.
  const clientClock=t.mock.method(Date,'now',()=>0);
  try{await delay(Math.max(0,Date.parse(renewed.outcome.expires_at)-Date.parse(renewed.observed_at)+100));}
  finally{clientClock.mock.restore();}
  await f.restart();
  const replay=await accepted(p.client,'announce',body);assert.deepEqual(replay.outcome,one.outcome);assert.equal(replay.current.state,'expired');
  const renewalReplay=await accepted(p.client,'renew',renew);assert.deepEqual(renewalReplay.outcome,renewed.outcome);assert.equal(renewalReplay.current.state,'expired');
  assert.equal((await p.client.call(endpoint+'/renew',mutation(one.current))).body.error.code,'editing_intent_conflict');
  const publish={idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'After expiry',content:plain('Expiry is harmless')};
  assert.equal((await p.client.call('/api/v1/revisions',publish)).status,201);
});

test('bounded admission and malformed commands never block publication, release or exact recovery',{timeout:120000},async t=>{
  const f=await fixture(t),a=await f.artifact(),body=announce(a);
  for(const change of [{duration_minutes:0},{duration_minutes:121},{duration_minutes:1.5},{purpose:''},{purpose:'🙂'.repeat(129)},
    {purpose:'   '},{purpose:'\ud800'},{scope:{kind:'described',description:''}},{scope:{kind:'described',description:'  '}},{scope:{kind:'described',description:'é'.repeat(129)}},{scope:{kind:'whole',description:'ignored?'}},{owner_id:randomUUID()},{base_revision_id:randomUUID()}]){
    const r=await f.admin.call(endpoint+'/announce',{...body,...change});assert.ok([400,404].includes(r.status),JSON.stringify(r.body));
  }
  const other=await f.artifact();assert.equal((await f.admin.call(endpoint+'/announce',{...body,base_revision_id:other.revision_id})).status,404);
  assert.equal((await f.admin.call(endpoint+'/announce',{...body,purpose:'\u0001'.repeat(512),scope:{kind:'described',description:'\u0001'.repeat(256)}})).status,413);
  for(const query of ['limit=0','limit=26','limit=1.5','cursor='+('a'.repeat(2049))])assert.equal((await f.admin.call(endpoint+'/resources/'+a.resource_id+'?'+query)).status,400);
  const first=await accepted(f.admin,'announce',body);assert.equal(Date.parse(first.outcome.expires_at)-Date.parse(first.outcome.accepted_at),30*60000);
  await f.database.transaction(tx=>tx.query('UPDATE loom.editing_intent_state SET decisions=10000 WHERE id=1',[]));
  assert.equal((await f.admin.call(endpoint+'/renew',mutation(first.current))).body.error.code,'editing_intent_limit');
  await accepted(f.admin,'release',mutation(first.current));
  assert.equal((await f.admin.call(endpoint+'/announce',announce(a))).body.error.code,'editing_intent_limit');
  assert.equal((await accepted(f.admin,'announce',body)).current.state,'released');
  assert.equal((await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'At capacity',content:plain('Ordinary publication')})).status,201);
});

test('active owner/resource and retained global/owner caps retain exact decisions and reserved cleanup',{timeout:120000},async t=>{
  const f=await fixture(t),records:any[]=[];
  for(let i=0;i<16;i++){const a=await f.artifact(),body=announce(a);records.push({a,body,result:await accepted(f.admin,'announce',body)});}
  const seventeenth=await f.artifact();assert.equal((await f.admin.call(endpoint+'/announce',announce(seventeenth))).body.error.code,'editing_intent_limit');
  for(const row of records)await accepted(f.admin,'release',mutation(row.result.current));
  const a=records[0].a;
  for(let i=0;i<25;i++){const p=await f.participant('capacity_peer_'+i);await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:p.id,state:'active',role:'administrator'});assert.equal((await p.client.call(endpoint+'/announce',announce(a))).status,200);}
  assert.equal((await f.admin.call(endpoint+'/announce',announce(a))).body.error.code,'editing_intent_limit');
  // Populate the actual 128 retained owner records across independently bounded resources.
  const target=await f.artifact(),target2=await f.artifact();
  for(let i=16;i<128;i++){const body=announce(i<100?target:target2);const result=await accepted(f.admin,'announce',body);await accepted(f.admin,'release',mutation(result.current));}
  assert.equal((await f.admin.call(endpoint+'/announce',announce(target2))).body.error.code,'editing_intent_limit');
  assert.equal((await accepted(f.admin,'announce',records[0].body)).current.state,'released');
  const p=await f.participant('global_capacity'),owned=await f.artifact(p.client),body=announce(owned),result=await accepted(p.client,'announce',body);
  await f.database.transaction(tx=>tx.query('UPDATE loom.editing_intent_state SET notices=4096 WHERE id=1',[]));
  await accepted(p.client,'release',mutation(result.current));assert.equal((await p.client.call(endpoint+'/announce',announce(owned))).body.error.code,'editing_intent_limit');
  assert.equal((await accepted(p.client,'announce',body)).current.state,'released');
});
