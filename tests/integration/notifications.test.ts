import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture,mentioned,fields } from '../helpers/notifications.js';
import { note } from '../helpers/changes.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import type { NotificationItemView } from '../../src/contracts/notifications.js';

test('offline recipient gets one original reply/mention signal; edits, retries, reindex and note ownership preserve identity',{timeout:90000},async t=>{
  const f=await fixture(t),agent=await f.participant('attention_agent'),human=await f.participant('attention_human','human'),other=await f.participant('attention_other');
  const opening=await f.publish(agent.client,'/api/v1/discussions',{area_id:f.area,title:'Work needing attention',content:{format:'loom-markdown-v1',text:'Original contribution',mentions:[]}});
  const discussion=(await f.observer.query('SELECT discussion_id FROM loom.contributions WHERE id=$1',[opening.resource_id])).rows[0].discussion_id;
  // A later administrator edit cannot retarget a direct reply to that editor.
  await f.publish(f.admin,'/api/v1/revisions',{resource_id:opening.resource_id,expected_revision_id:opening.revision_id,title:'Work needing attention',content:{format:'loom-markdown-v1',text:'Edited by another participant',mentions:[]}});
  const replyBody={idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.resource_id,content:mentioned(agent.id),change_note:null,change_account:null};
  const first=await f.publish(human.client,'/api/v1/replies',replyBody);
  const waiting=await f.page(agent.client);assert.deepEqual(waiting.items,[]);assert.equal(waiting.projection.state,'incomplete');assert.ok(waiting.checkpoint);
  const before=(await f.observer.query('SELECT created_at FROM loom.revisions WHERE id=$1',[first.revision_id])).rows[0].created_at.toISOString();
  await f.drain();
  const page=await f.page(agent.client,{checkpoint:waiting.checkpoint!});assert.equal(page.items.length,1);const signal=page.items[0]!;
  assert.deepEqual(signal.reasons.map(r=>[r.kind,r.source_field]),[['direct_reply','reply'],['main_mention','main']]);
  assert.equal(signal.source.resource_id,first.resource_id);assert.equal(signal.source.revision_id,first.revision_id);
  assert.equal(signal.source.created_at,before);assert.equal(signal.source.author.id,human.id);assert.equal(signal.source.publisher.id,human.id);
  assert.equal(signal.parent!.author!.id,agent.id);assert.equal(signal.current.main_mention,'present');assert.equal(signal.context_title,'Work needing attention');
  assert.equal((await f.page(f.admin)).items.length,0);assert.equal((await f.page(other.client)).items.length,0);
  assert.deepEqual((await human.client.call('/api/v1/replies',replyBody)).body,{...first,idempotency:'replayed',publication_state:'committed'});
  let latest=first;
  for(const content of [mentioned(agent.id),{format:'loom-markdown-v3' as const,text:'Removed mention',mentions:[],references:[]},mentioned(agent.id)]){
    latest=await f.publish(human.client,'/api/v1/revisions',{resource_id:latest.resource_id,expected_revision_id:latest.revision_id,title:null,content,...fields(content)});
    await f.drain();assert.deepEqual((await f.page(agent.client,{checkpoint:page.checkpoint!})).items,[]);
    const detail=(await agent.client.call(signal.detail_url)).body;assert.equal(detail.source.revision_id,first.revision_id);
    assert.equal(detail.current.main_mention,content.mentions.length?'present':'absent');
  }
  const added=mentioned(other.id);added.mentions.push({token:'c',participant_id:agent.id});added.text+=' [[mention:c]]';
  latest=await f.publish(human.client,'/api/v1/revisions',{resource_id:latest.resource_id,expected_revision_id:latest.revision_id,title:null,content:added,...fields(added)});
  await f.drain();assert.equal((await f.page(other.client)).items.length,1);assert.deepEqual((await f.page(agent.client,{checkpoint:page.checkpoint!})).items,[]);
  const artifact=await f.publish(human.client,'/api/v1/artifacts',{area_id:f.area,title:'Shared package',content:mentioned(agent.id),change_note:{...note('Explicit note [[mention:n]]'),mentions:[{token:'n',participant_id:agent.id}]},change_account:null});
  await f.drain();const two=await f.page(agent.client,{checkpoint:page.checkpoint!});assert.equal(two.items.length,1);
  assert.deepEqual(two.items[0]!.reasons.map(r=>r.kind),['main_mention','note_mention']);
  const r2=await f.publish(human.client,'/api/v1/revisions',{resource_id:artifact.resource_id,expected_revision_id:artifact.revision_id,title:'Shared package',content:mentioned(agent.id),change_note:{...note('New revision note [[mention:n]]'),mentions:[{token:'n',participant_id:agent.id}]},change_account:null});
  await f.drain();const next=await f.page(agent.client,{checkpoint:two.checkpoint!});assert.equal(next.items.length,1);assert.equal(next.items[0]!.source.revision_id,r2.revision_id);
  assert.deepEqual(next.items[0]!.reasons.map(r=>r.kind),['note_mention']);
  const rows=async()=>(await f.observer.query('SELECT * FROM loom.personal_deliveries ORDER BY id')).rows;
  const retained=await rows();await f.worker.tick();await new SearchWorker(f.database).tick();assert.deepEqual(await rows(),retained);
  assert.equal((await f.observer.query('SELECT count(*)::int AS n FROM loom.saved_items')).rows[0].n,0);
  assert.deepEqual((await agent.client.call(signal.detail_url)).body,{...signal,current:{state:'available',revision_id:latest.revision_id,main_mention:'present'}});
});

