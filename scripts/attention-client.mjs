#!/usr/bin/env node
// Immutable per-command journal: concurrent senders can only replay the same body.
import { request } from 'node:https';
import { readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--resource','--kind','--muted','--descendants','--inputs-file','--selection-file'];
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
  if(community.profile!=='synthetic'||community.attention_contract!=='attention-controls-1')throw new Error('This example requires the synthetic attention-controls-1 contract.');
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action');
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  function target(){const resource=options.get('--resource'),kind=options.get('--kind');
    if(!uuid.test(resource??'')||!['area','discussion','artifact'].includes(kind))throw new Error('Choose an area, discussion or artifact identity.');return {kind,resource_id:resource.toLowerCase()};}
  if(action==='lookup-mute'){console.log(JSON.stringify(await call('/api/v1/me/attention/mutes/lookup',target())));return;}
  if(!['prepare-mute','prepare-dismissal','send','retry','status','lose-response'].includes(action)||!options.get('--journal'))throw new Error('Use prepare-mute, prepare-dismissal, send, retry, status or lose-response with a private journal path.');
  const file=resolve(options.get('--journal'));let journal;
  if(action.startsWith('prepare-')){
    let command;
    if(action==='prepare-mute'){
      if(!['true','false'].includes(options.get('--muted'))||options.has('--descendants')&&!['true','false'].includes(options.get('--descendants')))throw new Error('Use explicit desired Boolean values.');
      const selected=target(),current=await call('/api/v1/me/attention/mutes/lookup',selected);
      command={kind:'mute',body:{idempotency_key:randomUUID(),target:selected,muted:options.get('--muted')==='true',include_descendants:options.get('--descendants')==='true',expected_version:current.version}};
    }else{
      let inputs,selection;
      if(options.has('--selection-file')){
        const raw=await readFile(options.get('--selection-file'),'utf8');if(Buffer.byteLength(raw)>65536)throw new Error('Selection is oversized.');
        const selected=JSON.parse(raw);selection=selected.selection;inputs=selected.inputs.map(({kind,id,version})=>({kind,id,dismissed:true,expected_version:version}));
      }else{
        const raw=await readFile(options.get('--inputs-file'),'utf8');if(Buffer.byteLength(raw)>32768)throw new Error('Input set is oversized.');
        const selected=JSON.parse(raw);if(!Array.isArray(selected)||!selected.length||selected.length>100||selected.some(v=>!['shared_event','personal_delivery'].includes(v.kind)||!uuid.test(v.id)||typeof v.dismissed!=='boolean'))throw new Error('Choose a bounded exact input set with desired dismissal booleans.');
        const current=await call('/api/v1/me/attention/dismissals/lookup',{inputs:selected.map(({kind,id})=>({kind,id}))});
        inputs=selected.map(v=>({...v,expected_version:current.items.find(i=>i.kind===v.kind&&i.id===v.id.toLowerCase()).version}));
      }
      command={kind:'dismissal',body:{idempotency_key:randomUUID(),...(selection?{selection}:{}),inputs}};
    }
    journal={version:1,...scope,contract:'attention-controls-1',command};
    if(Buffer.byteLength(JSON.stringify(journal))>65536)throw new Error('Journal exceeds release bound.');
    const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(journal)+'\n');await handle.sync();}finally{await handle.close();}
    const directory=await open(dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
  }else{const raw=await readFile(file,'utf8');if(Buffer.byteLength(raw)>65536)throw new Error('Journal exceeds release bound.');journal=JSON.parse(raw);}
  if(journal.version!==1||journal.contract!=='attention-controls-1'||Object.entries(scope).some(([key,value])=>journal[key]!==value)||!uuid.test(journal.command?.body?.idempotency_key??''))throw new Error('Incompatible journal or owner. Nothing sent.');
  if(action.startsWith('prepare-')){if(JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(journal))throw new Error('Journal read-back failed.');console.log(JSON.stringify({action,operation_key:journal.command.body.idempotency_key}));return;}
  const result=await call('/api/v1/me/attention/'+(action==='status'?'status':journal.command.kind==='mute'?'mutes/state':'dismissals/state'),action==='status'?{idempotency_key:journal.command.body.idempotency_key}:journal.command.body);
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(()=>{console.error('Attention client failed. Preserve the journal; check origin, current credential, exact input and service availability.');process.exitCode=1;});
