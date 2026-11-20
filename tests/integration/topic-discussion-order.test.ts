import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import type { PageView, ResourceView } from '../../src/contracts/participation.js';
import type { SqlTransaction } from '../../src/server/db/postgres.js';
import { fixture, plain } from '../helpers/references.js';
import { barrier, bounded } from '../helpers/search-races.js';

const directory = (area: string, parameters: Record<string, string> = {}) =>
  `/api/v1/areas/${area}/discussions?${new URLSearchParams({ order: 'created_desc', ...parameters })}`;
type Client = Awaited<ReturnType<typeof fixture>>['admin'];
type Opening = { resource_id: string; revision_id: string; discussion_id: string };

async function publish(client: Client, area: string, title: string): Promise<Opening> {
  const posted = await client.call('/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: area,
    title,
    content: plain('Opening prose for ' + title),
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const metadata = await client.call(
    `/api/v1/references/target?kind=contribution&resource_id=${posted.body.resource_id}`,
  );
  assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
  assert.equal(metadata.body.state, 'available');
  assert.notEqual(metadata.body.representation.discussion_id, posted.body.resource_id);
  return {
    resource_id: posted.body.resource_id,
    revision_id: posted.body.revision_id,
    discussion_id: metadata.body.representation.discussion_id,
  };
}

async function page(client: Client, path: string) {
  const result = await client.call(path);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const value = result.body as PageView;
  assert.equal(value.omitted_detail, 'bodies');
  assert.equal(value.representation, 'metadata');
  const rows: ResourceView[] = value.items.map((item) => {
    assert.ok('discussion_id' in item);
    assert.ok(item.discussion_id);
    assert.equal(item.parent_id, null);
    assert.equal('content' in item, false);
    return item;
  });
  return { ...value, rows, bytes: result.bytes };
}

async function invalidCursor(client: Client, path: string) {
  const result = await client.call(path);
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'invalid_cursor');
  assert.equal(result.body.error.recovery.action, 'replay_view');
}

