#!/usr/bin/env node
// Independent HTTPS reader. The private journal saves replay requests separately
// from successor tokens; source bodies and credentials never enter that file.
import { request } from 'node:https';
import { readFile, open, rename, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
if([...args.keys()].some(k=>!['--origin','--credential-file','--ca','--journal','--action','--scope-file','--reason','--group','--direct-only','--limit','--max-response-bytes'].includes(k)))throw new Error('Unsupported option');
const origin=new URL(args.get('--origin'));
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('An exact HTTPS origin is required');
const journalPath=resolve(args.get('--journal')),action=args.get('--action')??'read',scope=args.has('--scope-file')?JSON.parse(await readFile(args.get('--scope-file'),'utf8')):{kind:'following'},reason=args.get('--reason')??'all';
if(!['read','next','newer','complete','direct','members','next-members','close','renew','replay','resynchronize'].includes(action)||
  !['following','explicit','personal'].includes(scope.kind)||!['all','mention','reply'].includes(reason))throw new Error('Unsupported action or selection');
const validToken=v=>typeof v==='string'&&v.length>0&&v.length<=16384;
const validRequest=v=>v&&Object.keys(v).sort().join(',')==='cursor,limit,max_response_bytes'&&validToken(v.cursor)&&Number.isInteger(v.limit)&&v.limit>=1&&v.limit<=25&&
  Number.isInteger(v.max_response_bytes)&&v.max_response_bytes>=4096&&v.max_response_bytes<=131072;
const token=(await readFile(args.get('--credential-file'),'utf8')).trim(),ca=args.has('--ca')?await readFile(args.get('--ca')):undefined;
async function call(path,body){return new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  const req=request(new URL(path,origin),{method:bytes?'POST':'GET',ca,headers:{authorization:'Bearer '+token,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{
    const chunks=[];let length=0;res.on('data',chunk=>{length+=chunk.length;if(length>131072)res.destroy(new Error('Response exceeds byte budget'));else chunks.push(chunk);});res.on('error',reject);
    res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode>=400)throw new Error(`HTTP ${res.statusCode}: ${value.error?.code??'unknown'}. Preserve the journal and use the advertised recovery action.`);resolve(value);}catch(error){reject(error);}});
  });req.setTimeout(15000,()=>req.destroy(new Error('Retrieval timed out; retry the saved view')));req.on('error',reject);req.end(bytes);
});}
async function save(value){
  const bytes=JSON.stringify(value)+'\n';if(Buffer.byteLength(bytes)>131072)throw new Error('Updates journal exceeds its bound');
  const temporary=journalPath+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  try{await rename(temporary,journalPath);const directory=await open(dirname(journalPath),'r');try{await directory.sync();}finally{await directory.close();}}
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
const replayRequest=page=>({cursor:page.page_cursor,limit:page.limit,max_response_bytes:page.max_response_bytes});
async function main(){
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(self.kind!=='agent'||community.profile!=='synthetic'||community.updates_contract!=='combined-updates-1')throw new Error('An admitted synthetic agent with Updates support is required');
  const identity={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id,scope:JSON.stringify(scope),reason};
  let saved;try{if((await stat(journalPath)).size>131072)throw new Error('Recovery record exceeds its bound');saved=JSON.parse(await readFile(journalPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(saved&&(saved.version!==1||Object.entries(identity).some(([k,v])=>saved[k]!==v)||!validRequest(saved.overview)||
    saved.member&&!validRequest(saved.member)||[saved.next_cursor,saved.checkpoint,saved.member_next].some(v=>v!==null&&!validToken(v))))
    throw new Error('Updates recovery belongs to another scope, owner or instance, or is incompatible; it was not reset');
  const resize=['next','newer','members','next-members','complete','direct'].includes(action),old=action==='next-members'?saved?.member:saved?.overview;
  const limit=resize?Number(args.get('--limit')??old?.limit??12):old?.limit??Number(args.get('--limit')??12);
  const budget=resize?Number(args.get('--max-response-bytes')??old?.max_response_bytes??131072):old?.max_response_bytes??Number(args.get('--max-response-bytes')??131072);
  if(!validRequest({cursor:'validation',limit,max_response_bytes:budget}))throw new Error('Invalid item or byte budget');
  const budgets={limit,max_response_bytes:budget};let query=saved?saved.overview:{scope,reason,...budgets},memberQuery;
  if(['next','newer','complete','direct','members','next-members'].includes(action)&&!saved)throw new Error('Read and save an overview first');
  if(action==='next'){if(!saved.next_cursor)throw new Error('This selection ended. Choose complete or newer explicitly.');query={cursor:saved.next_cursor,...budgets};}
  if(action==='newer'){if(!saved.checkpoint)throw new Error('Complete both component intervals before requesting newer activity.');query={checkpoint:saved.checkpoint,...budgets};}
  if(action==='complete'||action==='direct')query={switch:{token:saved.overview.cursor,selection:action},...budgets};
  if(['renew','replay','resynchronize'].includes(action))query={recovery:{action,...(saved?{token:saved.overview.cursor}:{})},...(!saved?{scope,reason}:{}),...budgets};
  if(action==='members')memberQuery={cursor:saved.overview.cursor,...(args.has('--group')?{group_id:args.get('--group')}:{}),direct_only:args.get('--direct-only')==='true',...budgets};
  if(action==='next-members'){if(!saved.member_next)throw new Error('Requested member metadata is exhausted');memberQuery={cursor:saved.member_next,...budgets};}
  // Always reauthorize the overview as well when restoring its expansion.
  if((action==='read'||action==='renew')&&saved?.member)memberQuery={...saved.member,...(action==='renew'?{renew:true}:{})};
  const page=await call('/api/v1/me/updates/query',query);
  if(page.contract_version!=='combined-updates-1'||!validRequest(replayRequest(page))||!Array.isArray(page.items)||page.items.length>page.limit||
    !['preparing','ready'].includes(page.stage)||page.checkpoint&&!(page.grouped_interval_complete||page.baseline_established))throw new Error('Unsupported Updates response');
  const expansion=memberQuery?await call('/api/v1/me/updates/members',memberQuery):undefined;
  if(expansion&&(expansion.contract_version!=='combined-updates-1'||!validRequest(replayRequest(expansion))||!Array.isArray(expansion.items)||expansion.items.length>expansion.limit))throw new Error('Unsupported member response');
  await save({version:1,...identity,overview:replayRequest(page),previous_overview:saved?.overview,next_cursor:page.next_cursor,checkpoint:page.checkpoint,
    ...(expansion?{member:replayRequest(expansion)}:{}),member_next:expansion?.next_cursor??null});
  console.log(JSON.stringify({overview:page,members:expansion??null}));
}
async function lockJournal(){
  // Earlier exclusive-create locks carry no verifiable owner. Never delete one
  // automatically: an older client may still be writing this journal.
  try{await stat(journalPath+'.lock');throw new Error('Legacy journal lock exists. Stop older clients and remove it only after verifying no reader is active.');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const path=journalPath+'.lock.sqlite',file=await open(path,'a',0o600);await file.close();
  const lock=new DatabaseSync(path,{timeout:0});
  try{lock.exec('BEGIN EXCLUSIVE');return lock;}
  catch(error){lock.close();if(error.errcode===5||error.errcode===6)throw new Error('Another reader holds this journal. Use an independent journal.');throw error;}
}
// SQLite uses OS-held locks, released even after SIGKILL. Keep the empty sidecar:
// unlinking it could let contenders lock different inodes for the same journal.
let lock;try{lock=await lockJournal();await main();}
catch(error){console.error(error.message);process.exitCode=1;}
finally{lock?.close();}
