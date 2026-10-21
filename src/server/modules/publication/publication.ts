import { insertFiles, type PreparedFile } from './file-storage.js';
import { randomUUID } from 'node:crypto';
import type { SqlTransaction, Transactions } from '../../db/postgres.js';
import { identityOf, type ActorContext } from './actor.js';
import { PublicationError, safeError } from './errors.js';
import {
  canonicalAttemptKey,
  operationKind,
  preparePublication,
  semanticVersion,
} from './input.js';
import { lockAttempt } from '../../application/attempt.js';
import {
  lockActor,
  lockContext,
  authorizePublication,
  requireRevision,
  type Resource,
} from './guards.js';
import { insertReferences, type PreparedReference } from './reference-storage.js';
import { insertCoverage, type PreparedCoverage } from './summary-storage.js';
import { insertChangeFields } from './change-storage.js';
import type { NoteContent } from '../../../contracts/participation.js';
import type { PreparedChangeAccount } from '../participation/change-context.js';

export interface Outcome {
  id: string;
  resource_id: string;
  revision_id: string;
  semantic_version: string;
  request_digest: string;
}
export interface CommittedPublication {
  publication_state: 'committed';
  idempotency: 'created' | 'replayed';
  operation_id: string;
  resource_id: string;
  revision_id: string;
}
export type Reconciliation = CommittedPublication | { operation_state: 'not_recorded' };

async function beginAttempt(
  tx: SqlTransaction,
  participantId: string,
  key: string,
): Promise<Outcome | undefined> {
  await lockAttempt(tx, participantId, operationKind, key);
  return (
    await tx.query<Outcome>(
      'SELECT id, resource_id, revision_id, semantic_version, request_digest FROM loom.idempotency_records WHERE participant_id = $1 AND operation_kind = $2 AND idempotency_key = $3',
      [participantId, operationKind, key],
    )
  ).rows[0];
}
export function result(
  outcome: Pick<Outcome, 'id' | 'resource_id' | 'revision_id'>,
  idempotency: CommittedPublication['idempotency'],
): CommittedPublication {
  return {
    publication_state: 'committed',
    idempotency,
    operation_id: outcome.id,
    resource_id: outcome.resource_id,
    revision_id: outcome.revision_id,
  };
}
/** Trusted internal operation; no transport, upload/parser callback or worker work. */
export class PublicationOperation {
  constructor(private readonly database: Transactions) {}

  async publish(actorContext: ActorContext, value: unknown): Promise<CommittedPublication> {
    const identity = identityOf(actorContext);
    const { input, digest } = preparePublication(value);
    try {
      return await this.database.transaction(async (tx) => {
        const outcome = await beginAttempt(tx, identity.participantId, input.idempotency_key);
        const actor = await lockActor(tx, actorContext);
        const chain = await lockContext(
          tx,
          outcome?.resource_id ?? input.resource_id,
          outcome ? 'resolution' : 'publication',
        );
        const resource = chain[0]!;
        if (outcome) {
          // Reauthorize the exact historical reference, never a cached private body.
          await requireRevision(tx, outcome.resource_id, outcome.revision_id);
          await authorizePublication(tx, actor, chain);
          if (outcome.semantic_version !== semanticVersion || outcome.request_digest !== digest)
            throw new PublicationError('idempotency_conflict');
          return result(outcome, 'replayed');
        }
        if (resource.current_revision_id)
          await requireRevision(tx, resource.id, resource.current_revision_id);
        await authorizePublication(tx, actor, chain);
        if (resource.current_revision_id !== input.expected_revision_id)
          throw new PublicationError('revision_conflict', resource.current_revision_id);
        return commitRevision(tx, actor, chain, input, {
          kind: operationKind,
          version: semanticVersion,
          digest,
        });
      }); // The connection owner resolves only after successful COMMIT.
    } catch (error) {
      return safeError(error);
    }
  }

  /** Owner-bound read-only recovery. Absence is not proof an attempt cannot commit. */
  async reconcile(actorContext: ActorContext, idempotencyKey: string): Promise<Reconciliation> {
    const identity = identityOf(actorContext);
    const key = canonicalAttemptKey(idempotencyKey);
    try {
      return await this.database.transaction(async (tx) => {
        const outcome = await beginAttempt(tx, identity.participantId, key);
        await lockActor(tx, actorContext);
        if (!outcome) return { operation_state: 'not_recorded' };
        await lockContext(tx, outcome.resource_id, 'resolution');
        await requireRevision(tx, outcome.resource_id, outcome.revision_id);
        return result(outcome, 'replayed');
      });
    } catch (error) {
      return safeError(error);
    }
  }
}

