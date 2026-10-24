#!/usr/bin/env node
// One immutable, fsynced intent per file. A new opposite action needs a new file;
// a restart/retry never changes the old target, version, desired state or key.
import { request } from 'node:https';
import { readFile, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

async function main() {
  const options = new Map();
  const allowed = ['--origin','--credential-file','--ca','--journal','--action','--kind','--resource','--revision','--saved'];
  for (let i=2; i<process.argv.length; i+=2) {
    if (!allowed.includes(process.argv[i]) || !process.argv[i+1] || options.has(process.argv[i])) throw new Error('Invalid options.');
    options.set(process.argv[i], process.argv[i+1]);
  }
  if (!options.get('--origin') || !options.get('--credential-file'))
    throw new Error('Usage: --origin https://host --credential-file /private/token --action list|prepare|send|retry|status|lose-response [--journal /private/intent.json --kind discussion|contribution|artifact|revision --resource UUID --revision UUID --saved true|false] [--ca /private/ca.pem]');
  const origin = new URL(options.get('--origin'));
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('An exact HTTPS origin is required.');
  const token = (await readFile(options.get('--credential-file'),'utf8')).trim();
  const ca = options.get('--ca') ? await readFile(options.get('--ca')) : undefined;
  async function call(path, body) {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      const outgoing = request(new URL(path, origin), { ...(ca ? {ca} : {}), method: encoded ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, ...(encoded ? {'content-type':'application/json','content-length':Buffer.byteLength(encoded)} : {}) } }, incoming => {
        const chunks=[]; let size=0;
        incoming.on('data', chunk => { size+=chunk.length; if(size>131072) incoming.destroy(new Error('Response exceeded the release bound.')); else chunks.push(chunk); });
        incoming.on('error',reject);
        incoming.on('end',()=> { try {
          const value=JSON.parse(Buffer.concat(chunks).toString());
          if(incoming.statusCode!==200) throw new Error(`HTTP ${incoming.statusCode}: ${value.error?.code ?? 'unknown'}. Preserve the journal.`);
          resolve(value);
        } catch(error){reject(error);} });
      });
      outgoing.on('error',reject);
      outgoing.setTimeout(15000,()=>outgoing.destroy(new Error('Timeout is not rollback. Preserve the journal.')));
      outgoing.end(encoded);
    });
  }
  const self=await call('/api/v1/identity/self'), community=await call('/api/v1/community');
  if(self.kind!=='agent' || community.profile!=='synthetic' || !['2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17'].includes(community.guide_revision)) throw new Error('This trial requires a synthetic agent and supported guide 2 through 17.');
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id};
  const action=options.get('--action');
  if(action==='list') {
    const page=await call('/api/v1/me/saved-items?limit=25');
    // One bounded page, never claim that an unfinished traversal is complete.
    console.log(JSON.stringify({client_hostname:hostname(),...scope,page})); return;
  }
  if(!['prepare','send','retry','status','lose-response'].includes(action) || !options.get('--journal')) throw new Error('A known action and journal path are required.');
  const file=resolve(options.get('--journal'));
  let journal;
  if(action==='prepare') {
    const kind=options.get('--kind'), resource=options.get('--resource'), revision=options.get('--revision');
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if(!['discussion','contribution','artifact','revision'].includes(kind) || !uuid.test(resource ?? '') ||
      (kind==='revision' ? !uuid.test(revision ?? '') : revision!==undefined) || !['true','false'].includes(options.get('--saved')))
      throw new Error('Choose an exact valid target and explicit desired boolean state.');
    const target={kind,resource_id:resource.toLowerCase(),...(kind==='revision'?{revision_id:revision.toLowerCase()}:{})};
    const current=await call('/api/v1/me/saved-items/lookup',target);
    journal={version:1,...scope,operation_kind:'saved.set',body:{target,saved:options.get('--saved')==='true',expected_version:current.version,idempotency_key:randomUUID()}};
    const handle=await open(file,'wx',0o600);
    try {await handle.writeFile(JSON.stringify(journal)+'\n');await handle.sync();} finally{await handle.close();}
    const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
  } else journal=JSON.parse(await readFile(file,'utf8'));
  if(journal.version!==1 || journal.operation_kind!=='saved.set' || Object.entries(scope).some(([key,value])=>journal[key]!==value))
    throw new Error('Journal belongs to a different origin, instance or participant. Nothing sent.');
  let result;
  if(action==='status') result=await call('/api/v1/me/saved-items/status',{idempotency_key:journal.body.idempotency_key});
  else if(['send','retry','lose-response'].includes(action)) {
    result=await call('/api/v1/me/saved-items/state',journal.body);
    if(action==='lose-response') {
      console.log(JSON.stringify({test:'acknowledgement_discarded',client_hostname:hostname(),...scope})); process.exitCode=75; return;
    }
  }
  console.log(JSON.stringify({action,client_hostname:hostname(),...scope,operation_key:journal.body.idempotency_key,...(result?{result}:{})}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
