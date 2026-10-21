import { randomUUID } from 'node:crypto';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { hasChangeSchema } from '../../db/schema-capabilities.js';

export const workerLimits = Object.freeze({
  batch: 25,
  discovery: 50,
  jobs: 50000,
  sources: 5000,
  leaseSeconds: 30,
  attempts: 3,
});
export interface Claim {
  id: string;
  generation: number;
  claim_generation: number;
  owner: string;
  resource_id: string | null;
  revision_id: string | null;
  kind: string;
}
type Prepared =
  | { kind: 'text'; title: string; body: string; revision_number: string; note?: string }
  | { kind: 'organization' }
  | { kind: 'failure'; failure: 'unsupported_event' | 'unsupported_source' | 'source_limit' };
export async function discoveryGuard(tx: SqlTransaction) {
  await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 4]);
}
// Both backfill and retrieval use this typed population; arbitrary resource
// envelopes, historical text/plain fixtures and private collections cannot enter it.
const previousTypedSources = `SELECT r.id,r.current_revision_id FROM loom.resources r
  WHERE r.current_revision_id IS NOT NULL AND
  ((r.kind='artifact' AND EXISTS(SELECT 1 FROM loom.artifacts a WHERE a.id=r.id)) OR
   (r.kind='contribution' AND EXISTS(SELECT 1 FROM loom.contributions c WHERE c.id=r.id)))`;
export const typedSources =
  previousTypedSources.slice(0, -1) +
  ` OR
   (r.kind='summary' AND EXISTS(SELECT 1 FROM loom.summaries s WHERE s.id=r.id)))`;
// An additive migration may follow a populated older synthetic installation.
// Continue its typed text work until the new companion table exists; never infer
// summary eligibility from an untyped resource envelope.
async function population(tx: SqlTransaction) {
  return (
    await tx.query<{ ready: boolean }>(
      "SELECT to_regclass('loom.summaries') IS NOT NULL AS ready",
      [],
    )
  ).rows[0]!.ready
    ? typedSources
    : previousTypedSources;
}

export class SearchWorker {
  readonly owner = randomUUID();
  constructor(private readonly database: Transactions) {}

