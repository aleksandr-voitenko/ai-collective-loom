import { randomUUID } from 'node:crypto';
import type { SqlTransaction } from '../../db/postgres.js';

export type PreparedFile = { path: string; upload_id: string; reused_from: string | null };
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
