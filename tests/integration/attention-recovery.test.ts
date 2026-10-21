import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID,createHash } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { readFile,writeFile,stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fixture } from '../helpers/attention.js';
import { gates } from '../helpers/updates-gates.js';
import { barrier,blockedBy,bounded } from '../helpers/search-races.js';
import { mentioned } from '../helpers/notifications.js';
import { editUpdatesToken } from '../helpers/updates-token.js';

test('populated 0016 upgrade preserves every prior table, exact retry and shared/personal/combined/reading contracts',{timeout:120000},async t=>{
  const f=await fixture(t,{throughMigration:16}),r=await f.participant('attention_upgrade'),a=await f.artifact(),d=await f.discussion();
  const follow=await f.follow(r.client,f.settings('discussion',d.id));await f.drain();
  const read={idempotency_key:randomUUID(),basis:'manual',episode_id:null,targets:[{resource_id:a.resource_id,revision_id:a.revision_id,read:true,expected_version:0}]};
  assert.equal((await r.client.call('/api/v1/me/reading/state',read)).status,200);
  const personal=await f.page(r.client),shared=await f.changes(r.client),combined=await f.ready(r.client,{selection:'complete'});
  // Exercise every legacy read path before attention tables exist, including
  // retained-page and member renewal. A v2 join here must fail on the old schema.
  assert.equal((await f.observer.query("SELECT to_regclass('loom.attention_groups') AS relation")).rows[0].relation,null);
  const switched=await f.ready(r.client,{switch:{token:combined.page_cursor,selection:'highlights'}});
  assert.ok(switched.items.length);
  const members=await f.members(r.client,{cursor:switched.items[0]!.members_cursor});assert.ok(members.items.length);
  const reasons=await r.client.call('/api/v1/me/updates/reasons',{cursor:switched.page_cursor,event_id:members.items[0]!.source.event_id});
  assert.equal(reasons.status,200,JSON.stringify(reasons.body));assert.deepEqual(reasons.body,members.items[0]!.source);
  const cursorKey=(await f.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0].cursor_key;
  const renewed=await f.ready(r.client,{recovery:{action:'renew',token:editUpdatesToken(switched.page_cursor,cursorKey,b=>b.expires=0)}});
  for(const field of ['id','scope','definitions','reason','shared','personal'] as const)assert.deepEqual(renewed.traversal[field],switched.traversal[field]);
  const renewedMembers=await f.members(r.client,{cursor:editUpdatesToken(members.page_cursor,cursorKey,b=>b.expires=0),renew:true});
  assert.deepEqual(renewedMembers.items,members.items);
  assert.equal((await f.observer.query("SELECT to_regclass('loom.attention_views') AS relation")).rows[0].relation,null);
  const tables=(await f.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename")).rows.map(v=>v.tablename as string);
  const digest=async(name:string)=>createHash('sha256').update(JSON.stringify((await f.observer.query(`SELECT ${name==='resources'?"'{\"lifecycle_version\":1}'::jsonb || " : ''}to_jsonb(t) row FROM loom.${name} t ORDER BY to_jsonb(t)::text`)).rows)).digest('hex');
  const before=new Map<string,string>();for(const name of tables)before.set(name,await digest(name));
  await f.migrate();for(const name of tables)assert.equal(await digest(name),before.get(name),name+' changed on upgrade');
  for(const name of ['attention_mutes','attention_dismissals','attention_owners','attention_operations','attention_views','attention_members','attention_groups'])assert.equal((await f.observer.query(`SELECT count(*)::int n FROM loom.${name}`)).rows[0].n,0);
  await f.restart();assert.equal((await r.client.call('/api/v1/me/reading/state',read)).body.idempotency,'replayed');
  assert.equal((await r.client.call('/api/v1/me/following/state',follow.body)).body.idempotency,'replayed');
  assert.deepEqual((await f.page(r.client,{cursor:personal.page_cursor})).items,personal.items);
  assert.deepEqual((await f.changes(r.client,{cursor:shared.page_cursor})).items,shared.items);
  assert.deepEqual((await f.ready(r.client,{cursor:combined.page_cursor})).items.map(g=>g.id),combined.items.map(g=>g.id));
  assert.equal((await r.client.call('/api/v1/me/routine-updates/query',{cursor:combined.page_cursor})).body.error.code,'updates_token_invalid');
});

for(const boundary of ['source','revision','credential'] as const)for(const first of ['restriction','attention'] as const)test(`attention current ${boundary} guard: ${first} commits first`,{timeout:90000},async t=>{
  const control=gates(),f=await fixture(t,{transactionWrapper:control.wrapper}),r=await f.participant('attention_guard'),a=await f.artifact(),event=await f.event(a.revision_id);
  const body={idempotency_key:randomUUID(),inputs:[{kind:'shared_event',id:event,dismissed:true,expected_version:0}]};let attentionTransaction=false;
  const match=(sql:string,values:readonly unknown[])=>{
    if(sql.includes("set_config('transaction_timeout','15000ms',true)"))attentionTransaction=true;
    return boundary==='source'?sql==='SELECT id FROM loom.resources WHERE id=$1 FOR SHARE'&&values[0]===a.resource_id:
      boundary==='revision'?sql==='SELECT id FROM loom.revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE':attentionTransaction&&sql.includes('FROM loom.participant_credentials WHERE id = $1 OR id = (')&&values[0]===r.credential;
  };
  const gate=control.pause(match,first==='restriction'?'before':'after'),pending=r.client.call(f.endpoint+'/dismissals/state',body),pid=await bounded(gate.entered.promise),writer=barrier<number>();
  const restriction=f.database.transaction(async tx=>{
    writer.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);
    if(boundary==='source')await tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]);
    else if(boundary==='revision')await tx.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1",[a.revision_id]);
    else await tx.query("UPDATE loom.participant_credentials SET state='revoked' WHERE id=$1",[r.credential]);
  });
  try{if(first==='restriction')await restriction;else await blockedBy(f.observer,await writer.promise,pid);}
  finally{gate.release.release();}
  const result=await pending;await restriction;assert.equal(result.status,first==='attention'?200:404,JSON.stringify(result.body));
  assert.deepEqual((await f.observer.query('SELECT input_id,dismissed,version FROM loom.attention_dismissals WHERE participant_id=$1',[r.id])).rows,first==='attention'?[{input_id:event,dismissed:true,version:1}]:[]);
  if(first==='attention'&&boundary!=='credential')assert.equal((await r.client.call(f.endpoint+'/status',{idempotency_key:body.idempotency_key})).body.current[0].availability,'unavailable');
});

