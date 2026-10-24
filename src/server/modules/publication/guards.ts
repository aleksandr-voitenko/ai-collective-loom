import type { SqlTransaction } from '../../db/postgres.js';
import type { ActorContext } from './actor.js';
import { currentAuthority } from '../../application/authority.js';
import { PublicationError } from './errors.js';

export interface Resource {
  id: string;
  kind: 'area' | 'discussion' | 'contribution' | 'summary' | 'artifact';
  owner_resource_id: string | null;
  original_author_id: string | null;
  state: string;
  publication_open: boolean;
  current_revision_id: string | null;
}

// Disjoint from the 64-bit attempt-lock namespace. Structural/lifecycle writers
// must follow ADR-006; the shared structure guard stabilizes dependency discovery.
const structureNamespace = 0x4c4f4f4d;
const structureGuard = 1;
const resourceColumns =
  'id, kind, owner_resource_id, original_author_id, state, publication_open, current_revision_id';

export async function lockActor(tx: SqlTransaction, actor: ActorContext) {
  const authority = await currentAuthority(tx, actor);
  if (!authority) throw new PublicationError('unavailable');
  return authority;
}

export async function lockContext(
  tx: SqlTransaction,
  targetId: string,
  mode: 'publication' | 'resolution' | 'reply-traversal',
  allowedKinds = ['contribution', 'summary', 'artifact'],
  maxResources = 32,
): Promise<Resource[]> {
  await tx.query('SELECT pg_advisory_xact_lock_shared($1::integer, $2::integer)', [
    structureNamespace,
    structureGuard,
  ]);
  const discovered = await tx.query<{ id: string }>(
    `WITH RECURSIVE owners AS (
    SELECT id, owner_resource_id FROM loom.resources WHERE id = $1
    UNION SELECT parent.id, parent.owner_resource_id FROM loom.resources parent JOIN owners child ON parent.id = child.owner_resource_id
  ) SELECT id FROM owners LIMIT $2`,
    [targetId, maxResources === undefined ? null : maxResources + 1],
  );
  // Bounded secondary views can fail explicitly before an unbounded lock walk.
  // The structure guard keeps this dependency set fixed for the transaction.
  if (maxResources !== undefined && discovered.rows.length > maxResources)
    throw new PublicationError('service_unavailable');
  const locked = new Map<string, Resource>();
  for (const id of discovered.rows.map((row) => row.id).sort()) {
    const lock = mode === 'publication' && id === targetId ? 'FOR UPDATE' : 'FOR SHARE';
    const row = (
      await tx.query<Resource>(
        'SELECT ' + resourceColumns + ' FROM loom.resources WHERE id = $1 ' + lock,
        [id],
      )
    ).rows[0];
    if (!row) throw new PublicationError('retryable');
    locked.set(id, row);
  }
  const chain: Resource[] = [];
  let current: string | null = targetId;
  while (current) {
    const row = locked.get(current);
    if (!row) throw new PublicationError(locked.size ? 'retryable' : 'unavailable');
    if (chain.some((owner) => owner.id === current)) throw new PublicationError('unavailable');
    chain.push(row);
    current = row.owner_resource_id;
  }
  if (chain.length !== locked.size) throw new PublicationError('retryable');
  for (let index = 0; index < chain.length; index++) {
    const row = chain[index]!;
    const owner = chain[index + 1];
    const ownerKind = row.kind === 'contribution' || row.kind === 'summary' ? 'discussion' : 'area';
    // Reply ancestry is not ownership. Traversal can disclose a contribution's
    // structural placeholder, never its body, while every owner remains active.
    const placeholder = mode === 'reply-traversal' && index === 0 && row.kind === 'contribution';
    if (
      (!placeholder && row.state !== 'active') ||
      (owner ? owner.kind !== ownerKind : row.kind !== 'area')
    )
      throw new PublicationError('unavailable');
  }
  if (!allowedKinds.includes(chain[0]!.kind)) throw new PublicationError('unavailable');
  return chain;
}

export async function authorizePublication(
  tx: SqlTransaction,
  actor: Awaited<ReturnType<typeof lockActor>>,
  chain: Resource[],
) {
  await authorizeEditor(tx, actor, chain);
  if (chain.some((resource) => !resource.publication_open)) throw new PublicationError('forbidden');
}

// Editing-intent controls distinguish ordinary closure from lost editor rights,
// while ordinary publication retains its established error and digest contract.
export async function authorizeEditor(
  tx: SqlTransaction,
  actor: Awaited<ReturnType<typeof lockActor>>,
  chain: Resource[],
) {
  const resource = chain[0]!;
  const editor =
    resource.kind === 'contribution'
      ? resource.original_author_id === actor.participantId
      : (
          await tx.query(
            'SELECT 1 FROM loom.resource_editors WHERE resource_id = $1 AND participant_id = $2',
            [resource.id, actor.participantId],
          )
        ).rowCount === 1;
  if (!actor.administrator && !editor)
    throw new PublicationError(resource.current_revision_id ? 'forbidden' : 'unavailable');
}

export async function requireRevision(tx: SqlTransaction, resourceId: string, revisionId: string) {
  const result = await tx.query(
    'SELECT id FROM loom.revisions WHERE resource_id = $1 AND id = $2 AND availability = $3 FOR SHARE',
    [resourceId, revisionId, 'available'],
  );
  if (!result.rowCount) throw new PublicationError('unavailable');
}
