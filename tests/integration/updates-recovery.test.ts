import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile,writeFile,unlink,stat } from 'node:fs/promises';
import { fixture } from '../helpers/updates.js';
import { mentioned } from '../helpers/notifications.js';
import { gates } from '../helpers/updates-gates.js';
import { bounded } from '../helpers/search-races.js';

test('killed native readers release journal ownership while live readers stay exclusive',{timeout:90000},async t=>{
  const g=gates(),f=await fixture(t,{transactionWrapper:g.wrapper}),reader=await f.participant('updates_crash_reader'),source=await f.artifact();
  await f.revise(f.admin,source,'Another exact revision',[]);await f.follow(reader.client,f.settings('artifact',source.resource_id));
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:reader.id,kind:'agent',purpose:null,label:'Crash recovery reader',replace_credential_id:null});
  assert.equal(credential.status,200);
  const token=f.directory+'/updates-crash-token',journal=f.directory+'/updates-crash.json';
  await writeFile(token,credential.body.secret,{mode:0o600});
  const args=(action:string)=>['scripts/updates-client.mjs','--origin',f.origin,'--credential-file',token,'--ca',f.directory+'/cert.pem','--journal',journal,'--action',action,'--limit','1'];
  const run=async(action:string)=>JSON.parse((await promisify(execFile)(process.execPath,args(action),{timeout:20000})).stdout);
  await run('read');await run('next');await run('complete');const displayed=await run('members'),saved=await readFile(journal,'utf8');
  const held=g.pause(sql=>sql.includes('WHERE u.id=1'),'after'),child=spawn(process.execPath,args('read'),{stdio:'ignore'}),exit=once(child,'exit');
  t.after(async()=>{held.release.release();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
  try{
    await bounded(held.entered.promise);
    await assert.rejects(run('read'),/Another reader holds this journal/);
    assert.equal(await readFile(journal,'utf8'),saved);
    child.kill('SIGKILL');assert.deepEqual(await exit,[null,'SIGKILL']);
  }finally{held.release.release();}
  const recovered=await run('read');
  assert.deepEqual(recovered.overview.items,displayed.overview.items.map((item:any)=>({...item,
    members_cursor:recovered.overview.items.find((g:any)=>g.id===item.id).members_cursor,
    direct_cursor:recovered.overview.items.find((g:any)=>g.id===item.id).direct_cursor})));
  assert.deepEqual(recovered.members.items,displayed.members.items);
  assert.equal(recovered.members.limit,displayed.members.limit);assert.equal(recovered.overview.traversal.id,displayed.overview.traversal.id);
  assert.equal((await stat(journal+'.lock.sqlite')).mode&0o777,0o600);
  assert.equal((await run('next-members')).members.complete,true);
});

test('independent HTTPS/API processes retain displayed groups and member pages while resizing successors',{timeout:120000},async t=>{
  const f=await fixture(t),reader=await f.participant('updates_native'),expected:string[]=[];
  for(let n=0;n<4;n++){
    const source=await f.artifact(f.admin,'Native group '+n);expected.push(await f.event(source.revision_id));
    const next=await f.revise(f.admin,source,'Native revision two',[]);expected.push(await f.event(next.revision_id));await f.follow(reader.client,f.settings('artifact',source.resource_id));
  }
  const outside=await f.publish(f.admin,'/api/v1/artifacts',{area_id:f.area,title:'Outside direct source',content:mentioned(reader.id),change_note:null,change_account:null});
  expected.push(await f.event(outside.revision_id));await f.drain();
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:reader.id,kind:'agent',purpose:null,label:'Updates native reader',replace_credential_id:null});assert.equal(credential.status,200);
  const token=f.directory+'/updates-token',journal=f.directory+'/updates.json';await writeFile(token,credential.body.secret,{mode:0o600});
  const run=async(action:string,limit?:number,file=journal)=>JSON.parse((await promisify(execFile)(process.execPath,
    ['scripts/updates-client.mjs','--origin',f.origin,'--credential-file',token,'--ca',f.directory+'/cert.pem','--journal',file,'--action',action,...(limit===undefined?[]:['--limit',String(limit)])],{timeout:20000})).stdout);
  await run('read',1);const highlights=await run('next',1),first=await run('complete',1);
  assert.equal(first.overview.items[0].counts.personal_signals,1);assert.equal(first.overview.traversal.id,highlights.overview.traversal.id);
  const saved=await readFile(journal,'utf8');assert.equal(JSON.parse(saved).overview.cursor,first.overview.page_cursor);assert.ok(!saved.includes(credential.body.secret));assert.ok(!saved.includes('Native group'));assert.equal((await stat(journal)).mode&0o777,0o600);
  await f.app.close();
  async function api(){
    const c=f.configuration,child=spawn(process.execPath,['dist/server/main.js'],{env:{...process.env,LOOM_API_HOST:'127.0.0.1',LOOM_API_PORT:new URL(f.origin).port,LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password,LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:f.origin,LOOM_TLS_KEY_FILE:f.directory+'/key.pem',LOOM_TLS_CERT_FILE:f.directory+'/cert.pem'},stdio:['ignore','pipe','pipe']});
    const exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
    await new Promise<void>((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Native Updates API startup deadline')),10000);child.stdout.on('data',bytes=>{if(bytes.toString().includes('application_started')){clearTimeout(deadline);resolve();}});child.once('exit',()=>{clearTimeout(deadline);reject(new Error('Native Updates API startup failed'));});});
    return async()=>{child.kill('SIGTERM');assert.equal((await exit)[0],0);};
  }
  let stop=await api();assert.equal((await run('read')).overview.items[0].id,first.overview.items[0].id);
  const groups=[first.overview.items[0].id];for(let i=0;i<2;i++){const page=await run('next',2);groups.push(...page.overview.items.map((g:any)=>g.id));}
  assert.equal(new Set(groups).size,5);
  const start=await run('members',1),seen=start.members.items.map((m:any)=>m.source.event_id);
  assert.equal(start.members.items[0].personal.source.revision_id,outside.revision_id);
  await stop();stop=await api();assert.deepEqual((await run('read')).members.items,start.members.items);
  let page=start;for(let i=0;i<10&&page.members.next_cursor;i++){page=await run('next-members',3);seen.push(...page.members.items.map((m:any)=>m.source.event_id));}
  assert.deepEqual(seen.sort(),expected.sort());assert.equal(page.members.complete,true);
  await writeFile(journal+'.lock','Synthetic competing process');const before=await readFile(journal,'utf8');
  await assert.rejects(run('newer'),/Legacy journal lock exists/);assert.equal(await readFile(journal,'utf8'),before);
  assert.equal(await readFile(journal+'.lock','utf8'),'Synthetic competing process');await unlink(journal+'.lock');
  const replacement=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:reader.id,kind:'agent',purpose:null,label:'Replacement Updates reader',replace_credential_id:credential.body.credential_id});assert.equal(replacement.status,200);
  await writeFile(token,replacement.body.secret,{mode:0o600});assert.deepEqual((await run('read')).members.items,page.members.items);
  const independent=f.directory+'/independent-updates.json';await run('read',2,independent);assert.equal((await run('next',2,independent)).overview.items[0].counts.personal_signals,1);
  assert.equal((await run('newer')).overview.items.length,0);await stop();
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.saved_items')).rows[0].n,0);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.following_targets WHERE participant_id=$1 AND following',[reader.id])).rows[0].n,4);
});