test('native immutable private HTTPS recovery survives process death after COMMIT and authorized credential replacement',{timeout:90000},async t=>{
  const committed=barrier(),release=barrier();let armed=false;
  const f=await fixture(t,{transactionWrapper:database=>({transaction:async work=>{const result=await database.transaction(work);
    if(armed&&result&&typeof result==='object'&&'operation_state' in result&&result.operation_state==='applied'){armed=false;committed.release();await bounded(release.promise);}return result;}})});
  const r=await f.participant('attention_native'),a=await f.artifact(),issue=async(replace:string|null)=>(await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:r.id,kind:'agent',purpose:null,label:'Attention recovery',replace_credential_id:replace})).body;
  const credential=await issue(null);await writeFile(f.directory+'/token',credential.secret,{mode:0o600});
  const args=['scripts/attention-client.mjs','--origin',f.origin,'--credential-file',f.directory+'/token','--ca',f.directory+'/cert.pem','--journal',f.directory+'/intent.json'];
  const run=async(action:string,extra:string[]=[])=>JSON.parse((await promisify(execFile)(process.execPath,[...args,'--action',action,...extra],{timeout:20000})).stdout);
  await run('prepare-mute',['--kind','artifact','--resource',a.resource_id,'--muted','true']);
  const original=await readFile(f.directory+'/intent.json','utf8');assert.ok(!original.includes(credential.secret));assert.equal((await stat(f.directory+'/intent.json')).mode&0o777,0o600);
  armed=true;const child=spawn(process.execPath,[...args,'--action','send'],{stdio:'ignore'}),exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try{await bounded(committed.promise);child.kill('SIGKILL');await exit;}finally{release.release();}
  await f.restart();assert.equal((await run('retry')).idempotency,'replayed');
  await f.mute(r.client,'artifact',a.resource_id,false,1);
  const recovered=await run('status');assert.equal(recovered.outcome.muted,true);assert.equal(recovered.current.muted,false);assert.equal(recovered.current.version,2);
  const replacement=await issue(credential.credential_id);await writeFile(f.directory+'/token',replacement.secret,{mode:0o600});assert.equal((await run('status')).current.version,2);
  await assert.rejects(run('lose-response'),(e:any)=>e.code===75);assert.equal(await readFile(f.directory+'/intent.json','utf8'),original);
  const event=await f.event(a.revision_id);await writeFile(f.directory+'/inputs.json',JSON.stringify([{kind:'shared_event',id:event,dismissed:true}]),{mode:0o600});
  const dismissArgs=[...args.slice(0,-2),'--journal',f.directory+'/dismiss.json'];
  await promisify(execFile)(process.execPath,[...dismissArgs,'--action','prepare-dismissal','--inputs-file',f.directory+'/inputs.json']);
  await promisify(execFile)(process.execPath,[...dismissArgs,'--action','send']);
  assert.equal(JSON.parse((await promisify(execFile)(process.execPath,[...dismissArgs,'--action','status'])).stdout).current[0].dismissed,true);
  await writeFile(f.directory+'/token',credential.secret,{mode:0o600});await assert.rejects(run('status'));
});

