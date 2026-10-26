import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { syntheticServer } from './participation-server.js';
import type { httpClient } from './participation-http.js';

/** Bulk domain fixtures explicitly use permitted budgets; synthetic previews and
 * dedicated rate tests keep the migration defaults. Historical upgrades predate policy. */
export async function workloadRates(server: Awaited<ReturnType<typeof syntheticServer>>, admin: ReturnType<typeof httpClient>) {
  if (!(await server.observer.query("SELECT to_regclass('loom.participation_rate_policy') AS present")).rows[0].present) return;
  const current=await admin.call('/api/v1/admin/participation-rates');
  assert.equal(current.status,200,JSON.stringify(current.body));
  const changed=await admin.call('/api/v1/admin/participation-rates/state',{
    idempotency_key:randomUUID(),expected_version:current.body.version,
    ordinary_requests:6000,new_publications:600,recovery_control:1200,
  });
  assert.equal(changed.status,200,JSON.stringify(changed.body));
}
