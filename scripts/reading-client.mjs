#!/usr/bin/env node
// Immutable per-command journal: concurrent senders can only replay the same body.
import { request } from 'node:https';
import { readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--resource','--revision','--read'];
  for(let i=2;i<process.argv.length;i+=2){if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error('Invalid options.');options.set(process.argv[i],process.argv[i+1]);}
  const origin=new URL(options.get('--origin'));
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error('Use an exact HTTPS origin.');
  const token=(await readFile(options.get('--credential-file'),'utf8')).trim(),ca=options.get('--ca')?await readFile(options.get('--ca')):undefined;
  async function call(path,body){return new Promise((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    const req=request(new URL(path,origin),{...(ca?{ca}:{}),method:encoded?'POST':'GET',headers:{authorization:`Bearer ${token}`,
      ...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{})}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072)res.destroy(new Error('Response exceeds release bound.'));else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString());
        if(res.statusCode!==200)throw new Error(`HTTP ${res.statusCode}. Preserve the exact journal for reconciliation.`);resolve(result);
      }catch(error){reject(error);}});
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('Timeout is uncertain. Preserve the journal.')));req.end(encoded);
  });}
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(community.profile!=='synthetic'||community.reading_contract!=='reading-state-1')throw new Error('This example requires the synthetic reading-state-1 contract.');
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  function target(){const resource=options.get('--resource'),revision=options.get('--revision');
    if(!uuid.test(resource??'')||!uuid.test(revision??''))throw new Error('Choose an exact resource/revision pair.');return {resource_id:resource.toLowerCase(),revision_id:revision.toLowerCase()};}
  if(action==='lookup'){console.log(JSON.stringify(await call('/api/v1/me/reading/lookup',{targets:[target()]})));return;}
  if(!['prepare','send','retry','status','lose-response'].includes(action)||!options.get('--journal'))throw new Error('Use lookup, prepare, send, retry, status or lose-response with a private journal path.');
  const file=resolve(options.get('--journal'));let journal;
  if(action==='prepare'){
    if(!['true','false'].includes(options.get('--read')))throw new Error('Use explicit --read true or false.');
    const selected=target(),current=await call('/api/v1/me/reading/lookup',{targets:[selected]});
    journal={version:1,...scope,contract:'reading-state-1',body:{idempotency_key:randomUUID(),basis:'manual',episode_id:null,
      targets:[{...selected,read:options.get('--read')==='true',expected_version:current.items[0].version}]}};
    const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(journal)+'\n');await handle.sync();}finally{await handle.close();}
    const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
  }else{const raw=await readFile(file,'utf8');if(Buffer.byteLength(raw)>16384)throw new Error('Journal exceeds release bound.');journal=JSON.parse(raw);}
  if(journal.version!==1||journal.contract!=='reading-state-1'||Object.entries(scope).some(([key,value])=>journal[key]!==value)||!uuid.test(journal.body?.idempotency_key??''))throw new Error('Incompatible journal or owner. Nothing sent.');
  if(action==='prepare'){console.log(JSON.stringify({action,operation_key:journal.body.idempotency_key}));return;}
  const result=await call('/api/v1/me/reading/'+(action==='status'?'status':'state'),action==='status'?{idempotency_key:journal.body.idempotency_key}:journal.body);
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Reading client failed. Preserve the journal; check origin, current credential, exact input and service availability.');process.exitCode=1;});
