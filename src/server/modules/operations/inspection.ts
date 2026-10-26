import { failureCodes, type OperationalFailuresView } from '../../../contracts/operations.js';
import type { Transactions, SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from '../publication/actor.js';
import { lockActor } from '../publication/guards.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { TextSearch } from '../search/search.js';
import { FileText } from '../search/file-text.js';
import { NotificationAdministration } from '../notifications/administration.js';
import { fileGuard } from '../participation/file-context.js';
import { fileUsage } from '../participation/file-accounting.js';
import { fit, RetrievalError } from '../participation/retrieval.js';
import type { OperationalCollector } from './collector.js';
import {
  OperationalHealth,
  OutcomeRecord,
  operationalLimits,
  type OperationalHealthView,
  type OutcomeOptions,
  type OutcomePageView,
  type OutcomeRecordView,
} from '../../../contracts/operations.js';
import { Value } from '@sinclair/typebox/value';

export class OperationalInspection {
  private readonly started = new Date();
  private readonly search: TextSearch;
  private readonly files: FileText;
  private readonly notifications: NotificationAdministration;
  constructor(
    private readonly database: Transactions,
    private readonly collector: OperationalCollector,
    private readonly storageConfigured: boolean,
  ) {
    this.search = new TextSearch(database);
    this.files = new FileText(database);
    this.notifications = new NotificationAdministration(database);
  }
  private async run<T>(
    actor: ActorContext,
    work: (tx: SqlTransaction, owner: string) => Promise<T>,
  ) {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('statement_timeout','1000ms',true),set_config('lock_timeout','1000ms',true),set_config('transaction_timeout','5000ms',true)",
          [],
        );
        const authority = await lockActor(tx, actor);
        if (!authority.administrator) throw new PublicationError('forbidden');
        return work(tx, authority.participantId);
      });
    } catch (error) {
      if (error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
  private async sample<T>(work: () => Promise<T>) {
    const observed_at = new Date().toISOString();
    try {
      return { state: 'observed' as const, observed_at, value: await work() };
    } catch (error) {
      if (error instanceof PublicationError && ['forbidden', 'invalid_actor'].includes(error.code))
        throw error;
      return { state: 'unavailable' as const, observed_at, value: null };
    }
  }
  private worker(
    actor: ActorContext,
    table: 'search_state' | 'file_text_state' | 'notification_state',
    threshold: number,
  ) {
    return this.run(actor, async (tx) => {
      const row = (
        await tx.query<{ heartbeat_at: Date | null; recent: boolean }>(
          `SELECT heartbeat_at,heartbeat_at>clock_timestamp()-($1*interval '1 second') AS recent FROM loom.${table} WHERE id=1`,
          [threshold],
        )
      ).rows[0];
      if (!row) throw new PublicationError('service_unavailable');
      return {
        heartbeat_at: row.heartbeat_at?.toISOString() ?? null,
        state:
          row.heartbeat_at === null
            ? ('unknown' as const)
            : row.heartbeat_at < this.started
              ? ('prior_runtime' as const)
              : row.recent
                ? ('recent' as const)
                : ('stale' as const),
        threshold_seconds: threshold,
      };
    });
  }
  async health(actor: ActorContext): Promise<OperationalHealthView> {
    await this.run(actor, async () => undefined);
    // Independent bounded observations, not a snapshot spanning worker commits.
    const [authored, files, activity, uploads] = await Promise.all([
      this.sample(async () => ({
        health: await this.search.health(actor),
        coverage: await this.search.status(actor),
        worker: await this.worker(actor, 'search_state', 45),
      })),
      this.sample(async () => {
        const health = await this.files.health(actor);
        const coverage = await this.files.status(actor);
        const worker = await this.worker(actor, 'file_text_state', 45);
        const state = await this.run(actor, async (tx) => {
          const row = (
            await tx.query<{ capacity_limited: boolean; discovery_missing: boolean }>(
              `SELECT capacity_limited,
            EXISTS(SELECT 1 FROM loom.file_contexts c LEFT JOIN loom.file_text_jobs j ON j.file_id=c.id AND j.generation=f.generation WHERE j.file_id IS NULL) AS discovery_missing
            FROM loom.file_text_state f WHERE id=1`,
              [],
            )
          ).rows[0];
          if (!row) throw new PublicationError('service_unavailable');
          const jobs: Record<string, number> = {
            pending: 0,
            running: 0,
            complete: 0,
            partial: 0,
            unsupported: 0,
            failed: 0,
          };
          for (const count of (
            await tx.query<{ state: string; n: number }>(
              `SELECT state,count(*)::int AS n FROM loom.file_text_jobs WHERE generation=$1 GROUP BY state`,
              [health.generation],
            )
          ).rows)
            jobs[count.state === 'queued' ? 'pending' : count.state] = count.n;
          return { ...row, jobs };
        });
        return {
          generation: health.generation,
          retained_bytes: health.retained_bytes,
          reserved_bytes: health.reserved_bytes,
          coverage,
          worker,
          ...state,
        };
      }),
      this.sample(async () => ({
        health: await this.notifications.health(actor),
        worker: await this.worker(actor, 'notification_state', 60),
      })),
      this.sample(() =>
        this.run(actor, async (tx, owner) => {
          await fileGuard(tx);
          const usage = await fileUsage(tx, owner);
          // Preparation expiry concerns unassociated uploads; published originals have no TTL.
          const row = (
            await tx.query<{
              unfinished_uploads: number;
              quarantined_uploads: number;
              expired_reserved_uploads: number;
            }>(
              `SELECT
          count(*) FILTER(WHERE reserved AND state IN ('waiting','uploading','staged','finalizing','quarantined'))::int AS unfinished_uploads,
          count(*) FILTER(WHERE reserved AND state='quarantined')::int AS quarantined_uploads,
          count(*) FILTER(WHERE reserved AND prepared_expires_at<=clock_timestamp()
            AND NOT EXISTS(SELECT 1 FROM loom.file_contexts c WHERE c.upload_id=u.id))::int AS expired_reserved_uploads FROM loom.file_uploads u`,
              [],
            )
          ).rows[0]!;
          return { retained_uploads: usage.total, reserved_bytes: usage.bytes, ...row };
        }),
      ),
    ]);
    const result = {
      observed_at: new Date().toISOString(),
      readiness: 'independent_public_readiness' as const,
      storage_reachability: 'unverified' as const,
      authored,
      files,
      activity,
      uploads: !this.storageConfigured
        ? {
            state: 'not_configured' as const,
            observed_at: uploads.observed_at,
            value: uploads.value,
          }
        : uploads,
    };
    // Recheck after composing sources; a racing demotion cannot turn a partial
    // backend failure into authority to return earlier protected observations.
    return this.run(actor, async () => {
      if (!Value.Check(OperationalHealth, result))
        throw new PublicationError('service_unavailable');
      return fit(result, operationalLimits.bytes);
    });
  }
  async failures(
    actor: ActorContext,
    subject: 'authored' | 'files' | 'activity',
    after?: string,
    limit = 25,
  ): Promise<OperationalFailuresView> {
    await this.run(actor, async () => undefined);
    const result =
      subject === 'authored'
        ? await this.search.failures(actor, after)
        : subject === 'files'
          ? await this.files.health(actor, after)
          : await this.notifications.failures(actor, after);
    const items = result.items.map((item) => {
      const row = item as unknown as {
        id?: string;
        file_id?: string;
        failure?: string;
        reason?: string;
      };
      const code = row.failure ?? row.reason;
      return {
        id: (row.id ?? row.file_id)!,
        code: failureCodes.includes(code as (typeof failureCodes)[number])
          ? (code as (typeof failureCodes)[number])
          : ('unknown' as const),
      };
    });
    const more = items.length > limit || result.next_after !== null;
    const page = items.slice(0, limit);
    return this.run(actor, async () =>
      fit(
        {
          items: page,
          next_cursor: more ? page.at(-1)!.id : null,
          complete: !more,
          observed_at: new Date().toISOString(),
          consistency: 'live_jobs_refresh_after_changes' as const,
        },
        operationalLimits.bytes,
      ),
    );
  }
  outcomes(actor: ActorContext, options: OutcomeOptions): Promise<OutcomePageView> {
    return this.run(actor, async (tx) => {
      const limit = options.limit ?? 12,
        budget = options.max_bytes ?? operationalLimits.bytes;
      const window = (
        await tx.query<{ now: Date; start: Date; oldest: Date | null }>(
          `SELECT clock_timestamp() AS now,clock_timestamp()-interval '24 hours' AS start,
        (SELECT min(observed_at) FROM loom.operational_observations WHERE observed_at>=clock_timestamp()-interval '24 hours') AS oldest`,
          [],
        )
      ).rows[0]!;
      const rows = (
        await tx.query<OutcomeRecordView & { observed_at: Date }>(
          `SELECT position::text,request_id,observed_at,family,code,status FROM loom.operational_observations
        WHERE observed_at >= $1 AND ($2::bigint IS NULL OR position<$2) ORDER BY operational_observations.position DESC LIMIT $3`,
          [window.start, options.cursor ?? null, limit + 1],
        )
      ).rows.map((row) => ({ ...row, observed_at: row.observed_at.toISOString() }));
      if (rows.some((row) => !Value.Check(OutcomeRecord, row)))
        throw new PublicationError('service_unavailable');
      const page: OutcomePageView = {
        items: [],
        next_cursor: null,
        complete: rows.length === 0,
        observed_at: window.now.toISOString(),
        window_start: window.start.toISOString(),
        oldest_retained_at: window.oldest?.toISOString() ?? null,
        coverage: 'incomplete_sample',
        consistency: 'live_retained_window',
        ...this.collector.loss,
        max_records: 1024,
        max_response_bytes: budget,
      };
      for (const row of rows.slice(0, limit)) {
        const candidate = {
          ...page,
          items: [...page.items, row],
          next_cursor: row.position,
          complete: false,
        };
        if (Buffer.byteLength(JSON.stringify(candidate)) > budget) {
          if (!page.items.length)
            throw new RetrievalError(
              'response_budget_too_small',
              Buffer.byteLength(JSON.stringify(candidate)),
            );
          break;
        }
        page.items.push(row);
      }
      page.complete = page.items.length === rows.length;
      page.next_cursor = page.complete ? null : page.items.at(-1)!.position;
      return fit(page, budget);
    });
  }
}
