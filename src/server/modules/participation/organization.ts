import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/organization.js';
import { limits } from '../../../contracts/participation.js';
import { validUnicode } from '../../../contracts/authored.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError } from '../publication/errors.js';
import { lockActor, lockContext, requireRevision, safeError, type Transactions } from '../publication/publication.js';
import { fit, responseBudget, RetrievalError, type PageOptions } from './retrieval.js';
import { OrganizationError, structureGuard, hierarchyVersion, advanceHierarchy } from './organization-context.js';
import { structuralImpacts } from '../following/structural-facts.js';

type Actor = Awaited<ReturnType<typeof lockActor>>;
type Decision = { id:string; operation_kind:C.OrganizationCommand['kind']; request_digest:string; resource_id:string; original_parent_id:string|null; result_version:number; hierarchy_version:number; local_open:boolean; source_event_id:string };
const decisionColumns = 'id,operation_kind,request_digest,resource_id,original_parent_id,result_version,hierarchy_version,local_open,source_event_id';
const scopes = (chain: Awaited<ReturnType<typeof lockContext>>) => chain.filter(r => r.kind==='area').map(r => r.id);

export class TopicOrganization {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly database:Transactions) {}
  private async run<T>(work:(tx:SqlTransaction)=>Promise<T>) {
    try { return await this.database.transaction(work); }
    catch(error) { if(error instanceof OrganizationError || error instanceof RetrievalError) throw error; return safeError(error); }
  }
  private encode(binding:string, after:string) {
    const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.cursorKey,nonce);
    const bytes=Buffer.concat([cipher.update(JSON.stringify({binding,after})),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
  }
  private decode(binding:string,cursor?:string):string|null {
    if(!cursor) return null;
    try {
      const bytes=Buffer.from(cursor,'base64url'), decipher=createDecipheriv('aes-256-gcm',this.cursorKey,bytes.subarray(0,12));
      decipher.setAuthTag(bytes.subarray(12,28));
      const value=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
      if(value.binding!==binding || typeof value.after!=='string') throw new Error();
      return value.after as string;
    } catch { throw new RetrievalError('invalid_cursor'); }
  }
  private size(options:PageOptions) {
    const size=Number(options.limit??12);
    if(!Number.isInteger(size)||size<1||size>25) throw new PublicationError('invalid_input');
    return size;
  }
  private async administrator(tx:SqlTransaction,context:ActorContext) {
    const actor=await lockActor(tx,context);
    if(!actor.administrator) throw new PublicationError('forbidden');
    return actor;
  }
  private async projection(tx:SqlTransaction,actor:Actor,id:string):Promise<C.OrganizationResourceView> {
    const chain=await lockContext(tx,id,'resolution',['area','discussion','artifact']);
    const resource=chain[0]!;
    // Only typed participation resources are organizational destinations/targets.
    const companion=resource.kind==='area'?'areas':resource.kind==='discussion'?'discussions':'artifacts';
    if(!(await tx.query(`SELECT id FROM loom.${companion} WHERE id=$1`,[id])).rowCount) throw new PublicationError('unavailable');
    const row=(await tx.query<{organization_version:number}>('SELECT organization_version FROM loom.resources WHERE id=$1',[id])).rows[0]!;
    let title:string,description:string|null=null,metadata_version:number|null=null;
    if(resource.kind==='area') {
      const area=(await tx.query<{title:string;description:string;metadata_version:number}>('SELECT title,description,metadata_version FROM loom.areas WHERE id=$1',[id])).rows[0]!;
      ({title,description,metadata_version}=area);
    } else {
      const contentId=resource.kind==='discussion'?(await tx.query<{opening_id:string}>('SELECT opening_id FROM loom.discussions WHERE id=$1',[id])).rows[0]!.opening_id:id;
      const content=await lockContext(tx,contentId,'resolution');
      if(!content[0]!.current_revision_id) throw new PublicationError('unavailable');
      await requireRevision(tx,contentId,content[0]!.current_revision_id);
      title=(await tx.query<{title:string}>('SELECT title FROM loom.revisions WHERE id=$1',[content[0]!.current_revision_id])).rows[0]!.title;
    }
    const ancestors:C.OrganizationResourceView['ancestors']=[];
    const parents=chain.slice(1).filter(r=>r.kind==='area').reverse();
    if(parents.length+(resource.kind==='area'?1:0)>C.organizationLimits.areaDepth) throw new OrganizationError('organization_limit');
    for(const parent of parents) {
      const area=(await tx.query<{title:string}>('SELECT title FROM loom.areas WHERE id=$1',[parent.id])).rows[0];
      if(!area) throw new PublicationError('unavailable');
      ancestors.push({id:parent.id,title:area.title});
    }
    return {resource_id:id,kind:resource.kind as C.OrganizationResourceView['kind'],parent_id:resource.owner_resource_id,
      version:row.organization_version,hierarchy_version:await hierarchyVersion(tx),title,description,metadata_version,
      local_open:resource.publication_open,publication_open:chain.every(r=>r.publication_open),can_organize:actor.administrator,ancestors,
      contacts_url:'/api/v1/contacts',proposal_route_url:`/api/v1/areas/${resource.kind==='area'?id:resource.owner_resource_id}/proposal-route`};
  }
  resource(context:ActorContext,id:string) {
    return this.run(async tx=>fit(await this.projection(tx,await lockActor(tx,context),id),limits.responseBytes));
  }
  private async decision(tx:SqlTransaction,actor:Actor,kind:string,key:string) {
    return (await tx.query<Decision>(`SELECT ${decisionColumns} FROM loom.organization_operations WHERE actor_id=$1 AND operation_kind=$2 AND idempotency_key=$3`,[actor.participantId,kind,key])).rows[0];
  }
  private async recovered(tx:SqlTransaction,actor:Actor,decision:Decision):Promise<C.OrganizationResult> {
    const current=await this.projection(tx,actor,decision.resource_id);
    const event=(await tx.query<{before_area_scope_ids:string[];after_area_scope_ids:string[]}>('SELECT before_area_scope_ids,after_area_scope_ids FROM loom.shared_activity WHERE id=$1',[decision.source_event_id])).rows[0]!;
    // Retained outcome IDs are not permission to expose a now-suppressed scope.
    for(const id of [...new Set([...event.before_area_scope_ids,...event.after_area_scope_ids])].sort()) await lockContext(tx,id,'resolution',['area']);
    return fit({operation_state:'committed',operation_id:decision.id,kind:decision.operation_kind,idempotency:'replayed',
      outcome:{resource_id:decision.resource_id,parent_id:decision.original_parent_id,version:decision.result_version,hierarchy_version:decision.hierarchy_version,local_open:decision.local_open},current},limits.responseBytes);
  }
  status(context:ActorContext,value:unknown) {
    if(!Value.Check(C.OrganizationStatusInput,value)) throw new PublicationError('invalid_input');
    const input=value as {kind:string;idempotency_key:string};
    return this.run(async tx=>{
      await lockAttempt(tx,identityOf(context).participantId,input.kind,input.idempotency_key.toLowerCase());
      const actor=await this.administrator(tx,context);
      const saved=await this.decision(tx,actor,input.kind,input.idempotency_key.toLowerCase());
      return saved?this.recovered(tx,actor,saved):{operation_state:'not_recorded' as const};
    });
  }
  async change(context:ActorContext,value:unknown):Promise<C.OrganizationResult> {
    if(!Value.Check(C.OrganizationInput,value)) throw new PublicationError('invalid_input');
    const input=structuredClone(value) as C.OrganizationCommand;
    for(const [key,field] of Object.entries(input)) if((key.endsWith('_id')||key==='idempotency_key')&&typeof field==='string') (input as Record<string,unknown>)[key]=field.toLowerCase();
    if('title' in input && (!input.title.trim() || [input.title,input.description].some(s=>!validUnicode(s)||s.includes('\0')) || Buffer.byteLength(input.description)>C.organizationLimits.descriptionBytes)) throw new PublicationError('invalid_input');
    const {idempotency_key:key,...semantic}=input;
    const digest=createHash('sha256').update(JSON.stringify(['organization-v1',Object.fromEntries(Object.entries(semantic).sort(([a],[b])=>a.localeCompare(b)))])).digest('hex');
    return this.run(async tx=>{
      await lockAttempt(tx,identityOf(context).participantId,input.kind,key);
      const actor=await this.administrator(tx,context),saved=await this.decision(tx,actor,input.kind,key);
      if(saved) {
        if(saved.request_digest!==digest) throw new PublicationError('idempotency_conflict');
        return this.recovered(tx,actor,saved);
      }
      await structureGuard(tx,true);
      if(await hierarchyVersion(tx)!==input.expected_hierarchy_version) throw new OrganizationError('organization_conflict');
      if((await tx.query('SELECT id FROM loom.organization_operations LIMIT 10000',[])).rows.length>=C.organizationLimits.decisions) throw new OrganizationError('organization_limit');
      let id:string,before:string[]=[];
      if(input.kind==='area.create') {
        if((await tx.query('SELECT id FROM loom.areas LIMIT 500',[])).rows.length>=C.organizationLimits.areas) throw new OrganizationError('organization_limit');
        if(input.parent_id) {
          const parent=await this.projection(tx,actor,input.parent_id);
          if(parent.kind!=='area') throw new PublicationError('unavailable');
          if(parent.ancestors.length+2>C.organizationLimits.areaDepth) throw new OrganizationError('organization_limit');
        }
        id=randomUUID();
        await tx.query("INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES ($1,'area',$2,$3)",[id,input.parent_id,actor.participantId]);
        await tx.query('INSERT INTO loom.areas(id,title,description) VALUES ($1,$2,$3)',[id,input.title,input.description]);
        await this.metadata(tx,actor,id,1,input.title,input.description);
      } else {
        id=input.resource_id;
        const current=await this.projection(tx,actor,id);
        if(current.kind!==input.kind.split('.')[0]) throw new PublicationError('unavailable');
        if(current.version!==input.expected_version) throw new OrganizationError('organization_conflict');
        before=scopes(await lockContext(tx,id,'publication',[current.kind]));
        if('parent_id' in input) {
          const parent=input.parent_id?await this.projection(tx,actor,input.parent_id):null;
          if(parent && parent.kind!=='area') throw new PublicationError('unavailable');
          if(current.kind==='area') {
            // Exclusive structure ownership stabilizes each bounded frontier and
            // its depth, including two concurrent moves with opposite intentions.
            const seen=new Set([id]); let frontier=[id],height=1;
            while(frontier.length) {
              const children=(await tx.query<{id:string}>('SELECT a.id FROM loom.areas a JOIN loom.resources r ON r.id=a.id WHERE r.owner_resource_id=ANY($1::uuid[]) ORDER BY a.id LIMIT $2',[frontier,C.organizationLimits.subtree-seen.size+1])).rows;
              if(!children.length) break;
              height++;
              for(const child of children) { if(seen.has(child.id)) throw new OrganizationError('organization_cycle'); seen.add(child.id); }
              if(seen.size>C.organizationLimits.subtree || height>C.organizationLimits.areaDepth) throw new OrganizationError('organization_limit');
              frontier=children.map(r=>r.id);
            }
            if(input.parent_id && seen.has(input.parent_id)) throw new OrganizationError('organization_cycle');
            if((parent?parent.ancestors.length+1:0)+height>C.organizationLimits.areaDepth) throw new OrganizationError('organization_limit');
          }
          await tx.query('UPDATE loom.resources SET owner_resource_id=$2 WHERE id=$1',[id,input.parent_id]);
        } else if(input.kind==='area.edit') {
          const metadataVersion=current.metadata_version!+1;
          await tx.query('UPDATE loom.areas SET title=$2,description=$3,metadata_version=$4 WHERE id=$1',[id,input.title,input.description,metadataVersion]);
          await this.metadata(tx,actor,id,metadataVersion,input.title,input.description);
        } else {
          await tx.query('UPDATE loom.resources SET publication_open=$2 WHERE id=$1',[id,input.kind==='area.open']);
        }
        await tx.query('UPDATE loom.resources SET organization_version=organization_version+1 WHERE id=$1',[id]);
      }
      const hierarchy=await advanceHierarchy(tx),current=await this.projection(tx,actor,id);
      const after=scopes(await lockContext(tx,id,'resolution',[current.kind]));
      const operationId=randomUUID(),eventId=randomUUID();
      const impacts=await structuralImpacts(tx,id,current.kind);
      const result:C.OrganizationResult={operation_state:'committed',operation_id:operationId,kind:input.kind,idempotency:'created',
        outcome:{resource_id:id,parent_id:current.parent_id,version:current.version,hierarchy_version:hierarchy,local_open:current.local_open},current};
      fit(result,limits.responseBytes);
      // All domain/actor/referenced-row guards are held before the common tail.
      const position=(await tx.query<{position:string}>('UPDATE loom.community_clocks SET shared_position=shared_position+1 WHERE id=1 RETURNING shared_position::text AS position',[])).rows[0]!.position;
      if(impacts)await tx.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids,affected_target_ids) VALUES ($1,$2,'organization.changed',$3,NULL,$4,$5,$6,$7,$8)",[eventId,position,id,actor.participantId,[...new Set([...before,...after])],before,after,impacts]);
      else await tx.query("INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids) VALUES ($1,$2,'organization.changed',$3,NULL,$4,$5,$6,$7)",[eventId,position,id,actor.participantId,[...new Set([...before,...after])],before,after]);
      await tx.query("INSERT INTO loom.outbox_intents(id,source_event_id,kind) VALUES ($1,$2,'organization.project')",[randomUUID(),eventId]);
      await tx.query(`INSERT INTO loom.organization_operations(id,actor_id,operation_kind,idempotency_key,semantic_version,request_digest,resource_id,original_parent_id,result_version,hierarchy_version,local_open,source_event_id)
        VALUES ($1,$2,$3,$4,'organization-v1',$5,$6,$7,$8,$9,$10,$11)`,[operationId,actor.participantId,input.kind,key,digest,id,current.parent_id,current.version,hierarchy,current.local_open,eventId]);
      await tx.query('INSERT INTO loom.organization_audit(operation_id,actor_credential_id) VALUES ($1,$2)',[operationId,actor.credentialId]);
      return result;
    });
  }
  private metadata(tx:SqlTransaction,actor:Actor,id:string,version:number,title:string,description:string) {
    return tx.query('INSERT INTO loom.area_metadata_revisions(id,area_id,version,title,description,publisher_id) VALUES ($1,$2,$3,$4,$5,$6)',[randomUUID(),id,version,title,description,actor.participantId]);
  }
  list(context:ActorContext,kind:'children'|'destinations',options:PageOptions & {parent_id?:string}) {
    const size=this.size(options),budget=responseBudget(options.max_response_bytes);
    return this.run(async tx=>{
      const actor=await lockActor(tx,context);
      await structureGuard(tx);
      const hierarchy=await hierarchyVersion(tx),parent=options.parent_id?.toLowerCase()??null;
      if(parent && (await this.projection(tx,actor,parent)).kind!=='area') throw new PublicationError('unavailable');
      const binding=JSON.stringify([actor.participantId,kind,parent,hierarchy]);
      const after=this.decode(binding,options.cursor);
      const rows=(await tx.query<{id:string}>(`SELECT a.id FROM loom.areas a JOIN loom.resources r ON r.id=a.id
        WHERE ($1::uuid IS NULL OR a.id>$1) AND ($3 OR r.owner_resource_id IS NOT DISTINCT FROM $2::uuid) ORDER BY a.id LIMIT 101`,[after,parent,kind==='destinations'])).rows;
      const page:C.OrganizationPageView={items:[],hierarchy_version:hierarchy,next_cursor:null,complete:false,work_budget_reached:false,scope:`${kind}:${parent??'root'}`,limit:size,max_response_bytes:budget};
      let last=after,processed=0;
      for(const row of rows.slice(0,100)) {
        let item:C.OrganizationResourceView|undefined;
        try { item=await this.projection(tx,actor,row.id); }
        catch(error) { if(!(error instanceof PublicationError)||error.code!=='unavailable') throw error; }
        if(item && (page.items.length===size || Buffer.byteLength(JSON.stringify({...page,items:[...page.items,item]}))+1024>budget)) {
          if(!page.items.length) throw new RetrievalError('response_budget_too_small',Buffer.byteLength(JSON.stringify({...page,items:[item]}))+1024);
          break;
        }
        if(item) page.items.push(item);
        last=row.id;processed++;
      }
      page.complete=processed===rows.length;page.work_budget_reached=processed===100&&!page.complete;
      if(!page.complete && last) page.next_cursor=this.encode(binding,last);
      return fit(page,budget);
    });
  }
  proposal(context:ActorContext,id:string):Promise<C.ProposalRouteView> {
    return this.run(async tx=>{
      const actor=await lockActor(tx,context);
      const area=await this.projection(tx,actor,id);
      if(area.kind!=='area') throw new PublicationError('unavailable');
      const settings=(await tx.query<{version:number;proposal_area_id:string|null}>('SELECT version,proposal_area_id FROM loom.community_settings WHERE id=1',[])).rows[0]!;
      let destination:C.OrganizationResourceView|null=null;
      let closed=false;
      if(settings.proposal_area_id) {
        try { const value=await this.projection(tx,actor,settings.proposal_area_id); if(value.publication_open) destination=value; else closed=true; }
        catch(error) { if(!(error instanceof PublicationError)||error.code!=='unavailable') throw error; }
      }
      return fit({affected_area_id:id,settings_version:settings.version,state:destination?'ready':settings.proposal_area_id?'unavailable':'setup_incomplete',destination,
        ...(closed?{unavailable_reason:'publication_closed' as const}:{}),
        contacts:(await tx.query<{id:string;nickname:string;kind:string}>("SELECT id,nickname,kind FROM loom.participants WHERE state='active' AND role='administrator' AND kind<>'internal' ORDER BY id LIMIT 25",[])).rows,contacts_url:'/api/v1/contacts'},limits.responseBytes);
    });
  }
  history(context:ActorContext,id:string,options:PageOptions) {
    const size=this.size(options),budget=responseBudget(options.max_response_bytes);
    return this.run(async tx=>{
      const actor=await lockActor(tx,context),area=await this.projection(tx,actor,id);
      if(area.kind!=='area') throw new PublicationError('unavailable');
      const binding=JSON.stringify([actor.participantId,'metadata',id]),after=this.decode(binding,options.cursor);
      const rows=(await tx.query<{id:string;version:number;title:string;description:string;publisher_id:string|null;nickname:string;kind:string;baseline:boolean;recorded_at:Date}>(`SELECT m.*,p.nickname,p.kind FROM loom.area_metadata_revisions m LEFT JOIN loom.participants p ON p.id=m.publisher_id WHERE m.area_id=$1 AND m.version>$2 ORDER BY m.version LIMIT $3`,[id,after?Number(after):0,size+1])).rows;
      const items=[];
      for(const row of rows.slice(0,size)) {
        const item={id:row.id,version:row.version,title:row.title,description:row.description,publisher:row.publisher_id?{id:row.publisher_id,nickname:row.nickname,kind:row.kind}:null,baseline:row.baseline,recorded_at:row.recorded_at.toISOString()};
        if(Buffer.byteLength(JSON.stringify([...items,item]))+1024>budget) {if(!items.length) throw new RetrievalError('response_budget_too_small',Buffer.byteLength(JSON.stringify(item))+1024);break;}
        items.push(item);
      }
      const complete=items.length===rows.length;
      return fit({items,complete,next_cursor:complete?null:this.encode(binding,String(items.at(-1)!.version))},budget);
    });
  }
  audit(context:ActorContext,options:PageOptions) {
    const size=this.size(options),budget=responseBudget(options.max_response_bytes);
    return this.run(async tx=>{
      const actor=await this.administrator(tx,context),binding=JSON.stringify([actor.participantId,'audit']),after=this.decode(binding,options.cursor);
      const rows=(await tx.query<{operation_id:string;kind:string;actor_id:string;resource_id:string;result_version:number;hierarchy_version:number;recorded_at:Date}>(`SELECT o.id AS operation_id,o.operation_kind AS kind,o.actor_id,o.resource_id,o.result_version,o.hierarchy_version,a.recorded_at FROM loom.organization_operations o JOIN loom.organization_audit a ON a.operation_id=o.id WHERE ($1::uuid IS NULL OR o.id>$1) ORDER BY o.id LIMIT $2`,[after,size+1])).rows;
      const items=[];
      for(const row of rows.slice(0,size)) {
        const item={...row,recorded_at:row.recorded_at.toISOString()};
        if(Buffer.byteLength(JSON.stringify([...items,item]))+1024>budget) {
          if(!items.length) throw new RetrievalError('response_budget_too_small',Buffer.byteLength(JSON.stringify(item))+1024);
          break;
        }
        items.push(item);
      }
      const complete=items.length===rows.length;
      return fit({items,complete,next_cursor:complete?null:this.encode(binding,items.at(-1)!.operation_id)},budget);
    });
  }
}
