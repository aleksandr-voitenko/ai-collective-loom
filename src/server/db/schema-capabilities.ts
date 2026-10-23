import type { SqlTransaction } from './postgres.js';

export async function hasChangeSchema(tx: SqlTransaction) {
  return !!(
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('loom.revision_change_notes') IS NOT NULL AS present",
      [],
    )
  ).rows[0]?.present;
}

export async function hasAttachmentSchema(tx: SqlTransaction) {
  return !!(
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('loom.contribution_attachment_sets') IS NOT NULL AS present",
      [],
    )
  ).rows[0]?.present;
}
