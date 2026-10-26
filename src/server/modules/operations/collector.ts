import type { Transactions } from '../../db/postgres.js';
import {
  outcomeCodes,
  operationalLimits,
  type OperationFamily,
  type OutcomeCode,
} from '../../../contracts/operations.js';

/** The caller supplies a registered route template, never a URL or request body. */
export function operationFamily(template: string | undefined): OperationFamily | undefined {
  if (!template?.startsWith('/api/v1/') || template.startsWith('/api/v1/admin/operational-health'))
    return undefined;
  if (
    [
      '/api/v1/discussions',
      '/api/v1/replies',
      '/api/v1/artifacts',
      '/api/v1/revisions',
      '/api/v1/summaries',
      '/api/v1/summary-revisions',
      '/api/v1/attachment-promotions',
      '/api/v1/operations/status',
    ].includes(template)
  )
    return 'publication';
  if (template.startsWith('/api/v1/file-uploads')) return 'uploads';
  if (template.startsWith('/api/v1/shared-changes/')) return 'shared_recovery';
  if (template.startsWith('/api/v1/me/notifications')) return 'personal_recovery';
  if (
    template.startsWith('/api/v1/me/updates/') ||
    template.startsWith('/api/v1/me/routine-updates/')
  )
    return 'combined_recovery';
  if (template.startsWith('/api/v1/admin/')) return 'administration';
  if (template.startsWith('/api/v1/identity/')) return 'identity';
  return 'participation';
}

/** Best-effort bounded samples. Never awaited by a domain operation or response. */
export class OperationalCollector {
  private active: Promise<void> | undefined;
  private nextAttempt = 0;
  private stopped = false;
  private dropped = 0;
  private failed = false;
  constructor(
    private readonly database: Transactions,
    private readonly reportGap: () => void,
  ) {}
  get loss() {
    return { process_dropped: this.dropped, process_collection_failed: this.failed };
  }
  observe(requestId: string, family: OperationFamily | undefined, code: unknown, status: number) {
    if (!family || !outcomeCodes.includes(code as OutcomeCode) || status < 400 || status > 599)
      return;
    // No request objects or arbitrary strings enter the asynchronous closure.
    if (this.stopped || this.active || Date.now() < this.nextAttempt) {
      this.drop();
      return;
    }
    this.nextAttempt = Date.now() + operationalLimits.captureIntervalMs;
    this.active = this.capture(requestId, family, code as OutcomeCode, status)
      .catch(() => {
        this.drop();
        if (!this.failed) {
          this.failed = true;
          try {
            this.reportGap();
          } catch {
            /* The fixed fallback cannot affect a response. */
          }
        }
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  private drop() {
    this.dropped = Math.min(2147483647, this.dropped + 1);
  }
  private async capture(
    requestId: string,
    family: OperationFamily,
    code: OutcomeCode,
    status: number,
  ) {
    await this.database.transaction(async (tx) => {
      await tx.query("SET LOCAL statement_timeout='100ms'", []);
      await tx.query("SET LOCAL lock_timeout='25ms'", []);
      await tx.query("SET LOCAL transaction_timeout='250ms'", []);
      const locked = (
        await tx.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(1280266061,18) AS locked',
          [],
        )
      ).rows[0]?.locked;
      if (!locked) {
        this.drop();
        return;
      }
      const row = (
        await tx.query<{ position: string; observed_at: Date }>(
          `UPDATE loom.operational_capture
        SET position=position+1,admitted_at=clock_timestamp() WHERE id=1
        AND position<999999999999999 AND (admitted_at IS NULL OR admitted_at<=clock_timestamp()-interval '100 milliseconds')
        RETURNING position::text,admitted_at AS observed_at`,
          [],
        )
      ).rows[0];
      if (!row) {
        this.drop();
        return;
      }
      // Only this new observational table expires. At most 1024 rows can be touched;
      // idle installations retain bounded old slots, excluded from the 24h window.
      await tx.query(
        "DELETE FROM loom.operational_observations WHERE observed_at<clock_timestamp()-interval '24 hours'",
        [],
      );
      await tx.query(
        `INSERT INTO loom.operational_observations(slot,position,request_id,observed_at,family,code,status)
        VALUES (($1::bigint % 1024)::int,$1,$2,$3,$4,$5,$6)
        ON CONFLICT(slot) DO UPDATE SET position=excluded.position,request_id=excluded.request_id,
        observed_at=excluded.observed_at,family=excluded.family,code=excluded.code,status=excluded.status`,
        [row.position, requestId, row.observed_at, family, code, status],
      );
    });
  }
  async close() {
    this.stopped = true;
    await this.active;
  }
}
