import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import { fixture, content } from '../helpers/changes.js';
import { fixture as moderationFixture } from '../helpers/moderation.js';
import { barrier, bounded } from '../helpers/search-races.js';

const path = (id: string) => `/api/v1/discussions/${id}/freshness`;
const check = (
  cursor: string,
  parents: string[] = [],
  displayed: { resource_id: string; revision_id: string }[] = [],
) => ({ action: 'check', cursor, parents, displayed });
const pair = (value: { resource_id: string; revision_id: string }) => ({
  resource_id: value.resource_id,
  revision_id: value.revision_id,
});

test(
  'discussion baseline precedes reads; bounded checks distinguish roots, replies, revisions and unrelated activity',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const discussion = await f.discussion();
    const other = await f.discussion();
    const reader = await f.participant('fresh_reader');
    const writer = await f.participant('fresh_writer');
    const old = [];
    for (let i = 0; i < 6; i++) old.push(await f.reply(discussion, 'Existing ' + i));
    const baseline = await reader.client.call(path(discussion.id), { action: 'baseline' });
    assert.equal(baseline.status, 200);
    assert.deepEqual(baseline.body.events, []);
    const empty = await reader.client.call(
      path(discussion.id),
      check(baseline.body.cursor, [discussion.opening.resource_id], [pair(old[0]!)]),
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.events, [], 'six unloaded-before-baseline comments are not new');
    assert.equal(empty.body.complete, true);
    const root = await f.reply(discussion, 'Seventh', writer.client);
    const nested = await writer.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.id,
      parent_id: old[0]!.resource_id,
      content: content('External nested'),
      change_note: null,
      change_account: null,
    });
    assert.equal(nested.status, 201, JSON.stringify(nested.body));
    const revised = await writer.client.call('/api/v1/revisions', {
      idempotency_key: randomUUID(),
      resource_id: root.resource_id,
      expected_revision_id: root.revision_id,
      title: null,
      content: content('Changed seventh'),
      change_note: null,
      change_account: null,
    });
    assert.equal(revised.status, 201, JSON.stringify(revised.body));
    await f.reply(other, 'Other discussion');
    const result = await reader.client.call(
      path(discussion.id),
      check(
        empty.body.cursor,
        [discussion.opening.resource_id, old[0]!.resource_id],
        [pair(root), pair(old[0]!)],
      ),
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(
      result.body.events.map((event: any) => [event.kind, event.resource_id, event.parent_id]),
      [
        ['new_root', root.resource_id, discussion.opening.resource_id],
        ['new_reply', nested.body.resource_id, old[0]!.resource_id],
        ['revision', root.resource_id, discussion.opening.resource_id],
      ],
    );
    assert.deepEqual(
      result.body.displayed.find((item: any) => item.resource_id === root.resource_id),
      {
        resource_id: root.resource_id,
        revision_id: root.revision_id,
        state: 'available',
        current_revision_id: revised.body.revision_id,
      },
    );
    assert.equal(result.body.complete, true);
    assert.ok(result.body.scanned <= 32);
    assert.ok(result.bytes < 8192);
    for (const forbidden of ['content', 'title', 'nickname', 'read_state'])
      assert.equal(JSON.stringify(result.body).includes(`"${forbidden}"`), false);
    const again = await reader.client.call(path(discussion.id), check(result.body.cursor));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.events, []);
  },
);

