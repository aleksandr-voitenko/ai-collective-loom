import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SavedTarget, SavedUpdate, savedLimits, type SavedTargetView, type SavedItemView,
  type SavedResultView, type SavedPageView } from '../../../contracts/saved-items.js';
import type { SqlTransaction } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError } from '../publication/errors.js';
import { lockActor, lockContext, requireRevision, safeError, type Transactions } from '../publication/publication.js';
import { ParticipationRetrieval, RetrievalError, fit, responseBudget, type PageOptions } from './retrieval.js';

export class SavedItemsError extends Error {
  constructor(readonly code: 'saved_limit_reached' | 'saved_collection_changed') {
    super(code === 'saved_limit_reached'
      ? 'The synthetic Saved items retention limit has been reached. Existing outcomes remain recoverable.'
      : 'Saved items changed between pages. Refresh the collection to continue.');
  }
}
interface Row {
  id: string; participant_id: string; target_kind: SavedTargetView['kind']; resource_id: string;
  content_resource_id: string; revision_id: string | null; observed_revision_id: string | null;
  saved: boolean; version: number;
}
interface Outcome {
  id: string; bookmark_id: string; request_digest: string; semantic_version: string;
  desired_saved: boolean; expected_version: number; result_version: number;
  decision: SavedResultView['operation_state'];
}
function targetOf(row: Row): SavedTargetView {
  return row.target_kind === 'revision'
    ? { kind: 'revision', resource_id: row.resource_id, revision_id: row.revision_id! }
    : { kind: row.target_kind, resource_id: row.resource_id };
}
function normalizeTarget(value: unknown): SavedTargetView {
  if (!Value.Check(SavedTarget, value)) throw new PublicationError('invalid_input');
  return value.kind === 'revision'
    ? { kind: value.kind, resource_id: value.resource_id.toLowerCase(), revision_id: value.revision_id.toLowerCase() }
    : { kind: value.kind, resource_id: value.resource_id.toLowerCase() };
}

/** Private operations share authentication/transaction guards, never publication's
 * event tail. Owner serialization also makes quotas and list generations atomic. */
