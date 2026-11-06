import type { SqlTransaction } from '../../db/postgres.js';
import type { PreparedDiscussionLink } from '../participation/discussion-link-context.js';

export async function insertDiscussionLinks(
  tx: SqlTransaction,
  source: string,
  revision: string,
  links: readonly PreparedDiscussionLink[],
) {
  for (const link of links)
    await tx.query(
      `INSERT INTO loom.revision_discussion_links
      (source_id,revision_id,discussion_id,target_kind,target_id,target_revision_id,target_file_id,target_path,destination)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        source,
        revision,
        link.discussion_id,
        link.target.kind,
        link.target.resource_id,
        link.target.revision_id ?? null,
        link.target.file_id ?? null,
        link.target.path ?? null,
        link.destination,
      ],
    );
}
