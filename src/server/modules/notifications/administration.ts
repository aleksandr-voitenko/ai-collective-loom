import type { ActorContext } from '../publication/actor.js';
import { lockActor } from '../publication/guards.js';
import { safeError, PublicationError } from '../publication/errors.js';
import type { Transactions, SqlTransaction } from '../../db/postgres.js';
import { notificationDiscoveryGuard } from './worker.js';

/** Operational references only; administrator authority never selects an inbox. */
export class NotificationAdministration {
  constructor(private readonly database:Transactions){}
  private async run<T>(actor:ActorContext,work:(tx:SqlTransaction)=>Promise<T>){
    try{return await this.database.transaction(async tx=>{
      await tx.query("SET LOCAL statement_timeout='2500ms'",[]);
      if(!(await lockActor(tx,actor)).administrator)throw new PublicationError('forbidden');
      return work(tx);
    });}catch(error){return safeError(error);}
  }
  health(actor:ActorContext){return this.run(actor,async tx=>{
    const state=(await tx.query<{worker_available:boolean;scan_complete:boolean;event_discovery_caught_up:boolean;capacity_limited:boolean;discovery_generation:number}>(`
      SELECT COALESCE(heartbeat_at>clock_timestamp()-interval '60 seconds',false) AS worker_available,scan_complete,capacity_limited,discovery_generation,
        NOT EXISTS(SELECT 1 FROM loom.shared_activity e JOIN loom.outbox_intents i ON i.source_event_id=e.id
          WHERE e.position>n.event_after OR (e.position=n.event_after AND (n.event_after_intent IS NULL OR i.id>n.event_after_intent))) AS event_discovery_caught_up
      FROM loom.notification_state n WHERE id=1`,[])).rows[0]!;
    const jobs={pending:0,running:0,succeeded:0,failed:0};
    for(const row of (await tx.query<{state:keyof typeof jobs;n:number}>(`SELECT state,count(*)::int AS n FROM
      (SELECT state FROM loom.notification_jobs LIMIT 50000) j GROUP BY state`,[])).rows)jobs[row.state]=row.n;
    const gaps=(await tx.query<{n:number}>('SELECT count(*)::int AS n FROM (SELECT revision_id FROM loom.notification_gaps LIMIT 50000) g',[])).rows[0]!.n;
    return {...state,jobs,historical_eligibility_gaps:gaps};
  });}
  failures(actor:ActorContext,after?:string){return this.run(actor,async tx=>{
    const rows=(await tx.query<{id:string;claim_generation:number;attempts:number;failure:string;resource_id:string|null;revision_id:string|null}>(`
      SELECT j.id,j.claim_generation,j.attempts,COALESCE(j.failure,g.reason) AS failure,j.resource_id,j.revision_id
      FROM loom.notification_jobs j LEFT JOIN loom.notification_gaps g ON g.job_id=j.id
      WHERE (j.state='failed' OR g.revision_id IS NOT NULL) AND ($1::uuid IS NULL OR j.id>$1) ORDER BY j.id LIMIT 26`,[after??null])).rows;
    return {items:rows.slice(0,25),next_after:rows.length>25?rows[24]!.id:null};
  });}
  retry(actor:ActorContext,id:string,generation:number){return this.run(actor,async tx=>{
    await tx.query('SELECT id FROM loom.notification_jobs WHERE id=$1 FOR UPDATE',[id]);
    await tx.query(`UPDATE loom.notification_jobs SET state='pending',claim_generation=claim_generation+1,attempts=0,
      failure=NULL,owner=NULL,lease_until=NULL,due_at=clock_timestamp() WHERE id=$1 AND claim_generation=$2 AND state='failed'`,[id,generation]);
    return {accepted:true as const};
  });}
  reconcile(actor:ActorContext,expected:number){return this.run(actor,async tx=>{
    await notificationDiscoveryGuard(tx);
    const state=(await tx.query<{discovery_generation:number}>('SELECT discovery_generation FROM loom.notification_state WHERE id=1 FOR UPDATE',[])).rows[0]!;
    if(state.discovery_generation<expected)throw new PublicationError('invalid_input');
    if(state.discovery_generation===expected)await tx.query(`UPDATE loom.notification_state SET discovery_generation=discovery_generation+1,
      source_after=NULL,revision_after=0,scan_complete=false,event_after=0,event_after_intent=NULL WHERE id=1`,[]);
    return {discovery_generation:state.discovery_generation===expected?expected+1:state.discovery_generation};
  });}
}
