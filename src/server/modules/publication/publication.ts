import { randomUUID } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';
import { identityOf, type ActorContext } from './actor.js';
import { PublicationError } from './errors.js';
import { canonicalAttemptKey, operationKind, preparePublication, semanticVersion } from './input.js';

interface Transactions { transaction<T>(operation: (transaction: SqlTransaction) => Promise<T>): Promise<T> }
interface Resource {
  id: string; kind: 'area' | 'discussion' | 'contribution' | 'summary' | 'artifact';
  owner_resource_id: string | null; original_author_id: string | null;
  state: string; publication_open: boolean; current_revision_id: string | null;
}
interface Outcome { id: string; resource_id: string; revision_id: string; semantic_version: string; request_digest: string }
export interface CommittedPublication {
  publication_state: 'committed'; idempotency: 'created' | 'replayed';
  operation_id: string; resource_id: string; revision_id: string;
}
export type Reconciliation = CommittedPublication | { operation_state: 'not_recorded' };

// Disjoint from the 64-bit attempt-lock namespace. Structural/lifecycle writers
// must follow ADR-006; the shared structure guard stabilizes dependency discovery.
const structureNamespace = 0x4c4f4f4d;
const structureGuard = 1;
const resourceColumns = 'id, kind, owner_resource_id, original_author_id, state, publication_open, current_revision_id';

async function lockActor(tx: SqlTransaction, actor: ActorContext) {
  const identity = identityOf(actor);
  const participant = await tx.query<{ state: string; role: string }>('SELECT state, role FROM loom.participants WHERE id = $1 FOR SHARE', [identity.participantId]);
  const credential = await tx.query<{ participant_id: string; state: string }>('SELECT participant_id, state FROM loom.participant_credentials WHERE id = $1 FOR SHARE', [identity.credentialId]);
  if (participant.rows[0]?.state !== 'active' || credential.rows[0]?.state !== 'active'
    || credential.rows[0].participant_id !== identity.participantId) throw new PublicationError('unavailable');
  return { ...identity, administrator: participant.rows[0].role === 'administrator' };
}

async function lockContext(tx: SqlTransaction, targetId: string, mode: 'publication' | 'resolution'): Promise<Resource[]> {
  await tx.query('SELECT pg_advisory_xact_lock_shared($1::integer, $2::integer)', [structureNamespace, structureGuard]);
  const discovered = await tx.query<{ id: string }>(`WITH RECURSIVE owners AS (
    SELECT id, owner_resource_id FROM loom.resources WHERE id = $1
    UNION SELECT parent.id, parent.owner_resource_id FROM loom.resources parent JOIN owners child ON parent.id = child.owner_resource_id
  ) SELECT id FROM owners`, [targetId]);
  const locked = new Map<string, Resource>();
  for (const id of discovered.rows.map(row => row.id).sort()) {
    const lock = mode === 'publication' && id === targetId ? 'FOR UPDATE' : 'FOR SHARE';
    const row = (await tx.query<Resource>('SELECT ' + resourceColumns + ' FROM loom.resources WHERE id = $1 ' + lock, [id])).rows[0];
    if (!row) throw new PublicationError('retryable');
    locked.set(id, row);
  }
  const chain: Resource[] = [];
  let current: string | null = targetId;
  while (current) {
    const row = locked.get(current);
    if (!row) throw new PublicationError(locked.size ? 'retryable' : 'unavailable');
    if (chain.some(owner => owner.id === current)) throw new PublicationError('unavailable');
    chain.push(row);
    current = row.owner_resource_id;
  }
  if (chain.length !== locked.size) throw new PublicationError('retryable');
  for (let index = 0; index < chain.length; index++) {
    const row = chain[index]!;
    const owner = chain[index + 1];
    const ownerKind = row.kind === 'contribution' || row.kind === 'summary' ? 'discussion' : 'area';
    if (row.state !== 'active' || (owner ? owner.kind !== ownerKind : row.kind !== 'area')) throw new PublicationError('unavailable');
  }
  if (!['contribution', 'summary', 'artifact'].includes(chain[0]!.kind)) throw new PublicationError('unavailable');
  return chain;
}

async function authorizePublication(tx: SqlTransaction, actor: Awaited<ReturnType<typeof lockActor>>, chain: Resource[]) {
  const resource = chain[0]!;
  const editor = resource.kind === 'contribution' ? resource.original_author_id === actor.participantId
    : (await tx.query('SELECT 1 FROM loom.resource_editors WHERE resource_id = $1 AND participant_id = $2', [resource.id, actor.participantId])).rowCount === 1;
  if (!actor.administrator && !editor) throw new PublicationError(resource.current_revision_id ? 'forbidden' : 'unavailable');
  if (chain.some(resource => !resource.publication_open)) throw new PublicationError('forbidden');
}

