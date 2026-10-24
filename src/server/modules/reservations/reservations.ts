import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../../contracts/reservations.js';
import { UUID } from '../../../contracts/participation.js';
import { validUnicode } from '../../../contracts/authored.js';
import type { Transactions, SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, authorizeEditor, requireRevision } from '../publication/guards.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { fit, RetrievalError } from '../participation/retrieval.js';

export class ReservationError extends Error {
  constructor(
    readonly code: 'editing_intent_conflict' | 'editing_intent_limit' | 'editing_intent_closed',
  ) {
    super(
      code === 'editing_intent_closed'
        ? 'Contributions are closed here. Existing reading and private editing intent recovery remain available.'
        : code === 'editing_intent_conflict'
          ? 'Editing intent changed or expired. Refresh and review before a new command.'
          : 'The synthetic editing intent limit is reached. Publication, exact recovery and release remain available.',
    );
  }
}
type Notice = {
  id: string;
  participant_id: string;
  resource_id: string;
  base_revision_id: string;
  purpose: string;
  scope_kind: 'whole' | 'described';
  scope_description: string | null;
  created_at: Date;
  expires_at: Date;
  released_at: Date | null;
  version: number;
};
type Decision = {
  id: string;
  action: C.IntentActionValue;
  request_digest: string;
  notice_id: string;
  result_version: number;
  accepted_at: Date;
  expires_at: Date;
  released_at: Date | null;
};
const schemas = { announce: C.AnnounceIntent, renew: C.RenewIntent, release: C.ReleaseIntent };
function temporal(row: Notice, now: Date) {
  return {
    notice_id: row.id,
    version: row.version,
    expires_at: row.expires_at.toISOString(),
    released_at: row.released_at?.toISOString() ?? null,
    state: row.released_at
      ? ('released' as const)
      : row.expires_at <= now
        ? ('expired' as const)
        : ('active' as const),
  };
}
export class EditingReservations {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly database: Transactions) {}
  private async run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query(
          "SELECT set_config('statement_timeout','2500ms',true),set_config('lock_timeout','1500ms',true),set_config('transaction_timeout','15000ms',true)",
          [],
        );
        return work(tx);
      });
    } catch (error) {
      if (error instanceof ReservationError || error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
  private guard(tx: SqlTransaction) {
    return tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 17]);
  }
  private async now(tx: SqlTransaction) {
    return (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now', [])).rows[0]!.now;
  }
  private async notice(tx: SqlTransaction, owner: string, id: string) {
    const row = (
      await tx.query<Notice>(
        'SELECT * FROM loom.editing_notices WHERE id=$1 AND participant_id=$2',
        [id, owner],
      )
    ).rows[0];
    if (!row) throw new PublicationError('unavailable');
    return row;
  }
  private async decision(
    tx: SqlTransaction,
    owner: string,
    action: C.IntentActionValue,
    key: string,
  ) {
    return (
      await tx.query<Decision>(
        'SELECT * FROM loom.editing_intent_operations WHERE participant_id=$1 AND action=$2 AND idempotency_key=$3',
        [owner, action, key],
      )
    ).rows[0];
  }
  private async result(
    tx: SqlTransaction,
    owner: string,
    saved: Decision,
    idempotency: 'created' | 'replayed',
  ): Promise<C.IntentResultView> {
    const current = await this.notice(tx, owner, saved.notice_id),
      now = await this.now(tx);
    return fit(
      {
        operation_state: 'recorded',
        operation_id: saved.id,
        action: saved.action,
        idempotency,
        outcome: {
          notice_id: saved.notice_id,
          version: saved.result_version,
          accepted_at: saved.accepted_at.toISOString(),
          expires_at: saved.expires_at.toISOString(),
          released_at: saved.released_at?.toISOString() ?? null,
        },
        current: temporal(current, now),
        observed_at: now.toISOString(),
      },
      C.reservationLimits.responseBytes,
    );
  }
  async change(
    context: ActorContext,
    action: C.IntentActionValue,
    value: unknown,
  ): Promise<C.IntentResultView> {
    if (!Value.Check(schemas[action], value)) throw new PublicationError('invalid_input');
    const input = value as C.AnnounceIntentInput & C.RenewIntentInput & C.ReleaseIntentInput;
    if (action === 'announce')
      for (const [text, limit] of [
        [input.purpose, C.reservationLimits.purposeBytes],
        [
          input.scope.kind === 'described' ? input.scope.description : 'whole',
          C.reservationLimits.scopeBytes,
        ],
      ] as const) {
        if (!text.trim() || !validUnicode(text) || Buffer.byteLength(text) > limit)
          throw new PublicationError('invalid_input');
      }
    const key = input.idempotency_key.toLowerCase(),
      duration = input.duration_minutes ?? 30;
    // Presence of an optional duration is substantive; omission is not rewritten
    // into explicit input when comparing an exact retained request.
    const semantic =
      action === 'announce'
        ? [
            input.resource_id.toLowerCase(),
            input.base_revision_id.toLowerCase(),
            input.purpose,
            input.scope.kind,
            input.scope.kind === 'described' ? input.scope.description : null,
            input.duration_minutes ?? null,
          ]
        : [
            input.notice_id.toLowerCase(),
            input.expected_version,
            ...(action === 'renew' ? [input.duration_minutes ?? null] : []),
          ];
    const digest = createHash('sha256')
      .update(JSON.stringify([C.reservationContract, action, ...semantic]))
      .digest('hex');
    return this.run(async (tx) => {
      await lockAttempt(tx, identityOf(context).participantId, 'editing-intent.' + action, key);
      const actor = await lockActor(tx, context),
        owner = actor.participantId;
      await this.guard(tx);
      const saved = await this.decision(tx, owner, action, key);
      if (saved) {
        if (saved.request_digest !== digest) throw new PublicationError('idempotency_conflict');
        await lockActor(tx, context);
        return this.result(tx, owner, saved, 'replayed');
      }
      let notice: Notice | undefined;
      if (action !== 'announce')
        notice = await this.notice(tx, owner, input.notice_id.toLowerCase());
      if (action !== 'release') {
        const id = notice?.resource_id ?? input.resource_id.toLowerCase(),
          base = notice?.base_revision_id ?? input.base_revision_id.toLowerCase();
        const chain = await lockContext(tx, id, 'resolution');
        // Only concrete publications, never an untyped prepared resource.
        const kind = chain[0]!.kind;
        if (
          !['contribution', 'summary', 'artifact'].includes(kind) ||
          !(
            await tx.query(
              `SELECT id FROM loom.${kind === 'contribution' ? 'contributions' : kind === 'summary' ? 'summaries' : 'artifacts'} WHERE id=$1`,
              [id],
            )
          ).rowCount
        )
          throw new PublicationError('unavailable');
        await authorizeEditor(tx, actor, chain);
        await requireRevision(tx, id, base);
        if (chain.some((r) => !r.publication_open))
          throw new ReservationError('editing_intent_closed');
      }
      // Credential deadlines and notice validity must be observed after custody,
      // containment, editor and exact-revision waits, not at transaction start.
      await lockActor(tx, context);
      const now = await this.now(tx);
      if (
        notice &&
        (notice.version !== input.expected_version ||
          notice.released_at ||
          (action === 'renew' && notice.expires_at <= now))
      )
        throw new ReservationError('editing_intent_conflict');
      if (action === 'announce') {
        const counts = (
          await tx.query<{
            owned: number;
            resource: number;
            active_owner: number;
            active_resource: number;
            same: number;
          }>(
            `SELECT count(*) FILTER(WHERE participant_id=$1)::int AS owned,count(*) FILTER(WHERE resource_id=$2)::int AS resource,
          count(*) FILTER(WHERE participant_id=$1 AND released_at IS NULL AND expires_at>$3)::int AS active_owner,
          count(*) FILTER(WHERE resource_id=$2 AND released_at IS NULL AND expires_at>$3)::int AS active_resource,
          count(*) FILTER(WHERE participant_id=$1 AND resource_id=$2 AND released_at IS NULL AND expires_at>$3)::int AS same
          FROM loom.editing_notices WHERE participant_id=$1 OR resource_id=$2`,
            [owner, input.resource_id.toLowerCase(), now],
          )
        ).rows[0]!;
        if (counts.same) throw new ReservationError('editing_intent_conflict');
        if (
          counts.owned >= C.reservationLimits.perOwner ||
          counts.resource >= C.reservationLimits.perResource ||
          counts.active_owner >= C.reservationLimits.activePerOwner ||
          counts.active_resource >= C.reservationLimits.activePerResource
        )
          throw new ReservationError('editing_intent_limit');
      }
      if (action !== 'release') {
        const state = (
          await tx.query<{ notices: number; decisions: number }>(
            'SELECT notices,decisions FROM loom.editing_intent_state WHERE id=1',
            [],
          )
        ).rows[0]!;
        if (
          state.decisions >= C.reservationLimits.decisions ||
          (action === 'announce' && state.notices >= C.reservationLimits.notices)
        )
          throw new ReservationError('editing_intent_limit');
        await tx.query(
          'UPDATE loom.editing_intent_state SET decisions=decisions+1,notices=notices+$1 WHERE id=1',
          [action === 'announce' ? 1 : 0],
        );
      }
      const expires = new Date(now.getTime() + duration * 60000);
      if (action === 'announce')
        notice = (
          await tx.query<Notice>(
            `INSERT INTO loom.editing_notices
        (id,participant_id,resource_id,base_revision_id,purpose,scope_kind,scope_description,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              randomUUID(),
              owner,
              input.resource_id.toLowerCase(),
              input.base_revision_id.toLowerCase(),
              input.purpose,
              input.scope.kind,
              input.scope.kind === 'described' ? input.scope.description : null,
              now,
              expires,
            ],
          )
        ).rows[0]!;
      else
        notice = (
          await tx.query<Notice>(
            action === 'renew'
              ? 'UPDATE loom.editing_notices SET version=version+1,expires_at=$2 WHERE id=$1 RETURNING *'
              : 'UPDATE loom.editing_notices SET version=version+1,released_at=$2 WHERE id=$1 RETURNING *',
            [notice!.id, action === 'renew' ? expires : now],
          )
        ).rows[0]!;
      const decision = (
        await tx.query<Decision>(
          `INSERT INTO loom.editing_intent_operations
        (id,participant_id,action,idempotency_key,semantic_version,request_digest,notice_id,result_version,accepted_at,expires_at,released_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [
            randomUUID(),
            owner,
            action,
            key,
            C.reservationContract,
            digest,
            notice.id,
            notice.version,
            now,
            notice.expires_at,
            notice.released_at,
          ],
        )
      ).rows[0]!;
      return this.result(tx, owner, decision, 'created');
    });
  }
  async status(context: ActorContext, value: unknown): Promise<C.IntentStatusView> {
    if (!Value.Check(C.IntentStatusInput, value)) throw new PublicationError('invalid_input');
    const action = value.action as C.IntentActionValue,
      key = value.idempotency_key.toLowerCase();
    return this.run(async (tx) => {
      await lockAttempt(tx, identityOf(context).participantId, 'editing-intent.' + action, key);
      const actor = await lockActor(tx, context);
      await this.guard(tx);
      await lockActor(tx, context);
      const saved = await this.decision(tx, actor.participantId, action, key);
      return saved
        ? this.result(tx, actor.participantId, saved, 'replayed')
        : { operation_state: 'not_recorded' };
    });
  }
  private cursor(binding: string, after: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.cursorKey, nonce);
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify({ binding, after, expires: Date.now() + 300000 })),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url');
  }
  private after(binding: string, cursor?: string): string | null {
    if (!cursor) return null;
    try {
      if (cursor.length > 2048) throw new Error();
      const bytes = Buffer.from(cursor, 'base64url'),
        decipher = createDecipheriv('aes-256-gcm', this.cursorKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      );
      if (
        value.binding !== binding ||
        value.expires < Date.now() ||
        !Value.Check(UUID, value.after)
      )
        throw new Error();
      return value.after;
    } catch {
      throw new RetrievalError('invalid_cursor');
    }
  }
  async list(
    context: ActorContext,
    id: string,
    options: { limit?: string; cursor?: string } = {},
  ): Promise<C.IntentPageView> {
    if (!Value.Check(UUID, id) || !Value.Check(C.IntentPageInput, options))
      throw new PublicationError('invalid_input');
    id = id.toLowerCase();
    return this.run(async (tx) => {
      const actor = await lockActor(tx, context);
      await this.guard(tx);
      const chain = await lockContext(tx, id, 'resolution'),
        resource = chain[0]!;
      const rows = (
        await tx.query<Notice>(
          'SELECT * FROM loom.editing_notices WHERE resource_id=$1 ORDER BY id LIMIT 101',
          [id],
        )
      ).rows;
      if (rows.length > C.reservationLimits.perResource)
        throw new PublicationError('service_unavailable');
      const eligible = new Set<string>();
      for (const base of [...new Set(rows.map((r) => r.base_revision_id))].sort()) {
        try {
          await requireRevision(tx, id, base);
          eligible.add(base);
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        }
      }
      await lockActor(tx, context);
      const now = await this.now(tx),
        visible = rows.filter((r) => eligible.has(r.base_revision_id));
      const binding = createHash('sha256')
        .update(
          JSON.stringify([
            actor.participantId,
            id,
            visible.map((r) => [r.id, r.version, temporal(r, now).state]),
          ]),
        )
        .digest('hex');
      const after = this.after(binding, options.cursor),
        size = Number(options.limit ?? 12),
        remaining = visible.filter((r) => !after || r.id > after),
        shown = remaining.slice(0, size);
      const items: C.IntentPageView['items'] = [];
      for (const row of shown) {
        const owner = (
          await tx.query<{ may_edit: boolean; nickname: string }>(
            `SELECT p.nickname,(p.state='active' AND (p.role='administrator' OR
          ($2='contribution' AND p.id=$3) OR ($2<>'contribution' AND EXISTS(SELECT 1 FROM loom.resource_editors e WHERE e.resource_id=$4 AND e.participant_id=p.id)))) AS may_edit
          FROM loom.participants p WHERE p.id=$1`,
            [row.participant_id, resource.kind, resource.original_author_id, id],
          )
        ).rows[0];
        items.push({
          ...temporal(row, now),
          resource_id: id,
          base_revision_id: row.base_revision_id,
          participant_id: row.participant_id,
          participant_nickname: owner!.nickname,
          purpose: row.purpose,
          scope:
            row.scope_kind === 'whole'
              ? { kind: 'whole' }
              : { kind: 'described', description: row.scope_description! },
          older_base: row.base_revision_id !== resource.current_revision_id,
          owner_may_edit: !!owner?.may_edit && chain.every((r) => r.publication_open),
        });
      }
      const page = () => ({
        items,
        observed_at: now.toISOString(),
        complete: remaining.length === items.length,
        next_cursor:
          remaining.length > items.length ? this.cursor(binding, items.at(-1)!.notice_id) : null,
      });
      // Escaping counts toward the envelope; a full item is never truncated or
      // skipped. The cursor always follows the last eligible item actually sent.
      while (
        items.length > 1 &&
        Buffer.byteLength(JSON.stringify(page())) > C.reservationLimits.responseBytes
      )
        items.pop();
      return fit(page(), C.reservationLimits.responseBytes);
    });
  }
}
