import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { QueryResultRow } from 'pg';
import { syntheticServer } from '../helpers/participation-server.js';
import { httpClient } from '../helpers/participation-http.js';
import { SearchWorker } from '../../src/server/modules/search/worker.js';
import { createApplication } from '../../src/server/http/app.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});

test('search expiry, unsupported work, disclosure-safe failure and independent capacity limits',{timeout:120000},async t=>{
  let timedQuery=false;
  const server=await syntheticServer({transactionWrapper:database=>({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
    if(timedQuery&&sql.includes('SELECT e.id,e.search_kind'))await tx.query('SELECT pg_sleep(10)',[]);
    return tx.query<Row>(sql,values);
  }}))})});
  let restarted:Awaited<ReturnType<typeof createApplication>>|undefined;
  t.after(async()=>{await restarted?.close();await server.close();});
  const cert=await readFile(server.directory+'/cert.pem','utf8'),admin=httpClient(server.origin,cert);await admin.enroll(server.ticket);
  assert.equal((await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Limits trial',ordinary_area_name:'General',proposal_area_name:'Feedback',overview:content('Overview')})).status,201);
  const area=(await admin.call('/api/v1/areas')).body.items.find((r:any)=>r.title==='General').id;
  const publications:{resource_id:string;revision_id:string}[]=[];for(let i=0;i<14;i++){const p=await admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Bounded common',content:content('common 🧭 multibyte')});assert.equal(p.status,201);publications.push(p.body);}
  const worker=new SearchWorker(server.database);await worker.tick();
  const first=await admin.call('/api/v1/search?q=common&limit=1');assert.equal(first.status,200);assert.ok(first.body.next_cursor);
  const cursorPath='/api/v1/search?'+new URLSearchParams({q:'common',limit:'1',cursor:first.body.next_cursor});
  await t.test('stable ties are resource UUID ordered and an expired cursor fails explicitly',async child=>{
    const all=await admin.call('/api/v1/search?q=common&limit=25');assert.equal(all.status,200);
    assert.deepEqual(all.body.items.map((r:any)=>r.source_resource_id),publications.map(p=>p.resource_id).sort());
    const now=Date.now();child.mock.method(Date,'now',()=>now+301000);
    const expired=await admin.call(cursorPath);assert.equal(expired.status,409);assert.equal(expired.body.error.code,'search_changed');
  });
  await t.test('database query timeout is 503 without an empty successful result or SQL details',async()=>{
    timedQuery=true;try{const response=await admin.call('/api/v1/search?q=common');assert.equal(response.status,503);assert.equal(response.body.items,undefined);assert.ok(!JSON.stringify(response.body).includes('pg_sleep'));}finally{timedQuery=false;}
  });
  await t.test('API instance restart invalidates old cursors while retained sources stay readable',async()=>{
    await server.app.close();restarted=await createApplication({database:{isReady:()=>server.database.isReady(),close:async()=>{}},logger:false,
      tls:{cert,key:await readFile(server.directory+'/key.pem','utf8')},participation:{database:server.database,authentication:server.authentication,administration:server.administration}});
    await restarted.listen({host:'127.0.0.1',port:Number(new URL(server.origin).port)});
    assert.equal((await admin.call(cursorPath)).status,409);
    assert.equal((await admin.call('/api/v1/resources/'+publications[0]!.resource_id)).status,200);
  });
  await t.test('unsupported event work is retained as failed and administrator retry cannot silently succeed',async()=>{
    const event=randomUUID();await server.database.transaction(async tx=>{
      const position=(await tx.query<{position:string}>('UPDATE loom.community_clocks SET shared_position=shared_position+1 WHERE id=1 RETURNING shared_position::text AS position',[])).rows[0]!.position;
      // This deliberately inconsistent event/intent pair is private fault data.
      await tx.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids) VALUES ($1,$2,'organization.changed',$3,NULL,$4,$5,$5,$5)",[event,position,area,server.administratorId,[area]]);
      await tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES ($1,$2,'publication.project')",[randomUUID(),event]);
    });
    await worker.discover();let id='';for(let i=0;i<3;i++){
      const claim=(await worker.claim()).find(c=>c.kind==='unsupported')!;assert.ok(claim);id=claim.id;await worker.process(claim);
      if(i<2)await server.observer.query('UPDATE loom.search_jobs SET due_at=clock_timestamp() WHERE id=$1',[id]);
    }
    const failed=await admin.call('/api/v1/admin/search/failures');assert.equal(failed.status,200);const row=failed.body.items.find((r:any)=>r.id===id);assert.equal(row.failure,'unsupported_event');assert.equal(row.attempts,3);
    const participantStatus=await admin.call('/api/v1/search/status');assert.equal(participantStatus.body.coverage,'current_supported_text');assert.ok(!JSON.stringify(participantStatus.body).includes(id));
    const retry={id,claim_generation:row.claim_generation};assert.equal((await admin.call('/api/v1/admin/search/retry',retry)).status,200);assert.equal((await admin.call('/api/v1/admin/search/retry',retry)).status,200);
    const current=(await server.observer.query('SELECT state,attempts,claim_generation FROM loom.search_jobs WHERE id=$1',[id])).rows[0];assert.deepEqual(current,{state:'pending',attempts:0,claim_generation:row.claim_generation+1});
  });
  await t.test('retained work cap refuses new discovery without evicting jobs',async()=>{
    const p=publications[0]!;await server.database.transaction(tx=>tx.query(`INSERT INTO loom.search_jobs(generation,resource_id,revision_id,kind)
      SELECT n,$1,$2,'revision' FROM generate_series(100000,149999) n`,[p.resource_id,p.revision_id]));
    const count=(await server.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs')).rows[0].n;
    assert.equal((await worker.discover()).limited,true);assert.equal((await server.observer.query('SELECT count(*)::int AS n FROM loom.search_jobs')).rows[0].n,count);
    assert.equal((await admin.call('/api/v1/admin/search/health')).body.capacity_limited,true);
  });
  await t.test('corpus work cap fails independently of a tiny item limit and direct retrieval remains available',async()=>{
    await server.database.transaction(async tx=>{
      await tx.query(`WITH sources AS (INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id)
        SELECT gen_random_uuid(),'artifact',$1,$2 FROM generate_series(1,5001) RETURNING id)
        INSERT INTO loom.artifacts SELECT id FROM sources`,[area,server.administratorId]);
      await tx.query(`INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text,title)
        SELECT gen_random_uuid(),id,1,$1,'loom-markdown-v1','synthetic overflow','Limit fixture' FROM loom.resources WHERE kind='artifact' AND current_revision_id IS NULL`,[server.administratorId]);
      await tx.query('UPDATE loom.resources r SET current_revision_id=v.id FROM loom.revisions v WHERE r.id=v.resource_id AND r.current_revision_id IS NULL',[]);
    });
    const result=await admin.call('/api/v1/search?q=common&limit=1');assert.equal(result.status,429);assert.equal(result.body.error.code,'search_work_limit');assert.equal(result.body.items,undefined);
    assert.equal((await admin.call('/api/v1/resources/'+publications[0]!.resource_id)).status,200);
  });
});

test('synthetic preview supervises terminal worker stop/start while HTTPS stays available',{timeout:60000},async t=>{
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../scripts/synthetic-participation.ts',import.meta.url))],{
    env:{...process.env,LOOM_SYNTHETIC_PORT:'0'},stdio:['pipe','pipe','pipe'],
  });
  const closed=once(child,'close'),lines:string[]=[];let pending='';
  const listeners=new Set<()=>void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{pending+=chunk;const received=pending.split('\n');pending=received.pop()!;lines.push(...received);for(const wake of listeners)wake();});
  child.stderr.resume();
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;});
  const line=(prefix:string)=>new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>{listeners.delete(check);reject(new Error('Preview control deadline'));},15000);
    const check=()=>{const index=lines.findIndex(value=>value.startsWith(prefix));if(index>=0){clearTimeout(timer);listeners.delete(check);resolve(lines.splice(index,1)[0]!);}};
    listeners.add(check);check();
  });
  const preview=await line('Synthetic participation preview: ');
  const origin=preview.replace('Synthetic participation preview: ','').replace('/loom','');
  const certificate=(await line('Local self-signed TLS certificate: ')).replace('Local self-signed TLS certificate: ','');
  const client=httpClient(origin,await readFile(certificate,'utf8'));
  assert.equal((await client.call('/health/ready')).status,200);
  child.stdin.write('worker stop\n');await line('Search worker stopped; API remains available.');
  assert.equal((await client.call('/health/ready')).status,200);
  child.stdin.write('worker start\n');await line('Search worker started.');
  assert.equal((await client.call('/health/ready')).status,200);
  child.stdin.write('notifications stop\n');await line('Notification worker stopped; search and API remain available.');
  assert.equal((await client.call('/health/ready')).status,200);
  child.stdin.write('notifications start\n');await line('Notification worker started.');
  assert.equal((await client.call('/health/ready')).status,200);
  child.kill('SIGTERM');assert.deepEqual(await closed,[0,null]);
  await assert.rejects(stat(certificate),{code:'ENOENT'});
});
