#!/usr/bin/env node
// Standalone, bounded HTTPS reader. Recovery owns the displayed page, never a
// consumption acknowledgement. Read reauthorizes that page; next uses its saved
// successor, with current authorization on every request.
import { request } from 'node:https';
import { readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
if([...args.keys()].some(k=>!['--origin','--credential-file','--ca','--journal','--action','--scope-file','--limit','--max-response-bytes'].includes(k)))throw new Error('Unsupported option');
const origin=new URL(args.get('--origin'));
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('An exact HTTPS origin is required');
const journalPath=resolve(args.get('--journal')),action=args.get('--action')??'read',selection=args.has('--scope-file')?JSON.parse(await readFile(args.get('--scope-file'),'utf8')):{kind:'following'},requestedLimit=args.has('--limit')?Number(args.get('--limit')):undefined;
const validLimit=value=>Number.isInteger(value)&&value>=1&&value<=25;
const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=16384;
const hasSuccessor=value=>validToken(value.next_cursor)&&value.checkpoint===null||value.next_cursor===null&&validToken(value.checkpoint);
if(!['read','next','renew','replay','resynchronize'].includes(action)||!['following','explicit'].includes(selection.kind)||requestedLimit!==undefined&&!validLimit(requestedLimit))throw new Error('Unsupported action, scope or limit');
const token=(await readFile(args.get('--credential-file'),'utf8')).trim(),ca=args.has('--ca')?await readFile(args.get('--ca')):undefined;
async function call(path,body){return new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  const req=request(new URL(path,origin),{method:bytes?'POST':'GET',ca,headers:{authorization:'Bearer '+token,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{
    const chunks=[];let length=0;res.on('data',chunk=>{length+=chunk.length;if(length>131072)res.destroy(new Error('Response exceeds byte budget'));else chunks.push(chunk);});res.on('error',reject);
    res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode>=400)throw new Error(`HTTP ${res.statusCode}: ${value.error?.code??'unknown'}. Keep the journal and use the advertised recovery action.`);resolve(value);}catch(error){reject(error);}});
  });req.setTimeout(15000,()=>req.destroy(new Error('Retrieval timed out; retry the same journal')));req.on('error',reject);req.end(bytes);
});}
async function save(value){
  const temporary=journalPath+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}finally{await file.close();}
  try{await rename(temporary,journalPath);const directory=await open(dirname(journalPath),'r');try{await directory.sync();}finally{await directory.close();}}
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function main(){
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(self.kind!=='agent'||community.profile!=='synthetic'||community.shared_changes_contract!=='shared-changes-1')throw new Error('An admitted synthetic agent with shared change support is required');
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id,selection:JSON.stringify(selection)};
  let journal;try{if((await stat(journalPath)).size>65536)throw new Error('Recovery record exceeds its bound');journal=JSON.parse(await readFile(journalPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(journal&&(journal.version!==1||Object.entries(scope).some(([k,v])=>journal[k]!==v)||typeof journal.cursor!=='string'||!journal.cursor.length||journal.cursor.length>16384||journal.limit!==undefined&&!validLimit(journal.limit)))throw new Error('Recovery record belongs to another participant, instance or scope, or has an invalid page size');
  if(action==='next'&&journal&&(!validLimit(journal.limit)||!hasSuccessor(journal)))throw new Error('The saved page boundary is unavailable. Run read to display and save that page before advancing.');
  const limit=action==='next'?requestedLimit??journal?.limit??12:journal?.limit??requestedLimit??12;
  const budget=action==='next'?Number(args.get('--max-response-bytes')??journal?.max_response_bytes??131072):journal?.max_response_bytes??Number(args.get('--max-response-bytes')??131072);
  if(!Number.isInteger(budget)||budget<4096||budget>131072)throw new Error('Invalid byte budget');
  let query={limit,max_response_bytes:budget,...(journal?{cursor:journal.cursor}:{scope:selection})};
  // Use the successor durably saved with the displayed page. Reconstructing it
  // by fetching that page again could change its size or byte-budget membership.
  if(action==='next'&&journal)query={limit,max_response_bytes:budget,...(journal.next_cursor?{cursor:journal.next_cursor}:{checkpoint:journal.checkpoint})};
  if(['renew','replay','resynchronize'].includes(action))query={...(journal?{}:{scope:selection}),limit,max_response_bytes:budget,recovery:{action,...(journal?{token:journal.cursor}:{})}};
  const read=async q=>{
    const page=await call('/api/v1/shared-changes/query',q);
    if(page.contract_version!=='shared-changes-1'||page.traversal?.scope!==selection.kind||!validToken(page.page_cursor)||!validLimit(page.limit)||!(hasSuccessor(page)||page.next_cursor===null&&page.checkpoint===null&&page.page_exhausted)||!Array.isArray(page.items)||page.items.length>page.limit)throw new Error('Unsupported shared response');
    return page;
  };
  const page=await read(query);
  // Atomic fsync precedes printing/exposing the page and its successor. The file
  // contains no source body, credential or trusted cached permission decision.
  await save({version:1,...scope,cursor:page.page_cursor,next_cursor:page.next_cursor,checkpoint:page.checkpoint,limit:page.limit,max_response_bytes:page.max_response_bytes});
  console.log(JSON.stringify(page));
}
let lock;
try{lock=await open(journalPath+'.lock','wx',0o600);await main();}
catch(error){console.error(error.code==='EEXIST'?'Another reader holds this journal. Use a separate journal for an independent client.':error.message);process.exitCode=1;}
finally{if(lock){await lock.close();await unlink(journalPath+'.lock');}}
