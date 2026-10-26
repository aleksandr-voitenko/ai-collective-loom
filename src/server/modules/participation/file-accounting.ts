import type { SqlTransaction } from '../../db/postgres.js';
import { fileLimits } from '../../../contracts/files.js';
import { FilePolicy, type FilePolicyValue } from '../../../contracts/file-policy.js';
import { Value } from '@sinclair/typebox/value';
import { PublicationError } from '../publication/errors.js';

// All callers hold custody15 after current actor guards. Policy edits, admission,
// publication and cleanup therefore observe one committed reservation ordering.
export async function filePolicy(tx: SqlTransaction): Promise<FilePolicyValue> {
  const row = (
    await tx.query<FilePolicyValue>(
      `SELECT version,max_file_bytes,max_unfinished_uploads,participant_reserved_bytes,
      community_reserved_bytes FROM loom.file_admission_policy WHERE id=1`,
      [],
    )
  ).rows[0];
  if (!Value.Check(FilePolicy, row)) throw new PublicationError('service_unavailable');
  return row;
}

export async function admissionPolicy(tx: SqlTransaction): Promise<FilePolicyValue> {
  // Only historical populated-upgrade schemas retain their pre-migration limits.
  // SQL failures and a missing/invalid row in a migrated schema never admit work.
  const present = (
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('loom.file_admission_policy') IS NOT NULL AS present",
      [],
    )
  ).rows[0]?.present;
  if (present) return filePolicy(tx);
  return {
    version: 1,
    max_file_bytes: fileLimits.fileBytes,
    max_unfinished_uploads: fileLimits.active,
    participant_reserved_bytes: fileLimits.ownerBytes,
    community_reserved_bytes: fileLimits.communityBytes,
  };
}

export async function fileUsage(tx: SqlTransaction, owner: string) {
  const row = (
    await tx.query<{
      total: string;
      owned: string;
      active: string;
      bytes: string;
      owner_bytes: string;
    }>(
      `SELECT count(*)::text AS total,
      count(*) FILTER(WHERE participant_id=$1)::text AS owned,
      count(*) FILTER(WHERE participant_id=$1 AND state IN ('waiting','uploading','staged','finalizing','quarantined') AND reserved)::text AS active,
      coalesce(sum(size*2) FILTER(WHERE reserved),0)::text AS bytes,
      coalesce(sum(size*2) FILTER(WHERE reserved AND participant_id=$1),0)::text AS owner_bytes
      FROM loom.file_uploads`,
      [owner],
    )
  ).rows[0]!;
  return {
    total: Number(row.total),
    owned: Number(row.owned),
    unfinished: Number(row.active),
    bytes: Number(row.bytes),
    ownerBytes: Number(row.owner_bytes),
  };
}
