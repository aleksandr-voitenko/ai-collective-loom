#!/usr/bin/env node
// Independent HTTPS reads. Each invocation saves one bounded page, never a secret.
import { administrativeReadClient } from './lib/administrative-read-client.mjs';
import { open, readFile, stat } from 'node:fs/promises';
async function main() {
  const options=new Map(),allowed=['--origin','--ca','--credential-file','--collection','--limit','--max-bytes','--after-page','--output'];
  for(let i=2;i<process.argv.length;i+=2){if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();options.set(process.argv[i],process.argv[i+1]);}
  const {origin,call}=await administrativeReadClient({origin:options.get('--origin'),credentialFile:options.get('--credential-file'),caFile:options.get('--ca')});
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
