#!/usr/bin/env node
// One immutable private file per command: simultaneous senders only replay it.
import { request } from 'node:https';
import { readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--resource','--suppressed','--limit','--cursor'];
  for(let i=2;i<process.argv.length;i+=2){
    if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();
    options.set(process.argv[i],process.argv[i+1]);
  }
  const origin=new URL(options.get('--origin'));
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();
  const token=(await readFile(options.get('--credential-file'),'utf8')).trim(),ca=options.get('--ca')?await readFile(options.get('--ca')):undefined;
  async function call(path,body){return new Promise((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body);
    if(encoded&&Buffer.byteLength(encoded)>4096){reject(new Error());return;}
    const req=request(new URL(path,origin),{...(ca?{ca}:{}),method:encoded?'POST':'GET',headers:{authorization:`Bearer ${token}`,
      ...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{})}},res=>{
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072)res.destroy(new Error());else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{
        if(res.statusCode!==200)throw new Error();
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      }catch(error){reject(error);}});
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error()));req.end(encoded);
  });}
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(community.profile!=='synthetic'||community.moderation_contract!=='moderation-state-1'||self.role!=='administrator')throw new Error();
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action');
  const base='/api/v1/admin/moderation',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(action==='list'||action==='audit'){
    const query=new URLSearchParams(),limit=options.get('--limit'),cursor=options.get('--cursor');
    if(limit!==undefined){if(!/^(?:[1-9]|1[0-9]|2[0-5])$/.test(limit))throw new Error();query.set('limit',limit);}
    if(cursor!==undefined){if(cursor.length>2048)throw new Error();query.set('cursor',cursor);}
    console.log(JSON.stringify(await call(base+(action==='list'?'/targets':'/audit')+'?'+query.toString())));return;
  }
  if(options.has('--limit')||options.has('--cursor'))throw new Error();
  if(!['prepare','send','retry','status','lose-response','inspect'].includes(action))throw new Error();
  if(action==='inspect'){
    if(!uuid.test(options.get('--resource')??''))throw new Error();
    console.log(JSON.stringify(await call(base+'/resources/'+options.get('--resource'))));return;
  }
  const file=resolve(options.get('--journal'));let journal;
  if(action==='prepare'){
    if(!uuid.test(options.get('--resource')??'')||!['true','false'].includes(options.get('--suppressed')))throw new Error();
    const current=await call(base+'/resources/'+options.get('--resource'));
    journal={version:1,...scope,contract:'moderation-state-1',command:{idempotency_key:randomUUID(),target:current.target,
      suppressed:options.get('--suppressed')==='true',expected_version:current.version}};
    const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(journal)+'\n');await handle.sync();}finally{await handle.close();}
    const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
    if(JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(journal))throw new Error();
    console.log(JSON.stringify({action,operation_key:journal.command.idempotency_key}));return;
  }
  const raw=await readFile(file,'utf8');if(Buffer.byteLength(raw)>4096)throw new Error();journal=JSON.parse(raw);
  if(journal.version!==1||journal.contract!=='moderation-state-1'||Object.entries(scope).some(([key,value])=>journal[key]!==value)||
    !uuid.test(journal.command?.idempotency_key??''))throw new Error();
  const result=await call(base+(action==='status'?'/status':'/state'),action==='status'?{idempotency_key:journal.command.idempotency_key}:journal.command);
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Moderation client failed. Preserve the exact journal; verify origin, current administrator authority, input and service availability.');process.exitCode=1;});
