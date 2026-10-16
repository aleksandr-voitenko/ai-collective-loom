import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile,writeFile,unlink,stat } from 'node:fs/promises';
import { fixture } from '../helpers/following.js';

test('independent HTTPS and compiled API processes replay displayed shared pages and resize exact successors',{timeout:90000},async t=>{
  const f=await fixture(t),reader=await f.participant('external_shared'),expected:string[]=[];
  for(let n=0;n<4;n++){const source=await f.artifact(f.admin,'External shared '+n);expected.push(await f.event(source.revision_id));await f.follow(reader.client,f.settings('artifact',source.resource_id));}
  const credential=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:reader.id,kind:'agent',purpose:null,label:'Independent shared client',replace_credential_id:null});assert.equal(credential.status,200);
  const token=f.directory+'/shared-token',journal=f.directory+'/shared.json';await writeFile(token,credential.body.secret,{mode:0o600});
  const run=async(action:string,limit?:number,file=journal)=>JSON.parse((await promisify(execFile)(process.execPath,
    ['scripts/shared-changes-client.mjs','--origin',f.origin,'--credential-file',token,'--ca',f.directory+'/cert.pem','--journal',file,'--action',action,...(limit===undefined?[]:['--limit',String(limit)])],{timeout:20000})).stdout);
  const ids=(page:any)=>page.items.map((item:any)=>item.event_id);
  const first=await run('read',1),saved=await readFile(journal,'utf8');assert.deepEqual(ids(first),expected.slice(0,1));
  assert.equal(JSON.parse(saved).cursor,first.page_cursor);assert.ok(!saved.includes(credential.body.secret));assert.ok(!saved.includes('External shared'));assert.equal((await stat(journal)).mode&0o777,0o600);
  await f.app.close();
  async function api(){
    const c=f.configuration,child=spawn(process.execPath,['dist/server/main.js'],{env:{...process.env,LOOM_API_HOST:'127.0.0.1',LOOM_API_PORT:new URL(f.origin).port,LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password,LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_ORIGIN:f.origin,LOOM_TLS_KEY_FILE:f.directory+'/key.pem',LOOM_TLS_CERT_FILE:f.directory+'/cert.pem'},stdio:['ignore','pipe','pipe']});
    const exit=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;});
    await new Promise<void>((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Native shared API startup deadline')),10000);child.stdout.on('data',bytes=>{if(bytes.toString().includes('application_started')){clearTimeout(deadline);resolve();}});child.once('exit',()=>{clearTimeout(deadline);reject(new Error('Native shared API startup failed'));});});
    return async()=>{child.kill('SIGTERM');assert.equal((await exit)[0],0);};
  }
  let stop=await api();assert.deepEqual((await run('read')).items,first.items);
  const second=await run('next',2);assert.deepEqual(ids(second),expected.slice(1,3));await stop();stop=await api();
  assert.deepEqual((await run('read')).items,second.items);
  assert.deepEqual(ids(await run('next',2,f.directory+'/independent.json')),expected.slice(0,2));
  await writeFile(journal+'.lock','Owned synthetic competing process');const before=await readFile(journal,'utf8');
  await assert.rejects(run('next'),/Another reader holds/);assert.equal(await readFile(journal,'utf8'),before);await unlink(journal+'.lock');
  const third=await run('next',1);assert.deepEqual(ids(third),expected.slice(3));assert.equal(third.interval_complete,true);
  const legacy=JSON.parse(await readFile(journal,'utf8'));delete legacy.next_cursor;delete legacy.checkpoint;await writeFile(journal,JSON.stringify(legacy));
  await assert.rejects(run('next'),/saved page boundary is unavailable/);assert.deepEqual(ids(await run('read')),expected.slice(3));
  assert.deepEqual(ids(await run('next')),[]);assert.deepEqual(ids(await run('replay')),expected.slice(0,1));
  const replacement=await f.admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:reader.id,kind:'agent',purpose:null,label:'Replacement shared client',replace_credential_id:credential.body.credential_id});assert.equal(replacement.status,200);
  await writeFile(token,replacement.body.secret,{mode:0o600});assert.deepEqual(ids(await run('read')),expected.slice(0,1));await stop();
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.personal_deliveries')).rows[0].n,0);
  assert.equal((await f.observer.query('SELECT count(*)::int n FROM loom.following_targets WHERE participant_id=$1 AND following',[reader.id])).rows[0].n,4);
});
