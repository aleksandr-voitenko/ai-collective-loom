import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture,moderation} from '../helpers/moderation.js';

test('bounded metadata traversal skips unsupported restrictions, binds current authority and invalidates safely',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.artifact(f.admin,'Never disclose this title'),b=await f.artifact();
  await f.suppress(a.resource_id);await f.suppress(b.resource_id);
  // Legacy unsupported areas occupy the entire first candidate batch. There is
  // no new area moderation feature and no scan of the unbounded remainder.
  await f.observer.query(`INSERT INTO loom.resources(id,kind,state)
    SELECT ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'area','suppressed' FROM generate_series(1,100) n`);
  const first=await f.admin.call(moderation+'/targets?limit=1');
  assert.equal(first.status,200);assert.deepEqual(first.body.items,[]);assert.equal(first.body.complete,false);assert.ok(first.body.next_cursor);
  const next=await f.admin.call(moderation+'/targets?limit=1&cursor='+encodeURIComponent(first.body.next_cursor));
  assert.equal(next.status,200);assert.equal(next.body.items.length,1);assert.equal(next.body.complete,false);
  const last=await f.admin.call(moderation+'/targets?limit=1&cursor='+encodeURIComponent(next.body.next_cursor));
  assert.equal(last.body.items.length,1);assert.equal(last.body.complete,true);assert.equal(last.body.next_cursor,null);
  assert.doesNotMatch(JSON.stringify([first.body,next.body,last.body]),/Never disclose this title|"content"|"title"/);
  for(const result of [first,next,last])assert.ok(result.bytes<=32768);
  const other=await f.participant('other_moderation_admin');
  await f.admin.call('/api/v1/identity/state',{idempotency_key:randomUUID(),participant_id:other.id,state:'active',role:'administrator'});
  for(const [client,path] of [[other.client,'targets'],[f.admin,'audit']] as const)
    assert.equal((await client.call(moderation+'/'+path+'?cursor='+encodeURIComponent(first.body.next_cursor))).body.error.code,'invalid_cursor');
  for(const query of ['limit=0','limit=26','limit=1.5','cursor=invalid','cursor='+('a'.repeat(2049))])
    assert.equal((await f.admin.call(moderation+'/targets?'+query)).status,400);
  const audit=await f.admin.call(moderation+'/audit?limit=1');assert.equal(audit.body.items.length,1);assert.ok(audit.body.next_cursor);
  const auditLast=await f.admin.call(moderation+'/audit?limit=1&cursor='+encodeURIComponent(audit.body.next_cursor));
  assert.equal(auditLast.body.complete,true);assert.equal(auditLast.body.items.length,1);
  await f.restart();
  assert.equal((await f.admin.call(moderation+'/targets?cursor='+encodeURIComponent(first.body.next_cursor))).body.error.code,'invalid_cursor');
  assert.equal((await f.admin.call(moderation+'/resources/'+randomUUID())).status,404);
  const body=await f.command(a.resource_id,false);
  assert.equal((await f.admin.call(moderation+'/state',{...body,extra:'x'.repeat(4096)})).status,413);
  assert.equal((await f.admin.call(moderation+'/state',{...body,target:{...body.target,kind:'summary'}})).body.error.code,'moderation_target_unsupported');
  await f.observer.query("UPDATE loom.resources SET state='removed' WHERE id=$1",[a.resource_id]);
  const removed=await f.inspect(a.resource_id);assert.equal(removed.local_state,'removed');assert.equal(removed.ordinary_read_available,false);
  assert.equal((await f.admin.call(moderation+'/state',body)).status,404);
  assert.equal((await f.inspect(a.resource_id)).version,2);
});