/** Shared revision/pointer/event/intent/outcome tail. Call only after all domain,
 * entity and authority guards; no callback or external work can enter this tail. */
export async function commitRevision(
  tx: SqlTransaction,
  actor: Awaited<ReturnType<typeof lockActor>>,
  chain: Resource[],
  input: {
    idempotency_key: string;
    expected_revision_id: string | null;
    content: { format: string; text: string };
    title?: string | null;
    mentions?: readonly { token: string; participant_id: string }[];
    references?: readonly PreparedReference[];
    coverage?: PreparedCoverage;
    changeNote?: NoteContent;
    noteReferences?: readonly PreparedReference[];
    changeAccount?: PreparedChangeAccount;
    files?: readonly PreparedFile[];
  },
  attempt: { kind: string; version: string; digest: string },
): Promise<CommittedPublication> {
  const resource = chain[0]!;
  const ids = {
    operation: randomUUID(),
    revision: randomUUID(),
    event: randomUUID(),
    intent: randomUUID(),
  };
  const ordinal = (
    await tx.query<{ number: string }>(
      'SELECT COALESCE(MAX(revision_number), 0)::text AS number FROM loom.revisions WHERE resource_id = $1',
      [resource.id],
    )
  ).rows[0]!.number;
  await tx.query(
    'INSERT INTO loom.revisions(id, resource_id, revision_number, publisher_id, content_format, content_text, title) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      ids.revision,
      resource.id,
      String(BigInt(ordinal) + 1n),
      actor.participantId,
      input.content.format,
      input.content.text,
      input.title ?? null,
    ],
  );
  for (const mention of input.mentions ?? [])
    await tx.query(
      'INSERT INTO loom.revision_mentions(revision_id, token, participant_id) VALUES ($1,$2,$3)',
      [ids.revision, mention.token, mention.participant_id],
    );
  if (input.changeNote || input.changeAccount)
    await insertChangeFields(
      tx,
      resource.id,
      ids.revision,
      input.changeNote,
      input.noteReferences,
      input.changeAccount,
    );
  if (input.references)
    await insertReferences(
      tx,
      resource.id,
      ids.revision,
      input.references,
      input.expected_revision_id,
    );
  if (input.files) await insertFiles(tx, resource.id, ids.revision, input.files);
  if (input.coverage) await insertCoverage(tx, resource.id, ids.revision, input.coverage);
  const updated = await tx.query(
    'UPDATE loom.resources SET current_revision_id = $2 WHERE id = $1 AND current_revision_id IS NOT DISTINCT FROM $3::uuid RETURNING id',
    [resource.id, ids.revision, input.expected_revision_id],
  );
  if (updated.rowCount !== 1)
    throw new PublicationError('revision_conflict', resource.current_revision_id);

  // All contested domain guards are held before this tail. Referenced actor,
  // resource and revision rows are already guarded/owned; no network work or
  // new domain-lock discovery may follow the clock lock through COMMIT.
  const clock = await tx.query<{ position: string }>(
    'UPDATE loom.community_clocks SET shared_position = shared_position + 1 WHERE id = 1 RETURNING shared_position::text AS position',
    [],
  );
  if (!clock.rows[0]) throw new PublicationError('service_unavailable');
  await tx.query(
    'INSERT INTO loom.shared_activity(id, position, kind, resource_id, revision_id, publisher_id, area_scope_ids) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      ids.event,
      clock.rows[0].position,
      'revision.published',
      resource.id,
      ids.revision,
      actor.participantId,
      chain.filter((owner) => owner.kind === 'area').map((owner) => owner.id),
    ],
  );
  await tx.query('INSERT INTO loom.outbox_intents(id, source_event_id, kind) VALUES ($1, $2, $3)', [
    ids.intent,
    ids.event,
    'publication.project',
  ]);
  await tx.query(
    'INSERT INTO loom.idempotency_records(id, participant_id, operation_kind, idempotency_key, semantic_version, request_digest, resource_id, revision_id, source_event_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      ids.operation,
      actor.participantId,
      attempt.kind,
      input.idempotency_key,
      attempt.version,
      attempt.digest,
      resource.id,
      ids.revision,
      ids.event,
    ],
  );
  return result(
    { id: ids.operation, resource_id: resource.id, revision_id: ids.revision },
    'created',
  );
}