test('ordinary opening/comment account edits keep contribution identity; references and coverage never notify target authors',{timeout:90000},async t=>{
  const f=await fixture(t),a=await f.participant('account_attention'),b=await f.participant('cited_author');
  const target=await f.artifact(b.client,'Cited source');
  const body={area_id:f.area,title:'Opening account',content:mentioned(a.id),change_note:null,
    change_account:{revisions:[{kind:'artifact',resource_id:target.resource_id,revision_id:target.revision_id}]}};
  const opening=await f.publish(f.admin,'/api/v1/discussions',body),discussion=(await f.admin.call('/api/v1/resources/'+opening.resource_id)).body.discussion_id;
  const comment=await f.publish(f.admin,'/api/v1/replies',{discussion_id:discussion,parent_id:opening.resource_id,content:mentioned(a.id),change_note:null,change_account:body.change_account});
  await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Non-notifying references',content:{format:'loom-markdown-v2',text:'A reference is not a mention.',mentions:[],references:[{reference_id:randomUUID(),target:{kind:'artifact',resource_id:target.resource_id},relationship:'builds_on',rationale:'@cited_author [[mention:raw]]'}]}});
  await f.drain();const before=await f.page(a.client);assert.deepEqual(before.items.map(i=>i.source.resource_id).sort(),[opening.resource_id,comment.resource_id].sort());assert.deepEqual((await f.page(b.client)).items,[]);
  for(const source of [opening,comment])await f.publish(f.admin,'/api/v1/revisions',{resource_id:source.resource_id,expected_revision_id:source.revision_id,title:source===opening?'Edited opening account':null,content:mentioned(a.id),change_note:null,change_account:{carry_forward_revision_id:source.revision_id}});
  await f.drain();assert.deepEqual((await f.page(a.client,{checkpoint:before.checkpoint!})).items,[]);assert.deepEqual((await f.page(b.client)).items,[]);
});

test('all historical formats, self identities, nested replies, accounts, note fields and inert authored data',{timeout:90000},async t=>{
  const f=await fixture(t),alice=await f.participant('formats_alice'),bob=await f.participant('formats_bob');
  for(const format of ['loom-markdown-v1','loom-markdown-v2','loom-markdown-v3'] as const){
    const content=mentioned(alice.id,format),source=await f.publish(bob.client,'/api/v1/artifacts',{area_id:f.area,title:format,content,...fields(content)});
    assert.ok(source.revision_id);
  }
  const self=await f.publish(alice.client,'/api/v1/artifacts',{area_id:f.area,title:'Self',content:mentioned(alice.id),change_note:null,change_account:null});
  await f.publish(f.admin,'/api/v1/revisions',{resource_id:self.resource_id,expected_revision_id:self.revision_id,title:'Self',content:mentioned(alice.id),change_note:null,change_account:null});
  const opening=await f.publish(alice.client,'/api/v1/discussions',{area_id:f.area,title:'Nested',content:mentioned(bob.id,'loom-markdown-v1')});
  const discussion=(await f.observer.query('SELECT discussion_id FROM loom.contributions WHERE id=$1',[opening.resource_id])).rows[0].discussion_id;
  const first=await f.publish(bob.client,'/api/v1/replies',{discussion_id:discussion,parent_id:opening.resource_id,content:{format:'loom-markdown-v1',text:'Direct reply',mentions:[]}});
  const nested=await f.publish(alice.client,'/api/v1/replies',{discussion_id:discussion,parent_id:first.resource_id,content:{format:'loom-markdown-v1',text:'Nested reply',mentions:[]}});
  await f.publish(bob.client,'/api/v1/replies',{discussion_id:discussion,parent_id:first.resource_id,content:{format:'loom-markdown-v1',text:'Self reply',mentions:[]}});
  const inert=await f.publish(bob.client,'/api/v1/artifacts',{area_id:f.area,title:'Inert',content:{format:'loom-markdown-v2',text:'@formats_alice https://example.test/\n\n> quoted @formats_alice\n\n`@formats_alice`\n\n```\n[[mention:x]]\n```',mentions:[],references:[]}});
  const account=await f.publish(bob.client,'/api/v1/replies',{discussion_id:discussion,parent_id:first.resource_id,content:mentioned(alice.id),change_note:null,change_account:{revisions:[{kind:'artifact',resource_id:self.resource_id,revision_id:self.revision_id}]}});
  await f.drain();const a=(await f.page(alice.client)).items,b=(await f.page(bob.client)).items;
  assert.deepEqual(a.map(i=>i.source.resource_id).sort(),[first.resource_id,account.resource_id,...(await f.observer.query("SELECT resource_id FROM loom.revisions WHERE title LIKE 'loom-markdown-%'")).rows.map(r=>r.resource_id)].sort());
  assert.deepEqual(b.map(i=>i.source.resource_id).sort(),[opening.resource_id,nested.resource_id].sort());
  for(const item of [...a,...b])assert.notEqual(item.source.resource_id,inert.resource_id);
  assert.equal((await f.observer.query('SELECT signal_id FROM loom.notification_claims WHERE recipient_id=$1 AND resource_id=$2',[alice.id,self.resource_id])).rows[0].signal_id,null);
});

