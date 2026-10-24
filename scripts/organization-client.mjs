#!/usr/bin/env node
// Exact private custody, shared by the old and new organization command kinds.
import {request} from 'node:https';
import {readFile,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--resource','--input'];
  for(let i=2;i<process.argv.length;i+=2){
    if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();
    options.set(process.argv[i],process.argv[i+1]);
  }
  const origin=new URL(options.get('--origin'));
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();
  const token=(await readFile(options.get('--credential-file'),'utf8')).trim(),ca=options.get('--ca')?await readFile(options.get('--ca')):undefined;
  async function call(path,encoded){return new Promise((resolve,reject)=>{
    if(encoded&&Buffer.byteLength(encoded)>131072){reject(new Error());return;}
    const req=request(new URL(path,origin),{...(ca?{ca}:{}),method:encoded?'POST':'GET',headers:{authorization:`Bearer ${token}`,
      ...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{})}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072)res.destroy(new Error());else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{if(res.statusCode!==200)throw new Error();resolve(JSON.parse(Buffer.concat(chunks).toString()));}catch(error){reject(error);}});
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error()));req.end(encoded);
  });}
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(community.profile!=='synthetic'||community.contract_version!=='participation-1'||self.role!=='administrator')throw new Error();
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action');
  const base='/api/v1/organization',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(action==='inspect'){
    if(!uuid.test(options.get('--resource')??''))throw new Error();
    console.log(JSON.stringify(await call(base+'/resources/'+options.get('--resource'))));return;
  }
  if(!['prepare','send','retry','status','lose-response'].includes(action))throw new Error();
  const file=resolve(options.get('--journal'));let journal;
  if(action==='prepare'){
    const raw=await readFile(options.get('--input'),'utf8');if(Buffer.byteLength(raw)>131072)throw new Error();
    const command=JSON.parse(raw);
    if(!['area.create','area.edit','area.move','discussion.move','artifact.move','area.open','area.close','discussion.open','discussion.close'].includes(command.kind))throw new Error();
    command.idempotency_key??=randomUUID();if(!uuid.test(command.idempotency_key))throw new Error();
    journal={version:1,...scope,contract:'organization-v1',request:JSON.stringify(command)};
    if(Buffer.byteLength(journal.request)>131072)throw new Error();
    const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(journal)+'\n');await handle.sync();}finally{await handle.close();}
    const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
    if(JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(journal))throw new Error();
    console.log(JSON.stringify({action,kind:command.kind,operation_key:command.idempotency_key}));return;
  }
  const raw=await readFile(file,'utf8');if(Buffer.byteLength(raw)>262144)throw new Error();journal=JSON.parse(raw);
  if(journal.version!==1||journal.contract!=='organization-v1'||Object.entries(scope).some(([k,v])=>journal[k]!==v)||typeof journal.request!=='string')throw new Error();
  const command=JSON.parse(journal.request);if(!uuid.test(command.idempotency_key??''))throw new Error();
  const result=await call(base+(action==='status'?'/status':'/changes'),action==='status'?JSON.stringify({kind:command.kind,idempotency_key:command.idempotency_key}):journal.request);
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Organization client failed. Preserve the exact journal; verify origin, current administrator authority, input and service availability.');process.exitCode=1;});
