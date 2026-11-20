import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import type { QueryResultRow } from 'pg';
import * as C from '../../src/contracts/topic-discussion-freshness.js';
import { Page, type ResourceView } from '../../src/contracts/participation.js';
import type { SqlTransaction } from '../../src/server/db/postgres.js';
import { fixture } from '../helpers/moderation.js';
import { authored, plain } from '../helpers/references.js';
import { barrier, bounded } from '../helpers/search-races.js';

type Client = Awaited<ReturnType<typeof fixture>>['admin'];
type Pair = { resource_id: string; revision_id: string };
const path = (topic: string) => `/api/v1/areas/${topic}/discussions/freshness`;
const listing = (topic: string) =>
  `/api/v1/areas/${topic}/discussions?order=created_desc&observe=1`;
const pair = ({ resource_id, revision_id }: Pair) => ({ resource_id, revision_id });

async function observation(client: Client, topic: string, cursor?: string) {
  const result = await client.call(
    path(topic),
    cursor ? { action: 'check', cursor } : { action: 'baseline' },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(Value.Check(C.TopicFreshness, result.body));
  assert.ok(result.bytes <= C.topicFreshnessLimits.responseBytes);
  assert.equal(result.body.withdrawn_tags.length, result.body.visibility_scanned);
  return result.body;
}

async function publish(client: Client, area: string, title: string) {
  const result = await client.call('/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: area,
    title,
    content: plain('Opening ' + title),
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return pair(result.body);
}

async function rows(client: Client, url: string) {
  const list = await client.call(url);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(Value.Check(Page, list.body));
  const page = list.body;
  assert.equal(page.omitted_detail, 'bodies');
  return page.items.map((item) => {
    assert.ok('discussion_id' in item && item.discussion_id);
    assert.ok(item.discussion_observation_tags);
    return item;
  }) as (ResourceView & { discussion_id: string; discussion_observation_tags: [string, string] })[];
}

test(
  'topic observation detects late-committing openings without changing an accepted traversal',
  { timeout: 120000 },
  async (t) => {
    let gate:
      | { entered: ReturnType<typeof barrier<void>>; release: ReturnType<typeof barrier<void>> }
      | undefined;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        transaction: <T>(work: (tx: SqlTransaction) => Promise<T>) =>
          database.transaction((tx) =>
            work({
              async query<Row extends QueryResultRow>(sql: string, values: readonly unknown[]) {
                const held = sql.startsWith('UPDATE loom.community_clocks') ? gate : undefined;
                if (held) {
                  gate = undefined;
                  held.entered.release();
                  await bounded(held.release.promise);
                }
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    const reader = await f.participant('topic_fresh_reader');
    const author = await f.participant('topic_fresh_author');
    const existing = await publish(f.admin, f.area, 'Existing discussion');
    const baseline = await observation(reader.client, f.area);
    const held = (gate = { entered: barrier(), release: barrier() });
    const slow = publish(author.client, f.area, 'Created earlier');
    await bounded(held.entered.promise);
    let observed;
    let page;
    let fast;
    try {
      fast = await publish(reader.client, f.area, 'Committed before listing');
      page = await reader.client.call(listing(f.area) + '&limit=1');
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.items[0].resource_id, fast.resource_id);
      observed = await observation(reader.client, f.area, baseline.cursor);
      assert.equal(observed.change, 'new_discussions', 'a same-participant opening still counts');
      assert.equal(observed.scanned, 1);
    } finally {
      held.release.release();
    }
    const late = await slow;
    const check = await observation(reader.client, f.area, observed.cursor);
    assert.equal(check.scanned, 1);
    assert.equal(check.change, 'new_discussions');
    const continued = await rows(
      reader.client,
      listing(f.area) + '&limit=1&cursor=' + page.body.next_cursor,
    );
    assert.deepEqual(
      continued.map(pair),
      [existing],
      'the late opening cannot join the old traversal',
    );
    assert.deepEqual((await rows(reader.client, listing(f.area))).slice(0, 2).map(pair), [
      fast,
      late,
    ]);
  },
);

test(
  'direct-topic change notices, exact withdrawal and whole-discussion restoration use current authority',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const reader = await f.participant('topic_transition_reader');
    const sibling = await f.discussion();
    const d = await f.discussion();
    const before = await rows(reader.client, listing(f.area));
    const tag = before.find((row) => row.discussion_id === d.id)!.discussion_observation_tags;
    const siblingTag = before.find(
      (row) => row.discussion_id === sibling.id,
    )!.discussion_observation_tags;
    const differentOwnerTags = (await rows(f.admin, listing(f.area))).find(
      (row) => row.discussion_id === d.id,
    )!.discussion_observation_tags;
    assert.notDeepEqual(differentOwnerTags, tag);
    const unobserved = await reader.client.call(
      `/api/v1/areas/${f.area}/discussions?order=created_desc`,
    );
    assert.ok(unobserved.body.items.every((row: ResourceView) => !row.discussion_observation_tags));

    const a = await observation(reader.client, f.area);
    const b = await observation(reader.client, f.other);
    await f.reply(d, 'Reply only');
    const reply = await observation(reader.client, f.area, a.cursor);
    assert.equal(reply.change, 'none');
    assert.equal(reply.scanned, 0);
    const descendant = await f.newArea('Descendant', f.area);
    await publish(f.admin, descendant, 'Nested topic only');
    const descendantCheck = await observation(reader.client, f.area, reply.cursor);
    assert.equal(descendantCheck.change, 'none');
    assert.equal(descendantCheck.scanned, 0);
    const title = await f.admin.call('/api/v1/revisions', {
      idempotency_key: randomUUID(),
      resource_id: d.opening.resource_id,
      expected_revision_id: d.opening.revision_id,
      title: 'Revised opening',
      content: authored('Edited prose'),
    });
    assert.equal(title.status, 201, JSON.stringify(title.body));
    const edited = await observation(reader.client, f.area, descendantCheck.cursor);
    assert.equal(edited.change, 'updated');
    await f.move(d.id, f.other, 'discussion.move');
    const departed = await observation(reader.client, f.area, edited.cursor);
    const arrived = await observation(reader.client, f.other, b.cursor);
    assert.equal(departed.change, 'updated');
    assert.deepEqual(departed.withdrawn_tags, []);
    assert.equal(arrived.change, 'updated');
    assert.equal((await rows(reader.client, listing(f.other)))[0]!.discussion_id, d.id);

    await f.suppress(d.id);
    const departedAndSuppressed = await observation(reader.client, f.area, edited.cursor);
    assert.equal(
      departedAndSuppressed.change,
      'updated',
      'the origin still observes its direct departure when the destination source is unavailable',
    );
    assert.deepEqual(departedAndSuppressed.withdrawn_tags, [tag[0]]);
    const loss = await observation(reader.client, f.area, departed.cursor);
    assert.equal(
      loss.change,
      'none',
      'the previously moved row is not in the current direct collection',
    );
    assert.deepEqual(
      loss.withdrawn_tags,
      [tag[0]],
      'a previously accepted row is still fenced after moving',
    );
    assert.ok(siblingTag.every((selector) => !loss.withdrawn_tags.includes(selector)));
    const unavailable = await observation(reader.client, f.other, arrived.cursor);
    assert.equal(unavailable.change, 'updated');
    assert.deepEqual(await rows(reader.client, listing(f.other)), []);

    await f.suppress(d.id, false);
    const restored = await observation(reader.client, f.other, unavailable.cursor);
    assert.equal(restored.change, 'updated');
    assert.equal(restored.scanned, 0, 'restoration is not a publication');
    assert.equal(restored.visibility_scanned, 1);
    assert.equal((await rows(reader.client, listing(f.other)))[0]!.discussion_id, d.id);

    await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1", [
      d.opening.revision_id,
    ]);
    const historicalLoss = await observation(reader.client, f.area, loss.cursor);
    assert.ok(historicalLoss.withdrawn_tags.includes(tag[1]));
    assert.ok(!historicalLoss.withdrawn_tags.includes(tag[0]));
    const audit = await reader.client.call(path(f.area), {
      action: 'audit',
      displayed: [pair(sibling.opening), pair(d.opening), pair(title.body)],
    });
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    assert.ok(Value.Check(C.TopicFreshnessAudit, audit.body));
    assert.deepEqual(audit.body.unavailable, [1]);
    assert.deepEqual(audit.body.tags[0], siblingTag);
    assert.equal(audit.body.tags[1], null);
    assert.equal(audit.body.tags[2]?.[0], tag[0]);
  },
);

test(
  'incomplete topic continuation survives bounded scans, failed cursor scope and recovery',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const reader = await f.participant('topic_bound_reader');
    const foreign = await f.participant('topic_bound_foreign');
    const local = await f.discussion();
    const before = await observation(reader.client, f.area);
    const oldTag = (await rows(reader.client, listing(f.area)))[0]!.discussion_observation_tags;
    const check = { action: 'check', cursor: before.cursor };
    for (const [client, topic, input] of [
      [foreign.client, f.area, check],
      [reader.client, f.other, check],
      [reader.client, f.area, { ...check, cursor: check.cursor + 'a' }],
    ] as const) {
      const result = await client.call(path(topic), input);
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'invalid_cursor');
    }
    assert.equal(
      (
        await reader.client.call(path(f.area), {
          action: 'audit',
          displayed: Array(33).fill(pair(local.opening)),
        })
      ).status,
      400,
    );

    // Dense unrelated positions must never displace topic candidates in the cap.
    for (let i = 0; i <= C.topicFreshnessLimits.events; i++) {
      await publish(f.admin, f.other, 'Other topic ' + i);
      await publish(f.admin, f.area, 'This topic ' + i);
    }
    await f.suppress(local.id);
    const first = await observation(reader.client, f.area, before.cursor);
    assert.equal(first.complete, false);
    assert.equal(first.scanned, C.topicFreshnessLimits.events);
    assert.equal(first.change, 'new_discussions');
    assert.ok(
      first.withdrawn_tags.includes(oldTag[0]),
      'authority scan advances independently of activity',
    );
    const second = await observation(reader.client, f.area, first.cursor);
    assert.equal(second.complete, true);
    assert.equal(second.scanned, 1);
    assert.equal(second.change, 'new_discussions');
    assert.equal((await observation(reader.client, f.area, second.cursor)).change, 'none');

    await f.observer.query('UPDATE loom.shared_retrieval_state SET recovery_epoch=$1', [
      randomUUID(),
    ]);
    const invalid = await reader.client.call(path(f.area), {
      action: 'check',
      cursor: second.cursor,
    });
    assert.equal(invalid.body.error.code, 'invalid_cursor');
    const recovered = await observation(reader.client, f.area);
    const audit = await reader.client.call(path(f.area), {
      action: 'audit',
      displayed: [pair(local.opening)],
    });
    assert.deepEqual(audit.body, { unavailable: [0], tags: [null] });
    await f.suppress(local.id, false);
    assert.equal((await observation(reader.client, f.area, recovered.cursor)).change, 'updated');
    const reauthorized = await reader.client.call(path(f.area), {
      action: 'audit',
      displayed: [pair(local.opening)],
    });
    assert.deepEqual(reauthorized.body.unavailable, []);
    assert.notDeepEqual(reauthorized.body.tags[0], oldTag);
    await f.restart();
    const restarted = await reader.client.call(path(f.area), {
      action: 'check',
      cursor: recovered.cursor,
    });
    assert.equal(restarted.status, 400);
    assert.equal(restarted.body.error.code, 'invalid_cursor');
    assert.deepEqual(
      (
        await reader.client.call(path(f.area), {
          action: 'audit',
          displayed: [pair(local.opening)],
        })
      ).body,
      reauthorized.body,
      'ordinary restart invalidates the cursor and preserves current row selectors',
    );
    await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [f.area]);
    assert.equal((await reader.client.call(path(f.area), check)).status, 404);
  },
);

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Actual Rows': number;
  Plans?: PlanNode[];
};

function planNodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}

test(
  'the database bounds candidate scans and source lookup while freshness leaves private state untouched',
  { timeout: 120000 },
  async (t) => {
    const scans = new Map<string, { sql: string; values: readonly unknown[] }>();
    let sourceLookup: { sql: string; values: readonly unknown[] } | undefined;
    const f = await fixture(t, {
      rateLimits: 'defaults',
      transactionWrapper: (database) => ({
        transaction: <T>(work: (tx: SqlTransaction) => Promise<T>) =>
          database.transaction((tx) =>
            work({
              query<Row extends QueryResultRow>(sql: string, values: readonly unknown[]) {
                const table =
                  /FROM loom\.(topic_discussion_activity|topic_discussion_visibility) [av]/.exec(
                    sql,
                  )?.[1];
                if (table) scans.set(table, { sql, values });
                if (sql.startsWith('WITH RECURSIVE sources AS (')) sourceLookup = { sql, values };
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    const reader = await f.participant('topic_index_reader');
    const local = await f.discussion();
    const prior = await observation(reader.client, f.area);
    const topicTag = (await rows(reader.client, listing(f.area)))[0]!.discussion_observation_tags;
    // Seed retained control history to make the PostgreSQL access strategy visible
    // at realistic cardinality without issuing thousands of unrelated commands.
    await f.observer.query(
      `INSERT INTO loom.topic_discussion_activity(area_id,position,opening_id,effect)
       SELECT CASE WHEN n%100=0 THEN $1::uuid ELSE $2::uuid END,c.shared_position+n,$3,'revised'
       FROM loom.community_clocks c CROSS JOIN generate_series(1,10000) n`,
      [f.area, f.other, local.opening.resource_id],
    );
    await f.observer.query(
      'UPDATE loom.community_clocks SET shared_position=shared_position+10000',
    );
    await f.observer.query(
      `INSERT INTO loom.topic_discussion_visibility(visibility_version,area_id,opening_id)
       SELECT s.visibility_version+n,$1,$2
       FROM loom.shared_retrieval_state s CROSS JOIN generate_series(1,10000) n`,
      [f.other, local.opening.resource_id],
    );
    await f.observer.query(
      'UPDATE loom.shared_retrieval_state SET visibility_version=visibility_version+10000',
    );
    await f.observer.query('ANALYZE loom.topic_discussion_activity');
    await f.observer.query('ANALYZE loom.topic_discussion_visibility');
    // At this cardinality PostgreSQL can prefer a full resource scan at every
    // recursive level unless each ancestor lookup is correlated with one ID.
    await f.observer.query(
      `INSERT INTO loom.resources(id,kind)
       SELECT gen_random_uuid(),'area' FROM generate_series(1,500)`,
    );
    await f.observer.query('ANALYZE loom.resources');
    const privateState = async () =>
      (
        await f.observer.query(
          `SELECT (SELECT count(*) FROM loom.reading_states) AS reading,
              (SELECT count(*) FROM loom.reading_operations) AS reading_operations,
              (SELECT count(*) FROM loom.saved_items) AS saved,
              (SELECT count(*) FROM loom.saved_operations) AS saved_operations,
              (SELECT count(*) FROM loom.following_targets) AS following,
              (SELECT count(*) FROM loom.following_operations) AS following_operations,
              (SELECT count(*) FROM loom.personal_deliveries) AS deliveries,
              (SELECT count(*) FROM loom.attention_dismissals) AS dismissals,
              (SELECT count(*) FROM loom.updates_views) AS updates,
              (SELECT count(*) FROM loom.idempotency_records) AS publications,
              (SELECT shared_position FROM loom.community_clocks WHERE id=1) AS shared_position`,
        )
      ).rows;
    const state = await privateState();
    const used = async () =>
      Number(
        (
          await f.observer.query(
            "SELECT used FROM loom.participation_rate_windows WHERE participant_id=$1 AND category='ordinary_requests'",
            [reader.id],
          )
        ).rows[0]!.used,
      );
    const starting = await used();

    const result = await observation(reader.client, f.area, prior.cursor);
    assert.equal(result.complete, false);
    assert.equal(result.change, 'updated');
    assert.ok(topicTag.every((tag) => !result.withdrawn_tags.includes(tag)));
    const repeat = await observation(reader.client, f.area, prior.cursor);
    assert.equal(repeat.complete, result.complete);
    assert.equal(repeat.scanned, result.scanned);
    assert.equal(repeat.visibility_scanned, result.visibility_scanned);
    const continued = await observation(reader.client, f.area, result.cursor);
    assert.equal(continued.complete, false);
    assert.equal(continued.scanned, C.topicFreshnessLimits.events);
    assert.equal(continued.visibility_scanned, C.topicFreshnessLimits.visibility);
    const unknownSources = Array.from({ length: C.topicFreshnessLimits.displayed - 1 }, () => ({
      resource_id: randomUUID(),
      revision_id: randomUUID(),
    }));
    const audit = await reader.client.call(path(f.area), {
      action: 'audit',
      displayed: [pair(local.opening), ...unknownSources],
    });
    assert.deepEqual(audit.body, {
      unavailable: unknownSources.map((_, index) => index + 1),
      tags: [topicTag, ...unknownSources.map(() => null)],
    });
    assert.deepEqual(await privateState(), state);
    assert.equal((await used()) - starting, 4);

    for (const [table, budget] of [
      ['topic_discussion_activity', C.topicFreshnessLimits.events],
      ['topic_discussion_visibility', C.topicFreshnessLimits.visibility],
    ] as const) {
      const { sql, values } = scans.get(table)!;
      const result = await f.observer.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        'EXPLAIN (ANALYZE, FORMAT JSON) ' + sql,
        [...values],
      );
      const limit = result.rows[0]!['QUERY PLAN'][0]!.Plan;
      assert.equal(limit['Node Type'], 'Limit');
      assert.equal(limit['Actual Rows'], budget + 1);
      assert.equal(limit.Plans?.[0]?.['Index Name'], table + '_pkey');
      assert.equal(limit.Plans?.[0]?.['Actual Rows'], budget + 1);
    }
    assert.ok(sourceLookup);
    const sourcePlan = await f.observer.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
      'EXPLAIN (ANALYZE, FORMAT JSON) ' + sourceLookup.sql,
      [...sourceLookup.values],
    );
    const resources = planNodes(sourcePlan.rows[0]!['QUERY PLAN'][0]!.Plan).filter(
      (node) => node['Relation Name'] === 'resources',
    );
    assert.ok(resources.length >= 2);
    assert.ok(
      resources.every((node) => node['Node Type'] !== 'Seq Scan'),
      'opening and ancestry authorization should seek bounded resource IDs',
    );
  },
);
