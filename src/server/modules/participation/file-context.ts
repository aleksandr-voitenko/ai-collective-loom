import type { SqlTransaction } from '../../db/postgres.js';
import type { FileSetValue, UploadStatusValue } from '../../../contracts/files.js';
import { fileLimits } from '../../../contracts/files.js';
import { PublicationError } from '../publication/errors.js';
import {
  requireRevision,
  authorizePublication,
  lockContext,
  type lockActor,
} from '../publication/guards.js';
import type { PreparedFile } from '../publication/file-storage.js';
import { FileError } from './file-storage.js';

export type UploadRow = {
  id: string;
  participant_id: string;
  request_digest: string;
  target_kind: 'area' | 'artifact';
  target_id: string;
  path: string;
  size: number;
  sha256: string;
  media_type: string;
  state: UploadStatusValue['state'];
  stage_version: string | null;
  final_version: string | null;
  lease_until: Date | null;
  upload_expires_at: Date;
  prepared_expires_at: Date;
  reserved: boolean;
  upload_valid: boolean;
  prepared_valid: boolean;
  leased: boolean;
};
export async function fileGuard(tx: SqlTransaction) {
  await tx.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [0x4c4f4f4d, 15]);
}
export async function uploadRow(tx: SqlTransaction, id: string, owner?: string) {
  const row = (
    await tx.query<UploadRow>(
      `SELECT *,upload_expires_at>clock_timestamp() AS upload_valid,
    prepared_expires_at>clock_timestamp() AS prepared_valid,lease_until>clock_timestamp() AS leased
    FROM loom.file_uploads WHERE id=$1 ${owner ? 'AND participant_id=$2' : ''}`,
      [id, ...(owner ? [owner] : [])],
    )
  ).rows[0];
  if (!row) throw new PublicationError('unavailable');
  return row;
}
export function uploadStatus(row: UploadRow): UploadStatusValue {
  return {
    upload_id: row.id,
    state: row.state,
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    media_type: row.media_type,
    upload_expires_at: row.upload_expires_at.toISOString(),
    prepared_expires_at: row.prepared_expires_at.toISOString(),
  };
}
export async function authorizeUpload(
  tx: SqlTransaction,
  actor: Awaited<ReturnType<typeof lockActor>>,
  target: { kind: 'area' | 'artifact'; resource_id: string },
) {
  const chain = await lockContext(tx, target.resource_id, 'resolution', [target.kind]);
  if (target.kind === 'artifact') {
    await authorizePublication(tx, actor, chain);
    if (!chain[0]!.current_revision_id) throw new PublicationError('unavailable');
    await requireRevision(tx, target.resource_id, chain[0]!.current_revision_id);
  } else if (chain.some((r) => !r.publication_open)) throw new PublicationError('forbidden');
}
/** Called under custody and source guards, before the common clock tail. */
export async function prepareFiles(
  tx: SqlTransaction,
  owner: string,
  artifact: string,
  area: string | undefined,
  set: FileSetValue,
) {
  const prepared: PreparedFile[] = [];
  let bytes = 0;
  for (const member of set.files) {
    let row: UploadRow,
      reused: string | null = null;
    if ('upload_id' in member.source) {
      row = await uploadRow(tx, member.source.upload_id, owner);
      if (row.target_kind === 'artifact' ? row.target_id !== artifact : row.target_id !== area)
        throw new PublicationError('unavailable');
      if (!row.prepared_valid || row.state === 'expired' || row.state === 'cleaning')
        throw new FileError('file_expired');
      if (row.state !== 'prepared' || !row.final_version) throw new FileError('file_not_prepared');
    } else {
      await requireRevision(tx, artifact, member.source.revision_id);
      const source = (
        await tx.query<{ upload_id: string }>(
          `SELECT upload_id FROM loom.file_contexts
        WHERE artifact_id=$1 AND revision_id=$2 AND id=$3`,
          [artifact, member.source.revision_id, member.source.file_id],
        )
      ).rows[0];
      if (!source) throw new PublicationError('unavailable');
      row = await uploadRow(tx, source.upload_id);
      reused = member.source.file_id;
      if (row.state !== 'prepared' || !row.final_version) throw new FileError('file_not_prepared');
    }
    bytes += row.size;
    if (bytes > fileLimits.packageBytes) throw new FileError('file_capacity');
    prepared.push({ path: member.path, upload_id: row.id, reused_from: reused });
  }
  return prepared;
}
