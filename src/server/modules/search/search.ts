import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor,lockContext,safeError,type Transactions } from '../publication/publication.js';
import { PublicationError } from '../publication/errors.js';
import { ParticipationRetrieval,RetrievalError,fit,responseBudget } from '../participation/retrieval.js';
import { structureGuard } from '../participation/organization-context.js';
import { searchLimits, type SearchOptions,type SearchPageView,type SearchResultView,type SearchStatusView,type SearchAuthorsOptions,type SearchAuthorsView } from '../../../contracts/search.js';
import { discoveryGuard,typedSources } from './worker.js';
import { validUnicode } from '../../../contracts/authored.js';

export class SearchError extends Error {
  constructor(readonly code:'invalid_search'|'search_work_limit'|'search_changed') {
    super({invalid_search:'Use up to eight plain terms within 256 UTF-8 bytes. Punctuation can add terms; operators and phrases are unsupported.',
      search_work_limit:'Search exceeds the supported synthetic work limit. Direct source browsing remains available.',
      search_changed:'This search selection changed or expired. Refresh search to start again.'}[code]);
  }
}
export function normalizeSearch(options:SearchOptions) {
  if(!validUnicode(options.q) || /[\u0000-\u001f\u007f"&|!<>():*]/u.test(options.q)) throw new SearchError('invalid_search');
  const q=options.q.normalize('NFC').trim().replace(/\s+/gu,' ').toLowerCase();
  if(!q || Buffer.byteLength(q)>searchLimits.queryBytes) throw new SearchError('invalid_search');
  if(options.descendants!==undefined&&!options.topic) throw new SearchError('invalid_search');
  for(const date of [options.from,options.before]) if(date && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().replace('.000Z','Z')!==date.replace('.000Z','Z'))) throw new SearchError('invalid_search');
  if(options.from && options.before && Date.parse(options.from)>=Date.parse(options.before)) throw new SearchError('invalid_search');
  return {q,scope:{topic:options.topic?.toLowerCase()??null,descendants:options.descendants==='true',kind:options.kind??null,
    author:options.author?.toLowerCase()??null,from:options.from??null,before:options.before??null}};
}

// Bounded containment walk mirrors lockContext: contribution -> discussion ->
// areas, artifact -> areas. Reply parents are deliberately absent from this graph.
const eligibleSql=`WITH RECURSIVE population AS MATERIALIZED (
  SELECT r.id,r.kind,r.owner_resource_id,r.state,r.current_revision_id,r.original_author_id,
    v.availability,v.content_format,v.created_at,c.discussion_id,c.parent_id
  FROM (${typedSources} LIMIT 5001) s JOIN loom.resources r ON r.id=s.id
  JOIN loom.revisions v ON v.id=r.current_revision_id AND v.resource_id=r.id
  LEFT JOIN loom.contributions c ON c.id=r.id
), owners AS (
  SELECT id AS source,id,kind,owner_resource_id,ARRAY[id] AS path,state='active' AS eligible,1 AS depth
    FROM population
  UNION ALL
  SELECT o.source,p.id,p.kind,p.owner_resource_id,o.path||p.id,
    o.eligible AND p.state='active' AND p.kind=CASE WHEN o.kind='contribution' THEN 'discussion' ELSE 'area' END,o.depth+1
    FROM owners o JOIN loom.resources p ON p.id=o.owner_resource_id
    WHERE o.depth<32 AND NOT p.id=ANY(o.path)
), eligible AS MATERIALIZED (
  SELECT p.*,o.path,CASE WHEN p.kind='artifact' THEN 'artifact' WHEN p.parent_id IS NULL THEN 'discussion' ELSE 'comment' END AS search_kind,
    CASE WHEN p.kind='artifact' THEN p.owner_resource_id ELSE d.owner_resource_id END AS area_id
  FROM population p JOIN owners o ON o.source=p.id AND o.owner_resource_id IS NULL AND o.kind='area' AND o.eligible
  LEFT JOIN loom.resources d ON d.id=p.discussion_id
  WHERE p.availability='available' AND p.content_format='loom-markdown-v1'
)`;
async function boundary(tx:SqlTransaction) {
  return (await tx.query<{boundary:string;generation:number;scan_complete:boolean;alive:boolean;capacity_limited:boolean}>(`
    SELECT json_build_array(s.generation,s.index_version,s.visibility_version,c.shared_position,o.version)::text AS boundary,
      s.generation,s.scan_complete,s.capacity_limited,COALESCE(s.heartbeat_at>clock_timestamp()-interval '45 seconds',false) AS alive
    FROM loom.search_state s CROSS JOIN loom.community_clocks c CROSS JOIN loom.organization_state o WHERE s.id=1 AND c.id=1 AND o.id=1`,[])).rows[0]!;
}
async function checkPopulation(tx:SqlTransaction) {
  const count=(await tx.query<{n:number}>(`SELECT count(*)::int AS n FROM (${typedSources} LIMIT 5001) s`,[])).rows[0]!.n;
  if(count>searchLimits.corpus) throw new SearchError('search_work_limit');
}
async function status(tx:SqlTransaction,state:Awaited<ReturnType<typeof boundary>>):Promise<SearchStatusView> {
  const missing=(await tx.query<{missing:boolean}>(`${eligibleSql} SELECT EXISTS(
    SELECT 1 FROM eligible e LEFT JOIN loom.search_documents d ON d.resource_id=e.id AND d.revision_id=e.current_revision_id AND d.generation=$1
    WHERE d.resource_id IS NULL) AS missing`,[state.generation])).rows[0]!.missing;
  const established=state.scan_complete&&!state.capacity_limited&&!missing;
  return {indexing:!state.alive?'unavailable':established?'ready':'incomplete',coverage:established?'current_supported_text':'not_established',direct_retrieval:'independent'};
}
function excerpt(body:string,q:string) {
  const term=q.split(/[^\p{L}\p{N}_]+/u).find(Boolean)??q;
  const at=body.toLowerCase().indexOf(term),chars=Array.from(body),start=Math.max(0,Array.from(body.slice(0,Math.max(0,at))).length-80);
  const end=start+searchLimits.excerptCharacters-2;
  return (start?'…':'')+chars.slice(start,end).join('')+(chars.length>end?'…':'');
}

export class TextSearch {
  private readonly key=randomBytes(32);
  private readonly reads:ParticipationRetrieval;
  constructor(private readonly database:Transactions){this.reads=new ParticipationRetrieval(database);}
  private encode(value:unknown){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');}
  private decode(value:string,maximumOffset:number=searchLimits.window):{binding:string;boundary:string;offset:number;expires:number}{
    try {const bytes=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));const result=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
      if(!Number.isInteger(result.offset)||result.offset<0||result.offset>=maximumOffset||!Number.isFinite(result.expires)||Date.now()>=result.expires)throw new Error();return result;
    }catch{throw new SearchError('search_changed');}
  }
  private async run<T>(work:(tx:SqlTransaction)=>Promise<T>){try{return await this.database.transaction(async tx=>{
    await tx.query("SET LOCAL statement_timeout='2500ms'",[]);return work(tx);
  });}catch(error){if(error instanceof SearchError||error instanceof RetrievalError)throw error;return safeError(error);}}
  status(actor:ActorContext){return this.run(async tx=>{await lockActor(tx,actor);await structureGuard(tx);await checkPopulation(tx);return status(tx,await boundary(tx));});}

  /** Discover authors through readable current sources, including suspended authors.
   * This directory neither changes the active-participant list nor depends on indexing. */
  authors(actor:ActorContext,options:SearchAuthorsOptions){
    const budget=responseBudget(options.max_response_bytes),limit=Number(options.limit??12),author=options.author?.toLowerCase()??null;
    if(!Number.isInteger(limit)||limit<1||limit>25)throw new SearchError('invalid_search');
    return this.run(async tx=>{
      const authority=await lockActor(tx,actor);await structureGuard(tx);await checkPopulation(tx);
      const state=await boundary(tx),binding=JSON.stringify([authority.participantId,'current-search-authors-v1',author]);
      const saved=options.cursor?this.decode(options.cursor,searchLimits.corpus):undefined;
      if(saved&&(saved.binding!==binding||saved.boundary!==state.boundary))throw new SearchError('search_changed');
      const offset=saved?.offset??0,expires=saved?.expires??Date.now()+searchLimits.cursorSeconds*1000;
      const candidates=(await tx.query<{id:string;current_revision_id:string}>(`${eligibleSql}
        SELECT DISTINCT ON (e.original_author_id) e.id,e.current_revision_id FROM eligible e
        WHERE ($1::uuid IS NULL OR e.original_author_id=$1)
        ORDER BY e.original_author_id,e.id LIMIT $2 OFFSET $3`,[author,limit+1,offset])).rows;
      const view:SearchAuthorsView={items:[],next_cursor:null,limit,max_response_bytes:budget,expires_at:new Date(expires).toISOString()};
      const cursor=(count:number)=>count<candidates.length?this.encode({binding,boundary:state.boundary,offset:offset+count,expires}):null;
      for(const row of candidates.slice(0,limit)){
        const source=await this.reads.resource(tx,authority,row.id,row.current_revision_id);
        if((await lockContext(tx,row.id,'resolution'))[0]!.current_revision_id!==row.current_revision_id)throw new SearchError('search_changed');
        view.items.push(source.author);view.next_cursor=cursor(view.items.length);
        if(Buffer.byteLength(JSON.stringify(view))>budget){view.items.pop();if(!view.items.length)fit({...view,items:[source.author]},budget);break;}
      }
      view.next_cursor=cursor(view.items.length);
      if((await boundary(tx)).boundary!==state.boundary)throw new SearchError('search_changed');
      return fit(view,budget);
    });
  }

  search(actor:ActorContext,options:SearchOptions){
    const normalized=normalizeSearch(options),budget=responseBudget(options.max_response_bytes),limit=Number(options.limit??12);
    if(!Number.isInteger(limit)||limit<1||limit>25)throw new SearchError('invalid_search');
    return this.run(async tx=>{
      const authority=await lockActor(tx,actor);await structureGuard(tx);await checkPopulation(tx);
      if(normalized.scope.topic)await lockContext(tx,normalized.scope.topic,'resolution',['area']);
      const state=await boundary(tx),binding=JSON.stringify([authority.participantId,normalized,'simple-title-body-v1']);
      const saved=options.cursor?this.decode(options.cursor):undefined;
      if(saved&&(saved.binding!==binding||saved.boundary!==state.boundary))throw new SearchError('search_changed');
      const nodes=(await tx.query<{n:number}>('SELECT numnode(plainto_tsquery(\'pg_catalog.simple\',$1)) AS n',[normalized.q])).rows[0]!.n;
      if(nodes===0||nodes>searchLimits.queryNodes)throw new SearchError('invalid_search');
      const scope=normalized.scope;
      const matches=(await tx.query<{id:string;search_kind:'discussion'|'comment'|'artifact';revision_id:string;body:string}>(`${eligibleSql}
        SELECT e.id,e.search_kind,d.revision_id,d.body FROM eligible e
        JOIN loom.search_documents d ON d.resource_id=e.id AND d.revision_id=e.current_revision_id AND d.generation=$1
        WHERE d.document @@ plainto_tsquery('pg_catalog.simple',$2)
          AND ($3::uuid IS NULL OR CASE WHEN $4::boolean THEN $3=ANY(e.path) ELSE e.area_id=$3 END)
          AND ($5::text IS NULL OR e.search_kind=$5) AND ($6::uuid IS NULL OR e.original_author_id=$6)
          AND ($7::timestamptz IS NULL OR e.created_at>=$7) AND ($8::timestamptz IS NULL OR e.created_at<$8)
        ORDER BY ts_rank(d.document,plainto_tsquery('pg_catalog.simple',$2)) DESC,e.id LIMIT 201`,
        [state.generation,normalized.q,scope.topic,scope.descendants,scope.kind,scope.author,scope.from,scope.before])).rows;
      const window=matches.slice(0,searchLimits.window),expires=saved?.expires??Date.now()+searchLimits.cursorSeconds*1000;
      let offset=saved?.offset??0;
      const view:SearchPageView={items:[],query:normalized.q,scope,indexing:await status(tx,state),selection:'bounded_current_relevance',ranking:'simple-title-body-v1',
        next_cursor:null,window_exhausted:false,selection_limited:matches.length>searchLimits.window,corpus_exhaustive:false,limit,max_response_bytes:budget,expires_at:new Date(expires).toISOString()};
      const cursor=(next:number)=>next<window.length?this.encode({binding,boundary:state.boundary,offset:next,expires}):null;
      for(const row of window.slice(offset,offset+limit)) {
        const source=await this.reads.resource(tx,authority,row.id,row.revision_id);
        const chain=await lockContext(tx,row.id,'resolution');
        if(chain[0]!.current_revision_id!==row.revision_id)throw new SearchError('search_changed');
        const ids=chain.filter(r=>r.kind==='area').map(r=>r.id).reverse();
        const areas=(await tx.query<{id:string;title:string}>('SELECT id,title FROM loom.areas WHERE id=ANY($1::uuid[])',[ids])).rows;
        const item:SearchResultView={result_id:row.search_kind==='discussion'?source.discussion_id!:row.id,source_resource_id:row.id,
          revision_id:row.revision_id,kind:row.search_kind,title:source.title,author:source.author,publisher:source.publisher,published_at:source.created_at,
          area_id:source.area_id,area_title:source.area_title,location:ids.map(id=>areas.find(a=>a.id===id)!).filter(Boolean),
          discussion_id:source.discussion_id,parent_id:source.parent_id,excerpt:{text:excerpt(row.body,normalized.q),representation:'excerpt',omitted_detail:'full_body'},
          full_content_url:source.full_content_url,browser_url:`/loom/resource/${row.id}/${row.revision_id}`,
          context_url:source.discussion_id?`/api/v1/contributions/${row.id}/context`:`/api/v1/resources/${row.id}`,
          browser_context_url:source.discussion_id?`/loom/discussion/${source.discussion_id}?focus=${row.id}`:`/loom/resource/${row.id}`};
        view.items.push(item);view.next_cursor=cursor(offset+1);view.window_exhausted=view.next_cursor===null;
        if(Buffer.byteLength(JSON.stringify(view))>budget){view.items.pop();if(!view.items.length)fit({...view,items:[item]},budget);break;}
        offset++;
      }
      view.next_cursor=cursor(offset);view.window_exhausted=view.next_cursor===null;
      if((await boundary(tx)).boundary!==state.boundary)throw new SearchError('search_changed');
      return fit(view,budget);
    });
  }

  private async administrator(tx:SqlTransaction,actor:ActorContext){if(!(await lockActor(tx,actor)).administrator)throw new PublicationError('forbidden');}
  health(actor:ActorContext){return this.run(async tx=>{await this.administrator(tx,actor);const s=await boundary(tx);
    const counts=(await tx.query<{state:string;n:number}>('SELECT state,count(*)::int AS n FROM loom.search_jobs WHERE generation=$1 GROUP BY state',[s.generation])).rows;
    const caught=(await tx.query<{caught:boolean}>(`SELECT NOT EXISTS(
      SELECT 1 FROM loom.shared_activity e JOIN loom.outbox_intents i ON i.source_event_id=e.id
      WHERE e.position>s.event_after OR (e.position=s.event_after AND (s.event_after_intent IS NULL OR i.id>s.event_after_intent))) AS caught
      FROM loom.search_state s WHERE s.id=1`,[])).rows[0]!.caught;
    return {generation:s.generation,scan_complete:s.scan_complete,worker_available:s.alive,capacity_limited:s.capacity_limited,event_discovery_caught_up:caught,
      jobs:Object.fromEntries(['pending','running','succeeded','failed'].map(state=>[state,counts.find(r=>r.state===state)?.n??0]))};});}
  failures(actor:ActorContext,after?:string){return this.run(async tx=>{await this.administrator(tx,actor);
    const rows=(await tx.query<{id:string}>(`SELECT id,generation,claim_generation,attempts,failure,resource_id,revision_id,source_event_id,source_intent_id
      FROM loom.search_jobs WHERE state='failed' AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 26`,[after??null])).rows;
    return {items:rows.slice(0,25),next_after:rows.length>25?rows[24]!.id:null};});}
  retry(actor:ActorContext,id:string,generation:number){return this.run(async tx=>{await this.administrator(tx,actor);
    const row=(await tx.query<{state:string;claim_generation:number;generation:number}>('SELECT state,claim_generation,generation FROM loom.search_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row)throw new PublicationError('unavailable');
    if(row.generation!==(await boundary(tx)).generation)throw new SearchError('search_changed');
    if(row.claim_generation===generation&&row.state==='failed')await tx.query(`UPDATE loom.search_jobs SET state='pending',attempts=0,claim_generation=claim_generation+1,due_at=clock_timestamp(),failure=NULL WHERE id=$1`,[id]);
    else if(row.claim_generation<=generation)throw new SearchError('search_changed');
    return {accepted:true};});}
  rebuild(actor:ActorContext,generation:number){return this.run(async tx=>{await this.administrator(tx,actor);await discoveryGuard(tx);
    const s=(await tx.query<{generation:number}>('SELECT generation FROM loom.search_state WHERE id=1 FOR UPDATE',[])).rows[0]!;
    if(s.generation===generation)await tx.query(`UPDATE loom.search_state SET generation=generation+1,source_after=NULL,scan_complete=false,event_after=0,event_after_intent=NULL,capacity_limited=false WHERE id=1`,[]);
    else if(s.generation!==generation+1)throw new SearchError('search_changed');
    return {generation:generation+1};});}
}
