import { createHash, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  ReadingLookup,
  ReadingUpdate,
  ReadingStatusInput,
  readingLimits,
  type ReadingTargetView,
  type ReadingUpdateInput,
  type ReadingItemView,
  type ReadingResultView,
} from '../../../contracts/reading.js';
import { lockAttempt } from '../../application/attempt.js';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { lockReferencePlan } from './reference-context.js';

export class ReadingLimitError extends Error {
  readonly code = 'reading_limit_reached';
  constructor() {
    super(
      'The synthetic reading retention limit has been reached. Lookup and exact recovery remain available.',
    );
  }
}
interface State {
  resource_id: string;
  revision_id: string;
  is_read: boolean;
  version: number;
  deliberate_version: number;
}
interface Outcome {
  id: string;
  request_digest: string;
  decision: ReadingResultView['operation_state'];
  outcome: ReadingResultView['outcome'];
}
const pair = (v: ReadingTargetView) => ({
  resource_id: v.resource_id.toLowerCase(),
  revision_id: v.revision_id.toLowerCase(),
});
function targets<T extends ReadingTargetView>(values: T[]): T[] {
  const result = values
    .map((v) => ({ ...v, ...pair(v) }))
    .sort((a, b) => a.revision_id.localeCompare(b.revision_id));
  if (new Set(result.map((v) => v.revision_id)).size !== result.length)
    throw new PublicationError('invalid_input');
  return result;
}
function fit<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > readingLimits.responseBytes)
    throw new PublicationError('service_unavailable');
  return value;
}

