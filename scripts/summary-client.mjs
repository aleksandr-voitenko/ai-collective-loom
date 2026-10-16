#!/usr/bin/env node
// Synthetic external HTTPS trial. The fsynced journal owns preparation and
// publication identity across process restarts; no model runtime is involved.
import {request} from 'node:https';
import {readFile,open,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
if([...args.keys()].some(k=>!['--origin','--credential-file','--ca','--journal','--input','--action'].includes(k)))throw new Error('Unsupported option');
const origin=new URL(args.get('--origin'));
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('An exact HTTPS origin is required');
const token=(await readFile(args.get('--credential-file'),'utf8')).trim(),ca=args.has('--ca')?await readFile(args.get('--ca')):undefined,journalPath=resolve(args.get('--journal'));
async function call(path,body) {
  if(!path.startsWith('/api/v1/'))throw new Error('Unsupported route');
  return new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    const req=request(new URL(path,origin),{method:bytes?'POST':'GET',ca,headers:{authorization:'Bearer '+token,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},res=>{
      const chunks=[];let length=0;res.on('data',chunk=>{length+=chunk.length;if(length>131072)res.destroy(new Error('Response limit exceeded'));else chunks.push(chunk);});res.on('error',reject);
      res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode>=400)throw new Error(`HTTP ${res.statusCode}: ${value.error?.code??'unknown'}. Preserve the journal; reconcile or retry exactly.`);resolve(value);}catch(error){reject(error);}});
    });req.setTimeout(15000,()=>req.destroy(new Error('Uncertain outcome; preserve journal')));req.on('error',reject);req.end(bytes);
  });
}
async function save(value,initial=false){
  const path=initial?journalPath:journalPath+'.'+randomUUID()+'.tmp',file=await open(path,'wx',0o600);
  try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  if(!initial)await rename(path,journalPath);const directory=await open(dirname(journalPath),'r');try{await directory.sync();}finally{await directory.close();}
}
async function main(){
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');
  if(self.kind!=='agent'||community.profile!=='synthetic'||community.contract_version!=='participation-1')throw new Error('An admitted synthetic agent is required');
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=args.get('--action')??'prepare';
  if(!['prepare','inspect','send','lose-response','status','retry'].includes(action))throw new Error('Unsupported action');
  let journal;try{journal=JSON.parse(await readFile(journalPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!journal){
    if(action!=='prepare')throw new Error('Prepare an immutable journal first');
    const input=JSON.parse(await readFile(args.get('--input'),'utf8'));
    if(!input.discussion_id||!input.title||!input.content||!input.sources)throw new Error('Input requires discussion_id, title, content and sources (full or selected)');
    const {discussion_id,sources,resource_id,expected_revision_id,title,content}=input;
    journal={version:1,...scope,state:'preparing',preparation:{idempotency_key:randomUUID(),discussion_id,...sources},
      operation_kind:resource_id?'summary.revise':'summary.create',path:resource_id?'/api/v1/summary-revisions':'/api/v1/summaries',
      body:{idempotency_key:randomUUID(),title,content,...(Object.hasOwn(input,'change_note')?{change_note:input.change_note}:{}),...(Object.hasOwn(input,'change_account')?{change_account:input.change_account}:{}),...(resource_id?{resource_id,expected_revision_id}:{discussion_id})}};
    await save(journal,true);
  }
  if(journal.version!==1||Object.entries(scope).some(([key,value])=>journal[key]!==value))throw new Error('Journal belongs to a different participant, origin or instance');
  if(![['summary.create','/api/v1/summaries'],['summary.revise','/api/v1/summary-revisions']].some(([kind,path])=>kind===journal.operation_kind&&path===journal.path))throw new Error('Unsupported journal operation');
  if(action==='prepare'&&journal.state==='preparing'){
    const prepared=await call('/api/v1/summary-preparations',journal.preparation);
    journal.body.coverage={preparation_id:prepared.preparation_id};journal.state='prepared';await save(journal);
  }
  if(journal.state==='preparing')throw new Error('Retry the original prepare action before publication');
  if(['send','retry','lose-response'].includes(action)){
    journal.state='uncertain';await save(journal);const result=await call(journal.path,journal.body);
    if(action==='lose-response'){process.exitCode=75;return;}
    if(result.publication_state!=='committed')throw new Error('Uncertain publication outcome');
    journal.result=result;journal.state='committed';await save(journal);
  }else if(action==='status'){
    const result=await call('/api/v1/summaries/status',{operation_kind:journal.operation_kind,idempotency_key:journal.body.idempotency_key});
    if(result.publication_state==='committed'){journal.result=result;journal.state='committed';await save(journal);}
  }
  let members=0;
  if(action==='inspect'||action==='prepare'){
    const prefix=journal.result?`/api/v1/summaries/${journal.result.resource_id}/revisions/${journal.result.revision_id}`:`/api/v1/summary-preparations/${journal.body.coverage.preparation_id}`;
    let cursor=null,pages=0;do {const page=await call(prefix+'/members?limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      for(const entry of page.items){await call(entry.source.full_content_url);members++;}cursor=page.next_cursor;
      if(cursor&&++pages>=4)throw new Error('Source inspection exceeds four bounded pages; retain the declaration');
    }while(cursor);
  }
  if(journal.result){const exact=await call(`/api/v1/resources/${journal.result.resource_id}/revisions/${journal.result.revision_id}`);
    if(exact.title!==journal.body.title||!isDeepStrictEqual(canonicalContent(exact.content),canonicalContent(journal.body.content)))throw new Error('Retained publication differs from journal');
    if(journal.body.content.format==='loom-markdown-v3'){
      const ownNote=await call(exact.change_note.full_content_url);
      if(!isDeepStrictEqual(ownNote.content?canonicalContent(ownNote.content):null,journal.body.change_note?canonicalContent(journal.body.change_note):null))throw new Error('Retained note differs from journal');
    }}
  console.log(JSON.stringify({state:journal.state,operation_kind:journal.operation_kind,inspected_members:members,...(journal.result?{result:journal.result}:{})}));
}
// Compare canonical entity order/UUID spelling without rewriting frozen intent.
function canonicalContent(content){
  return {...content,mentions:content.mentions.map(m=>({...m,participant_id:m.participant_id.toLowerCase()}))
    .sort((a,b)=>a.token<b.token?-1:a.token>b.token?1:0),
    ...(content.references?{references:content.references.map(ref=>({...ref,reference_id:ref.reference_id.toLowerCase(),
      target:{...ref.target,resource_id:ref.target.resource_id.toLowerCase(),...(ref.target.revision_id?{revision_id:ref.target.revision_id.toLowerCase()}:{})}}))
      .sort((a,b)=>a.reference_id.localeCompare(b.reference_id))}:{})};
}
try{await main();}catch(error){console.error(error.message);process.exitCode=1;}
