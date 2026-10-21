import type { SqlTransaction } from '../../db/postgres.js';
import type { NoteContent } from '../../../contracts/participation.js';
import type { PreparedChangeAccount } from '../participation/change-context.js';
import { insertReferences, type PreparedReference } from './reference-storage.js';

/** All validation and target guards precede these fixed revision-owned inserts. */
export async function insertChangeFields(
  tx: SqlTransaction,
  source: string,
  revision: string,
  note?: NoteContent,
  references?: readonly PreparedReference[],
  account?: PreparedChangeAccount,
) {
  if (note) {
    await tx.query(
      'INSERT INTO loom.revision_change_notes(source_id,revision_id,content_format,content_text) VALUES ($1,$2,$3,$4)',
      [source, revision, note.format, note.text],
    );
    for (const mention of note.mentions)
      await tx.query(
        "INSERT INTO loom.revision_mentions(revision_id,source_field,token,participant_id) VALUES ($1,'change_note',$2,$3)",
        [revision, mention.token, mention.participant_id],
      );
    await insertReferences(tx, source, revision, references ?? [], null, 'change_note');
  }
  if (account) {
    await tx.query(
      'INSERT INTO loom.change_account_sets(source_id,revision_id,carried_from_revision_id) VALUES ($1,$2,$3)',
      [source, revision, account.carried_from_revision_id],
    );
    for (const member of account.revisions)
      await tx.query(
        'INSERT INTO loom.change_account_members(revision_id,target_kind,target_id,target_revision_id) VALUES ($1,$2,$3,$4)',
        [revision, member.kind, member.resource_id, member.revision_id],
      );
  }
}