export class SavedItems {
  private readonly cursorKey = randomBytes(32);
  private readonly reads: ParticipationRetrieval;
  constructor(private readonly database: Transactions) { this.reads = new ParticipationRetrieval(database); }
  private async run<T>(work: (tx: SqlTransaction) => Promise<T>) {
    try { return await this.database.transaction(work); }
    catch (error) {
      if (error instanceof SavedItemsError || error instanceof RetrievalError) throw error;
      return safeError(error);
    }
  }
  private async owner(tx: SqlTransaction, actor: ActorContext, write: boolean) {
    const authority = await lockActor(tx, actor);
    await tx.query("SELECT set_config('lock_timeout', $1, true)", ['1500ms']);
    await tx.query(`SELECT ${write ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtextextended($1, 0))`,
      [JSON.stringify(['loom.saved.owner', authority.participantId])]);
    return authority;
  }
  private async find(tx: SqlTransaction, owner: string, target: SavedTargetView) {
    return (await tx.query<Row>(`SELECT * FROM loom.saved_items WHERE participant_id=$1
      AND target_kind=$2 AND resource_id=$3 AND revision_id IS NOT DISTINCT FROM $4::uuid`,
    [owner, target.kind, target.resource_id, target.kind === 'revision' ? target.revision_id : null])).rows[0];
  }
  private async source(tx: SqlTransaction, actor: Awaited<ReturnType<typeof lockActor>>, target: SavedTargetView) {
    let contentId = target.resource_id;
    if (target.kind === 'discussion') {
      await lockContext(tx, target.resource_id, 'resolution', ['discussion'], savedLimits.ownerResources);
      contentId = (await tx.query<{ opening_id: string }>('SELECT opening_id FROM loom.discussions WHERE id=$1', [target.resource_id])).rows[0]?.opening_id ?? '';
      if (!contentId) throw new PublicationError('unavailable');
    } else {
      await lockContext(tx, target.resource_id, 'resolution', target.kind === 'revision' ? ['contribution', 'artifact'] : [target.kind], savedLimits.ownerResources);
      const typed = await tx.query(`SELECT id FROM loom.contributions WHERE id=$1 UNION ALL SELECT id FROM loom.artifacts WHERE id=$1`, [contentId]);
      if (!typed.rowCount) throw new PublicationError('unavailable');
    }
    if (target.kind === 'discussion') await lockContext(tx, contentId, 'resolution', ['contribution'], savedLimits.ownerResources);
    return this.reads.resource(tx, actor, contentId, target.kind === 'revision' ? target.revision_id : undefined);
  }
  private async view(tx: SqlTransaction, actor: Awaited<ReturnType<typeof lockActor>>, row: Row): Promise<SavedItemView> {
    const item: SavedItemView = { target: targetOf(row), saved: row.saved, version: row.version, source: { state: 'unavailable' } };
    try {
      const resource = await this.source(tx, actor, item.target);
      let observed = row.observed_revision_id;
      if (observed) {
        try { await requireRevision(tx, row.content_resource_id, observed); }
        catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
          observed = null;
        }
      }
      item.source = { state: 'available', resource, observed_revision_id: observed };
    } catch (error) {
      if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
      // Only the owner's retained target identity survives this projection.
      // Never replay a title, author, path or hidden observed revision from an
      // earlier authorized response.
    }
    return fit(item, responseBudget());
  }
  private async outcome(tx: SqlTransaction, owner: string, key: string) {
    return (await tx.query<Outcome>('SELECT * FROM loom.saved_operations WHERE participant_id=$1 AND idempotency_key=$2', [owner, key])).rows[0];
  }
  private async result(tx: SqlTransaction, actor: Awaited<ReturnType<typeof lockActor>>, outcome: Outcome, replayed: boolean): Promise<SavedResultView> {
    const row = (await tx.query<Row>('SELECT * FROM loom.saved_items WHERE participant_id=$1 AND id=$2', [actor.participantId, outcome.bookmark_id])).rows[0];
    if (!row) throw new PublicationError('service_unavailable');
    return fit({
      operation_state: outcome.decision, operation_id: outcome.id, idempotency: replayed ? 'replayed' : 'created',
      outcome: { target: targetOf(row), saved: outcome.desired_saved, expected_version: outcome.expected_version, result_version: outcome.result_version },
      current: await this.view(tx, actor, row),
    }, responseBudget());
  }
  lookup(actorContext: ActorContext, value: unknown) {
    const target = normalizeTarget(value);
    return this.run(async tx => {
      const actor = await this.owner(tx, actorContext, false), row = await this.find(tx, actor.participantId, target);
      if (row) return this.view(tx, actor, row);
      const resource = await this.source(tx, actor, target);
      return fit({ target, saved: false, version: 0, source: { state: 'available', resource, observed_revision_id: null } } satisfies SavedItemView, responseBudget());
    });
  }
  update(actorContext: ActorContext, value: unknown) {
    if (!Value.Check(SavedUpdate, value)) throw new PublicationError('invalid_input');
    const target = normalizeTarget(value.target), key = value.idempotency_key.toLowerCase();
    const digest = createHash('sha256').update(JSON.stringify(['saved-state-v1', 'saved.set', target, value.saved, value.expected_version])).digest('hex');
    return this.run(async tx => {
      await lockAttempt(tx, identityOf(actorContext).participantId, 'saved.set', key);
      const actor = await this.owner(tx, actorContext, true), previous = await this.outcome(tx, actor.participantId, key);
      if (previous) {
        if (previous.semantic_version !== 'saved-state-v1' || previous.request_digest !== digest) throw new PublicationError('idempotency_conflict');
        return this.result(tx, actor, previous, true);
      }
      const count = (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM
        (SELECT 1 FROM loom.saved_operations WHERE participant_id=$1 LIMIT 10000) bounded`, [actor.participantId])).rows[0]!.n;
      if (count >= savedLimits.operations) throw new SavedItemsError('saved_limit_reached');
      let row = await this.find(tx, actor.participantId, target);
      // New saves need source eligibility; known tombstones can always be unsaved
      // without source access. Initial targets still require a valid shared source.
      const source = value.saved || !row ? await this.source(tx, actor, target) : undefined;
      if (!row) {
        const targets = (await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM
          (SELECT 1 FROM loom.saved_items WHERE participant_id=$1 LIMIT 500) bounded`, [actor.participantId])).rows[0]!.n;
        if (targets >= savedLimits.targets) throw new SavedItemsError('saved_limit_reached');
        row = (await tx.query<Row>(`INSERT INTO loom.saved_items(id,participant_id,target_kind,resource_id,content_resource_id,revision_id)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), actor.participantId, target.kind, target.resource_id,
          source!.resource_id, target.kind === 'revision' ? target.revision_id : null])).rows[0]!;
      }
      const decision = row.version === value.expected_version ? 'applied' : 'version_conflict';
      if (decision === 'applied') {
        if (row.version >= 2147483646) throw new SavedItemsError('saved_limit_reached');
        row = (await tx.query<Row>(`UPDATE loom.saved_items SET version=version+1,saved=$3,
          observed_revision_id=CASE WHEN $3 AND NOT saved THEN $4::uuid WHEN NOT $3 THEN NULL ELSE observed_revision_id END
          WHERE participant_id=$1 AND id=$2 RETURNING *`, [actor.participantId, row.id, value.saved, source?.revision_id ?? null])).rows[0]!;
        await tx.query(`INSERT INTO loom.saved_collections(participant_id,version) VALUES ($1,1)
          ON CONFLICT (participant_id) DO UPDATE SET version=loom.saved_collections.version+1`, [actor.participantId]);
      }
      const outcome = (await tx.query<Outcome>(`INSERT INTO loom.saved_operations(id,participant_id,idempotency_key,bookmark_id,semantic_version,
        request_digest,desired_saved,expected_version,result_version,decision) VALUES ($1,$2,$3,$4,'saved-state-v1',$5,$6,$7,$8,$9) RETURNING *`,
      [randomUUID(), actor.participantId, key, row.id, digest, value.saved, value.expected_version, row.version, decision])).rows[0]!;
      return this.result(tx, actor, outcome, false);
    });
  }
  reconcile(actorContext: ActorContext, key: string) {
    return this.run(async tx => {
      await lockAttempt(tx, identityOf(actorContext).participantId, 'saved.set', key.toLowerCase());
      const actor = await this.owner(tx, actorContext, false), outcome = await this.outcome(tx, actor.participantId, key.toLowerCase());
      return outcome ? this.result(tx, actor, outcome, true) : { operation_state: 'not_recorded' as const };
    });
  }
  private encode(owner: string, version: number, after: string) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.cursorKey, nonce);
    const data = Buffer.concat([cipher.update(JSON.stringify({ owner, version, after })), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64url');
  }
  private decode(owner: string, value: string) {
    try {
      const bytes = Buffer.from(value, 'base64url'), cipher = createDecipheriv('aes-256-gcm', this.cursorKey, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const cursor = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()) as { owner: string; version: number; after: string };
      if (cursor.owner !== owner || !Number.isSafeInteger(cursor.version) || !/^[a-f0-9-]{36}$/.test(cursor.after)) throw new Error();
      return cursor;
    } catch { throw new RetrievalError('invalid_cursor'); }
  }
  list(actorContext: ActorContext, options: PageOptions): Promise<SavedPageView> {
    const size = Number(options.limit ?? 12), budget = responseBudget(options.max_response_bytes);
    if (!Number.isInteger(size) || size < 1 || size > savedLimits.pageItems) throw new PublicationError('invalid_input');
    return this.run(async tx => {
      const actor = await this.owner(tx, actorContext, false);
      const cursor = options.cursor ? this.decode(actor.participantId, options.cursor) : undefined;
      const version = (await tx.query<{ version: number }>('SELECT version FROM loom.saved_collections WHERE participant_id=$1', [actor.participantId])).rows[0]?.version ?? 0;
      if (cursor && cursor.version !== version) throw new SavedItemsError('saved_collection_changed');
      const rows = (await tx.query<Row>(`SELECT * FROM loom.saved_items WHERE participant_id=$1 AND saved
        AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`, [actor.participantId, cursor?.after ?? null, size + 1])).rows;
      const page: SavedPageView = { items: [], next_cursor: null, complete: false, collection_version: version,
        ordering: 'stable_target_id', scope: 'own_saved_items', representation: 'currently_authorized_metadata', limit: size, max_response_bytes: budget };
      for (const row of rows.slice(0, size)) {
        const item = await this.view(tx, actor, row);
        if (Buffer.byteLength(JSON.stringify({ ...page, items: [...page.items, item] })) + 1024 > budget) {
          if (!page.items.length) throw new RetrievalError('response_budget_too_small');
          break;
        }
        page.items.push(item);
      }
      page.complete = page.items.length === rows.length;
      if (!page.complete) page.next_cursor = this.encode(actor.participantId, version, rows[page.items.length - 1]!.id);
      return fit(page, budget);
    });
  }
}
