#!/usr/bin/env node
// Independent HTTPS reads. Each invocation saves one bounded page, never a secret.
import { request } from 'node:https';
import { open, readFile, stat } from 'node:fs/promises';
async function main() {
  const options=new Map(),allowed=['--origin','--ca','--credential-file','--collection','--limit','--max-bytes','--after-page','--output'];
  for(let i=2;i<process.argv.length;i+=2){if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();options.set(process.argv[i],process.argv[i+1]);}
  const origin=new URL(options.get('--origin'));
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();
  const credential=options.get('--credential-file'),info=await stat(credential);
  if(!info.isFile()||(info.mode&0o077)||info.size>1024)throw new Error();
  const token=(await readFile(credential,'utf8')).trim(),ca=options.has('--ca')?await readFile(options.get('--ca')):undefined;
  if(!/^loom_agent\.[a-f0-9-]+\.[A-Za-z0-9_-]+$/i.test(token))throw new Error();
  async function call(path,body){return new Promise((resolve,reject)=>{
    const encoded=body===undefined?undefined:JSON.stringify(body),chunks=[];let bytes=0;
    const req=request(new URL('/api/v1/'+path,origin),{ca,agent:false,method:encoded?'POST':'GET',headers:{authorization:'Bearer '+token,...(encoded?{'content-type':'application/json','content-length':Buffer.byteLength(encoded)}:{})}},res=>{
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>32768)res.destroy(new Error());else chunks.push(chunk);});res.on('error',reject);
      res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200){const code=result.error?.code;process.stderr.write(['collection_changed','cursor_expired','cursor_restart','invalid_cursor','page_budget_exceeded','forbidden','unauthenticated'].includes(code)?code+'; explicitly refresh or correct the request.\n':'HTTPS read failed; retry the same read.\n');throw new Error();}resolve(result);}catch(error){reject(error);}});
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error()));req.end(encoded);
  });}
  const self=await call('identity/self');if(self.role!=='administrator')throw new Error();
  const collection=options.get('--collection');
  if(!['health','outcomes','authored','files','activity'].includes(collection))throw new Error();
  const path='admin/operational-health'+(collection==='health'?'':collection==='outcomes'?'/outcomes':'/'+collection+'/failures');
  let body=collection==='health'?undefined:{};
  if(collection==='health'&&(options.has('--after-page')||options.has('--limit')||options.has('--max-bytes')))throw new Error();
  if(body){
    for(const [option,key,min,max] of [['--limit','limit',1,25],['--max-bytes','max_bytes',1024,32768]])if(options.has(option)){
      if(key==='max_bytes'&&collection!=='outcomes')throw new Error();
      const raw=options.get(option),value=Number(raw);if(!/^\d+$/.test(raw)||!Number.isInteger(value)||value<min||value>max)throw new Error();body[key]=value;
    }
    if(options.has('--after-page')){
      const file=options.get('--after-page'),info=await stat(file);if(!info.isFile()||(info.mode&0o077)||info.size>36864)throw new Error();
      const prior=JSON.parse(await readFile(file,'utf8'));
      if(prior.origin!==origin.origin||prior.owner!==self.participant_id||prior.collection!==collection||prior.page.complete||typeof prior.page.next_cursor!=='string')throw new Error();
      body.cursor=prior.page.next_cursor;
    }
  }
  const page=await call(path,body);
  const handle=await open(options.get('--output'),'wx',0o600);
  try{await handle.writeFile(JSON.stringify({origin:origin.origin,owner:self.participant_id,collection,request:body,page})+'\n');await handle.sync();}finally{await handle.close();}
  console.log(JSON.stringify({items:page.items?.length??1,complete:page.complete??true}));
}
main().catch(()=>{console.error('Operational read failed. Keep the prior page; check private input files, origin, current authority and the reported restart condition. No write was sent.');process.exitCode=1;});
