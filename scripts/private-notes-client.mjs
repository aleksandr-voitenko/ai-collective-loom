#!/usr/bin/env node
// One fsynced, immutable, identity-scoped private journal per deliberate command.
import {request} from 'node:https';
import {readFile,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--kind','--input','--note','--output'];
  for(let i=2;i<process.argv.length;i+=2){if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();options.set(process.argv[i],process.argv[i+1]);}
  const origin=new URL(options.get('--origin'));if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();
  const token=(await readFile(options.get('--credential-file'),'utf8')).trim(),ca=options.has('--ca')?await readFile(options.get('--ca')):undefined;
  async function call(path,body){return new Promise((resolve,reject)=>{
    if(body!==undefined&&Buffer.byteLength(body)>131072){reject(new Error());return;}
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
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action'),base='/api/v1/me/notes';
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(['read','sources','query'].includes(action)){
    let result;
    if(action==='query') {
      const raw=await readFile(options.get('--input'),'utf8');if(Buffer.byteLength(raw)>4096)throw new Error();
      const input=JSON.parse(raw);result=await call(base+'/query',JSON.stringify(input));
    } else {
      const id=options.get('--note');if(!uuid.test(id??''))throw new Error();
      result=await call(base+'/'+id+(action==='sources'?'/sources':''));
    }
    await persist(options.get('--output'),result);
    console.log(JSON.stringify({action,private_output_written:true}));return;
  }
  if(action==='prepare'){
    const kind=options.get('--kind');if(!['create','update','delete'].includes(kind))throw new Error();
    const raw=await readFile(options.get('--input'),'utf8');if(Buffer.byteLength(raw)>131072)throw new Error();const input=JSON.parse(raw);
    if('idempotency_key' in input)throw new Error();const command={...input,...(kind==='create'&&!input.note_id?{note_id:randomUUID()}:{}),idempotency_key:randomUUID()},bytes=JSON.stringify(command);
    if(!uuid.test(command.note_id??''))throw new Error();
    if(Buffer.byteLength(bytes)>131072)throw new Error();
    await persist(options.get('--journal'),{version:1,contract:'owner-notes-1',...scope,action:kind,request:bytes});
    console.log(JSON.stringify({action,operation_key:command.idempotency_key,note_id:command.note_id}));return;
  }
  if(!['send','retry','status','lose-response'].includes(action))throw new Error();
  const raw=await readFile(options.get('--journal'),'utf8');if(Buffer.byteLength(raw)>262144)throw new Error();const journal=JSON.parse(raw);
  if(journal.version!==1||journal.contract!=='owner-notes-1'||Object.entries(scope).some(([k,v])=>journal[k]!==v)||
    !['create','update','delete'].includes(journal.action)||typeof journal.request!=='string')throw new Error();
  const body=JSON.parse(journal.request);if(!uuid.test(body.idempotency_key??''))throw new Error();
  const result=await call(base+'/'+(action==='status'?'status':journal.action),action==='status'?JSON.stringify({action:journal.action,idempotency_key:body.idempotency_key}):journal.request);
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Private note request failed. Preserve the exact journal and private input/output files; verify current identity, version and service availability. A failed response does not prove rollback.');process.exitCode=1;});