test(
  'existing and new discussion readers page in their selected order, including equal and submillisecond opening times',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, { throughMigration: 31 });
    const author = await f.participant('original_author', 'human');
    const reader = await f.participant('chronological_reader');
    const creations = [];
    for (let i = 0; i < 6; i++)
      creations.push(await publish(author.client, f.area, `Opening ${i}`));
    const byId = creations.sort((a, b) => (a.resource_id < b.resource_id ? -1 : 1));
    const times = ['001000', '123457', '123458', '123458', '123459', '012000'].map(
      (fraction) => `2025-10-15T20:00:00.${fraction}Z`,
    );
    for (const [index, opening] of byId.entries()) {
      // Set deterministic historical fixture times before backfilling the new index.
      await f.observer.query('UPDATE loom.contributions SET created_at=$2 WHERE id=$1', [
        opening.resource_id,
        times[index],
      ]);
    }
    await f.migrate();

    const old = byId[0]!;
    const revised = await f.admin.call('/api/v1/revisions', {
      idempotency_key: randomUUID(),
      resource_id: old.resource_id,
      expected_revision_id: old.revision_id,
      title: 'Edited oldest opening',
      content: plain('New current prose'),
    });
    assert.equal(revised.status, 201, JSON.stringify(revised.body));
    const reply = await reader.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: old.discussion_id,
      parent_id: old.resource_id,
      content: plain('Reply to the oldest opening'),
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));

    const legacyPath = `/api/v1/areas/${f.area}/discussions`;
    const legacyFirst = await page(reader.client, legacyPath + '?limit=1');
    assert.ok(legacyFirst.next_cursor);
    const legacyNext = await page(
      reader.client,
      legacyPath + '?limit=25&cursor=' + legacyFirst.next_cursor,
    );
    assert.equal(legacyNext.complete, true);
    assert.deepEqual(
      [...legacyFirst.rows, ...legacyNext.rows].map((row) => [
        row.resource_id,
        row.discussion_created_at,
      ]),
      byId.map((row) => [row.resource_id, undefined]),
    );

    const page1 = await page(reader.client, directory(f.area, { limit: '2' }));
    assert.equal(page1.complete, false);
    assert.ok(page1.next_cursor);
    const page2 = await page(
      reader.client,
      directory(f.area, { limit: '2', cursor: page1.next_cursor }),
    );
    assert.equal(page2.complete, false);
    assert.ok(page2.next_cursor);
    const page3 = await page(
      reader.client,
      directory(f.area, { limit: '2', cursor: page2.next_cursor }),
    );
    assert.equal(page3.complete, true);
    assert.equal(page3.next_cursor, null);
    const actual = [...page1.rows, ...page2.rows, ...page3.rows];
    assert.deepEqual(
      actual.map((row) => [row.resource_id, row.discussion_created_at]),
      [4, 3, 2, 1, 5, 0].map((i) => [byId[i]!.resource_id, times[i]]),
    );
    assert.deepEqual(actual.at(-1)?.author, {
      id: author.id,
      nickname: 'original_author',
      kind: 'human',
    });
    assert.equal(actual.at(-1)?.title, 'Edited oldest opening');
    assert.equal(actual.at(-1)?.revision_id, revised.body.revision_id);
    assert.equal(actual.at(-1)?.publisher.id, f.administratorId);
    assert.notEqual(actual.at(-1)?.created_at, actual.at(-1)?.discussion_created_at);
    assert.deepEqual((await f.observer.query('SELECT * FROM loom.reading_states')).rows, []);

    const cursor = page1.next_cursor;
    const input = { cursor, limit: '2' };
    await invalidCursor(reader.client, legacyPath + '?cursor=' + cursor);
    await invalidCursor(
      reader.client,
      directory(f.area, { ...input, cursor: legacyFirst.next_cursor }),
    );
    await invalidCursor(reader.client, directory(f.other, input));
    await invalidCursor(author.client, directory(f.area, input));
    await invalidCursor(reader.client, directory(f.area, { ...input, limit: '3' }));
    await invalidCursor(reader.client, directory(f.area, { ...input, max_response_bytes: '4096' }));
    const unknownOrder = await reader.client.call(directory(f.area, { order: 'created_asc' }));
    assert.equal(unknownOrder.status, 400);
    const unrelatedOrder = await reader.client.call(
      `/api/v1/areas/${f.area}/artifacts?order=created_desc`,
    );
    assert.equal(unrelatedOrder.status, 400);
    const definition = await reader.client.call('/api/v1/openapi.json');
    assert.ok(
      definition.body.paths['/api/v1/areas/{id}/discussions'].get.parameters.some(
        (p: { name: string }) => p.name === 'order',
      ),
    );
    assert.ok(
      !definition.body.paths['/api/v1/areas/{id}/artifacts'].get.parameters.some(
        (p: { name: string }) => p.name === 'order',
      ),
    );

    await f.move(old.discussion_id, f.other, 'discussion.move');
    await invalidCursor(reader.client, directory(f.area, input));
    assert.deepEqual(
      (await page(reader.client, directory(f.other))).rows.map((row) => [
        row.discussion_id,
        row.area_id,
        row.discussion_created_at,
      ]),
      [[old.discussion_id, f.other, times[0]]],
    );
    assert.equal(
      (await page(reader.client, directory(f.area))).rows.some(
        (row) => row.discussion_id === old.discussion_id,
      ),
      false,
    );

    const area = (await f.admin.call('/api/v1/organization/resources/' + f.other)).body;
    const closed = await f.admin.call('/api/v1/organization/changes', {
      kind: 'area.close',
      idempotency_key: randomUUID(),
      resource_id: f.other,
      expected_version: area.version,
      expected_hierarchy_version: area.hierarchy_version,
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal((await page(reader.client, directory(f.other))).rows[0]?.publication_open, false);
  },
);

