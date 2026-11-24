import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { QueryResultRow } from 'pg';
import * as C from '../../src/contracts/organization.js';
import type { SqlTransaction } from '../../src/server/db/postgres.js';
import { fixture } from '../helpers/organization.js';
import { barrier, bounded } from '../helpers/search-races.js';

type Client = Awaited<ReturnType<typeof fixture>>['admin'];
const children = '/api/v1/organization/children';
const scope = (id?: string) => (id ? '?parent_id=' + id : '');
async function observe(client: Client, id?: string) {
  const r = await client.call(children + '/observation' + scope(id));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Value.Check(C.DirectoryObservation, r.body));
  assert.equal(r.body.parent_id, id ?? null);
  assert.ok(r.bytes <= C.directoryObservationBytes);
  return r.body;
}
async function page(client: Client, id?: string) {
  const r = await client.call(children + '?observe=1&limit=1' + (id ? '&parent_id=' + id : ''));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Value.Check(C.OrganizationPage, r.body));
  assert.ok(r.body.observation);
  assert.equal(r.body.hierarchy_version, r.body.observation.hierarchy_version);
  return r.body;
}

test(
  'populated 0034 upgrade preserves traversal and distinguishes direct, inherited and unrelated organization changes',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, { throughMigration: 33 });
    const reader = await f.participant('directory_reader');
    const firstId = '00000000-0000-0000-0000-000000000001';
    // Give the seed the smallest possible resource ID. A real organization
    // creation will land beyond the unmodified first page regardless of its UUID.
    await f.database.transaction(async (tx) => {
      await tx.query("INSERT INTO loom.resources(id,kind) VALUES ($1,'area')", [firstId]);
      await tx.query("INSERT INTO loom.areas(id,title,description) VALUES ($1,'First','')", [
        firstId,
      ]);
    });
    const nested = await f.newArea('Nested directory', f.area);
    const leaf = await f.newArea('Locally open leaf', nested);
    const before = await reader.client.call(children + '?limit=1');
    assert.equal(before.body.items[0].resource_id, firstId);
    const originalVersion = before.body.hierarchy_version;
    await f.migrate();
    await f.migrate();
    const legacy = (await reader.client.call(children + '?limit=1')).body;
    assert.deepEqual(legacy.items, before.body.items);
    assert.equal(legacy.hierarchy_version, originalVersion);
    assert.ok(!('observation' in legacy));
    assert.equal(
      (await reader.client.call(children + '?limit=1&cursor=' + before.body.next_cursor)).status,
      200,
    );
    assert.ok(
      !('observation' in (await reader.client.call('/api/v1/organization/destinations')).body),
    );
    const root = await page(reader.client);
    assert.deepEqual(await observe(reader.client), root.observation);
    assert.equal(root.complete, false);
    assert.equal(root.observation!.directory_version, 0);

    const empty = await page(reader.client, leaf);
    assert.deepEqual(empty.items, []);
    assert.ok(empty.complete);
    assert.deepEqual(empty.observation, await observe(reader.client, leaf));
    const complete = await page(reader.client, nested);
    assert.equal(complete.complete, true);
    assert.deepEqual(
      complete.items.map((row) => row.resource_id),
      [leaf],
    );

    const later = await f.newArea('Created beyond the first page');
    const after = await observe(reader.client);
    assert.equal(after.directory_version, root.observation!.directory_version + 1);
    assert.deepEqual(
      (await page(reader.client)).items.map((row) => row.resource_id),
      [firstId],
    );
    assert.equal(
      (await reader.client.call(children + '?cursor=' + root.next_cursor)).body.error.code,
      'invalid_cursor',
    );
    const sibling = await observe(reader.client, nested);
    assert.equal(sibling.directory_version, complete.observation!.directory_version);
    assert.ok(sibling.hierarchy_version > complete.hierarchy_version);
    await f.organize(
      await f.organizationCommand(later, 'area.edit', {
        title: 'Edited root topic',
        description: 'Changed scope',
      }),
    );
    const edit = await observe(reader.client);
    assert.equal(edit.directory_version, after.directory_version + 1);
    await f.organize(
      await f.organizationCommand(later, 'area.edit', {
        title: 'Edited root topic',
        description: 'Changed scope',
      }),
    );
    assert.equal(
      (await observe(reader.client)).directory_version,
      edit.directory_version,
      'same metadata only invalidates the global cursor',
    );
    await f.move(later, nested, 'area.move');
    assert.equal((await observe(reader.client)).directory_version, edit.directory_version + 1);
    assert.equal(
      (await observe(reader.client, nested)).directory_version,
      sibling.directory_version + 1,
    );
    assert.equal((await page(reader.client, nested)).complete, false);
    await f.move(later, f.other, 'area.move');
    const single = await observe(reader.client, nested);
    assert.equal(single.directory_version, sibling.directory_version + 2);
    await f.organize(await f.organizationCommand(f.area, 'area.close'));
    const closed = await observe(reader.client, nested);
    assert.equal(closed.directory_version, single.directory_version + 1);
    assert.equal(closed.inherited_closure, true);
    assert.equal((await page(reader.client, nested)).items[0]!.publication_open, false);
    assert.equal((await observe(reader.client, leaf)).inherited_closure, false, 'empty directory');
    await f.organize(await f.organizationCommand(f.area, 'area.open'));
    assert.equal((await observe(reader.client, nested)).inherited_closure, false);
    await f.organize(await f.organizationCommand(leaf, 'area.close'));
    await f.organize(await f.organizationCommand(f.area, 'area.close'));
    assert.equal(
      (await observe(reader.client, nested)).inherited_closure,
      false,
      'all children already locally closed',
    );

    const path = children + '/observation?parent_id=' + nested;
    await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [f.area]);
    assert.equal((await reader.client.call(path)).body.error.code, 'unavailable');
    await f.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1", [f.area]);
    assert.equal((await reader.client.call(path)).status, 200);
    await f.observer.query("UPDATE loom.participants SET state='suspended' WHERE id=$1", [
      reader.id,
    ]);
    assert.equal((await reader.client.call(path)).status, 401);
    assert.equal((await reader.client.call(children + '/observation')).status, 401);
  },
);