test('fixed availability, source suppression, independent parent context and restoration before a completed lower bound',{timeout:90000},async t=>{
  const f=await fixture(t),alice=await f.participant('replay_alice'),bob=await f.participant('replay_bob');
  const sources:{resource_id:string;revision_id:string}[]=[];
  for(let i=0;i<3;i++)sources.push(await f.publish(bob.client,'/api/v1/artifacts',{area_id:f.area,title:`Attention ${i}`,content:mentioned(alice.id),change_note:null,change_account:null}));
  await f.drain();
  const order=(await f.observer.query('SELECT s.resource_id FROM loom.personal_deliveries d JOIN loom.notification_signals s ON s.id=d.signal_id WHERE d.recipient_id=$1 ORDER BY d.position',[alice.id])).rows.map(r=>r.resource_id as string);
  sources.sort((a,b)=>order.indexOf(a.resource_id)-order.indexOf(b.resource_id));
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[sources[0]!.resource_id]));
  const first=await f.page(alice.client,{limit:1});assert.equal(first.items.length,1);assert.ok(first.next_cursor);
  const later=await f.publish(bob.client,'/api/v1/artifacts',{area_id:f.area,title:'Later',content:mentioned(alice.id),change_note:null,change_account:null});await f.drain();
  const second=await f.page(alice.client,{cursor:first.next_cursor!});assert.equal(second.items.length,1);assert.ok(second.checkpoint);assert.equal(second.items[0]!.source.resource_id,sources[2]!.resource_id);
  const newer=await f.page(alice.client,{checkpoint:second.checkpoint!});assert.deepEqual(newer.items.map(i=>i.source.resource_id),[later.resource_id]);
  const finished=await f.page(alice.client,{checkpoint:newer.checkpoint!});assert.deepEqual(finished.items,[]);assert.ok(finished.checkpoint);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[sources[0]!.resource_id]));
  for(const reason of ['all','reply'])assert.equal((await alice.client.call('/api/v1/me/notifications/query',{checkpoint:finished.checkpoint,reason})).body.error.code,'visibility_replay_required');
  const replay=await f.page(alice.client,{recovery:{token:finished.checkpoint!,action:'replay'}});
  assert.equal(replay.recovery,'visibility_replay');assert.deepEqual(replay.items.map(i=>i.source.resource_id),[...sources.map(s=>s.resource_id),later.resource_id]);
  const ids=new Map<string,string>([...first.items,...second.items,...newer.items].map(i=>[i.source.resource_id,i.delivery_id]));
  for(const item of replay.items)if(ids.has(item.source.resource_id))assert.equal(item.delivery_id,ids.get(item.source.resource_id));
  await f.restart();assert.deepEqual((await f.page(alice.client,{checkpoint:replay.checkpoint!})).items,[]);
  for(const client of [bob.client,f.admin])assert.equal((await client.call(replay.items[0]!.detail_url)).status,404);
  assert.equal((await bob.client.call('/api/v1/me/notifications/query',{checkpoint:replay.checkpoint})).body.error.code,'notification_token_invalid');
  assert.equal((await alice.client.call('/api/v1/me/notifications/query',{recipient_id:bob.id})).status,400);
  const item:NotificationItemView=replay.items[0]!;
  await f.database.transaction(tx=>tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[item.source.revision_id]));
  assert.equal((await alice.client.call(item.detail_url)).status,404);
  const hidden=await f.page(alice.client);assert.ok(!JSON.stringify(hidden).includes(item.source.resource_id));
});