/** Independent private state: never call the publication/event tail or a worker. */
export class ReadingProgress {
  constructor(private readonly database: Transactions) {}
  private async run<T>(
    actor: ActorContext,
    write: boolean,
    key: string | undefined,
    work: (tx: SqlTransaction, owner: string) => Promise<T>,
  ) {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('statement_timeout','2500ms',true), set_config('lock_timeout','1500ms',true), set_config('transaction_timeout','15000ms',true)",
          [],
        );
        if (key) await lockAttempt(tx, identityOf(actor).participantId, 'reading.set', key);
        const current = await lockActor(tx, actor);
        await tx.query(
          `SELECT ${write ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,
          [JSON.stringify(['loom.reading.owner', current.participantId])],
        );
        return fit(await work(tx, current.participantId));
      });
    } catch (error) {
      if (error instanceof ReadingLimitError) throw error;
      return safeError(error);
    }
  }
  private async states(tx: SqlTransaction, owner: string, list: ReadingTargetView[]) {
    const rows = (
      await tx.query<State>(
        'SELECT resource_id,revision_id,is_read,version,deliberate_version FROM loom.reading_states WHERE participant_id=$1 AND revision_id=ANY($2::uuid[])',
        [owner, list.map((v) => v.revision_id)],
      )
    ).rows;
    // A caller cannot turn knowledge of a revision into a different resource pair.
    if (
      rows.some(
        (row) =>
          !list.some((v) => v.resource_id === row.resource_id && v.revision_id === row.revision_id),
      )
    )
      throw new PublicationError('unavailable');
    return new Map(rows.map((row) => [row.revision_id, row]));
  }
  private async available(tx: SqlTransaction, list: ReadingTargetView[]) {
    await lockReferencePlan(
      tx,
      list.map((v) => v.resource_id),
    );
    // Acquire exact guards in one deterministic order before validating members.
    await tx.query('SELECT id FROM loom.revisions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [
      list.map((v) => v.revision_id),
    ]);
    const availability = new Map<string, boolean>();
    for (const target of list) {
      try {
        const chain = await lockContext(tx, target.resource_id, 'resolution', [
          'contribution',
          'artifact',
          'summary',
        ]);
        const kind = chain[0]!.kind,
          table =
            kind === 'contribution'
              ? 'contributions'
              : kind === 'artifact'
                ? 'artifacts'
                : 'summaries';
        if (
          !(await tx.query(`SELECT id FROM loom.${table} WHERE id=$1`, [target.resource_id]))
            .rowCount
        )
          throw new PublicationError('unavailable');
        await requireRevision(tx, target.resource_id, target.revision_id);
        const row = (
          await tx.query<{ content_format: string }>(
            'SELECT content_format FROM loom.revisions WHERE id=$1',
            [target.revision_id],
          )
        ).rows[0];
        if (
          !row ||
          !['loom-markdown-v1', 'loom-markdown-v2', 'loom-markdown-v3'].includes(row.content_format)
        )
          throw new PublicationError('unavailable');
        availability.set(target.revision_id, true);
      } catch (error) {
        if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        availability.set(target.revision_id, false);
      }
    }
    return availability;
  }
  private item(
    target: ReadingTargetView,
    state: State | undefined,
    available: boolean,
  ): ReadingItemView {
    return {
      ...pair(target),
      read: state?.is_read ?? false,
      version: state?.version ?? 0,
      availability: available ? 'available' : 'unavailable',
    };
  }
  private async outcome(tx: SqlTransaction, owner: string, key: string) {
    return (
      await tx.query<Outcome>(
        'SELECT id,request_digest,decision,outcome FROM loom.reading_operations WHERE participant_id=$1 AND idempotency_key=$2',
        [owner, key],
      )
    ).rows[0];
  }
  private async result(
    tx: SqlTransaction,
    owner: string,
    outcome: Outcome,
    replayed: boolean,
  ): Promise<ReadingResultView> {
    const list = outcome.outcome.targets,
      states = await this.states(tx, owner, list),
      available = await this.available(tx, list);
    // Retained outcomes prove owner knowledge even when a refused member has no state row.
    return {
      operation_state: outcome.decision,
      operation_id: outcome.id,
      idempotency: replayed ? 'replayed' : 'created',
      outcome: outcome.outcome,
      current: list.map((v) =>
        this.item(v, states.get(v.revision_id), available.get(v.revision_id)!),
      ),
    };
  }
  lookup(actor: ActorContext, value: unknown) {
    if (!Value.Check(ReadingLookup, value)) throw new PublicationError('invalid_input');
    const list = targets(value.targets);
    return this.run(actor, false, undefined, async (tx, owner) => {
      const states = await this.states(tx, owner, list),
        available = await this.available(tx, list);
      if (list.some((v) => !states.has(v.revision_id) && !available.get(v.revision_id)))
        throw new PublicationError('unavailable');
      return {
        scope: 'own_exact_revisions' as const,
        items: list.map((v) =>
          this.item(v, states.get(v.revision_id), available.get(v.revision_id)!),
        ),
      };
    });
  }
  update(actor: ActorContext, value: unknown) {
    if (
      !Value.Check(ReadingUpdate, value) ||
      Buffer.byteLength(JSON.stringify(value)) > readingLimits.requestBytes
    )
      throw new PublicationError('invalid_input');
    if (
      value.basis === 'presentation'
        ? !value.episode_id || value.targets.some((v) => !v.read)
        : value.episode_id !== null
    )
      throw new PublicationError('invalid_input');
    const input: ReadingUpdateInput = {
      ...value,
      idempotency_key: value.idempotency_key.toLowerCase(),
      episode_id: value.episode_id?.toLowerCase() ?? null,
      targets: targets(value.targets),
    };
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          'reading-state-1',
          input.basis,
          input.episode_id,
          input.targets.map((v) => [v.resource_id, v.revision_id, v.read, v.expected_version]),
        ]),
      )
      .digest('hex');
    return this.run(actor, true, input.idempotency_key, async (tx, owner) => {
      const previous = await this.outcome(tx, owner, input.idempotency_key);
      if (previous) {
        if (previous.request_digest !== digest) throw new PublicationError('idempotency_conflict');
        return this.result(tx, owner, previous, true);
      }
      const states = await this.states(tx, owner, input.targets),
        available = await this.available(tx, input.targets);
      if (
        input.targets.some(
          (v) => !available.get(v.revision_id) && (v.read || !states.has(v.revision_id)),
        )
      )
        throw new PublicationError('unavailable');
      const applied = input.targets.every((v) => {
        const state = states.get(v.revision_id),
          version = state?.version ?? 0;
        return (
          v.expected_version === version ||
          (input.basis === 'manual' &&
            !v.read &&
            v.expected_version < version &&
            v.expected_version >= (state?.deliberate_version ?? 0))
        );
      });
      const added = applied ? input.targets.filter((v) => !states.has(v.revision_id)).length : 0;
      await tx.query(
        'INSERT INTO loom.reading_owners(participant_id) VALUES($1) ON CONFLICT DO NOTHING',
        [owner],
      );
      const quota = (
        await tx.query<{ targets: number; operations: number; members: number }>(
          'SELECT targets,operations,members FROM loom.reading_owners WHERE participant_id=$1',
          [owner],
        )
      ).rows[0]!;
      if (
        quota.targets + added > readingLimits.targets ||
        quota.operations >= readingLimits.operations ||
        quota.members + input.targets.length > readingLimits.outcomeMembers ||
        (applied &&
          input.targets.some((v) => (states.get(v.revision_id)?.version ?? 0) >= 2147483646))
      )
        throw new ReadingLimitError();
      const results: ReadingResultView['outcome']['targets'] = [];
      for (const command of input.targets) {
        let state = states.get(command.revision_id);
        if (applied) {
          const version = (state?.version ?? 0) + 1,
            deliberate = input.basis === 'manual' ? version : (state?.deliberate_version ?? 0);
          state = (
            await tx.query<State>(
              `INSERT INTO loom.reading_states(participant_id,resource_id,revision_id,is_read,version,deliberate_version)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(participant_id,revision_id) DO UPDATE SET
            is_read=EXCLUDED.is_read,version=EXCLUDED.version,deliberate_version=EXCLUDED.deliberate_version RETURNING *`,
              [owner, command.resource_id, command.revision_id, command.read, version, deliberate],
            )
          ).rows[0]!;
          states.set(command.revision_id, state);
        }
        results.push({ ...command, result_version: state?.version ?? 0 });
      }
      const outcome = { basis: input.basis, episode_id: input.episode_id, targets: results };
      const saved = (
        await tx.query<Outcome>(
          `INSERT INTO loom.reading_operations(id,participant_id,idempotency_key,semantic_version,request_digest,decision,outcome)
        VALUES($1,$2,$3,'reading-state-1',$4,$5,$6::jsonb) RETURNING *`,
          [
            randomUUID(),
            owner,
            input.idempotency_key,
            digest,
            applied ? 'applied' : 'version_conflict',
            JSON.stringify(outcome),
          ],
        )
      ).rows[0]!;
      await tx.query(
        'UPDATE loom.reading_owners SET targets=targets+$2,operations=operations+1,members=members+$3 WHERE participant_id=$1',
        [owner, added, input.targets.length],
      );
      return {
        operation_state: saved.decision,
        operation_id: saved.id,
        idempotency: 'created' as const,
        outcome,
        current: input.targets.map((v) =>
          this.item(v, states.get(v.revision_id), available.get(v.revision_id)!),
        ),
      };
    });
  }
  reconcile(actor: ActorContext, value: unknown) {
    if (!Value.Check(ReadingStatusInput, value)) throw new PublicationError('invalid_input');
    const key = value.idempotency_key.toLowerCase();
    return this.run(actor, false, key, async (tx, owner) => {
      const outcome = await this.outcome(tx, owner, key);
      return outcome
        ? this.result(tx, owner, outcome, true)
        : { operation_state: 'not_recorded' as const };
    });
  }
}