test('inherited closure round trips persist only in directories whose children changed', async (t) => {
  const f = await fixture(t);
  const branch = await f.newArea('Moving branch', f.area);
  const scopeId = await f.newArea('Observed directory', branch);
  const leaf = await f.newArea('Direct child', scopeId);
  const masked = await f.newArea('Locally closed branch', branch);
  const maskedDirectory = await f.newArea('Already restricted directory', masked);
  await f.newArea('Already restricted child', maskedDirectory);
  await f.organize(await f.organizationCommand(masked, 'area.close'));
  await f.organize(await f.organizationCommand(f.other, 'area.close'));
  const baseline = (await page(f.admin, scopeId)).observation!;
  const closedBranch = await observe(f.admin, maskedDirectory);
  const empty = await observe(f.admin, leaf);

  await f.organize(await f.organizationCommand(f.area, 'area.close'));
  await f.organize(await f.organizationCommand(f.area, 'area.open'));
  const reopened = await observe(f.admin, scopeId);
  assert.equal(reopened.inherited_closure, baseline.inherited_closure);
  assert.equal(reopened.directory_version, baseline.directory_version + 2);
  await f.move(branch, f.other, 'area.move');
  await f.move(branch, f.area, 'area.move');
  const returned = await observe(f.admin, scopeId);
  assert.equal(returned.inherited_closure, reopened.inherited_closure);
  assert.equal(returned.directory_version, reopened.directory_version + 2);
  assert.equal(
    (await observe(f.admin, maskedDirectory)).directory_version,
    closedBranch.directory_version,
  );
  assert.equal((await observe(f.admin, leaf)).directory_version, empty.directory_version);
});

test(
  'initial and replacement pages carry a boundary preceding writes committed while their response is in flight',
  { timeout: 120000 },
  async (t) => {
    let hold:
      | { entered: ReturnType<typeof barrier<void>>; release: ReturnType<typeof barrier<void>> }
      | undefined;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        async transaction(work) {
          const result = await database.transaction(work);
          if (hold && typeof result === 'object' && result && 'observation' in result) {
            const gate = hold;
            hold = undefined;
            gate.entered.release();
            await bounded(gate.release.promise);
          }
          return result;
        },
      }),
    });
    const reader = await f.participant('directory_race');
    for (const title of ['After initial read', 'After replacement read']) {
      const gate = (hold = { entered: barrier(), release: barrier() });
      const listing = page(reader.client, f.area);
      await bounded(gate.entered.promise);
      let added: string;
      try {
        added = await f.newArea(title, f.area);
      } finally {
        gate.release.release();
      }
      const result = await listing;
      assert.ok(result.items.every((row) => row.resource_id !== added));
      assert.equal(
        (await observe(reader.client, f.area)).directory_version,
        result.observation!.directory_version + 1,
      );
    }
  },
);

