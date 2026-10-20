import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/updates.js';
import * as R from '../../../contracts/routine-updates.js';
import * as A from '../../../contracts/attention.js';
import { attentionOwner, attentionPolicy, dismissalStates, inputKey, normalizeInputs, prepareAttentionSelection, AttentionError } from '../attention/controls.js';
import { BoundDefinition, eventPreferences, type BoundDefinitionView, type FollowTargetView } from '../../../contracts/following.js';
import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision, safeError, type Transactions } from '../publication/publication.js';
import { PublicationError } from '../publication/errors.js';
import { fit, RetrievalError } from '../participation/retrieval.js';
import { lockReferencePlan } from '../participation/reference-context.js';
import { followingDefinitions, normalizeSettings } from '../following/subscriptions.js';
import { followingOwner, followSource, unavailable } from '../following/context.js';
import { SharedChanges, sharedCandidatesSql, sharedMatches, type SharedCandidate } from '../following/retrieval.js';
import { PersonalNotifications, type PersonalCandidate } from '../notifications/retrieval.js';

const L = C.updatesLimits;
const messages = {
  updates_attention_refresh_required: 'Attention settings changed. Refresh attention selection over the same subjects and intervals, or open Complete retrieval.',
  updates_attention_preparing: 'Routine attention selection is still preparing. Continue preparing or refresh attention selection over the same subjects and intervals; Complete retrieval remains available.',
  updates_token_invalid: 'This Updates descriptor does not match its owner, purpose, operation or bound selection.',
  updates_descriptor_expired: 'This Updates view expired. Renew the same retained view and page.',
  updates_state_unavailable: 'The bounded grouping state is unavailable. Exact page recovery cannot be established; explicitly resynchronize.',
  updates_visibility_replay_required: 'Visibility changed. Replay both retained streams, including history before completed lower bounds.',
  updates_shared_history_gap: 'Required shared history is unavailable. Explicit resynchronization cannot reconstruct those events.',
  updates_personal_history_gap: 'Required personal history is unavailable. Explicit resynchronization cannot reconstruct those deliveries.',
  updates_epoch_changed: 'An Updates or component recovery epoch changed. Continuity requires deployment recovery.',
  updates_definition_changed: 'Following changed. Start a new retained-history scope to include newly selected history.',
  updates_capacity: 'The synthetic grouping or custody limit was reached. Narrow oversized scopes; if retained view slots are full, reuse a saved view or wait for expiry. Live views are not evicted.',
  updates_work_limit: 'Updates exceeded a bounded work deadline. Retry the same position; no failed component advanced.',
  updates_view_changed: 'Authority or source state changed during retrieval. Reauthorize the same page.',
};
export class UpdatesError extends Error { constructor(readonly code: keyof typeof messages) { super(messages[code]); } }
type Authority = Awaited<ReturnType<typeof lockActor>>;
type State = { cursor_key: Buffer; epoch: string; instance: string; shared_epoch: string; personal_epoch: string;
  shared_visibility: string; personal_visibility: string; shared_position: string; personal_position: string;
  shared_floor: string; personal_floor: string };
type Bound = { purpose: typeof C.updatesContract|typeof R.routineUpdatesContract; policy?:number; v: 1; owner: string; instance: string; epoch: string;
  shared_epoch: string; personal_epoch: string; shared_visibility: string; personal_visibility: string;
  id: string; scope: 'following'|'explicit'|'personal'; definitions: BoundDefinitionView[]; reason: 'all'|'mention'|'reply';
  shared_lower: string; shared_upper: string; personal_lower: string; personal_upper: string;
  shared_history: 'retained'|'incomplete'; personal_history: 'retained'|'incomplete';
  kind: 'prepare'|'groups'|'members'|'checkpoint'; selection: 'highlights'|'complete'|'direct';
  after: number; group: string|null; direct: boolean; expires: number; baseline: boolean };
type View = { shared_after: string; personal_after: string; ready: boolean; unknown_shared: boolean; steps: number; retain_until: Date };
type Group = { id: string; kind: C.UpdateGroupView['kind']; group_key: string; ordinal: number; direct: boolean; highlighted: boolean };
type Member = { event_id: string; resource_id: string; revision_id: string|null; group_kind: Group['kind']; group_key: string;
  shared: boolean; delivery_id: string|null; display_at: Date };
const personalSql = `SELECT d.id,d.signal_id,d.position::text,d.available_at,s.resource_id,s.revision_id,s.source_event_id,c.parent_id,
  COALESCE(c.discussion_id,CASE WHEN r.kind='summary' THEN r.owner_resource_id END) AS discussion_id
  FROM loom.personal_deliveries d JOIN loom.notification_signals s ON s.id=d.signal_id JOIN loom.resources r ON r.id=s.resource_id
  LEFT JOIN loom.contributions c ON c.id=s.resource_id`;

