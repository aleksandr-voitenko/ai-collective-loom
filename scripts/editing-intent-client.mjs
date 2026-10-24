#!/usr/bin/env node
// One fsynced, immutable, identity-scoped private journal per deliberate command.
import {request} from 'node:https';
import {readFile,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--kind','--input','--resource','--limit','--cursor','--output'];
  for(let i=2;i<process.argv.length;i+=2){if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();options.set(process.argv[i],process.argv[i+1]);}
  const origin=new URL(options.get('--origin'));if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();
  const token=(await readFile(options.get('--credential-file'),'utf8')).trim(),ca=options.has('--ca')?await readFile(options.get('--ca')):undefined;
  async function call(path,body){return new Promise((resolve,reject)=>{
    if(body!==undefined&&Buffer.byteLength(body)>4096){reject(new Error());return;}
    const req=request(new URL(path,origin),{...(ca?{ca}:{}),method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,
      ...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(body)})}},res=>{
      let bytes=0;const chunks=[];res.on('data',chunk=>{bytes+=chunk.length;if(bytes>131072)res.destroy(new Error());else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw new Error();resolve(value);}catch(e){reject(e);}});
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error()));req.end(body);
  });}
  async function persist(path,value){const file=resolve(path),raw=JSON.stringify(value)+'\n',handle=await open(file,'wx',0o600);
    try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
    const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
    if(await readFile(file,'utf8')!==raw)throw new Error();
  }
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(community.profile!=='synthetic')throw new Error();
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action'),base='/api/v1/editing-intent';
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(action==='inspect'){
    const id=options.get('--resource');if(!uuid.test(id??''))throw new Error();const query=new URLSearchParams();
    if(options.has('--limit')){const limit=options.get('--limit');if(!/^(?:[1-9]|1[0-9]|2[0-5])$/.test(limit))throw new Error();query.set('limit',limit);}
    if(options.has('--cursor')){const cursor=options.get('--cursor');if(cursor.length>2048)throw new Error();query.set('cursor',cursor);}
    const result=await call(base+'/resources/'+id+'?'+query);await persist(options.get('--output'),result);
    console.log(JSON.stringify({action,complete:result.complete,next_cursor:result.next_cursor}));return;
  }
  if(action==='prepare'){
    const kind=options.get('--kind');if(!['announce','renew','release'].includes(kind))throw new Error();
    const raw=await readFile(options.get('--input'),'utf8');if(Buffer.byteLength(raw)>4096)throw new Error();const input=JSON.parse(raw);
    if('idempotency_key' in input)throw new Error();const command={...input,idempotency_key:randomUUID()},bytes=JSON.stringify(command);
    if(Buffer.byteLength(bytes)>4096)throw new Error();
    await persist(options.get('--journal'),{version:1,contract:'editing-intent-1',...scope,action:kind,request:bytes});
    console.log(JSON.stringify({action,operation_key:command.idempotency_key}));return;
  }
  if(!['send','retry','status','lose-response'].includes(action))throw new Error();
  const raw=await readFile(options.get('--journal'),'utf8');if(Buffer.byteLength(raw)>8192)throw new Error();const journal=JSON.parse(raw);
  if(journal.version!==1||journal.contract!=='editing-intent-1'||Object.entries(scope).some(([k,v])=>journal[k]!==v)||
    !['announce','renew','release'].includes(journal.action)||typeof journal.request!=='string')throw new Error();
  const body=JSON.parse(journal.request);if(!uuid.test(body.idempotency_key??''))throw new Error();
  const result=await call(base+'/'+(action==='status'?'status':journal.action),action==='status'?JSON.stringify({action:journal.action,idempotency_key:body.idempotency_key}):journal.request);
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Editing intent request failed. Preserve the exact journal; verify input, identity and service availability. Publication remains independent.');process.exitCode=1;});