async function requireRevision(tx: SqlTransaction, resourceId: string, revisionId: string) {
  const result = await tx.query('SELECT id FROM loom.revisions WHERE resource_id = $1 AND id = $2 AND availability = $3 FOR SHARE', [resourceId, revisionId, 'available']);
  if (!result.rowCount) throw new PublicationError('unavailable');
}
async function beginAttempt(tx: SqlTransaction, participantId: string, key: string): Promise<Outcome | undefined> {
  await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED', []);
  await tx.query("SELECT set_config('lock_timeout', $1, true)", ['1500ms']);
  // An advisory mutex exists even when the durable outcome row does not. Hash
  // collisions only serialize unrelated attempts; the SQL scope remains exact.
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['loom.publication.attempt', participantId, operationKind, key])]);
  return (await tx.query<Outcome>('SELECT id, resource_id, revision_id, semantic_version, request_digest FROM loom.idempotency_records WHERE participant_id = $1 AND operation_kind = $2 AND idempotency_key = $3', [participantId, operationKind, key])).rows[0];
}
function result(outcome: Pick<Outcome, 'id' | 'resource_id' | 'revision_id'>, idempotency: CommittedPublication['idempotency']): CommittedPublication {
  return { publication_state: 'committed', idempotency, operation_id: outcome.id, resource_id: outcome.resource_id, revision_id: outcome.revision_id };
}
function safeError(error: unknown): never {
  if (error instanceof PublicationError) throw error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  throw new PublicationError(['40P01', '40001', '55P03'].includes(String(code)) ? 'retryable' : 'service_unavailable');
}

/** Trusted internal operation; no transport, upload/parser callback or worker work. */
export class PublicationOperation {
  constructor(private readonly database: Transactions) {}

  async publish(actorContext: ActorContext, value: unknown): Promise<CommittedPublication> {
    const identity = identityOf(actorContext);
    const { input, digest } = preparePublication(value);
    const ids = { operation: randomUUID(), revision: randomUUID(), event: randomUUID(), intent: randomUUID() };
    try {
      return await this.database.transaction(async tx => {
        const outcome = await beginAttempt(tx, identity.participantId, input.idempotency_key);
        const actor = await lockActor(tx, actorContext);
        const chain = await lockContext(tx, outcome?.resource_id ?? input.resource_id, outcome ? 'resolution' : 'publication');
        const resource = chain[0]!;
        if (outcome) {
          // Reauthorize the exact historical reference, never a cached private body.
          await requireRevision(tx, outcome.resource_id, outcome.revision_id);
          await authorizePublication(tx, actor, chain);
          if (outcome.semantic_version !== semanticVersion || outcome.request_digest !== digest) throw new PublicationError('idempotency_conflict');
          return result(outcome, 'replayed');
        }
        if (resource.current_revision_id) await requireRevision(tx, resource.id, resource.current_revision_id);
        await authorizePublication(tx, actor, chain);
        if (resource.current_revision_id !== input.expected_revision_id) throw new PublicationError('revision_conflict', resource.current_revision_id);
        const ordinal = (await tx.query<{ number: string }>('SELECT COALESCE(MAX(revision_number), 0)::text AS number FROM loom.revisions WHERE resource_id = $1', [resource.id])).rows[0]!.number;
        await tx.query('INSERT INTO loom.revisions(id, resource_id, revision_number, publisher_id, content_format, content_text) VALUES ($1, $2, $3, $4, $5, $6)', [ids.revision, resource.id, String(BigInt(ordinal) + 1n), actor.participantId, input.content.format, input.content.text]);
        const updated = await tx.query('UPDATE loom.resources SET current_revision_id = $2 WHERE id = $1 AND current_revision_id IS NOT DISTINCT FROM $3::uuid RETURNING id', [resource.id, ids.revision, input.expected_revision_id]);
        if (updated.rowCount !== 1) throw new PublicationError('revision_conflict', resource.current_revision_id);

        // All contested domain guards are held before this tail. Referenced actor,
        // resource and revision rows are already guarded/owned; no network work or
        // new domain-lock discovery may follow the clock lock through COMMIT.
        const clock = await tx.query<{ position: string }>('UPDATE loom.community_clocks SET shared_position = shared_position + 1 WHERE id = 1 RETURNING shared_position::text AS position', []);
        if (!clock.rows[0]) throw new PublicationError('service_unavailable');
        await tx.query('INSERT INTO loom.shared_activity(id, position, kind, resource_id, revision_id, publisher_id, area_scope_ids) VALUES ($1, $2, $3, $4, $5, $6, $7)', [ids.event, clock.rows[0].position, 'revision.published', resource.id, ids.revision, actor.participantId, chain.filter(owner => owner.kind === 'area').map(owner => owner.id)]);
        await tx.query('INSERT INTO loom.outbox_intents(id, source_event_id, kind) VALUES ($1, $2, $3)', [ids.intent, ids.event, 'publication.project']);
        await tx.query('INSERT INTO loom.idempotency_records(id, participant_id, operation_kind, idempotency_key, semantic_version, request_digest, resource_id, revision_id, source_event_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [ids.operation, actor.participantId, operationKind, input.idempotency_key, semanticVersion, digest, resource.id, ids.revision, ids.event]);
        return result({ id: ids.operation, resource_id: resource.id, revision_id: ids.revision }, 'created');
      }); // The connection owner resolves only after successful COMMIT.
    } catch (error) { return safeError(error); }
  }

  /** Owner-bound read-only recovery. Absence is not proof an attempt cannot commit. */
  async reconcile(actorContext: ActorContext, idempotencyKey: string): Promise<Reconciliation> {
    const identity = identityOf(actorContext);
    const key = canonicalAttemptKey(idempotencyKey);
    try {
      return await this.database.transaction(async tx => {
        const outcome = await beginAttempt(tx, identity.participantId, key);
        await lockActor(tx, actorContext);
        if (!outcome) return { operation_state: 'not_recorded' };
        await lockContext(tx, outcome.resource_id, 'resolution');
        await requireRevision(tx, outcome.resource_id, outcome.revision_id);
        return result(outcome, 'replayed');
      });
    } catch (error) { return safeError(error); }
  }
}