test('same-view attention refresh preserves captured subjects, Following, reason, group identity and both intervals',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_refresh'),a=await f.artifact();await f.follow(r.client,f.settings('artifact',a.resource_id));
  const view=await f.readyRoutine(r.client,{reason:'reply'}),group=view.items[0]!;
  await f.mute(r.client,'artifact',a.resource_id);await f.follow(r.client,f.settings('artifact',a.resource_id),false,1);
  await f.artifact();const hidden=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:view.page_cursor}});assert.deepEqual(hidden.items,[]);
  for(const field of ['id','scope','definitions','reason','shared','personal'] as const)assert.deepEqual(hidden.traversal[field],view.traversal[field],field);
  await f.mute(r.client,'artifact',a.resource_id,false,1);
  const restored=await f.readyRoutine(r.client,{recovery:{action:'attention_refresh',token:hidden.page_cursor}});assert.equal(restored.items[0]!.id,group.id);
  assert.equal(restored.traversal.settings_current,false);assert.equal(restored.items.length,1);
  const complete=await f.readyRoutine(r.client,{switch:{token:restored.page_cursor,selection:'complete'}});assert.ok(complete.checkpoint);
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1",[a.resource_id]));
  await f.mute(r.client,'artifact',a.resource_id,false,2);
  assert.equal((await r.client.call('/api/v1/me/routine-updates/query',{cursor:restored.page_cursor})).body.error.code,'updates_visibility_replay_required','source recovery precedes private filters');
  await f.database.transaction(tx=>tx.query("UPDATE loom.resources SET state='active' WHERE id=$1",[a.resource_id]));
  const replay=await f.readyRoutine(r.client,{recovery:{action:'replay',token:complete.page_cursor}});assert.equal(replay.items[0]!.id===group.id,false);assert.equal((await f.allRoutineMembers(r.client,replay.records_cursor!))[0]!.source.revision_id,a.revision_id);
});

test('continuing main claims stay dismissed across remove/re-add while revision-owned note signals stay independently eligible',{timeout:90000},async t=>{
  const f=await fixture(t),r=await f.participant('attention_claims');
  const a=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Claims',content:mentioned(r.id),change_note:null,change_account:null});await f.drain();
  const view=await f.readyRoutine(r.client,{scope:{kind:'personal'}}),selection=await f.selection(r.client,view.page_cursor,view.items[0]!.id);await f.dismiss(r.client,f.fromSelection(selection));
  const plain=await f.publish(f.admin,'/api/v1/revisions',{resource_id:a.resource_id,expected_revision_id:a.revision_id,title:'Mention removed',
    content:{format:'loom-markdown-v3',text:'Mention removed',mentions:[],references:[]},change_note:null,change_account:null});
  await f.publish(f.admin,'/api/v1/revisions',{resource_id:a.resource_id,expected_revision_id:plain.revision_id,title:'Mention returns',content:mentioned(r.id),
    change_note:{format:'loom-markdown-v2',text:'New note [[mention:n]]',mentions:[{token:'n',participant_id:r.id}],references:[]},change_account:null});await f.drain();
  const next=await f.readyRoutine(r.client,{scope:{kind:'personal'}});assert.equal(next.items[0]!.counts.personal_signals,1);
  assert.deepEqual(next.items[0]!.direct_sources[0]!.personal!.reasons.map(v=>v.kind),['note_mention']);
  const personal=await f.page(r.client);assert.equal(personal.items.length,2);assert.equal(personal.items[0]!.delivery_id,selection.inputs[0]!.id);
});
