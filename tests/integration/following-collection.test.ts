import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import * as C from '../../src/contracts/following.js';
import * as P from '../../src/contracts/private-controls.js';
import { fixture } from '../helpers/following.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Client = Fixture['admin'];

async function privateState(f: Fixture) {
  return {
    collections: (await f.observer.query('SELECT * FROM loom.following_collections ORDER BY participant_id')).rows,
    targets: (await f.observer.query('SELECT * FROM loom.following_targets ORDER BY id')).rows,
    operations: (await f.observer.query('SELECT * FROM loom.following_operations ORDER BY id')).rows,
  };
}

function refused(response: Awaited<ReturnType<Client['call']>>, code: 'invalid_cursor' | 'following_collection_changed') {
  assert.equal(response.status, code === 'invalid_cursor' ? 400 : 409);
  assert.equal(typeof response.body.error.request_id, 'string');
  const { request_id, ...error } = response.body.error;
  assert.ok(request_id);
  assert.deepEqual({ ...response.body, error }, {
    error: {
      code,
      message: code === 'invalid_cursor'
        ? 'This continuation is unavailable. Start this view again.'
        : 'Following changed between pages. Refresh the collection.',
      recovery: { action: 'replay_view' },
    },
  });
}

for (const projection of ['legacy', 'private'] as const) {
  test(`${projection} Following collection pages preserve complete ordered choices and owner/version/restart boundaries`, { timeout: 90000 }, async t => {
    const f = await fixture(t);
    const owner = await f.participant('collection_owner');
    const other = await f.participant('collection_other');
    const discussion = await f.discussion();
    const artifact = await f.artifact();
    const definitions = [
      f.settings('area', f.area, true, ['new_discussions', 'structural']),
      f.settings('discussion', discussion.id, false, ['replies']),
      f.settings('artifact', artifact.resource_id, false, ['artifact_revisions', 'change_notes']),
    ];
    const commands = [];
    for (const definition of definitions) {
      commands.push(await f.follow(owner.client, definition));
      await f.follow(other.client, definition);
    }
    const path = '/api/v1/me/following' + (projection === 'private' ? '/private' : '');
    const schema = projection === 'private' ? P.FollowPage : C.FollowPage;
    const page = async (client: Client, options: Record<string, string> = {}) => {
      const response = await client.call(path + '?' + new URLSearchParams(options));
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.ok(Value.Check(schema, response.body), JSON.stringify([...Value.Errors(schema, response.body)]));
      assert.ok(response.bytes <= response.body.max_response_bytes);
      return response.body as C.FollowPageView | P.FollowPageView;
    };
    const expectedSources: C.FollowSourceView[] = [
      { state: 'available', title: 'General', path: [{ id: f.area, title: 'General' }], browser_url: `/loom/area/${f.area}` },
      { state: 'available', title: 'Summary discussion', path: [{ id: f.area, title: 'General' }], browser_url: `/loom/discussion/${discussion.id}` },
      { state: 'available', title: 'Reference source', path: [{ id: f.area, title: 'General' }], browser_url: `/loom/resource/${artifact.resource_id}` },
    ];
    const byResource = new Map(definitions.map((definition, index) => [definition.target.resource_id, {
      ...definition, following: true, version: 1,
      ...(projection === 'legacy' ? { source: expectedSources[index]! } : {}),
    }]));
    // Retained target IDs, rather than resource UUIDs or creation order, define this collection's order.
    const ordered = (await f.observer.query<{ resource_id: string }>(
      'SELECT resource_id FROM loom.following_targets WHERE participant_id=$1 AND following ORDER BY id', [owner.id],
    )).rows.map(row => byResource.get(row.resource_id)!);
    assert.equal(ordered.length, 3);
    const beforeReads = await privateState(f);
    const complete = await page(owner.client);
    assert.deepEqual(complete, {
      items: ordered, next_cursor: null, complete: true, collection_version: 3,
      ordering: 'stable_target_id', limit: 12, max_response_bytes: 131072,
    });
    let current = await page(owner.client, { limit: '1' });
    const firstCursor = current.next_cursor;
    assert.ok(firstCursor);
    const collected = [];
    for (let index = 0; index < ordered.length; index++) {
      const { next_cursor, ...value } = current;
      assert.deepEqual(value, {
        items: [ordered[index]], complete: index === ordered.length - 1,
        collection_version: 3, ordering: 'stable_target_id', limit: 1, max_response_bytes: 131072,
      });
      collected.push(...current.items);
      if (index < ordered.length - 1) {
        assert.ok(next_cursor);
        current = await page(owner.client, { cursor: next_cursor, limit: '1' });
      } else assert.equal(next_cursor, null);
    }
    assert.deepEqual(collected, ordered);

    const continuation = await page(owner.client, { cursor: firstCursor, limit: '25' });
    assert.deepEqual(continuation, {
      items: ordered.slice(1), next_cursor: null, complete: true, collection_version: 3,
      ordering: 'stable_target_id', limit: 25, max_response_bytes: 131072,
    });
    refused(await other.client.call(path + '?' + new URLSearchParams({ cursor: firstCursor })), 'invalid_cursor');
    const altered = Buffer.from(firstCursor, 'base64url');
    altered[0] = altered[0]! ^ 1;
    refused(await owner.client.call(path + '?' + new URLSearchParams({ cursor: altered.toString('base64url') })), 'invalid_cursor');
    assert.deepEqual(await privateState(f), beforeReads);

    const replay = await owner.client.call('/api/v1/me/following/state', commands[0]!.body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { ...commands[0]!.result, idempotency: 'replayed' });
    assert.deepEqual(await page(owner.client, { cursor: firstCursor, limit: '25' }), continuation);
    assert.deepEqual(await privateState(f), beforeReads);

    // A fresh accepted no-op still advances the private choice and collection versions.
    const fresh = await f.follow(owner.client, definitions[2]!, true, 1);
    assert.deepEqual(fresh.result, {
      operation_state: 'applied', operation_id: fresh.result.operation_id, idempotency: 'created',
      outcome: { ...definitions[2], following: true, expected_version: 1, result_version: 2 },
      current: { ...definitions[2], following: true, version: 2, source: expectedSources[2] },
    });
    const afterChoice = await privateState(f);
    refused(await owner.client.call(path + '?' + new URLSearchParams({ cursor: firstCursor })), 'following_collection_changed');
    const updated = ordered.map(item => item.target.resource_id === artifact.resource_id ? { ...item, version: 2 } : item);
    const refreshed = await page(owner.client);
    assert.deepEqual(refreshed, { ...complete, items: updated, collection_version: 4 });
    const beforeRestart = await page(owner.client, { limit: '1' });
    assert.ok(beforeRestart.next_cursor);

    // Shared retrieval custody is durable; collection cursors are deliberately process-local.
    const shared = await f.allChanges(owner.client);
    assert.ok(shared.page.checkpoint);
    const nextShared = await f.changes(owner.client, { checkpoint: shared.page.checkpoint });
    assert.deepEqual(nextShared.items, []);
    assert.equal(nextShared.interval_complete, true);
    await f.restart();
    refused(await owner.client.call(path + '?' + new URLSearchParams({ cursor: beforeRestart.next_cursor })), 'invalid_cursor');
    assert.deepEqual(await page(owner.client), refreshed);
    const resumed = await f.changes(owner.client, { checkpoint: shared.page.checkpoint });
    // Each checkpoint query creates a fresh interval identity and expiry, preserving the saved definition.
    const publicShared = ({ page_cursor, checkpoint, next_cursor, traversal, ...value }: C.SharedPageView) => {
      const { id, expires_at, ...definition } = traversal;
      assert.ok(id);
      assert.ok(Date.parse(expires_at) > Date.now());
      return { ...value, traversal: definition };
    };
    assert.deepEqual(publicShared(resumed), publicShared(nextShared));
    assert.notEqual(resumed.traversal.id, nextShared.traversal.id);
    assert.ok(resumed.checkpoint);
    assert.deepEqual(await privateState(f), afterChoice);
  });
}