type Plan = {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  Plans?: Plan[];
};
const visit = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(visit)];

test(
  'one index seek per directory observation with bounded ancestry and only ordinary read admission',
  { timeout: 120000 },
  async (t) => {
    const reads = new Map<string, readonly unknown[]>();
    let capture = false;
    const f = await fixture(t, {
      rateLimits: 'defaults',
      transactionWrapper: (database) => ({
        transaction: <T>(work: (tx: SqlTransaction) => Promise<T>) =>
          database.transaction((tx) =>
            work({
              query<Row extends QueryResultRow>(sql: string, values: readonly unknown[]) {
                if (capture) reads.set(sql, values);
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    const reader = await f.participant('directory_bounds');
    let child = f.area;
    for (let depth = 2; depth <= C.organizationLimits.areaDepth; depth++) {
      child = await f.newArea('Directory at depth ' + depth, child);
    }
    const discussion = await f.discussion();
    await f.move(discussion.id, child, 'discussion.move');
    for (const suffix of ['', '/observation']) {
      const invalid = await reader.client.call(children + suffix + scope(discussion.id));
      assert.equal(invalid.body.error.code, 'unavailable', 'a discussion cannot be a directory');
    }
    const ids = Array.from({ length: 480 }, () => randomUUID());
    await f.database.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO loom.resources(id,kind,owner_resource_id) SELECT id,'area',$2 FROM unnest($1::uuid[]) AS ids(id)",
        [ids, f.other],
      );
      await tx.query(
        "INSERT INTO loom.areas(id,title,description) SELECT id,'Synthetic topic','' FROM unnest($1::uuid[]) AS ids(id)",
        [ids],
      );
    });
    for (const table of ['resources', 'areas', 'topic_directory_state'])
      await f.observer.query('ANALYZE loom.' + table);
    const state = async () =>
      (
        await f.observer.query(`SELECT
    (SELECT shared_position FROM loom.community_clocks WHERE id=1) AS shared,
    (SELECT count(*) FROM loom.outbox_intents) AS intents,
    (SELECT count(*) FROM loom.reading_operations) AS reading,
    (SELECT count(*) FROM loom.saved_operations) AS saved,
    (SELECT count(*) FROM loom.following_operations) AS following,
    (SELECT count(*) FROM loom.personal_deliveries) AS notifications,
    (SELECT count(*) FROM loom.updates_views) AS updates,
    (SELECT count(*) FROM loom.organization_operations) AS organization,
    (SELECT count(*) FROM loom.idempotency_records) AS publications`)
      ).rows;
    const rate = async () =>
      Number(
        (
          await f.observer.query(
            "SELECT used FROM loom.participation_rate_windows WHERE participant_id=$1 AND category='ordinary_requests'",
            [reader.id],
          )
        ).rows[0]?.used ?? 0,
      );
    const before = await state(),
      used = await rate();
    capture = true;
    const scopeState = await observe(reader.client, child);
    capture = false;
    assert.equal(scopeState.directory_version, 0);
    assert.equal(
      (await observe(reader.client)).directory_version,
      2,
      'community setup inserts both root topics',
    );
    assert.deepEqual(await state(), before);
    assert.equal(await rate(), used + 2);
    const plans: Plan[] = [];
    for (const [sql, values] of reads) {
      if (
        !sql.includes('FROM loom.topic_directory_state') &&
        !sql.includes('WITH RECURSIVE owners') &&
        sql !== 'SELECT id FROM loom.areas WHERE id=$1' &&
        !sql.startsWith('SELECT topic.id FROM unnest')
      )
        continue;
      const plan = (await f.observer.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + sql, [...values]))
        .rows[0]['QUERY PLAN'][0].Plan as Plan;
      plans.push(...visit(plan));
    }
    for (const table of ['topic_directory_state', 'resources', 'areas']) {
      const scans = plans.filter((p) => p['Relation Name'] === table);
      assert.ok(scans.length, table + ' lookup must be inspected');
      assert.ok(
        scans.every(
          (p) =>
            p['Node Type'].includes('Index') &&
            p['Actual Rows'] <= 1 &&
            p['Actual Loops'] <= C.organizationLimits.areaDepth,
        ),
        JSON.stringify(scans),
      );
    }
    assert.ok(
      [...reads.keys()].every(
        (sql) =>
          !sql.includes('loom.shared_activity') &&
          !sql.includes('organization_operations') &&
          !sql.includes('ORDER BY a.id'),
      ),
    );
  },
);