test(
  'the captured committed position excludes newly committed openings before and after the page boundary',
  { timeout: 120000 },
  async (t) => {
    type Gate = {
      entered: ReturnType<typeof barrier<void>>;
      release: ReturnType<typeof barrier<void>>;
    };
    let captureGate: Gate | undefined;
    let openingTime: string | undefined;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        transaction: <T>(work: (tx: SqlTransaction) => Promise<T>) =>
          database.transaction((tx) =>
            work({
              query: async <Row extends QueryResultRow>(
                sql: string,
                values: readonly unknown[],
              ) => {
                if (openingTime && sql.startsWith('INSERT INTO loom.contributions(')) {
                  const time = openingTime;
                  openingTime = undefined;
                  return tx.query<Row>(
                    'INSERT INTO loom.contributions(id,discussion_id,parent_id,created_at) VALUES ($1,$2,$3,$4)',
                    [...values, time],
                  );
                }
                const result = await tx.query<Row>(sql, values);
                if (
                  captureGate &&
                  sql.includes('SELECT s.instance_id,c.shared_position::text AS position')
                ) {
                  const selected = captureGate;
                  captureGate = undefined;
                  selected.entered.release();
                  await bounded(selected.release.promise);
                }
                return result;
              },
            }),
          ),
      }),
    });
    const reader = await f.participant('bound_reader');
    const writer = await f.participant('bound_writer');
    const before = [];
    for (const day of [1, 3, 5]) {
      openingTime = `2025-10-0${day}T00:00:00.123456Z`;
      before.push(await publish(writer.client, f.area, `Existing ${day}`));
    }
    const held = (captureGate = { entered: barrier(), release: barrier() });
    const firstResult = page(reader.client, directory(f.area, { limit: '1' }));
    await bounded(held.entered.promise);
    let newTop: Opening, lateOlder: Opening;
    try {
      openingTime = '2025-10-06T00:00:00.123456Z';
      newTop = await publish(writer.client, f.area, 'Newly committed newest time');
      openingTime = '2025-10-04T00:00:00.123456Z';
      lateOlder = await publish(writer.client, f.area, 'Newly committed older time');
    } finally {
      held.release.release();
    }
    const first = await firstResult;
    assert.deepEqual(
      first.rows.map((row) => row.resource_id),
      [before[2]!.resource_id],
    );
    assert.ok(first.next_cursor);
    const middle = await page(
      reader.client,
      directory(f.area, { limit: '1', cursor: first.next_cursor }),
    );
    assert.deepEqual(
      middle.rows.map((row) => row.resource_id),
      [before[1]!.resource_id],
    );
    assert.ok(middle.next_cursor);
    const last = await page(
      reader.client,
      directory(f.area, { limit: '1', cursor: middle.next_cursor }),
    );
    assert.deepEqual(
      last.rows.map((row) => row.resource_id),
      [before[0]!.resource_id],
    );
    assert.equal(last.complete, true);
    assert.equal(last.next_cursor, null);
    const fresh = await page(reader.client, directory(f.area));
    assert.deepEqual(
      fresh.rows.map((row) => row.resource_id),
      [newTop!, before[2]!, lateOlder!, before[1]!, before[0]!].map((row) => row.resource_id),
    );

    await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
      before[1]!.discussion_id,
    ]);
    const afterWithdrawal = await page(
      reader.client,
      directory(f.area, { limit: '1', cursor: first.next_cursor }),
    );
    assert.deepEqual(
      afterWithdrawal.rows.map((row) => row.resource_id),
      [before[0]!.resource_id],
    );
    assert.equal(afterWithdrawal.complete, true);
    await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [f.area]);
    assert.equal(
      (await reader.client.call(directory(f.area, { limit: '1', cursor: first.next_cursor })))
        .status,
      404,
    );
  },
);

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  Plans?: PlanNode[];
};

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

