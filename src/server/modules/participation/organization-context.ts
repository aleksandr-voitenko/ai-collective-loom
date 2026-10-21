import type { SqlTransaction } from '../../db/postgres.js';
export class OrganizationError extends Error {
  constructor(
    readonly code:
      | 'organization_conflict'
      | 'organization_limit'
      | 'organization_cycle'
      | 'proposal_route_changed',
  ) {
    super(
      {
        organization_conflict:
          'Organization changed. Refresh and review your retained input before a new command.',
        organization_limit: 'This operation exceeds the synthetic organization limit.',
        organization_cycle: 'An area cannot be placed inside itself or its descendants.',
        proposal_route_changed:
          'The configured proposal destination changed. Keep your draft and contact an administrator.',
      }[code],
    );
  }
}
export async function structureGuard(tx: SqlTransaction, exclusive = false) {
  await tx.query(
    exclusive
      ? 'SELECT pg_advisory_xact_lock($1::integer,$2::integer)'
      : 'SELECT pg_advisory_xact_lock_shared($1::integer,$2::integer)',
    [0x4c4f4f4d, 1],
  );
}
export async function hierarchyVersion(tx: SqlTransaction) {
  return (
    await tx.query<{ version: number }>(
      'SELECT version FROM loom.organization_state WHERE id=1',
      [],
    )
  ).rows[0]!.version;
}
export async function advanceHierarchy(tx: SqlTransaction) {
  return (
    await tx.query<{ version: number }>(
      'UPDATE loom.organization_state SET version=version+1 WHERE id=1 RETURNING version',
      [],
    )
  ).rows[0]!.version;
}
