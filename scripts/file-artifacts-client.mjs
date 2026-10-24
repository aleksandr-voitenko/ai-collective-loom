#!/usr/bin/env node
// Independently retained immutable JSON intent. Byte files and credentials never
// enter the journal; replacement credentials must resolve the same participant.
import {request} from 'node:https';
import {readFile,open} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const refusalCodes=new Set(['file_storage_unavailable','file_capacity','file_not_prepared','file_expired','file_mismatch','file_busy',
  'file_format_required','invalid_input','invalid_request','invalid_search','search_changed','search_work_limit','response_budget_too_small','unauthenticated','unavailable','forbidden','revision_conflict','idempotency_conflict','retryable','service_unavailable']);
class RequestRefused extends Error {
  constructor(code,outcome){super();this.receipt={error:{code,...(['unknown','rejected'].includes(outcome)?{operation_outcome:outcome}:{})}};}
}

async function main(){
  const options=new Map(),allowed=['--origin','--credential-file','--ca','--journal','--action','--kind','--input','--bytes','--artifact','--contribution','--revision','--file-id','--output','--cursor'];
  for(let i=2;i<process.argv.length;i+=2){if(!allowed.includes(process.argv[i])||!process.argv[i+1]||options.has(process.argv[i]))throw new Error();options.set(process.argv[i],process.argv[i+1]);}
  const origin=new URL(options.get('--origin'));
  if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.password||origin.search||origin.hash)throw new Error();
  const token=(await readFile(options.get('--credential-file'),'utf8')).trim(),ca=options.has('--ca')?await readFile(options.get('--ca')):undefined;
  async function call(path,body,binary=false){return new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
    if(bytes&&bytes.length>(Buffer.isBuffer(body)?4194304:131072)){reject(new Error());return;}
    const req=request(new URL(path,origin),{agent:false,...ca?{ca}:{},method:bytes?'POST':'GET',headers:{authorization:'Bearer '+token,
      ...bytes?{'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json','content-length':bytes.length}:{}}},res=>{
      const chunks=[];let count=0;res.on('data',chunk=>{count+=chunk.length;if(count>(binary?4194304:131072))res.destroy(new Error());else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{
        const raw=Buffer.concat(chunks);
        if(![200,201].includes(res.statusCode)){
          const failure=JSON.parse(raw.toString()).error;
          // Expose only fixed protocol tokens, never server messages, bodies,
          // credentials or storage locations. Absence remains distinct from refusal.
          if(refusalCodes.has(failure?.code))throw new RequestRefused(failure.code,failure.operation_outcome);
          throw new Error();
        }
        resolve(binary?raw:JSON.parse(raw.toString()));
      }catch(error){reject(error);}});
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error()));req.end(bytes);
  });}
  const self=await call('/api/v1/identity/self'),community=await call('/api/v1/community');if(community.profile!=='synthetic'||!['14','15','16','17','18'].includes(community.guide_revision))throw new Error();
  const scope={origin:origin.origin,instance_id:community.instance_id,participant_id:self.participant_id},action=options.get('--action');
  async function retain(path,value){const handle=await open(resolve(path),'wx',0o600);try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
    const dir=await open(dirname(resolve(path)),'r');try{await dir.sync();}finally{await dir.close();}}
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if(action==='files-search'){
    const raw=await readFile(options.get('--input'),'utf8');if(Buffer.byteLength(raw)>4096)throw new Error();
    const input=JSON.parse(raw);if(options.has('--cursor'))input.cursor=options.get('--cursor');
    const result=await call('/api/v1/search/files?'+new URLSearchParams(input));
    await retain(options.get('--output'),JSON.stringify(result)+'\n');
    console.log(JSON.stringify({items:result.items.length,next_cursor:result.next_cursor,indexing:result.indexing}));return;
  }
  if(['download','text-preview','text-status'].includes(action)){
    const contribution=options.has('--contribution');
    if(contribution===options.has('--artifact'))throw new Error();
    const ids=[contribution?'--contribution':'--artifact','--revision','--file-id'].map(k=>options.get(k));if(ids.some(id=>!uuid.test(id??'')))throw new Error();
    const base=`/api/v1/${contribution?'contributions':'artifacts'}/${ids[0]}/revisions/${ids[1]}/${contribution?'attachments':'files'}/${ids[2]}`;
    if(action!=='download'){
      const result=await call(base+'/text'+(action==='text-status'?'/status':options.has('--cursor')?'?cursor='+encodeURIComponent(options.get('--cursor')):''));
      await retain(options.get('--output'),JSON.stringify(result)+'\n');
      console.log(JSON.stringify({file_id:result.file_id,processing:result.processing,next_cursor:result.next_cursor,retained_text_complete:result.retained_text_complete}));return;
    }
    const bytes=await call(base+'/download',undefined,true);
    await retain(options.get('--output'),bytes);console.log(JSON.stringify({bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));return;
  }
  if(action==='prepare'){
    const kind=options.get('--kind');if(!['file.upload','artifact.create','revision.publish','discussion.create','reply.create','attachment.promote'].includes(kind))throw new Error();
    const raw=await readFile(options.get('--input'),'utf8');if(Buffer.byteLength(raw)>131072)throw new Error();
    const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body)||'idempotency_key' in body)throw new Error();
    const journal={version:1,...scope,kind,body:{...body,idempotency_key:randomUUID()}};
    const bytes=JSON.stringify(journal)+'\n';await retain(options.get('--journal'),bytes);
    if(await readFile(options.get('--journal'),'utf8')!==bytes)throw new Error();
    console.log(JSON.stringify({operation_key:journal.body.idempotency_key}));return;
  }
  if(!['send','status','lose-response'].includes(action))throw new Error();
  const raw=await readFile(options.get('--journal'),'utf8');if(Buffer.byteLength(raw)>132096)throw new Error();
  const journal=JSON.parse(raw);if(journal.version!==1||Object.entries(scope).some(([k,v])=>journal[k]!==v)||!uuid.test(journal.body?.idempotency_key??''))throw new Error();
  let result;
  if(journal.kind==='file.upload'){
    if(action==='status')result=await call('/api/v1/file-uploads/status',{idempotency_key:journal.body.idempotency_key});
    else{
      result=await call('/api/v1/file-uploads',journal.body);
      if(['waiting','uploading'].includes(result.state)){
        const bytes=await readFile(options.get('--bytes'));
        if(bytes.length!==journal.body.size||createHash('sha256').update(bytes).digest('hex')!==journal.body.sha256.toLowerCase())throw new Error();
        result=await call(`/api/v1/file-uploads/${result.upload_id}/bytes`,bytes);
      }
      if(result.state!=='prepared')result=await call(`/api/v1/file-uploads/${result.upload_id}/finalize`,{});
    }
  }else{
    const path={'artifact.create':'/api/v1/artifacts','revision.publish':'/api/v1/revisions','discussion.create':'/api/v1/discussions','reply.create':'/api/v1/replies','attachment.promote':'/api/v1/attachment-promotions'}[journal.kind];if(!path)throw new Error();
    result=await call(action==='status'?'/api/v1/operations/status':path,action==='status'?{operation_kind:journal.kind,idempotency_key:journal.body.idempotency_key}:journal.body);
  }
  if(action==='lose-response'){console.log(JSON.stringify({test:'acknowledgement_discarded'}));process.exitCode=75;return;}
  console.log(JSON.stringify(result));
}
main().catch(error=>{if(error instanceof RequestRefused)console.log(JSON.stringify(error.receipt));
  console.error('File client failed. Preserve the exact journal and original bytes; verify current authority and service availability before retrying.');process.exitCode=1;});
