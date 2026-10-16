import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, safeError, type Transactions } from '../publication/publication.js';
import { PublicationError } from '../publication/errors.js';
import { ParticipationRetrieval, RetrievalError, fit, responseBudget } from './retrieval.js';
import { declaration, lockReferencePlan, referenceTarget, revisionReferences } from './reference-context.js';
import { changeMembers } from './change-context.js';
import { ReferenceError } from './references.js';
import { ChangePageInput, ChangeDiscoveryInput, type ChangePageOptions, type ChangeDiscoveryOptions,
  type ChangeCoverageView, type ChangeDiscoveryView, type ChangeEntryView, type NoteDetailView } from '../../../contracts/changes.js';
import type { ExactChangeTargetValue, ResourceView } from '../../../contracts/participation.js';

type Position = [string,string,string];
type Cursor = { binding: string; boundary: string; after: Position; expires: number };
const contextUrl = (source: ResourceView) => source.kind === 'contribution' && source.discussion_id
  ? `/loom/discussion/${source.discussion_id}?focus=${source.resource_id}` : `/loom/resource/${source.resource_id}`;
const unavailable = (error:unknown) => error instanceof PublicationError && error.code === 'unavailable';
export class ChangeNotes {
  private readonly key = randomBytes(32);
  private readonly reads: ParticipationRetrieval;
  constructor(private readonly database: Transactions) { this.reads = new ParticipationRetrieval(database); }
  private encode(value:Cursor) {
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
  }
  private decode(value:string):Cursor {
    try {
      if(Buffer.byteLength(value)>2048)throw new Error();
      const bytes=Buffer.from(value,'base64url'),decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      const saved=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')) as Cursor;
      if(!Array.isArray(saved.after)||saved.after.length!==3||saved.expires<=Date.now())throw new Error();
      return saved;
    }catch{throw new ReferenceError('references_changed');}
  }
  private async run<T>(work:(tx:SqlTransaction)=>Promise<T>) {
    try{return await this.database.transaction(async tx=>{
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',[]);
      await tx.query("SET LOCAL statement_timeout='2500ms'",[]);
      return work(tx);
    });}catch(error){
      if(error instanceof ReferenceError||error instanceof RetrievalError)throw error;
      if(['40001','40P01','55P03'].includes(String((error as {code?:string})?.code)))throw new ReferenceError('references_changed');
      if((error as {code?:string})?.code==='57014')throw new ReferenceError('reference_work_limit');
      return safeError(error);
    }
  }
  private async traversal(tx:SqlTransaction,participant:string,selection:unknown,options:ChangePageOptions) {
    const boundary=(await tx.query<{value:string}>(`SELECT json_build_array(c.shared_position,s.visibility_version,o.version)::text AS value
      FROM loom.community_clocks c CROSS JOIN loom.search_state s CROSS JOIN loom.organization_state o WHERE c.id=1 AND s.id=1 AND o.id=1`,[])).rows[0]!.value;
    const binding=JSON.stringify([participant,selection]),saved=options.cursor?this.decode(options.cursor):undefined;
    if(saved&&(saved.binding!==binding||saved.boundary!==boundary))throw new ReferenceError('references_changed');
    return {binding,boundary,after:saved?.after,expires:saved?.expires??Date.now()+300000};
  }
  note(actorContext:ActorContext,source:string,revision:string,budgetValue?:string) {
    const budget=responseBudget(budgetValue);
    return this.run(async tx=>{
      const actor=await lockActor(tx,actorContext);
      await lockReferencePlan(tx,[source]);
      const view=await this.reads.resource(tx,actor,source,revision);
      if(!['artifact','summary'].includes(view.kind))throw new PublicationError('unavailable');
      const note=(await tx.query<{content_text:string}>('SELECT content_text FROM loom.revision_change_notes WHERE source_id=$1 AND revision_id=$2',[source,revision])).rows[0];
      const mentions=note?(await tx.query<{token:string;participant_id:string;nickname:string;kind:string}>(`SELECT m.token,m.participant_id,p.nickname,p.kind
        FROM loom.revision_mentions m JOIN loom.participants p ON p.id=m.participant_id WHERE m.revision_id=$1 AND m.source_field='change_note' ORDER BY m.token LIMIT 16`,[revision])).rows:[];
      const result:NoteDetailView={source:view,source_field:'change_note',state:note?'available':'absent',described_scope:'owning_revision_only; no_interval_claim',
        content:note?{format:'loom-markdown-v2',text:note.content_text,mentions:mentions.map(m=>({token:m.token,participant_id:m.participant_id})),
          references:(await revisionReferences(tx,revision,'change_note')).map(declaration)}:null,
        mentioned_participants:mentions.map(m=>({id:m.participant_id,nickname:m.nickname,kind:m.kind}))};
      return fit(result,budget);
    });
  }
  coverage(actorContext:ActorContext,source:string,revision:string,options:ChangePageOptions) {
    if(!Value.Check(ChangePageInput,options))throw new PublicationError('invalid_input');
    const budget=responseBudget(options.max_response_bytes),limit=Number(options.limit??12);
    return this.run(async tx=>{
      const actor=await lockActor(tx,actorContext),traversal=await this.traversal(tx,actor.participantId,['coverage',source,revision],options);
      const members=await changeMembers(tx,revision);
      await lockReferencePlan(tx,[source,...members.map(m=>m.resource_id)]);
      const view=await this.reads.resource(tx,actor,source,revision);
      if(view.kind!=='contribution')throw new PublicationError('unavailable');
      const declared=!!(await tx.query('SELECT revision_id FROM loom.change_account_sets WHERE source_id=$1 AND revision_id=$2',[source,revision])).rowCount;
      const page:ChangeCoverageView={source:view,state:declared?'declared':'absent',described_scope:'exact_set; no_intermediate_revision_claim',
        claim:'author_declared; not_read_correctness_approval_or_currency_proof',items:[],unknown:false,
        omitted_detail:'bodies; unavailable_members',order:'target_resource_uuid_then_revision_uuid',
        next_cursor:null,complete:false,work_budget_reached:false,limit,max_response_bytes:budget,expires_at:new Date(traversal.expires).toISOString()};
      // At most sixteen members: authorize the entire declaration so unknown is
      // meaningful even when this page shows only an eligible subset.
      const resolved=new Map<string,ChangeCoverageView['items'][number]>();
      for(const member of members)try{
        await referenceTarget(tx,member);
        const representation=await this.reads.resource(tx,actor,member.resource_id,member.revision_id);
        resolved.set(member.resource_id+member.revision_id,{target:member,representation,
          browser_url:`/loom/resource/${member.resource_id}/${member.revision_id}`,context_url:contextUrl(representation)});
      }catch(error){if(!unavailable(error))throw error;page.unknown=true;}
      const candidates=members.filter(m=>!traversal.after||m.resource_id>traversal.after[0]||m.resource_id===traversal.after[0]&&m.revision_id>traversal.after[2]);
      let consumed=0,last=traversal.after;
      for(const member of candidates){
        const entry=resolved.get(member.resource_id+member.revision_id),position:Position=[member.resource_id,'main',member.revision_id];
        if(entry){const preview={...page,items:[...page.items,entry],next_cursor:this.encode({...traversal,after:position})};
          if(page.items.length===limit||Buffer.byteLength(JSON.stringify(preview))>budget){if(!page.items.length)fit(preview,budget);break;}page.items.push(entry);}
        last=position;consumed++;
      }
      page.complete=consumed===candidates.length;
      if(!page.complete&&last)page.next_cursor=this.encode({...traversal,after:last});
      return fit(page,budget);
    });
  }
  discover(actorContext:ActorContext,input:ChangeDiscoveryOptions) {
    if(!Value.Check(ChangeDiscoveryInput,input))throw new PublicationError('invalid_input');
    const target={kind:input.kind,resource_id:input.resource_id.toLowerCase(),...(input.revision_id?{revision_id:input.revision_id.toLowerCase()}:{})};
    const history=input.history??'current',form=input.form??null,budget=responseBudget(input.max_response_bytes),limit=Number(input.limit??12);
    return this.run(async tx=>{
      const actor=await lockActor(tx,actorContext),traversal=await this.traversal(tx,actor.participantId,['discovery',target,history,form],input),after=traversal.after;
      type Candidate={source_id:string;revision_id:string;source_field:'main'|'change_note';target_revision_id:string};
      // Each row is one exact described membership, not an event or inferred interval.
      const candidates=(await tx.query<Candidate>(`SELECT * FROM (
        SELECT s.source_id,m.revision_id,'main'::text AS source_field,m.target_revision_id
          FROM loom.change_account_members m JOIN loom.change_account_sets s ON s.revision_id=m.revision_id WHERE m.target_id=$1
        UNION ALL SELECT n.source_id,n.revision_id,'change_note'::text,n.revision_id FROM loom.revision_change_notes n WHERE n.source_id=$1
      ) candidates WHERE ($2::uuid IS NULL OR target_revision_id=$2)
        AND ($3::uuid IS NULL OR (revision_id,source_field,target_revision_id)>($3::uuid,$4::text,$5::uuid))
      ORDER BY revision_id,source_field,target_revision_id LIMIT 101`,[target.resource_id,target.revision_id??null,after?.[0]??null,after?.[1]??null,after?.[2]??null])).rows;
      await lockReferencePlan(tx,[target.resource_id,...candidates.slice(0,100).map(c=>c.source_id)]);
      await lockContext(tx,target.resource_id,'resolution',[target.kind]);
      if(target.revision_id)await referenceTarget(tx,{...target,revision_id:target.revision_id});
      else {
        // Resource aggregation can include eligible history when its current
        // revision is unavailable. Validate typed identity, then each exact row.
        const table=target.kind==='artifact'?'artifacts':target.kind==='summary'?'summaries':'contributions';
        if(!(await tx.query(`SELECT id FROM loom.${table} WHERE id=$1`,[target.resource_id])).rowCount)throw new PublicationError('unavailable');
      }
      const page:ChangeDiscoveryView={items:[],scope:target.revision_id?'exact_revision':'resource_described_revisions',history,form,
        order:'source_revision_uuid_then_field_then_described_revision_uuid',omitted_detail:'bodies; full_account_sets; unavailable_sources_or_targets; other_target_resources',
        next_cursor:null,complete:false,work_budget_reached:false,limit,max_response_bytes:budget,expires_at:new Date(traversal.expires).toISOString()};
      let consumed=0,last=after;
      for(const candidate of candidates.slice(0,100)){
        let entry:ChangeEntryView|undefined;
        try{
          const note=candidate.source_field==='change_note',actualForm=note?'revision_note':'change_account';
          const chain=await lockContext(tx,candidate.source_id,'resolution'),current=chain[0]!.current_revision_id;
          if((!form||form===actualForm)&&(history==='all'||current===candidate.revision_id)){
            const described:ExactChangeTargetValue={kind:target.kind,resource_id:target.resource_id,revision_id:candidate.target_revision_id};
            await referenceTarget(tx,described);
            const source=await this.reads.resource(tx,actor,candidate.source_id,candidate.revision_id);
            const currentAvailable=current&&(await tx.query("SELECT id FROM loom.revisions WHERE id=$1 AND availability='available' FOR SHARE",[current])).rowCount;
            entry={source,source_field:candidate.source_field,form:actualForm,membership:current===candidate.revision_id?'current':currentAvailable?'historical':'current_unavailable',
              described,described_scope:note?'owning_revision_only':'member_of_exact_set',
              explanation_url:source.full_content_url+(note?'/change-note':''),coverage_url:note?null:source.full_content_url+'/change-coverage',
              browser_url:`/loom/resource/${source.resource_id}/${source.revision_id}${note?'#change-note':''}`,context_url:contextUrl(source)};
          }
        }catch(error){if(!unavailable(error))throw error;}
        const position:Position=[candidate.revision_id,candidate.source_field,candidate.target_revision_id];
        if(entry){const preview={...page,items:[...page.items,entry],next_cursor:this.encode({...traversal,after:position})};
          if(page.items.length===limit||Buffer.byteLength(JSON.stringify(preview))>budget){if(!page.items.length)fit(preview,budget);break;}page.items.push(entry);}
        last=position;consumed++;
      }
      page.complete=consumed===candidates.length;page.work_budget_reached=!page.complete&&consumed===100;
      if(!page.complete&&last)page.next_cursor=this.encode({...traversal,after:last});
      return fit(page,budget);
    });
  }
}
