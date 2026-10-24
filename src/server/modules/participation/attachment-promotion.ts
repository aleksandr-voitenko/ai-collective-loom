import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import {
  PromotionInput,
  type PromotionInputValue,
  type PromotionProvenanceValue,
} from '../../../contracts/files.js';
import { validUnicode } from '../../../contracts/authored.js';
import type { Transactions } from '../../db/postgres.js';
import { lockAttempt } from '../../application/attempt.js';
import { identityOf, type ActorContext } from '../publication/actor.js';
import { lockActor, lockContext, requireRevision } from '../publication/guards.js';
import { PublicationClosedError, PublicationError, safeError } from '../publication/errors.js';
import { commitRevision, result, type Outcome } from '../publication/publication.js';
import type { PreparedPromotion } from '../publication/file-storage.js';
import { canonicalAttemptKey } from '../publication/input.js';
import { fileGuard, uploadRow, admitFilePublication } from './file-context.js';
import { FileError } from './file-storage.js';
import { lockReferencePlan } from './reference-context.js';
import { digestRequest } from './publications.js';

const kind = 'attachment.promote',
  version = 'attachment-promotion-v1';

export class AttachmentPromotion {
  constructor(private readonly database: Transactions) {}

  async publish(actorContext: ActorContext, value: unknown) {
    if (!Value.Check(PromotionInput, value)) throw new PublicationError('invalid_input');
    const input: PromotionInputValue = structuredClone(value);
    if (!input.title.trim() || input.title.includes('\0') || !validUnicode(input.title))
      throw new PublicationError('invalid_input');
    input.idempotency_key = input.idempotency_key.toLowerCase();
    input.area_id = input.area_id.toLowerCase();
    for (const field of ['contribution_id', 'revision_id', 'file_id'] as const)
      input.source[field] = input.source[field].toLowerCase();
    const { idempotency_key, ...semantic } = input;
    const digest = digestRequest(kind, semantic, version);
    try {
      return await this.database.transaction(async (tx) => {
        await lockAttempt(tx, identityOf(actorContext).participantId, kind, idempotency_key);
        const actor = await lockActor(tx, actorContext);
        const saved = (
          await tx.query<Outcome>(
            'SELECT id,resource_id,revision_id,semantic_version,request_digest FROM loom.idempotency_records WHERE participant_id=$1 AND operation_kind=$2 AND idempotency_key=$3',
            [actor.participantId, kind, idempotency_key],
          )
        ).rows[0];
        if (saved) {
          // The independent result, not an old source preview, controls recovery.
          const chain = await lockContext(tx, saved.resource_id, 'resolution', ['artifact']);
          await requireRevision(tx, saved.resource_id, saved.revision_id);
          if (chain.some((r) => !r.publication_open)) throw new PublicationClosedError();
          if (saved.semantic_version !== version || saved.request_digest !== digest)
            throw new PublicationError('idempotency_conflict');
          return result(saved, 'replayed');
        }
        await fileGuard(tx);
        await admitFilePublication(tx, actor.participantId, 1);
        await lockReferencePlan(tx, [input.source.contribution_id, input.area_id]);
        const source = await lockContext(tx, input.source.contribution_id, 'resolution', [
          'contribution',
        ]);
        const destination = await lockContext(tx, input.area_id, 'resolution', ['area']);
        await requireRevision(tx, input.source.contribution_id, input.source.revision_id);
        const context = (
          await tx.query<{ upload_id: string; path: string; publisher_id: string }>(
            `
          SELECT f.upload_id,f.path,r.publisher_id FROM loom.file_contexts f
          JOIN loom.revisions r ON r.id=f.revision_id
          WHERE f.contribution_id=$1 AND f.revision_id=$2 AND f.id=$3`,
            [input.source.contribution_id, input.source.revision_id, input.source.file_id],
          )
        ).rows[0];
        if (!context) throw new PublicationError('unavailable');
        const upload = await uploadRow(tx, context.upload_id);
        if (upload.state !== 'prepared' || !upload.final_version)
          throw new PublicationError('unavailable');
        if (destination.some((r) => !r.publication_open)) throw new PublicationClosedError();
        const artifact = randomUUID();
        const provenance: PreparedPromotion = {
          ...input.source,
          discussion_id: source[0]!.owner_resource_id!,
          contributor_id: source[0]!.original_author_id!,
          revision_publisher_id: context.publisher_id,
          uploader_id: upload.participant_id,
          promoter_id: actor.participantId,
        };
        await tx.query(
          "INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id) VALUES($1,'artifact',$2,$3)",
          [artifact, input.area_id, actor.participantId],
        );
        await tx.query('INSERT INTO loom.artifacts VALUES($1)', [artifact]);
        await tx.query('INSERT INTO loom.resource_editors VALUES($1,$2)', [
          artifact,
          actor.participantId,
        ]);
        const chain = await lockContext(tx, artifact, 'publication', ['artifact']);
        return commitRevision(
          tx,
          actor,
          chain,
          {
            idempotency_key,
            expected_revision_id: null,
            title: input.title,
            content: { format: 'loom-markdown-v3', text: '' },
            mentions: [],
            references: [],
            files: [
              { path: context.path, upload_id: upload.id, reused_from: input.source.file_id },
            ],
            promotion: provenance,
          },
          { kind, version, digest },
        );
      });
    } catch (error) {
      if (error instanceof FileError) throw error;
      return safeError(error);
    }
  }

  async provenance(
    actorContext: ActorContext,
    artifact: string,
    revision: string,
  ): Promise<PromotionProvenanceValue> {
    artifact = canonicalAttemptKey(artifact);
    revision = canonicalAttemptKey(revision);
    try {
      return await this.database.transaction(async (tx) => {
        await lockActor(tx, actorContext);
        const row = (
          await tx.query<{
            source_discussion_id: string;
            source_contribution_id: string;
            source_revision_id: string;
            source_file_id: string;
            contributor_id: string;
            revision_publisher_id: string;
            uploader_id: string;
            promoter_id: string;
          }>('SELECT * FROM loom.attachment_promotions WHERE artifact_id=$1 AND revision_id=$2', [
            artifact,
            revision,
          ])
        ).rows[0];
        await lockReferencePlan(tx, [artifact, ...(row ? [row.source_contribution_id] : [])]);
        await lockContext(tx, artifact, 'resolution', ['artifact']);
        await requireRevision(tx, artifact, revision);
        if (!row) throw new PublicationError('unavailable');
        let source: PromotionProvenanceValue['source'] = { state: 'unavailable' };
        try {
          await lockContext(tx, row.source_contribution_id, 'resolution', ['contribution']);
          await requireRevision(tx, row.source_contribution_id, row.source_revision_id);
          source = {
            state: 'available',
            discussion_id: row.source_discussion_id,
            contribution_id: row.source_contribution_id,
            revision_id: row.source_revision_id,
            file_id: row.source_file_id,
            contributor_id: row.contributor_id,
            revision_publisher_id: row.revision_publisher_id,
            uploader_id: row.uploader_id,
          };
        } catch (error) {
          if (!(error instanceof PublicationError) || error.code !== 'unavailable') throw error;
        }
        return {
          artifact_id: artifact,
          revision_id: revision,
          promoter_id: row.promoter_id,
          source,
        };
      });
    } catch (error) {
      return safeError(error);
    }
  }
}
