import { createHash, randomUUID } from 'node:crypto';
import type { syntheticServer } from './participation-server.js';
export const administrationTarget = 'ffffffff-ffff-4fff-bfff-fffffffffff0';
export async function populateAdministration(server: Awaited<ReturnType<typeof syntheticServer>>) {
  const db = server.observer;
  const accountIds = Array.from({length: 130}, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12,'0')}`);
  accountIds.push(administrationTarget);
  await db.query(`INSERT INTO loom.participants(id,state,role,kind,nickname)
    SELECT id::uuid, CASE WHEN ordinality % 3 = 0 THEN 'revoked' WHEN ordinality % 3 = 1 THEN 'active' ELSE 'suspended' END,
      'participant',CASE WHEN ordinality % 2 = 0 THEN 'human' ELSE 'agent' END,'browse_'||ordinality
    FROM unnest($1::text[]) WITH ORDINALITY AS ids(id,ordinality)`,[accountIds]);
  await db.query("UPDATE loom.participants SET kind='agent',state='active',nickname='browse_target' WHERE id=$1",[administrationTarget]);
  await db.query("INSERT INTO loom.participants(id,state,role,kind,nickname) VALUES ($1,'active','participant','internal',NULL)",[randomUUID()]);
  const credentialIds = Array.from({length: 135}, (_, i) => `20000000-0000-4000-8000-${String(i + 1).padStart(12,'0')}`);
  await db.query(`INSERT INTO loom.participant_credentials(id,participant_id,state,kind,label,verifier,expires_at,created_at)
    SELECT id::uuid,$2,CASE WHEN ordinality % 2 = 0 THEN 'active' ELSE 'revoked' END,'agent',
      'History '||ordinality||' Ω " \\ '||chr(10),repeat('a',64),'2020-01-01Z','2019-01-01Z'
    FROM unnest($1::text[]) WITH ORDINALITY AS ids(id,ordinality)`,[credentialIds,administrationTarget]);
  const auditIds = Array.from({length: 137}, (_, i) => `30000000-0000-4000-8000-${String(i + 1).padStart(12,'0')}`);
  for (const id of auditIds) {
    await db.query(`INSERT INTO loom.identity_outcomes(id,attempt_scope,operation_kind,idempotency_key,semantic_version,request_digest,participant_id)
      VALUES($1,$2,'account.create',$3,'identity-prototype-v1',repeat('b',64),$2)`,[id,administrationTarget,randomUUID()]);
    await db.query(`INSERT INTO loom.administrative_audit(id,authority,target_id,action,operation_id,recorded_at)
      VALUES($1,'deployment_recovery',$2,'fixture.identity',$1,'2020-01-01T00:00:00.000123Z')`,[id,administrationTarget]);
  }
  return {accountIds,credentialIds,auditIds,target:administrationTarget};
}
export async function administrationSnapshot(server: Awaited<ReturnType<typeof syntheticServer>>) {
  const tables = (await server.observer.query("SELECT tablename FROM pg_tables WHERE schemaname='loom' ORDER BY tablename")).rows;
  const result: Record<string,string> = {};
  for (const {tablename} of tables) {
    const data = await server.observer.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text AS data FROM loom."${tablename}" t`);
    result[tablename] = createHash('sha256').update(data.rows[0].data).digest('hex');
  }
  return result;
}
