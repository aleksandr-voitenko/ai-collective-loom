import type { Transactions } from '../../db/postgres.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { PublicationError, safeError } from '../publication/errors.js';
import { canonicalAttemptKey } from '../publication/input.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { result, type Reconciliation } from '../publication/publication.js';
import { FileError } from './file-storage.js';
import { OrganizationError } from './organization-context.js';
import { SummaryError } from './summary-context.js';
import {
  schemas,
  preparePublicationRequest,
  type PublicationKind,
} from './publication-preparation.js';
import { publicationOutcome } from './publication-attempt.js';
import { publishPreparedPublication } from './publication-transaction.js';
export {
  digestRequest,
  participationSemanticVersion,
  type PublicationKind,
  type PublicationRequest,
} from './publication-preparation.js';

export class ParticipationPublications {
  constructor(private readonly database: Transactions) {}

  async publish(actorContext: ActorContext, operation: PublicationKind, value: unknown) {
    const prepared = preparePublicationRequest(operation, value);
    // Validate the trusted actor before entering SQL, including for replay.
    identityOf(actorContext);
    try {
      const completed = await this.database.transaction((tx) =>
        publishPreparedPublication(tx, actorContext, prepared),
      );
      if (completed instanceof SummaryError || completed instanceof FileError) throw completed;
      return completed;
    } catch (error) {
      if (
        error instanceof OrganizationError ||
        error instanceof SummaryError ||
        error instanceof FileError
      )
        throw error;
      return safeError(error);
    }
  }
  async reconcile(actor: ActorContext, kind: string, key: string): Promise<Reconciliation> {
    if (!schemas[kind as PublicationKind] && kind !== 'attachment.promote')
      throw new PublicationError('invalid_input');
    key = canonicalAttemptKey(key);
    try {
      return await this.database.transaction(async (tx) => {
        const saved = await publicationOutcome(tx, identityOf(actor).participantId, kind, key);
        await lockActor(tx, actor);
        if (!saved) {
          if (
            (
              await tx.query<{ ready: boolean }>(
                "SELECT to_regclass('loom.file_publication_refusals') IS NOT NULL AS ready",
                [],
              )
            ).rows[0]!.ready &&
            (
              await tx.query(
                'SELECT idempotency_key FROM loom.file_publication_refusals WHERE participant_id=$1 AND operation_kind=$2 AND idempotency_key=$3',
                [identityOf(actor).participantId, kind, key],
              )
            ).rowCount
          )
            throw new FileError('file_expired', true);
          return { operation_state: 'not_recorded' };
        }
        await lockContext(tx, saved.resource_id, 'resolution');
        await requireRevision(tx, saved.resource_id, saved.revision_id);
        return result(saved, 'replayed');
      });
    } catch (error) {
      if (error instanceof FileError) throw error;
      return safeError(error);
    }
  }
}