type AnyPage=C.UpdatesPageView|R.RoutinePageView;
type AnyMembers=C.UpdatesMembersPageView|R.RoutineMembersPageView;
type SelectionView={policy_version:number;scanned:number;ready:boolean};
export class CombinedUpdates<Routine extends boolean=false> {
  private readonly shared: SharedChanges;
  private readonly personal: PersonalNotifications;
  constructor(private readonly database: Transactions, private readonly routine:Routine=false as Routine) {
    this.shared = new SharedChanges(database); this.personal = new PersonalNotifications(database);
  }
  private get contract(){return this.routine?R.routineUpdatesContract:C.updatesContract;}
  private coverage(bound:Bound):R.RoutinePageView['attention']{return {policy_version:bound.policy??0,selection:bound.selection==='complete'?'all_represented_inputs':'remaining_routine_inputs',counts:'source_records; shared_events; personal_signals_are_distinct_units',refresh:'explicit_same_scope_and_intervals'};}
  private async run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    try { return await this.database.transaction(async tx => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
      await tx.query("SET LOCAL statement_timeout='2500ms'", []);
      await tx.query("SET LOCAL lock_timeout='1500ms'", []);
      await tx.query("SET LOCAL transaction_timeout='15000ms'", []);
      return work(tx);
    }); } catch (error) {
      if (error instanceof UpdatesError || error instanceof RetrievalError || error instanceof AttentionError) throw error;
      const code = (error as {code?: string})?.code;
      if (['40001','40P01','55P03'].includes(code ?? '')) throw new UpdatesError('updates_view_changed');
      if (['57014','25P04'].includes(code ?? '')) throw new UpdatesError('updates_work_limit');
      return safeError(error);
    }
  }
  private async state(tx: SqlTransaction, owner: string): Promise<State> {
    // One MVCC boundary captures two different committed clocks; neither is MAX(event).
    return (await tx.query<State>(`SELECT u.cursor_key,u.recovery_epoch AS epoch,c.instance_id AS instance,
      s.recovery_epoch AS shared_epoch,n.recovery_epoch AS personal_epoch,
      s.visibility_version::text AS shared_visibility,n.visibility_version::text AS personal_visibility,
      k.shared_position::text AS shared_position,COALESCE(p.position,0)::text AS personal_position,
      s.retained_after::text AS shared_floor,COALESCE(p.retained_after,0)::text AS personal_floor
      FROM loom.updates_state u CROSS JOIN loom.shared_retrieval_state s CROSS JOIN loom.notification_state n
      CROSS JOIN loom.community_settings c CROSS JOIN loom.community_clocks k
      LEFT JOIN loom.participant_delivery_clocks p ON p.participant_id=$1
      WHERE u.id=1 AND s.id=1 AND n.id=1 AND c.id=1 AND k.id=1`, [owner])).rows[0]!;
  }
  private encode(state: State, bound: Bound) {
    const {definitions, ...rest} = bound;
    const d = definitions.map(v => [v.target.kind,v.target.resource_id,v.include_descendants ? 1 : 0,
      eventPreferences.reduce((mask,p,i) => mask + (v.preferences.includes(p) ? 2**i : 0),0),v.version]);
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',state.cursor_key,nonce);
    cipher.setAAD(Buffer.from(this.contract));
    const bytes=Buffer.concat([cipher.update(JSON.stringify({...rest,d})),cipher.final()]);
    const token=Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
    if (Buffer.byteLength(token)>L.tokenBytes) throw new UpdatesError('updates_capacity');
    return token;
  }
  private decode(state: State, token: string, owner: string): Bound {
    let bound: Bound;
    try {
      if (Buffer.byteLength(token)>L.tokenBytes) throw new Error();
      const bytes=Buffer.from(token,'base64url'), cipher=createDecipheriv('aes-256-gcm',state.cursor_key,bytes.subarray(0,12));
      cipher.setAAD(Buffer.from(this.contract)); cipher.setAuthTag(bytes.subarray(12,28));
      const {d,...rest}=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString());
      if (!Array.isArray(d)||d.length>64) throw new Error();
      bound={...rest,definitions:d.map(([kind,id,desc,mask,version]:[string,string,number,number,number])=>{
        if(![0,1].includes(desc)||!Number.isInteger(mask)||mask<1||mask>127)throw new Error();
        return {target:{kind,resource_id:id},include_descendants:desc===1,preferences:eventPreferences.filter((_,i)=>mask&2**i),version};
      })};
      if(bound.purpose!==this.contract||bound.v!==1||this.routine&&(!Number.isInteger(bound.policy)||bound.policy!<0)||bound.owner!==owner||bound.instance!==state.instance||
        !['following','explicit','personal'].includes(bound.scope)||!['all','mention','reply'].includes(bound.reason)||
        !['prepare','groups','members','checkpoint'].includes(bound.kind)||!['highlights','complete','direct'].includes(bound.selection)||
        !bound.definitions.every(d=>Value.Check(BoundDefinition,d))||
        ![bound.shared_lower,bound.shared_upper,bound.personal_lower,bound.personal_upper].every(v=>/^\d{1,19}$/.test(v))||
        BigInt(bound.shared_lower)>BigInt(bound.shared_upper)||BigInt(bound.personal_lower)>BigInt(bound.personal_upper)||
        !Number.isInteger(bound.after)||bound.after<0||bound.after>L.members||!Number.isFinite(bound.expires)||
        !/^[a-f0-9-]{36}$/.test(bound.id)||typeof bound.direct!=='boolean'||typeof bound.baseline!=='boolean'||
        !['retained','incomplete'].includes(bound.shared_history)||!['retained','incomplete'].includes(bound.personal_history))throw new Error();
    }catch{throw new UpdatesError('updates_token_invalid');}
    if(bound.epoch!==state.epoch||bound.shared_epoch!==state.shared_epoch||bound.personal_epoch!==state.personal_epoch)
      throw new UpdatesError('updates_epoch_changed');
    return bound;
  }
  private continuity(state: State, saved: Bound, action?: string) {
    if((saved.shared_visibility!==state.shared_visibility||saved.personal_visibility!==state.personal_visibility)&&
      !['replay','resynchronize'].includes(action??''))throw new UpdatesError('updates_visibility_replay_required');
    for(const component of ['shared','personal'] as const){
      const floor=BigInt(state[`${component}_floor`]);
      if(action!=='resynchronize'&&((action==='replay'&&floor>0n)||
        BigInt(saved.kind==='checkpoint'?saved[`${component}_upper`]:saved[`${component}_lower`])<floor||
        BigInt(saved[`${component}_upper`])>BigInt(state[`${component}_position`])))
        throw new UpdatesError(component==='shared'?'updates_shared_history_gap':'updates_personal_history_gap');
    }
    if(saved.kind!=='checkpoint'&&saved.expires<=Date.now()&&!action)throw new UpdatesError('updates_descriptor_expired');
  }
  private async view(tx: SqlTransaction, bound: Bound, write=false) {
    const view=(await tx.query<View>(`SELECT shared_after::text,personal_after::text,ready,unknown_shared,steps,retain_until
      FROM loom.updates_views WHERE id=$1 AND participant_id=$2 FOR ${write?'UPDATE':'SHARE'}`,[bound.id,bound.owner])).rows[0];
    if(!view||view.retain_until.getTime()<=Date.now())throw new UpdatesError('updates_state_unavailable');
    return view;
  }
  private async create(tx: SqlTransaction, bound: Bound) {
    // A conflicting write forces an older RR snapshot to retry. An advisory lock
    // alone serializes execution but leaves the quota count on that old snapshot.
    // This custody guard precedes source guards and never touches either clock.
    await tx.query('UPDATE loom.updates_custody_serialization SET generation=generation+1 WHERE id=1',[]);
    await tx.query(`DELETE FROM loom.updates_views WHERE id IN
      (SELECT id FROM loom.updates_views WHERE retain_until<=clock_timestamp() ORDER BY retain_until,id LIMIT 1)`,[]);
    const caps=(await tx.query<{total:number;own:number}>(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE participant_id=$1)::int AS own FROM loom.updates_views`,[bound.owner])).rows[0]!;
    if(caps.total>=L.views||caps.own>=L.ownerViews)throw new UpdatesError('updates_capacity');
    await tx.query(`INSERT INTO loom.updates_views(id,participant_id,shared_after,personal_after,ready)
      VALUES($1,$2,$3,$4,$5)`,[bound.id,bound.owner,bound.shared_lower,bound.personal_lower,bound.baseline]);
  }
  private memberColumns(bound:Bound){return this.routine&&bound.selection!=='complete'
    ?'m.*,a.shared AS shared,CASE WHEN a.personal THEN m.delivery_id ELSE NULL END AS delivery_id':'m.*';}
  private memberJoin(bound:Bound){return this.routine&&bound.selection!=='complete'
    ?'JOIN loom.attention_members a ON a.view_id=m.view_id AND a.event_id=m.event_id':'';}
  private memberWhere(bound:Bound){return this.routine&&bound.selection!=='complete'?'a.shared OR a.personal':'true';}
  private selectedMembers(tx:SqlTransaction,bound:Bound,groups:string[]){
    return tx.query<Member>(`SELECT ${this.memberColumns(bound)} FROM loom.updates_members m ${this.memberJoin(bound)}
      WHERE m.view_id=$1 AND (${this.memberWhere(bound)}) AND (group_kind,group_key) IN
      (SELECT kind,group_key FROM loom.updates_groups WHERE view_id=$1 AND id=ANY($2::uuid[]))`,[bound.id,groups]).then(r=>r.rows);
  }
  private async selectionView(tx:SqlTransaction,bound:Bound):Promise<SelectionView>{
    // Selection custody is locked before any source plan, never after a clock.
    await tx.query('INSERT INTO loom.attention_views(view_id,policy_version) VALUES($1,$2) ON CONFLICT DO NOTHING',[bound.id,bound.policy]);
    let view=(await tx.query<SelectionView>('SELECT * FROM loom.attention_views WHERE view_id=$1 FOR UPDATE',[bound.id])).rows[0]!;
    if(view.policy_version!==bound.policy){
      await tx.query('DELETE FROM loom.attention_members WHERE view_id=$1',[bound.id]);
      await tx.query('DELETE FROM loom.attention_groups WHERE view_id=$1',[bound.id]);
      await tx.query('UPDATE loom.attention_views SET policy_version=$2,scanned=0,ready=false WHERE view_id=$1',[bound.id,bound.policy]);
      view={policy_version:bound.policy!,scanned:0,ready:false};
    }
    return view;
  }
  private async requireReadySelection(tx:SqlTransaction,bound:Bound){
    if(!this.routine||bound.selection==='complete')return;
    // Base grouping can finish before the bounded attention scan. Partial rows
    // are never complete membership or a whole-card dismissal selection.
    const view=(await tx.query<SelectionView>('SELECT policy_version,ready FROM loom.attention_views WHERE view_id=$1 FOR SHARE',[bound.id])).rows[0];
    if(!view?.ready||view.policy_version!==bound.policy)throw new UpdatesError('updates_attention_preparing');
  }
  private async selectStep(tx:SqlTransaction,actor:Authority,bound:Bound,view:SelectionView,
    policy:Awaited<ReturnType<typeof attentionPolicy>>,statusSources:{id:string}[]):Promise<SelectionView>{
    const rows=(await tx.query<Member>('SELECT * FROM loom.updates_members WHERE view_id=$1 ORDER BY event_id LIMIT 101 OFFSET $2',[bound.id,view.scanned])).rows;
    const selected=rows.slice(0,L.scan),events=await this.events(tx,selected);
    await lockReferencePlan(tx,[...statusSources.map(v=>v.id),...events.flatMap(e=>[e.resource_id,...(e.discussion_id?[e.discussion_id]:[]),...(e.parent_id?[e.parent_id]:[])])]);
    await tx.query('SELECT id FROM loom.revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[events.flatMap(e=>e.revision_id?[e.revision_id]:[])]);
    const inputs=selected.flatMap(m=>[...(m.shared?[{kind:'shared_event' as const,id:m.event_id}]:[]),...(m.delivery_id?[{kind:'personal_delivery' as const,id:m.delivery_id}]:[])]);
    const dismissed=await dismissalStates(tx,actor.participantId,inputs);
    for(const m of selected){
      const event=events.find(e=>e.id===m.event_id)!;let eligible=true;
      try{await this.authorize(tx,event);}catch(error){if(!unavailable(error))throw error;eligible=false;}
      // Unknown coverage was captured before this private selector. Never infer
      // missing old structural impacts from current mute targets or hierarchy.
      const shared=eligible&&m.shared&&!sharedMatches(event,policy.definitions).reasons.length&&!dismissed.get(inputKey({kind:'shared_event',id:m.event_id}))?.dismissed;
      const personal=eligible&&!!m.delivery_id&&!dismissed.get(inputKey({kind:'personal_delivery',id:m.delivery_id!}))?.dismissed;
      await tx.query(`INSERT INTO loom.attention_members(view_id,event_id,shared,personal) VALUES($1,$2,$3,$4)
        ON CONFLICT(view_id,event_id) DO UPDATE SET shared=EXCLUDED.shared,personal=EXCLUDED.personal`,[bound.id,m.event_id,shared,personal]);
    }
    const ready=rows.length<=L.scan,scanned=view.scanned+selected.length;
    await tx.query('UPDATE loom.attention_views SET scanned=$2,ready=$3 WHERE view_id=$1',[bound.id,scanned,ready]);
    if(ready)await tx.query(`INSERT INTO loom.attention_groups(view_id,group_id,visible,direct,highlighted)
      SELECT $1,id,visible,direct,visible AND (direct OR routine_ordinal<=$2) FROM (
        SELECT *,sum(CASE WHEN visible AND NOT direct THEN 1 ELSE 0 END) OVER(ORDER BY ordinal) AS routine_ordinal FROM (
          SELECT g.id,g.ordinal,COALESCE(bool_or(a.shared OR a.personal),false) AS visible,COALESCE(bool_or(a.personal),false) AS direct
          FROM loom.updates_groups g LEFT JOIN loom.updates_members m ON m.view_id=g.view_id AND m.group_kind=g.kind AND m.group_key=g.group_key
          LEFT JOIN loom.attention_members a ON a.view_id=m.view_id AND a.event_id=m.event_id
          WHERE g.view_id=$1 GROUP BY g.id,g.ordinal) groups) ranked`,[bound.id,L.routineHighlights]);
    return {...view,scanned,ready};
  }
  private async authorize(tx: SqlTransaction, row: SharedCandidate) {
    await lockContext(tx,row.resource_id,'resolution',['area','discussion','contribution','artifact','summary']);
    if(row.revision_id)await requireRevision(tx,row.resource_id,row.revision_id);
  }
  private groupKey(row: SharedCandidate): {kind: Group['kind']; key: string} {
    if(row.discussion_id||row.resource_kind==='discussion')return {kind:'discussion',key:row.discussion_id??row.resource_id};
    if(row.resource_kind==='artifact')return {kind:'artifact',key:row.resource_id};
    return {kind:'structural',key:row.id};
  }
  private async prepare(tx: SqlTransaction, actor: Authority, bound: Bound, view: View, statusSources: {id:string}[]) {
    if(view.ready){await lockReferencePlan(tx,statusSources.map(r=>r.id));return view;}
    if(view.steps>=L.steps)throw new UpdatesError('updates_capacity');
    const shared=bound.definitions.length?(await tx.query<SharedCandidate>(`${sharedCandidatesSql}
      WHERE e.position>$1 AND e.position<=$2 ORDER BY e.position LIMIT 101`,[view.shared_after,bound.shared_upper])).rows:[];
    const personal=(await tx.query<PersonalCandidate>(`${personalSql} WHERE d.recipient_id=$1 AND d.position>$2 AND d.position<=$3
      ORDER BY d.position LIMIT 101`,[actor.participantId,view.personal_after,bound.personal_upper])).rows;
    const personalEvents=(await tx.query<SharedCandidate>(`${sharedCandidatesSql} WHERE e.id=ANY($1::uuid[])`,
      [personal.slice(0,L.scan).map(p=>p.source_event_id)])).rows;
    if(personalEvents.length!==personal.slice(0,L.scan).length)throw new UpdatesError('updates_personal_history_gap');
    await lockReferencePlan(tx,[...statusSources.map(r=>r.id),...bound.definitions.map(d=>d.target.resource_id),...shared.slice(0,L.scan).flatMap(r=>[r.resource_id,...(r.discussion_id?[r.discussion_id]:[])]),
      ...personal.slice(0,L.scan).flatMap(r=>[r.resource_id,r.parent_id,r.discussion_id].filter((v):v is string=>!!v))]);
    if(bound.scope==='explicit'&&(await followSource(tx,bound.definitions[0]!.target)).state==='unavailable')throw new PublicationError('unavailable');
    const rows=new Map<string,{event:SharedCandidate;shared:boolean;delivery:PersonalCandidate|null}>();
    let unknown=view.unknown_shared;
    for(const row of shared.slice(0,L.scan))if(row.actor_kind!=='internal')try{
      await this.authorize(tx,row);
      const match=sharedMatches(row,bound.definitions);unknown ||= match.unknown;
      if(match.reasons.length)rows.set(row.id,{event:row,shared:true,delivery:null});
    }catch(error){if(!unavailable(error))throw error;}
    for(const row of personal.slice(0,L.scan))try{
      const reasons=await this.personal.reasons(tx,row.signal_id);
      if(bound.reason!=='all'&&!reasons.some(r=>bound.reason==='reply'?r.kind==='direct_reply':r.kind!=='direct_reply'))continue;
      // Reuse personal exact-source/owner policy, including real parent provenance.
      await this.personal.item(tx,actor,row,reasons);
      const event=personalEvents.find(e=>e.id===row.source_event_id)!;
      rows.set(event.id,{event,shared:rows.get(event.id)?.shared??false,delivery:row});
    }catch(error){if(!unavailable(error))throw error;}
    for(const {event,shared,delivery} of rows.values()){
      const key=this.groupKey(event),at=delivery&&delivery.available_at>event.created_at?delivery.available_at:event.created_at;
      await tx.query(`INSERT INTO loom.updates_members(view_id,event_id,resource_id,revision_id,group_kind,group_key,shared,delivery_id,display_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(view_id,event_id) DO UPDATE SET
        shared=loom.updates_members.shared OR EXCLUDED.shared,delivery_id=COALESCE(EXCLUDED.delivery_id,loom.updates_members.delivery_id),
        display_at=GREATEST(loom.updates_members.display_at,EXCLUDED.display_at)`,
        [bound.id,event.id,event.resource_id,event.revision_id,key.kind,key.key,shared,delivery?.id??null,at]);
    }
    const sizes=(await tx.query<{n:number}>(`SELECT count(*)::int AS n FROM loom.updates_members WHERE view_id=$1 GROUP BY group_kind,group_key`,[bound.id])).rows;
    if(sizes.length>L.groups||sizes.some(s=>s.n>L.groupMembers)||sizes.reduce((a,s)=>a+s.n,0)>L.members)throw new UpdatesError('updates_capacity');
    const sa=shared.length<=L.scan?bound.shared_upper:shared[L.scan-1]!.position;
    const pa=personal.length<=L.scan?bound.personal_upper:personal[L.scan-1]!.position;
    const ready=sa===bound.shared_upper&&pa===bound.personal_upper;
    await tx.query(`UPDATE loom.updates_views SET shared_after=$2,personal_after=$3,ready=$4,unknown_shared=$5,steps=steps+1 WHERE id=$1`,[bound.id,sa,pa,ready,unknown]);
    if(ready){
      const groups=(await tx.query<{group_kind:Group['kind'];group_key:string;direct:boolean}>(`SELECT group_kind,group_key,bool_or(delivery_id IS NOT NULL) AS direct,
        max(display_at) AS latest FROM loom.updates_members WHERE view_id=$1 GROUP BY group_kind,group_key
        ORDER BY direct DESC,latest DESC,group_kind,group_key`,[bound.id])).rows;
      let routine=0;
      for(const [index,g] of groups.entries())await tx.query(`INSERT INTO loom.updates_groups(view_id,id,kind,group_key,ordinal,direct,highlighted)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[bound.id,randomUUID(),g.group_kind,g.group_key,index+1,g.direct,g.direct||++routine<=L.routineHighlights]);
    }
    return {...view,shared_after:sa,personal_after:pa,ready,unknown_shared:unknown,steps:view.steps+1};
  }
  query(context: ActorContext, options: C.UpdatesOptions|R.RoutineOptions): Promise<Routine extends true?R.RoutinePageView:C.UpdatesPageView> {
    if(!Value.Check(this.routine?R.RoutineQuery:C.UpdatesQuery,options)||[options.cursor,options.checkpoint,options.switch,options.recovery].filter(Boolean).length>1||
      options.recovery&&!options.recovery.token&&options.recovery.action!=='resynchronize')throw new PublicationError('invalid_input');
    return this.run(async tx=>{
      const actor=await lockActor(tx,context);await followingOwner(tx,actor.participantId);
      if(this.routine)await attentionOwner(tx,actor.participantId);
      const policy=this.routine?await attentionPolicy(tx,actor.participantId):undefined;
      const state=await this.state(tx,actor.participantId),token=options.cursor??options.checkpoint??options.switch?.token??options.recovery?.token;
      const saved=token?this.decode(state,token,actor.participantId):undefined,action=options.recovery?.action;
      if(saved)this.continuity(state,saved,action);
      if(action==='attention_refresh'&&(!saved||saved.kind==='checkpoint'))throw new UpdatesError('updates_token_invalid');
      if(options.checkpoint&&saved?.kind!=='checkpoint'||options.cursor&&(!saved||!['groups','prepare'].includes(saved.kind))||
        options.switch&&saved?.kind==='checkpoint'||action==='renew'&&saved?.kind==='checkpoint')throw new UpdatesError('updates_token_invalid');
      const scope=saved?.scope??options.scope?.kind??'following',reason=saved?.reason??options.reason??'all';
      if(saved&&(options.reason&&options.reason!==saved.reason||options.selection&&options.selection!==saved.selection||
        options.scope&&(options.scope.kind!==saved.scope||options.scope.kind==='explicit'&&JSON.stringify(normalizeSettings(options.scope.definition))!==
          JSON.stringify((({version:_,...s})=>s)(saved.definitions[0]!)))))throw new UpdatesError('updates_token_invalid');
      const current=scope==='following'?await followingDefinitions(tx,actor.participantId):undefined;
      const definitions=saved?.definitions??current??(scope==='personal'?[]:[{...normalizeSettings((options.scope as Extract<NonNullable<C.UpdatesOptions['scope']>,{kind:'explicit'}>).definition),version:0}]);
      const settingsCurrent=!current||JSON.stringify(current)===JSON.stringify(definitions);
      if(saved?.kind==='checkpoint'&&!settingsCurrent&&action!=='replay'&&action!=='resynchronize')throw new UpdatesError('updates_definition_changed');
      if(!saved&&action!=='resynchronize'){
        if(state.shared_floor!=='0')throw new UpdatesError('updates_shared_history_gap');
        if(state.personal_floor!=='0')throw new UpdatesError('updates_personal_history_gap');
      }
      const fresh=!saved||saved.kind==='checkpoint'||action==='replay'||action==='resynchronize';
      const resync=action==='resynchronize',replay=action==='replay';
      let bound:Bound=fresh?{purpose:this.contract,...(this.routine?{policy:policy!.version}:{}),v:1,owner:actor.participantId,instance:state.instance,epoch:state.epoch,
        shared_epoch:state.shared_epoch,personal_epoch:state.personal_epoch,shared_visibility:state.shared_visibility,personal_visibility:state.personal_visibility,
        id:randomUUID(),scope,definitions,reason,shared_lower:resync?state.shared_position:replay?'0':saved?.shared_upper??'0',shared_upper:state.shared_position,
        personal_lower:resync?state.personal_position:replay?'0':saved?.personal_upper??'0',personal_upper:state.personal_position,
        shared_history:resync?'incomplete':saved?.shared_history??'retained',personal_history:resync?'incomplete':saved?.personal_history??'retained',
        kind:'prepare',selection:options.selection??saved?.selection??'highlights',after:0,group:null,direct:false,
        expires:Date.now()+L.cursorSeconds*1000,baseline:resync}:{...saved};
      if(this.routine&&!fresh&&action!=='attention_refresh'&&(options.switch?.selection??bound.selection)!=='complete'&&bound.policy!==policy!.version)throw new UpdatesError('updates_attention_refresh_required');
      if(action==='attention_refresh')bound={...bound,policy:policy!.version,after:0,kind:'prepare',group:null,direct:false};
      if(fresh)await this.create(tx,bound);
      let view=await this.view(tx,bound,bound.kind==='prepare');
      // Explicit attention refresh must also recover an expired descriptor when
      // ordinary renewal requires a policy refresh. Custody and bounds stay fixed.
      if(action==='renew'||action==='attention_refresh'&&bound.expires<=Date.now())bound.expires=Math.min(Date.now()+L.cursorSeconds*1000,view.retain_until.getTime());
      if(options.switch)bound={...bound,selection:options.switch.selection,kind:view.ready?'groups':'prepare',after:0,group:null,direct:false};
      if(bound.kind==='members')throw new UpdatesError('updates_token_invalid');
      const statusSources=await this.personal.statusSources(tx);
      const filtered=this.routine&&bound.selection!=='complete';
      let selection=filtered?await this.selectionView(tx,bound):undefined;
      const basePreparing=!view.ready,selecting=!basePreparing&&filtered&&!selection!.ready;
      const preparing=basePreparing||selecting||bound.kind==='prepare'&&!this.routine;
      if(basePreparing||preparing&&!selecting)view=await this.prepare(tx,actor,bound,view,statusSources);
      if(selecting)selection=await this.selectStep(tx,actor,bound,selection!,policy!,statusSources);
      if(view.ready&&(!filtered||selection?.ready)){if(bound.kind==='prepare')bound={...bound,kind:'groups',after:0};}
      else bound={...bound,kind:'prepare'};
      const groupSql=this.routine?`SELECT g.* FROM loom.updates_groups g LEFT JOIN loom.attention_groups a ON a.view_id=g.view_id AND a.group_id=g.id
        WHERE g.view_id=$1 AND ordinal>$2 AND (NOT $5 OR a.visible)
        AND ($3='complete' OR $3='highlights' AND CASE WHEN $5 THEN a.highlighted ELSE g.highlighted END
        OR $3='direct' AND CASE WHEN $5 THEN a.direct ELSE g.direct END) ORDER BY ordinal LIMIT $4`:`SELECT * FROM loom.updates_groups WHERE view_id=$1 AND ordinal>$2
        AND ($3='complete' OR $3='highlights' AND highlighted OR $3='direct' AND direct) ORDER BY ordinal LIMIT $4`;
      const groups=view.ready&&!preparing?(await tx.query<Group>(groupSql,
        [bound.id,bound.after,bound.selection,(options.limit??12)+1,...(this.routine?[filtered]:[])])).rows:[];
      const selected=groups.slice(0,options.limit??12);
      const members=selected.length?await this.selectedMembers(tx,bound,selected.map(g=>g.id)):[];
      const events=await this.events(tx,members);
      const explanationCandidates=await this.explanations(tx,bound,members);
      if(!preparing)await lockReferencePlan(tx,[...statusSources.map(r=>r.id),...events.flatMap(e=>[e.resource_id,...(e.discussion_id?[e.discussion_id]:[]),...(e.parent_id?[e.parent_id]:[])]),
        ...explanationCandidates.flatMap(e=>[e.resource_id,...(e.discussion_id?[e.discussion_id]:[])])]);
      const projection=await this.personal.projection(tx,statusSources),budget=options.max_response_bytes??131072;
      const boundary=(component:string,position:string)=>createHmac('sha256',state.cursor_key).update(JSON.stringify([C.updatesContract,bound.owner,component,position])).digest('base64url');
      const page:AnyPage={contract_version:this.contract,...(this.routine?{attention:this.coverage(bound)}:{}),stage:view.ready&&!preparing?'ready':'preparing',items:[],
        traversal:{id:bound.id,scope,definitions,reason,selection:bound.selection,settings_current:settingsCurrent,grouping:'ownership; area_event',
          order:'direct_first; frozen_recent_then_identity',expires_at:new Date(bound.expires).toISOString(),
          shared:{contract:'shared-changes-1',lower:boundary('shared',bound.shared_lower),upper:boundary('shared',bound.shared_upper),
            scan_complete:view.shared_after===bound.shared_upper,coverage:view.unknown_shared?'unknown':'known',history:bound.shared_history},
          personal:{contract:'personal-attention-1',lower:boundary('personal',bound.personal_lower),upper:boundary('personal',bound.personal_upper),
            scan_complete:view.personal_after===bound.personal_upper,coverage:'known',history:bound.personal_history}},
        page_cursor:this.encode(state,bound),next_cursor:null,checkpoint:null,
        complete_cursor:view.ready?this.encode(state,{...bound,kind:'groups',selection:'complete',after:0}):null,
        direct_cursor:view.ready?this.encode(state,{...bound,kind:'groups',selection:'direct',after:0}):null,
        records_cursor:view.ready?this.encode(state,{...bound,kind:'members',selection:'complete',after:0,group:null,direct:false}):null,
        page_exhausted:false,selection_exhausted:false,grouped_interval_complete:false,member_metadata_complete:false,full_contents_fetched:false,
        projection,work_budget_reached:!view.ready,recovery:action==='attention_refresh'?'attention_refreshed':action==='renew'?'renewed':replay?'visibility_replay':resync?'retained_resynchronization':'none',
        baseline_established:bound.baseline,inventory:bound.baseline?[{label:'Current topic inventory',url:'/api/v1/organization/children'},
          {label:'Current artifact inventory and exact history',url:'/api/v1/artifacts'},{label:'Retained personal attention',url:'/api/v1/me/notifications/query'}]:[],
        limit:options.limit??12,max_response_bytes:budget} as AnyPage;
      if(preparing||!view.ready){page.next_cursor=this.encode(state,bound);return fit(page,budget);}
      let last=bound.after,consumed=0;
      for(const group of selected){
        const own=members.filter(m=>m.group_kind===group.kind&&m.group_key===group.group_key);
        const item=await this.group(tx,actor,state,bound,group,own,events,explanationCandidates,view.unknown_shared);
        if(item){
          const preview={...page,items:[...page.items,item],next_cursor:this.encode(state,{...bound,after:group.ordinal})};
          if(Buffer.byteLength(JSON.stringify(preview))+128>budget){if(!page.items.length)throw new RetrievalError('response_budget_too_small',Buffer.byteLength(JSON.stringify(preview))+128);break;}
          page.items.push(item);
        }
        consumed++;last=group.ordinal;
      }
      page.page_exhausted=consumed===groups.length;page.selection_exhausted=page.page_exhausted;
      page.grouped_interval_complete=page.selection_exhausted&&bound.selection==='complete'&&!view.unknown_shared&&!bound.baseline;
      if(page.grouped_interval_complete||bound.baseline)page.checkpoint=this.encode(state,{...bound,kind:'checkpoint',after:0,expires:0,baseline:false});
      else if(!page.selection_exhausted)page.next_cursor=this.encode(state,{...bound,after:last});
      return fit(page,budget);
    }) as Promise<Routine extends true?R.RoutinePageView:C.UpdatesPageView>;
  }
  private async events(tx: SqlTransaction, members: Member[]) {
    if(!members.length)return [];
    const rows=(await tx.query<SharedCandidate>(`${sharedCandidatesSql} WHERE e.id=ANY($1::uuid[])`,[members.map(m=>m.event_id)])).rows;
    if(rows.length!==members.length)throw new UpdatesError(members.some(m=>m.shared&&!rows.some(r=>r.id===m.event_id))?'updates_shared_history_gap':'updates_personal_history_gap');
    const deliveries=members.flatMap(m=>m.delivery_id?[m.delivery_id]:[]);
    if(deliveries.length&&(await tx.query('SELECT id FROM loom.personal_deliveries WHERE id=ANY($1::uuid[])',[deliveries])).rowCount!==deliveries.length)
      throw new UpdatesError('updates_personal_history_gap');
    return rows;
  }
  private async explanations(tx: SqlTransaction, bound: Bound, members: Member[]) {
    if(!members.length)return [];
    // At most sixteen candidates per displayed group, with no body download.
    const groups=[...new Set(members.map(m=>m.group_kind+':'+m.group_key))],out:SharedCandidate[]=[];
    for(const key of groups){
      const revisions=members.filter(m=>m.group_kind+':'+m.group_key===key).flatMap(m=>m.revision_id?[m.revision_id]:[]);
      const rows=(await tx.query<SharedCandidate>(`${sharedCandidatesSql} WHERE e.position<=$1 AND
        (e.revision_id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM loom.revision_change_notes n WHERE n.revision_id=e.revision_id)
        OR EXISTS(SELECT 1 FROM loom.change_account_members m WHERE m.revision_id=e.revision_id AND m.target_revision_id=ANY($2::uuid[])))
        ORDER BY note DESC,e.position DESC,e.id LIMIT 16`,[bound.shared_upper,revisions])).rows;
      out.push(...rows);
    }
    return [...new Map(out.map(e=>[e.id,e])).values()].sort((a,b)=>Number(b.note)-Number(a.note)||
      (BigInt(a.position)>BigInt(b.position)?-1:BigInt(a.position)<BigInt(b.position)?1:a.id.localeCompare(b.id)));
  }
  private async explanation(tx: SqlTransaction, events: SharedCandidate[], candidates: SharedCandidate[]): Promise<C.UpdateExplanationView|null> {
    for(const row of candidates)try{
      if(!row.revision_id||row.actor_kind==='internal')continue;
      const note=row.note&&events.some(e=>e.revision_id===row.revision_id);
      const coverage=note?events.filter(e=>e.revision_id===row.revision_id):(await tx.query<{target_revision_id:string}>(
        'SELECT target_revision_id FROM loom.change_account_members WHERE revision_id=$1 LIMIT 16',[row.revision_id])).rows
        .flatMap(m=>events.filter(e=>e.revision_id===m.target_revision_id));
      if(!coverage.length)continue;
      await this.authorize(tx,row);
      return {form:note?'revision_note':'change_account',resource_id:row.resource_id,revision_id:row.revision_id,
        publisher:{id:row.publisher_id,nickname:row.nickname,kind:row.actor_kind},browser_url:`/loom/resource/${row.resource_id}/${row.revision_id}`+(note?'#change-note':''),
        explanation_url:`/api/v1/resources/${row.resource_id}/revisions/${row.revision_id}`+(note?'/change-note':''),
        coverage_url:note?null:`/api/v1/resources/${row.resource_id}/revisions/${row.revision_id}/change-coverage`,
        included_revisions:coverage.slice(0,16).map(e=>({kind:e.resource_kind as 'artifact'|'summary'|'contribution',resource_id:e.resource_id,revision_id:e.revision_id!})),
        scope:note?'owning_revision_only':'declared_exact_set',limitation:'author_claim; only_named_revisions; not_whole_interval_or_summary_currency'};
    }catch(error){if(!unavailable(error))throw error;}
    return null;
  }
  private async member(tx: SqlTransaction, actor: Authority, bound: Bound, member: Member, event: SharedCandidate): Promise<C.UpdateMemberView> {
    const source={...await this.shared.item(tx,event,member.shared?sharedMatches(event,bound.definitions).reasons:[]),detail_url:this.routine?'/api/v1/me/routine-updates/reasons':'/api/v1/me/updates/reasons'};
    let personal:C.UpdateMemberView['personal']=null;
    if(member.delivery_id){
      const row=(await tx.query<PersonalCandidate>(`${personalSql} WHERE d.id=$1 AND d.recipient_id=$2`,[member.delivery_id,actor.participantId])).rows[0];
      if(!row)throw new UpdatesError('updates_personal_history_gap');
      personal=await this.personal.item(tx,actor,row,await this.personal.reasons(tx,row.signal_id));
      // The existing direct feed's source stays unchanged; combined context uses
      // the contribution-only focus rule fixed by PR #11 for shared summaries.
      personal={...personal,context_url:source.context_url};
    }
    return {source,shared_in_interval:member.shared,personal};
  }
  private async group(tx: SqlTransaction, actor: Authority, state: State, bound: Bound, group: Group, members: Member[],
    events: SharedCandidate[], explanations: SharedCandidate[], unknownShared: boolean): Promise<C.UpdateGroupView|undefined> {
    const eligible:SharedCandidate[]=[];
    for(const member of members){const event=events.find(e=>e.id===member.event_id)!;
      try{await this.authorize(tx,event);eligible.push(event);}catch(error){if(!unavailable(error))throw error;}}
    if(!eligible.length)return;
    const visible=members.filter(m=>eligible.some(e=>e.id===m.event_id));
    const count=(test:(e:SharedCandidate)=>boolean)=>eligible.filter(test).length;
    const target:FollowTargetView=group.kind==='structural'?{kind:'area',resource_id:eligible[0]!.resource_id}:{kind:group.kind,resource_id:group.group_key};
    const current=await followSource(tx,target);
    const direct=visible.filter(m=>m.delivery_id).sort((a,b)=>b.display_at.getTime()-a.display_at.getTime()||a.event_id.localeCompare(b.event_id));
    const previews:C.UpdateMemberView[]=[];
    for(const member of direct.slice(0,L.previews))previews.push(await this.member(tx,actor,bound,member,eligible.find(e=>e.id===member.event_id)!));
    return {id:group.id,kind:group.kind,current,context_url:current.state==='available'?current.browser_url:'/loom/topics',
      counts:{certainty:unknownShared?'known_sources_only':'exact',source_records:visible.length,shared_changes:visible.filter(m=>m.shared).length,personal_signals:direct.length,
        reply_publications:count(e=>e.resource_kind==='contribution'&&!!e.parent_id&&e.revision_number==='1'),
        reply_revisions:count(e=>e.resource_kind==='contribution'&&!!e.parent_id&&e.revision_number!=='1'),
        summary_changes:count(e=>e.resource_kind==='summary'),artifact_changes:count(e=>e.resource_kind==='artifact'&&e.kind==='revision.published'),
        opening_changes:count(e=>e.resource_kind==='contribution'&&!e.parent_id),structural_changes:count(e=>e.kind==='organization.changed')},
      direct_sources:previews,direct_sources_complete:direct.length<=L.previews,
      members_cursor:this.encode(state,{...bound,kind:'members',group:group.id,after:0,direct:false}),
      direct_cursor:direct.length?this.encode(state,{...bound,kind:'members',group:group.id,after:0,direct:true}):null,
      explanation:await this.explanation(tx,eligible,explanations),omitted_detail:'remaining_member_metadata; full_bodies; summary_coverage_not_computed'};
  }
  members(context: ActorContext, options: C.UpdatesMembersOptions): Promise<Routine extends true?R.RoutineMembersPageView:C.UpdatesMembersPageView> {
    if(!Value.Check(C.UpdatesMembersQuery,options))throw new PublicationError('invalid_input');
    return this.run(async tx=>{
      const actor=await lockActor(tx,context);if(this.routine)await attentionOwner(tx,actor.participantId);
      const state=await this.state(tx,actor.participantId);
      let bound=this.decode(state,options.cursor,actor.participantId);this.continuity(state,bound,options.renew?'renew':undefined);
      if(this.routine&&bound.selection!=='complete'&&bound.policy!==(await attentionPolicy(tx,actor.participantId)).version)throw new UpdatesError('updates_attention_refresh_required');
      if(bound.kind!=='members'&&bound.kind!=='groups')throw new UpdatesError('updates_token_invalid');
      if(bound.kind==='groups')bound={...bound,kind:'members',group:options.group_id??null,direct:options.direct_only??false,after:0};
      else if(options.group_id&&options.group_id!==bound.group||options.direct_only!==undefined&&options.direct_only!==bound.direct)throw new UpdatesError('updates_token_invalid');
      const view=await this.view(tx,bound);if(!view.ready)throw new UpdatesError('updates_state_unavailable');
      await this.requireReadySelection(tx,bound);
      if(options.renew)bound.expires=Math.min(Date.now()+L.cursorSeconds*1000,view.retain_until.getTime());
      if(bound.group&&!(await tx.query('SELECT id FROM loom.updates_groups WHERE view_id=$1 AND id=$2',[bound.id,bound.group])).rowCount)throw new PublicationError('unavailable');
      const rows=(await tx.query<Member>(`SELECT ${this.memberColumns(bound)} FROM loom.updates_members m ${this.memberJoin(bound)} JOIN loom.updates_groups g
        ON g.view_id=m.view_id AND g.kind=m.group_kind AND g.group_key=m.group_key
        WHERE m.view_id=$1 AND ($2::uuid IS NULL OR g.id=$2) AND (${this.memberWhere(bound)}) AND (NOT $3 OR ${this.routine&&bound.selection!=='complete'?'a.personal':'m.delivery_id IS NOT NULL'})
        ORDER BY g.ordinal,(m.delivery_id IS NOT NULL) DESC,m.display_at DESC,m.event_id LIMIT $4 OFFSET $5`,
        [bound.id,bound.group,bound.direct,(options.limit??12)+1,bound.after])).rows;
      const selected=rows.slice(0,options.limit??12),events=await this.events(tx,selected);
      const personalParents=(await tx.query<{parent_id:string}>(`SELECT c.parent_id FROM loom.contributions c WHERE c.id=ANY($1::uuid[]) AND c.parent_id IS NOT NULL`,[selected.map(m=>m.resource_id)])).rows;
      await lockReferencePlan(tx,[...events.flatMap(e=>[e.resource_id,...(e.discussion_id?[e.discussion_id]:[])]),...personalParents.map(p=>p.parent_id)]);
      const budget=options.max_response_bytes??131072,page:AnyMembers={contract_version:this.contract,...(this.routine?{attention:this.coverage(bound)}:{}),traversal_id:bound.id,
        group_id:bound.group,direct_only:bound.direct,items:[],page_cursor:this.encode(state,bound),next_cursor:null,complete:false,
        full_contents_fetched:false,limit:options.limit??12,max_response_bytes:budget} as AnyMembers;
      let consumed=0;
      for(const row of selected){
        let item:C.UpdateMemberView|undefined;
        try{item=await this.member(tx,actor,bound,row,events.find(e=>e.id===row.event_id)!);}catch(error){if(!unavailable(error))throw error;}
        if(item){const preview={...page,items:[...page.items,item],next_cursor:this.encode(state,{...bound,after:bound.after+consumed+1})};
          if(Buffer.byteLength(JSON.stringify(preview))+64>budget){if(!page.items.length)throw new RetrievalError('response_budget_too_small',Buffer.byteLength(JSON.stringify(preview))+64);break;}
          page.items.push(item);}
        consumed++;
      }
      page.complete=consumed===rows.length;
      if(!page.complete)page.next_cursor=this.encode(state,{...bound,after:bound.after+consumed});
      return fit(page,budget);
    }) as Promise<Routine extends true?R.RoutineMembersPageView:C.UpdatesMembersPageView>;
  }
  selection(context:ActorContext,options:A.AttentionSelectionOptions){
    if(!this.routine||!Value.Check(A.AttentionSelectionQuery,options))throw new PublicationError('invalid_input');
    return this.run(async tx=>{
      const actor=await lockActor(tx,context);await attentionOwner(tx,actor.participantId);
      const state=await this.state(tx,actor.participantId),bound=this.decode(state,options.cursor,actor.participantId);
      this.continuity(state,bound);
      const policy=await attentionPolicy(tx,actor.participantId);
      if(bound.selection!=='complete'&&bound.policy!==policy.version)throw new UpdatesError('updates_attention_refresh_required');
      const view=await this.view(tx,bound);if(!view.ready||!['groups','members'].includes(bound.kind))throw new UpdatesError('updates_state_unavailable');
      await this.requireReadySelection(tx,bound);
      const group=options.group_id.toLowerCase();
      if(bound.group&&bound.group!==group)throw new UpdatesError('updates_token_invalid');
      const members=await this.selectedMembers(tx,bound,[group]),events=await this.events(tx,members);
      await lockReferencePlan(tx,events.flatMap(e=>[e.resource_id,...(e.discussion_id?[e.discussion_id]:[])]));
      await tx.query('SELECT id FROM loom.revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[events.flatMap(e=>e.revision_id?[e.revision_id]:[])]);
      const inputs:A.AttentionInputView[]=[];
      for(const m of members){
        await this.authorize(tx,events.find(e=>e.id===m.event_id)!);
        if(m.shared&&!bound.direct)inputs.push({kind:'shared_event',id:m.event_id});
        if(m.delivery_id){
          if(!(await tx.query('SELECT id FROM loom.personal_deliveries WHERE id=$1 AND recipient_id=$2',[m.delivery_id,actor.participantId])).rowCount)throw new PublicationError('unavailable');
          inputs.push({kind:'personal_delivery',id:m.delivery_id});
        }
      }
      const selected=options.inputs?normalizeInputs(options.inputs):inputs;
      if(selected.some(v=>!inputs.some(i=>inputKey(i)===inputKey(v))))throw new PublicationError('invalid_input');
      return prepareAttentionSelection(tx,actor.participantId,state.instance,policy.version,{view:bound.id,group,selection:bound.selection},selected);
    });
  }
  reasons(context: ActorContext, options: C.UpdatesReasonsOptions) {
    if(!Value.Check(C.UpdatesReasonsQuery,options))throw new PublicationError('invalid_input');
    return this.run(async tx=>{
      const actor=await lockActor(tx,context);if(this.routine)await attentionOwner(tx,actor.participantId);
      const state=await this.state(tx,actor.participantId),bound=this.decode(state,options.cursor,actor.participantId);
      this.continuity(state,bound);
      if(this.routine&&bound.selection!=='complete'&&bound.policy!==(await attentionPolicy(tx,actor.participantId)).version)throw new UpdatesError('updates_attention_refresh_required');
      if(!['groups','members'].includes(bound.kind))throw new UpdatesError('updates_token_invalid');
      const view=await this.view(tx,bound);if(!view.ready)throw new UpdatesError('updates_state_unavailable');
      await this.requireReadySelection(tx,bound);
      const members=(await tx.query<Member>(`SELECT ${this.memberColumns(bound)} FROM loom.updates_members m ${this.memberJoin(bound)} WHERE m.view_id=$1 AND m.event_id=$2 AND (${this.memberWhere(bound)})`,[bound.id,options.event_id])).rows;
      if(!members.length)throw new PublicationError('unavailable');
      const event=(await this.events(tx,members))[0]!;
      await lockReferencePlan(tx,[event.resource_id,...(event.discussion_id?[event.discussion_id]:[])]);
      return fit({...await this.shared.item(tx,event,members[0]!.shared?sharedMatches(event,bound.definitions).reasons:[],options.reason_offset??0),
        detail_url:this.routine?'/api/v1/me/routine-updates/reasons':'/api/v1/me/updates/reasons'},options.max_response_bytes??131072);
    });
  }
}