test(
  'an earlier-created reply that commits after a later reply remains detectable',
  { timeout: 120000 },
  async (t) => {
    let gate:
      | { entered: ReturnType<typeof barrier<void>>; release: ReturnType<typeof barrier<void>> }
      | undefined;
    const f = await fixture(t, {
      transactionWrapper: (database) => ({
        transaction: <T>(
          work: (tx: import('../../src/server/db/postgres.js').SqlTransaction) => Promise<T>,
        ) =>
          database.transaction((tx) =>
            work({
              query: async <Row extends QueryResultRow>(
                sql: string,
                values: readonly unknown[],
              ) => {
                const selected =
                  gate && sql.startsWith('UPDATE loom.community_clocks') ? gate : undefined;
                if (selected) {
                  gate = undefined;
                  selected.entered.release();
                  await bounded(selected.release.promise);
                }
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      }),
    });
    const d = await f.discussion();
    const reader = await f.participant('fresh_order_reader');
    const writer = await f.participant('fresh_order_writer');
    const baseline = (await reader.client.call(path(d.id), { action: 'baseline' })).body.cursor;
    const held = (gate = { entered: barrier(), release: barrier() });
    const slow = f.reply(d, 'Created earlier');
    await bounded(held.entered.promise);
    let firstCheck;
    try {
      const fast = await f.reply(d, 'Committed earlier', writer.client);
      firstCheck = await reader.client.call(path(d.id), check(baseline));
      assert.equal(firstCheck.status, 200);
      assert.deepEqual(
        firstCheck.body.events.map((event: any) => event.resource_id),
        [fast.resource_id],
      );
    } finally {
      held.release.release();
    }
    const delayed = await slow;
    const secondCheck = await reader.client.call(path(d.id), check(firstCheck!.body.cursor));
    assert.equal(secondCheck.status, 200);
    assert.deepEqual(
      secondCheck.body.events.map((event: any) => event.resource_id),
      [delayed.resource_id],
    );
  },
);

test(
  'freshness checks reject foreign and wrong-discussion inputs and continue a fixed global event scan',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const d = await f.discussion();
    const other = await f.discussion();
    const reader = await f.participant('fresh_scope');
    const stranger = await f.participant('fresh_foreign');
    const baseline = (await reader.client.call(path(d.id), { action: 'baseline' })).body.cursor;
    assert.equal((await stranger.client.call(path(d.id), check(baseline))).status, 400);
    assert.equal((await reader.client.call(path(other.id), check(baseline))).status, 400);
    assert.equal((await reader.client.call(path(d.id), check(baseline + 'a'))).status, 400);
    assert.equal(
      (await reader.client.call(path(d.id), check(baseline, [other.opening.resource_id]))).status,
      400,
    );
    assert.equal(
      (await reader.client.call(path(d.id), check(baseline, [], [pair(other.opening)]))).status,
      400,
    );
    for (let i = 0; i < 33; i++) await f.reply(other, 'Unrelated ' + i);
    const local = await f.reply(d, 'Eventually visible');
    const first = await reader.client.call(path(d.id), check(baseline));
    assert.equal(first.status, 200);
    assert.equal(first.body.scanned, 32);
    assert.equal(first.body.complete, false);
    assert.deepEqual(first.body.events, []);
    const second = await reader.client.call(path(d.id), check(first.body.cursor));
    assert.equal(second.status, 200);
    assert.equal(second.body.complete, true);
    assert.deepEqual(
      second.body.events.map((item: any) => item.resource_id),
      [local.resource_id],
    );
  },
);

test(
  'default ordinary request limits account for one baseline and bounded checks without private reading writes',
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t, { rateLimits: 'defaults' });
    const d = await f.discussion();
    const reader = await f.participant('fresh_default_rate');
    const before = await f.observer.query(
      "SELECT used FROM loom.participation_rate_windows WHERE participant_id=$1 AND category='ordinary_requests'",
      [reader.id],
    );
    const starting = Number(before.rows[0]?.used ?? 0);
    let cursor = (await reader.client.call(path(d.id), { action: 'baseline' })).body.cursor;
    for (let i = 0; i < 4; i++) {
      const response = await reader.client.call(
        path(d.id),
        check(cursor, [d.opening.resource_id], [pair(d.opening)]),
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.complete, true);
      cursor = response.body.cursor;
    }
    const after = await f.observer.query(
      "SELECT used FROM loom.participation_rate_windows WHERE participant_id=$1 AND category='ordinary_requests'",
      [reader.id],
    );
    assert.equal(Number(after.rows[0]!.used) - starting, 5);
    assert.equal(
      (
        await f.observer.query(
          'SELECT count(*)::int n FROM loom.reading_states WHERE participant_id=$1',
          [reader.id],
        )
      ).rows[0]!.n,
      0,
    );
  },
);

test(
  'an unavailable structural parent can still scope an eligible child',
  { timeout: 120000 },
  async (t) => {
    const f = await moderationFixture(t);
    const discussion = await f.discussion();
    const parent = await f.reply(discussion, 'Parent later suppressed');
    const child = await f.publish(f.admin, '/api/v1/replies', {
      discussion_id: discussion.id,
      parent_id: parent.resource_id,
      content: content('Eligible child'),
      change_note: null,
      change_account: null,
    });
    const reader = await f.participant('fresh_structural');
    const baseline = (await reader.client.call(path(discussion.id), { action: 'baseline' })).body;
    await f.suppress(parent.resource_id);
    const response = await reader.client.call(
      path(discussion.id),
      check(baseline.cursor, [parent.resource_id], [pair(parent), pair(child)]),
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.displayed.find((item: any) => item.resource_id === parent.resource_id).state,
      'unavailable',
    );
    assert.equal(
      response.body.displayed.find((item: any) => item.resource_id === child.resource_id).state,
      'available',
    );
    const unchanged = await reader.client.call(
      path(discussion.id),
      check(response.body.cursor, [parent.resource_id], [pair(child)]),
    );
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.body.events, []);
    assert.equal(unchanged.body.displayed[0].state, 'available');
  },
);
