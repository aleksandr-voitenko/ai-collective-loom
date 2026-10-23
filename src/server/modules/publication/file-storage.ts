import { randomUUID } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';

export type PreparedFile = { path: string; upload_id: string; reused_from: string | null };
export type PreparedPromotion = {
  discussion_id: string;
  contribution_id: string;
  revision_id: string;
  file_id: string;
  contributor_id: string;
  revision_publisher_id: string;
  uploader_id: string;
  promoter_id: string;
};
export async function insertFiles(
  tx: SqlTransaction,
  artifact: string,
  revision: string,
  files: readonly PreparedFile[],
) {
  await tx.query(
    "INSERT INTO loom.artifact_file_sets(artifact_id,revision_id,version) VALUES($1,$2,'artifact-files-v1')",
    [artifact, revision],
  );
  for (const file of files)
    await tx.query(
      `INSERT INTO loom.file_contexts(id,artifact_id,revision_id,path,upload_id,reused_from)
    VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), artifact, revision, file.path, file.upload_id, file.reused_from],
    );
}

export async function insertAttachments(
  tx: SqlTransaction,
  contribution: string,
  discussion: string,
  revision: string,
  files: readonly PreparedFile[],
) {
  await tx.query(
    "INSERT INTO loom.contribution_attachment_sets(contribution_id,discussion_id,revision_id,version) VALUES($1,$2,$3,'contribution-attachments-v1')",
    [contribution, discussion, revision],
  );
  for (const file of files)
    await tx.query(
      `INSERT INTO loom.file_contexts(id,contribution_id,revision_id,path,upload_id,reused_from)
    VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), contribution, revision, file.path, file.upload_id, file.reused_from],
    );
}

export async function insertPromotion(
  tx: SqlTransaction,
  artifact: string,
  revision: string,
  source: PreparedPromotion,
) {
  await tx.query(
    `INSERT INTO loom.attachment_promotions(artifact_id,revision_id,source_discussion_id,source_contribution_id,source_revision_id,source_file_id,contributor_id,revision_publisher_id,uploader_id,promoter_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      artifact,
      revision,
      source.discussion_id,
      source.contribution_id,
      source.revision_id,
      source.file_id,
      source.contributor_id,
      source.revision_publisher_id,
      source.uploader_id,
      source.promoter_id,
    ],
  );
}