test(
  'a skewed 10,000-opening fixture uses bounded topic index scans and can continue an empty work-limited page within its byte budget',
  { timeout: 120000 },
  async (t) => {
    const orderedQueries: { sql: string; values: readonly unknown[] }[] = [];
    const f = await fixture(t, {
      throughMigration: 31,
      transactionWrapper: (database) => ({
        transaction: <T>(work: (tx: SqlTransaction) => Promise<T>) =>
          database.transaction((tx) =>
            work({
              query: <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => {
                if (sql.includes('FROM loom.topic_discussion_openings c WHERE'))
                  orderedQueries.push({ sql, values });
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    // Synthetic workload construction skips the HTTPS writes and derived outbox.
    // All opening, revision/first-event and topic relations use the live constraints.
    const bulkSize = 10000,
      topicSize = 4000,
      hiddenCount = 104,
      editCount = 300;
    const authoredTitle = '文\\"'.repeat(50);
    const seedRows = Array.from({ length: bulkSize }, (_, i) => ({
      n: i + 1,
      discussion: randomUUID(),
      opening: randomUUID(),
      revision: randomUUID(),
      area: i < topicSize ? f.area : f.other,
      hidden: i >= topicSize - hiddenCount && i < topicSize,
    }));
    const heavilyEdited = seedRows[topicSize - hiddenCount - 1]!;
    const seed = JSON.stringify(seedRows);
    const openings =
      'jsonb_to_recordset($1::jsonb) AS f(n integer,discussion uuid,opening uuid,revision uuid,area uuid,hidden boolean)';
    await f.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id,state)
       SELECT discussion,'discussion',area,$2,CASE WHEN hidden THEN 'suppressed' ELSE 'active' END
       FROM ${openings}`,
        [seed, f.administratorId],
      );
      await tx.query(
        `INSERT INTO loom.resources(id,kind,owner_resource_id,original_author_id)
       SELECT opening,'contribution',discussion,$2 FROM ${openings}`,
        [seed, f.administratorId],
      );
      await tx.query(`INSERT INTO loom.discussions SELECT discussion,opening FROM ${openings}`, [
        seed,
      ]);
      await tx.query(
        `INSERT INTO loom.contributions(id,discussion_id,created_at)
       SELECT opening,discussion,'2025-01-01T00:00:00Z'::timestamptz+n*interval '1 microsecond'
       FROM ${openings}`,
        [seed],
      );
      await tx.query(
        `INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text,title)
       SELECT revision,opening,1,$2,'loom-markdown-v1','Synthetic content',$3 FROM ${openings}`,
        [seed, f.administratorId, authoredTitle],
      );
      await tx.query(
        `UPDATE loom.resources r SET current_revision_id=f.revision FROM ${openings} WHERE r.id=f.opening`,
        [seed],
      );
      const allocated = (
        await tx.query<{ base: string }>(
          'UPDATE loom.community_clocks SET shared_position=shared_position+$1::bigint WHERE id=1 RETURNING (shared_position-$1)::text AS base',
          [bulkSize + editCount],
        )
      ).rows[0]!;
      await tx.query(
        `INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids)
       SELECT gen_random_uuid(),$2::bigint+n,'revision.published',opening,revision,$3,ARRAY[area]
       FROM ${openings}`,
        [seed, allocated.base, f.administratorId],
      );
      await tx.query(
        `WITH history AS (
           INSERT INTO loom.revisions(id,resource_id,revision_number,publisher_id,content_format,content_text,title)
           SELECT gen_random_uuid(),$1,n,$2,'loom-markdown-v1','Synthetic edited content',$3
           FROM generate_series(2,$4::integer) n RETURNING id,revision_number
         )
         INSERT INTO loom.shared_activity(id,position,kind,resource_id,revision_id,publisher_id,area_scope_ids)
         SELECT gen_random_uuid(),$5::bigint+revision_number-1,'revision.published',$1,id,$2,ARRAY[$6::uuid]
         FROM history`,
        [
          heavilyEdited.opening,
          f.administratorId,
          authoredTitle,
          editCount + 1,
          String(BigInt(allocated.base) + BigInt(bulkSize)),
          f.area,
        ],
      );
      await tx.query(
        `UPDATE loom.resources SET current_revision_id=(
          SELECT id FROM loom.revisions WHERE resource_id=$1 AND revision_number=$2
        ) WHERE id=$1`,
        [heavilyEdited.opening, editCount + 1],
      );
    });

    await f.observer.query(
      'ANALYZE loom.resources,loom.discussions,loom.contributions,loom.revisions,loom.shared_activity',
    );
    const explain = async (sql: string, values: readonly unknown[]) =>
      (
        await f.observer.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
          'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql,
          [...values],
        )
      ).rows[0]!['QUERY PLAN'][0].Plan;

    const normalized = planNodes(
      await explain(
        `SELECT c.id FROM loom.contributions c JOIN loom.discussions d ON d.opening_id=c.id
     JOIN loom.resources r ON r.id=d.id WHERE r.owner_resource_id=$1 AND c.parent_id IS NULL
     ORDER BY c.created_at DESC,c.id DESC LIMIT 101`,
        [f.area],
      ),
    );
    const examined = (node: PlanNode) => node['Actual Rows'] * node['Actual Loops'];
    const normalizedMaximum = Math.max(...normalized.map(examined));
    assert.ok(normalizedMaximum >= topicSize, JSON.stringify(normalized));

    await f.migrate();
    await f.observer.query('ANALYZE loom.topic_discussion_openings');
    const controls = { limit: '25', max_response_bytes: '4096' };
    const hidden = await page(f.admin, directory(f.area, controls));
    assert.deepEqual(hidden.rows, []);
    assert.equal(hidden.complete, false);
    assert.equal(hidden.work_budget_reached, true);
    assert.ok(hidden.next_cursor);
    assert.ok(hidden.bytes <= 4096);
    const visible = await page(
      f.admin,
      directory(f.area, { ...controls, cursor: hidden.next_cursor }),
    );
    assert.equal(visible.complete, false);
    assert.equal(visible.work_budget_reached, false);
    assert.ok(visible.next_cursor);
    assert.ok(visible.rows.length > 1 && visible.rows.length < 25);
    assert.ok(visible.bytes <= 4096);
    assert.equal(visible.rows[0]?.resource_id, heavilyEdited.opening);
    assert.equal(visible.rows[0]?.revision_number, String(editCount + 1));
    const next = await page(
      f.admin,
      directory(f.area, { ...controls, cursor: visible.next_cursor }),
    );
    const expected = (
      await f.observer.query<{ id: string }>(
        `SELECT c.id FROM loom.contributions c JOIN loom.discussions d ON d.opening_id=c.id
     JOIN loom.resources r ON r.id=d.id WHERE r.owner_resource_id=$1 AND r.state='active'
     ORDER BY c.created_at DESC,c.id DESC LIMIT $2`,
        [f.area, visible.rows.length + next.rows.length],
      )
    ).rows;
    assert.deepEqual(
      [...visible.rows, ...next.rows].map((r) => r.resource_id),
      expected.map((r) => r.id),
    );

    for (const [index, statement] of orderedQueries.entries()) {
      const nodes = planNodes(await explain(statement.sql, statement.values));
      const scan = nodes.find(
        (node) => node['Index Name'] === 'topic_discussion_openings_by_creation',
      );
      assert.ok(scan, JSON.stringify(nodes));
      assert.equal(examined(scan), 101);
      assert.match(scan['Index Cond']!, /area_id/);
      if (index > 0) assert.match(scan['Index Cond']!, /ROW\(opening_created_at, opening_id\)/);
      assert.ok(
        nodes.every((node) => examined(node) <= 101),
        JSON.stringify(nodes),
      );
      assert.ok(nodes.every((node) => node['Relation Name'] !== 'revisions'));
      assert.ok(
        nodes.some(
          (node) =>
            node['Relation Name'] === 'shared_activity' &&
            /resource_id.*revision_id/.test(node['Index Cond'] ?? ''),
        ),
        JSON.stringify(nodes),
      );
      assert.ok(nodes.every((node) => node['Node Type'] !== 'Sort'));
    }
    assert.equal(orderedQueries.length, 3);
    t.diagnostic(
      `Normalized join max rows at one node: ${normalizedMaximum}. Indexed first page and both keyset pages: 101 candidates each, with an exact event probe per candidate, no revision-history scan and no sort. One opening has ${editCount} subsequent revisions.`,
    );
  },
);