  /** Bounded resumable discovery; progress means enqueued, never completed. */
  discover() {
    return this.database.transaction(async (tx) => {
      await discoveryGuard(tx);
      const sources = await population(tx);
      const state = (
        await tx.query<{
          generation: number;
          source_after: string | null;
          scan_complete: boolean;
          event_after: string;
          event_after_intent: string | null;
        }>(
          'SELECT generation,source_after,scan_complete,event_after::text,event_after_intent FROM loom.search_state WHERE id=1',
          [],
        )
      ).rows[0]!;
      const size = (
        await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM (SELECT id FROM loom.search_jobs LIMIT $1) j',
          [workerLimits.jobs],
        )
      ).rows[0]!.n;
      const populationSize = (
        await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sources} LIMIT $1) s`, [
          workerLimits.sources + 1,
        ])
      ).rows[0]!.n;
      if (
        size + 2 * workerLimits.discovery > workerLimits.jobs ||
        populationSize > workerLimits.sources
      ) {
        await tx.query(
          'UPDATE loom.search_state SET capacity_limited=true,heartbeat_at=clock_timestamp() WHERE id=1',
          [],
        );
        return { enqueued: 0, limited: true };
      }
      let enqueued = 0;
      if (!state.scan_complete) {
        const rows = (
          await tx.query<{ id: string; current_revision_id: string }>(
            `${sources}
          AND ($1::uuid IS NULL OR r.id>$1) ORDER BY r.id LIMIT $2`,
            [state.source_after, workerLimits.discovery],
          )
        ).rows;
        for (const row of rows)
          enqueued +=
            (
              await tx.query(
                `INSERT INTO loom.search_jobs(generation,resource_id,revision_id,kind)
          VALUES ($1,$2,$3,'revision') ON CONFLICT DO NOTHING`,
                [state.generation, row.id, row.current_revision_id],
              )
            ).rowCount ?? 0;
        state.source_after = rows.at(-1)?.id ?? state.source_after;
        state.scan_complete = rows.length < workerLimits.discovery;
      }
      const events = (
        await tx.query<{
          id: string;
          position: string;
          kind: string;
          intent: string;
          intent_id: string;
          resource_id: string;
          revision_id: string | null;
        }>(
          `
        SELECT e.id,e.position::text,e.kind,i.id AS intent_id,i.kind AS intent,e.resource_id,e.revision_id
        FROM loom.shared_activity e JOIN loom.outbox_intents i ON i.source_event_id=e.id
        WHERE e.position>$1 OR (e.position=$1 AND ($2::uuid IS NULL OR i.id>$2))
        ORDER BY e.position,i.id LIMIT $3`,
          [state.event_after, state.event_after_intent, workerLimits.discovery],
        )
      ).rows;
      for (const event of events) {
        const kind =
          event.kind === 'revision.published' &&
          event.intent === 'publication.project' &&
          event.revision_id
            ? 'revision'
            : event.kind === 'organization.changed' &&
                event.intent === 'organization.project' &&
                !event.revision_id
              ? 'organization'
              : 'unsupported';
        enqueued +=
          (
            await tx.query(
              `INSERT INTO loom.search_jobs(generation,resource_id,revision_id,source_event_id,source_intent_id,kind)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
              [
                state.generation,
                event.resource_id,
                event.revision_id,
                event.id,
                event.intent_id,
                kind,
              ],
            )
          ).rowCount ?? 0;
      }
      await tx.query(
        `UPDATE loom.search_state SET source_after=$1,scan_complete=$2,event_after=$3,event_after_intent=$4,
        heartbeat_at=clock_timestamp(),capacity_limited=false WHERE id=1`,
        [
          state.source_after,
          state.scan_complete,
          events.at(-1)?.position ?? state.event_after,
          events.at(-1)?.intent_id ?? state.event_after_intent,
        ],
      );
      return { enqueued, limited: false };
    });
  }

  claim(limit: number = workerLimits.batch): Promise<Claim[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > workerLimits.batch)
      throw new Error('Invalid worker batch.');
    return this.database.transaction(async (tx) => {
      // Exhausted abandoned claims remain inspectable; never silently disappear.
      await tx.query(
        `WITH exhausted AS (SELECT j.id FROM loom.search_jobs j
        WHERE generation=(SELECT generation FROM loom.search_state WHERE id=1)
        AND state='running' AND lease_until<=clock_timestamp() AND attempts>=$1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
        UPDATE loom.search_jobs j SET state='failed',owner=NULL,lease_until=NULL,failure='lease_expired'
        FROM exhausted x WHERE j.id=x.id`,
        [workerLimits.attempts, limit],
      );
      return (
        await tx.query<Claim>(
          `WITH due AS (SELECT j.id FROM loom.search_jobs j
        WHERE generation=(SELECT generation FROM loom.search_state WHERE id=1) AND attempts<$1
        AND ((state='pending' AND due_at<=clock_timestamp()) OR (state='running' AND lease_until<=clock_timestamp()))
        ORDER BY due_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
        UPDATE loom.search_jobs j SET state='running',claim_generation=claim_generation+1,owner=$3,
        lease_until=clock_timestamp()+make_interval(secs=>$4),attempts=attempts+1,failure=NULL
        FROM due WHERE j.id=due.id RETURNING j.id,j.generation,j.claim_generation,j.owner,j.resource_id,j.revision_id,j.kind`,
          [workerLimits.attempts, limit, this.owner, workerLimits.leaseSeconds],
        )
      ).rows;
    });
  }

  renew(claim: Claim) {
    return this.database.transaction(async (tx) => {
      // UPDATE can evaluate its predicate before a lock wait that changes no row.
      // Acquire the guard first, then observe ownership and PostgreSQL time afresh.
      await tx.query('SELECT id FROM loom.search_jobs WHERE id=$1 FOR UPDATE', [claim.id]);
      return (
        (
          await tx.query(
            `UPDATE loom.search_jobs SET lease_until=clock_timestamp()+make_interval(secs=>$4)
        WHERE id=$1 AND owner=$2 AND claim_generation=$3 AND state='running' AND lease_until>clock_timestamp()
        AND generation=(SELECT generation FROM loom.search_state WHERE id=1)`,
            [claim.id, claim.owner, claim.claim_generation, workerLimits.leaseSeconds],
          )
        ).rowCount === 1
      );
    });
  }

  async prepare(claim: Claim): Promise<Prepared> {
    if (claim.kind === 'organization') return { kind: 'organization' };
    if (claim.kind !== 'revision' || !claim.revision_id || !claim.resource_id)
      return { kind: 'failure', failure: 'unsupported_event' };
    return this.database.transaction(async (tx) => {
      const sources = await population(tx);
      const row = (
        await tx.query<{
          title: string | null;
          body: string;
          revision_number: string;
          format: string;
          bytes: number;
          typed: boolean;
        }>(
          `
        SELECT v.title,v.content_text AS body,v.revision_number::text,v.content_format AS format,octet_length(v.content_text) AS bytes,
        EXISTS(SELECT 1 FROM (${sources}) s WHERE s.id=v.resource_id) AS typed
        FROM loom.revisions v WHERE v.id=$1 AND v.resource_id=$2`,
          [claim.revision_id, claim.resource_id],
        )
      ).rows[0];
      if (
        !row ||
        !row.typed ||
        !['loom-markdown-v1', 'loom-markdown-v2', 'loom-markdown-v3'].includes(row.format)
      )
        return { kind: 'failure', failure: 'unsupported_source' };
      if (row.bytes > 16384) return { kind: 'failure', failure: 'source_limit' };
      const fields = await hasChangeSchema(tx);
      const note = fields
        ? ((
            await tx.query<{ content_text: string }>(
              'SELECT content_text FROM loom.revision_change_notes WHERE revision_id=$1',
              [claim.revision_id],
            )
          ).rows[0]?.content_text ?? '')
        : undefined;
      if (
        note !== undefined &&
        (Buffer.byteLength(note) > 4096 || row.bytes + Buffer.byteLength(note) > 16384)
      )
        return { kind: 'failure', failure: 'source_limit' };
      return {
        kind: 'text',
        title: row.title ?? '',
        body: row.body,
        revision_number: row.revision_number,
        ...(note !== undefined ? { note } : {}),
      };
    });
  }

  /** Source -> revision -> job -> index state. All output and completion share COMMIT. */
  finalize(claim: Claim, prepared: Prepared) {
    if (prepared.kind === 'failure') return this.fail(claim, prepared.failure);
    return this.database.transaction(async (tx) => {
      let current: string | null = null;
      if (prepared.kind === 'text') {
        current =
          (
            await tx.query<{ current_revision_id: string | null }>(
              'SELECT current_revision_id FROM loom.resources WHERE id=$1 FOR SHARE',
              [claim.resource_id],
            )
          ).rows[0]?.current_revision_id ?? null;
        await tx.query('SELECT id FROM loom.revisions WHERE id=$1 FOR SHARE', [claim.revision_id]);
      }
      const job = (
        await tx.query<{ owner: string | null; claim_generation: number; state: string }>(
          'SELECT owner,claim_generation,state FROM loom.search_jobs WHERE id=$1 FOR UPDATE',
          [claim.id],
        )
      ).rows[0];
      if (
        job?.owner !== claim.owner ||
        job.claim_generation !== claim.claim_generation ||
        job.state !== 'running'
      )
        return false;
      const state = (
        await tx.query<{ generation: number }>(
          'SELECT generation FROM loom.search_state WHERE id=1 FOR UPDATE',
          [],
        )
      ).rows[0]!;
      // Check time after every potentially blocking guard, before the first effect.
      const valid = await tx.query(
        'SELECT id FROM loom.search_jobs WHERE id=$1 AND lease_until>clock_timestamp()',
        [claim.id],
      );
      if (!valid.rowCount || state.generation !== claim.generation) return false;
      let outcome = 'not_applicable';
      if (prepared.kind === 'text') {
        outcome = 'superseded';
        if (current === claim.revision_id) {
          const written = await tx.query(
            `INSERT INTO loom.search_documents(resource_id,revision_id,revision_number,generation,job_id,title,body,document${prepared.note !== undefined ? ',note_text,note_document' : ''})
            VALUES ($1,$2,$3,$4,$5,$6,$7,
              setweight(to_tsvector('pg_catalog.simple',normalize($6,NFC)),'A') || setweight(to_tsvector('pg_catalog.simple',normalize($7,NFC)),'D')${prepared.note !== undefined ? " || setweight(to_tsvector('pg_catalog.simple',normalize($8,NFC)),'D'),$8,to_tsvector('pg_catalog.simple',normalize($8,NFC))" : ''})
            ON CONFLICT (resource_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,revision_number=EXCLUDED.revision_number,
              generation=EXCLUDED.generation,job_id=EXCLUDED.job_id,title=EXCLUDED.title,body=EXCLUDED.body,document=EXCLUDED.document${prepared.note !== undefined ? ',note_text=EXCLUDED.note_text,note_document=EXCLUDED.note_document' : ''},indexed_at=clock_timestamp()
            WHERE loom.search_documents.generation<EXCLUDED.generation OR
              (loom.search_documents.generation=EXCLUDED.generation AND loom.search_documents.revision_number<=EXCLUDED.revision_number)
            RETURNING resource_id`,
            [
              claim.resource_id,
              claim.revision_id,
              prepared.revision_number,
              claim.generation,
              claim.id,
              prepared.title,
              prepared.body,
              ...(prepared.note !== undefined ? [prepared.note] : []),
            ],
          );
          if (written.rowCount) {
            outcome = 'indexed';
            await tx.query(
              'UPDATE loom.search_state SET index_version=index_version+1 WHERE id=1',
              [],
            );
          }
        }
      }
      await tx.query(
        `UPDATE loom.search_jobs SET state='succeeded',outcome=$2,owner=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1`,
        [claim.id, outcome],
      );
      return true;
    });
  }

  fail(
    claim: Claim,
    failure:
      | 'unsupported_event'
      | 'unsupported_source'
      | 'source_limit'
      | 'processing_failed' = 'processing_failed',
  ) {
    return this.database.transaction(async (tx) => {
      await tx.query('SELECT id FROM loom.search_jobs WHERE id=$1 FOR UPDATE', [claim.id]);
      return (
        (
          await tx.query(
            `UPDATE loom.search_jobs SET
        state=CASE WHEN attempts>=$4 THEN 'failed' ELSE 'pending' END,owner=NULL,lease_until=NULL,failure=$5,
        due_at=clock_timestamp()+make_interval(secs=>power(2,attempts-1)::int)
        WHERE id=$1 AND owner=$2 AND claim_generation=$3 AND state='running' AND lease_until>clock_timestamp()
        AND generation=(SELECT generation FROM loom.search_state WHERE id=1)`,
            [claim.id, claim.owner, claim.claim_generation, workerLimits.attempts, failure],
          )
        ).rowCount === 1
      );
    });
  }

  async process(claim: Claim) {
    const renewal = setInterval(() => {
      void this.renew(claim).catch(() => {});
    }, 10000);
    try {
      return await this.finalize(claim, await this.prepare(claim));
    } catch {
      await this.fail(claim);
      return false;
    } finally {
      clearInterval(renewal);
    }
  }
  async tick() {
    await this.discover();
    const claims = await this.claim();
    await Promise.all(claims.map((claim) => this.process(claim)));
    return claims.length;
  }
}
