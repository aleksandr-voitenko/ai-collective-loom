import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { fixture } from '../helpers/attention.js';
import { mentioned } from '../helpers/notifications.js';
import { editUpdatesToken } from '../helpers/updates-token.js';
import {
  RoutineObservation,
  type RoutineObservationView,
  type RoutinePageView,
} from '../../src/contracts/routine-updates.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Client = Fixture['admin'];
const prefix = '/api/v1/me/routine-updates/';
const timeout = 120000;

async function observe(client: Client, page: RoutinePageView, cursor?: string) {
  const result = await client.call(prefix + 'observe', { view: page.page_cursor, cursor });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(Value.Check(RoutineObservation, result.body));
  assert.ok(Buffer.byteLength(JSON.stringify(result.body)) <= 1024);
  return result.body as RoutineObservationView;
}

test(
  'preparing and Highlights observers use the captured bounds, preserve full custody and keep fixed switches fixed',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observer_full'),
      d = await f.discussion();
    await f.follow(reader.client, f.settings('discussion', d.id));
    const initial = await f.routine(reader.client);
    assert.equal(initial.stage, 'preparing');
    const ready = await f.readyRoutine(reader.client, { cursor: initial.next_cursor! });
    assert.equal(ready.checkpoint, null);
    assert.equal(ready.traversal.selection, 'highlights');
    await f.reply(d);
    for (let i = 1; i < 16; i++) await f.routine(reader.client);
    const tables = [
      'updates_custody_serialization',
      'updates_views',
      'updates_groups',
      'updates_members',
      'attention_views',
      'attention_groups',
      'attention_members',
      'attention_mutes',
      'attention_dismissals',
      'reading_states',
      'following_targets',
      'personal_deliveries',
      'participant_delivery_clocks',
      'notification_jobs',
      'community_clocks',
    ];
    const snapshot = async () => {
      const hashes: string[] = [];
      for (const table of tables) {
        const { rows } = await f.observer.query(
          'SELECT md5(string_agg(to_jsonb(t)::text, chr(10) ORDER BY to_jsonb(t)::text)) AS hash FROM loom.' +
            table +
            ' t',
        );
        hashes.push(rows[0].hash);
      }
      return hashes;
    };
    const before = await snapshot();
    for (const page of [initial, ready]) {
      const found = await observe(reader.client, page);
      assert.equal(found.new_activity, true);
      assert.equal(found.scan_complete, true);
      assert.equal(found.coverage, 'known');
      assert.ok(found.cursor.length <= 512);
      assert.equal((await observe(reader.client, page, found.cursor)).new_activity, true);
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (await reader.client.call(prefix + 'query', { refresh_from_view: ready.page_cursor })).body
        .error.code,
      'updates_capacity',
    );
    const fixed = await f.readyRoutine(reader.client, {
      switch: { token: ready.page_cursor, selection: 'complete' },
    });
    assert.equal(fixed.items[0]!.counts.shared_changes, 1);
    assert.equal(fixed.traversal.shared.upper, initial.traversal.shared.upper);
  },
);

test(
  'delayed delivery crosses its own boundary after shared dismissal and mute; Direct, Complete and personal reason filters remain independent',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observer_deliveries'),
      d = await f.discussion();
    await f.follow(reader.client, f.settings('discussion', d.id));
    await f.publish(f.admin, '/api/v1/replies', {
      discussion_id: d.id,
      parent_id: d.opening.resource_id,
      content: mentioned(reader.id),
      change_note: null,
      change_account: null,
    });
    const original = await f.readyRoutine(reader.client);
    const selected = await f.selection(reader.client, original.page_cursor, original.items[0]!.id);
    assert.equal(selected.personal_signals, 0);
    await f.dismiss(reader.client, f.fromSelection(selected));
    await f.mute(reader.client, 'discussion', d.id);
    assert.equal(
      (await reader.client.call(prefix + 'observe', { view: original.page_cursor })).body.error
        .code,
      'updates_attention_refresh_required',
    );
    assert.equal(
      (await reader.client.call(prefix + 'query', { refresh_from_view: original.page_cursor })).body
        .error.code,
      'updates_attention_refresh_required',
    );
    const filtered = await f.readyRoutine(reader.client),
      direct = await f.readyRoutine(reader.client, {
        switch: { token: filtered.page_cursor, selection: 'direct' },
      }),
      complete = await f.readyRoutine(reader.client, {
        switch: { token: filtered.page_cursor, selection: 'complete' },
      }),
      mentions = await f.readyRoutine(reader.client, {
        scope: { kind: 'personal' },
        reason: 'mention',
      }),
      replies = await f.readyRoutine(reader.client, {
        scope: { kind: 'personal' },
        reason: 'reply',
      });
    await f.reply(d);
    const shared = await observe(reader.client, filtered),
      personal = await observe(reader.client, mentions);
    assert.equal(shared.new_activity, false);
    assert.equal(personal.new_activity, false);
    assert.equal((await observe(reader.client, direct)).new_activity, false);
    assert.equal((await observe(reader.client, complete)).new_activity, true);
    const clock = async () =>
      (await f.observer.query('SELECT shared_position FROM loom.community_clocks')).rows[0]
        .shared_position;
    const before = await clock();
    await f.drain();
    assert.equal(await clock(), before);
    assert.equal((await observe(reader.client, filtered, shared.cursor)).new_activity, true);
    assert.equal((await observe(reader.client, mentions, personal.cursor)).new_activity, true);
    assert.equal((await observe(reader.client, replies)).new_activity, false);
    assert.equal((await observe(reader.client, direct)).new_activity, true);
    const applied = await f.readyRoutine(reader.client, {
      refresh_from_view: mentions.page_cursor,
    });
    assert.equal(applied.traversal.reason, 'mention');
    assert.equal(applied.traversal.scope, 'personal');
    assert.equal(applied.items[0]!.counts.personal_signals, 1);
    assert.equal(applied.items[0]!.counts.shared_changes, 0);
    assert.equal((await observe(reader.client, applied)).new_activity, false);
  },
);

test(
  'bounded lookahead, frozen Following and explicit descendants and preferences',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observer_scope'),
      wanted = await f.artifact(),
      child = await f.newArea('Nested', f.area);
    await f.follow(reader.client, f.settings('artifact', wanted.resource_id));
    const old = await f.readyRoutine(reader.client);
    const direct = await f.readyRoutine(reader.client, {
      switch: { token: old.page_cursor, selection: 'direct' },
    });
    await f.follow(reader.client, f.settings('artifact', wanted.resource_id), false, 1);
    for (let i = 0; i < 100; i++) await f.artifact(f.admin, 'Other ' + i);
    await f.revise(f.admin, wanted, 'Later followed revision', []);
    const first = await observe(reader.client, old);
    assert.equal(first.new_activity, false);
    assert.equal(first.scan_complete, false);
    assert.equal(first.settings_current, false);
    const found = await observe(reader.client, old, first.cursor);
    assert.equal(found.new_activity, true);
    assert.equal(found.scan_complete, true);
    const directFirst = await observe(reader.client, direct);
    assert.equal((await observe(reader.client, direct, directFirst.cursor)).new_activity, false);
    const applied = await f.readyRoutine(reader.client, { refresh_from_view: old.page_cursor });
    assert.deepEqual(applied.traversal.definitions, old.traversal.definitions);
    assert.equal(applied.traversal.settings_current, false);
    assert.equal(applied.items[0]!.counts.shared_changes, 2);
    const area = async (descendants: boolean, preference: 'artifact_revisions' | 'replies') =>
      f.routine(reader.client, {
        scope: {
          kind: 'explicit',
          definition: f.settings('area', f.area, descendants, [preference]),
        },
      });
    const nested = await area(true, 'artifact_revisions'),
      exact = await area(false, 'artifact_revisions'),
      other = await area(true, 'replies');
    await f.publish(f.admin, '/api/v1/artifacts', {
      area_id: child,
      title: 'Nested artifact',
      content: { format: 'loom-markdown-v1', text: 'Nested', mentions: [] },
    });
    assert.equal((await observe(reader.client, nested)).new_activity, true);
    assert.equal((await observe(reader.client, exact)).new_activity, false);
    assert.equal((await observe(reader.client, other)).new_activity, false);
  },
);

test(
  'refresh of unfinished nonzero intervals retains original lower bounds, unseen groups and ordinary checkpoint semantics',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observer_interval');
    await f.follow(reader.client, f.settings('area', f.area, true, ['artifact_revisions']));
    await f.artifact(f.admin, 'Before completed lower bound');
    const completed = await f.readyRoutine(reader.client, { selection: 'complete' });
    assert.ok(completed.checkpoint);
    const a = await f.artifact(f.admin, 'First unvisited'),
      b = await f.artifact(f.admin, 'Second unvisited');
    const intermediate = await f.readyRoutine(reader.client, {
      checkpoint: completed.checkpoint!,
      limit: 1,
    });
    assert.equal(intermediate.checkpoint, null);
    assert.ok(intermediate.next_cursor);
    const c = await f.artifact(f.admin, 'After the first snapshot');
    assert.equal((await observe(reader.client, intermediate)).new_activity, true);
    const preparing = await f.routine(reader.client, {
      refresh_from_view: intermediate.page_cursor,
      limit: 1,
    });
    assert.equal(preparing.stage, 'preparing');
    assert.notEqual(preparing.traversal.id, intermediate.traversal.id);
    assert.equal(preparing.traversal.shared.lower, completed.traversal.shared.upper);
    assert.equal(preparing.traversal.personal.lower, intermediate.traversal.personal.lower);
    assert.notEqual(preparing.traversal.shared.upper, intermediate.traversal.shared.upper);
    // A commit after the replacement captured its bounds but before the reader accepts it.
    const d = await f.artifact(f.admin, 'While applying the view');
    assert.equal((await observe(reader.client, preparing)).new_activity, true);
    const ready = await f.readyRoutine(reader.client, { cursor: preparing.next_cursor!, limit: 1 });
    const ids = (await f.allRoutineMembers(reader.client, ready.records_cursor!))
      .map((item) => item.source.revision_id)
      .sort();
    assert.deepEqual(ids, [a.revision_id, b.revision_id, c.revision_id].sort());
    const expanded = await f.readyRoutine(reader.client, {
      refresh_from_view: preparing.page_cursor,
      limit: 12,
    });
    assert.deepEqual(
      (await f.allRoutineMembers(reader.client, expanded.records_cursor!))
        .map((item) => item.source.revision_id)
        .sort(),
      [...ids, d.revision_id].sort(),
    );
    const oldEnd = await f.readyRoutine(reader.client, {
      cursor: intermediate.next_cursor!,
      limit: 1,
    });
    assert.ok(oldEnd.checkpoint);
    assert.equal(oldEnd.traversal.id, intermediate.traversal.id);
    const later = await f.readyRoutine(reader.client, { checkpoint: oldEnd.checkpoint! });
    assert.deepEqual(
      (await f.allRoutineMembers(reader.client, later.records_cursor!))
        .map((item) => item.source.revision_id)
        .sort(),
      [c.revision_id, d.revision_id].sort(),
    );
  },
);

test(
  'extending an explicitly incomplete resynchronization prepares its new range',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observer_baseline');
    await f.follow(reader.client, f.settings('area', f.area, true, ['artifact_revisions']));
    await f.artifact();
    const baseline = await f.readyRoutine(reader.client, {
      recovery: { action: 'resynchronize' },
      selection: 'complete',
    });
    assert.equal(baseline.baseline_established, true);
    const next = await f.artifact();
    const extended = await f.readyRoutine(reader.client, {
      refresh_from_view: baseline.page_cursor,
    });
    assert.equal(extended.baseline_established, false);
    for (const kind of ['shared', 'personal'] as const) {
      assert.equal(extended.traversal[kind].history, 'incomplete');
      assert.equal(extended.traversal[kind].lower, baseline.traversal[kind].lower);
    }
    assert.equal(extended.items.length, 1);
    assert.deepEqual(
      (await f.allRoutineMembers(reader.client, extended.records_cursor!)).map(
        (m) => m.source.revision_id,
      ),
      [next.revision_id],
    );
  },
);

test(
  'observation authority, purpose, visibility, retention, expiry, custody and epoch refusals remain distinct',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observer_tokens'),
      d = await f.discussion();
    await f.follow(reader.client, f.settings('discussion', d.id));
    const view = await f.readyRoutine(reader.client),
      other = await f.readyRoutine(reader.client),
      result = await observe(reader.client, view);
    const code = async (path: string, body: Record<string, unknown>, client = reader.client) =>
      (await client.call(path, body)).body.error?.code;
    for (const body of [
      { cursor: result.cursor },
      { checkpoint: result.cursor },
      { refresh_from_view: result.cursor },
      { refresh_from_view: view.items[0]!.members_cursor },
    ]) {
      assert.equal(await code(prefix + 'query', body), 'updates_token_invalid');
    }
    assert.equal(
      await code(prefix + 'selection', { cursor: result.cursor, group_id: view.items[0]!.id }),
      'updates_token_invalid',
    );
    const confirmed = await f.selection(reader.client, view.page_cursor, view.items[0]!.id);
    assert.equal(
      await code(f.endpoint + '/dismissals/state', {
        ...f.fromSelection(confirmed),
        selection: result.cursor,
      }),
      'invalid_input',
    );
    const direct = await f.readyRoutine(reader.client, {
      switch: { token: view.page_cursor, selection: 'direct' },
    });
    assert.equal(direct.traversal.id, view.traversal.id);
    assert.equal(
      await code(prefix + 'observe', { view: direct.page_cursor, cursor: result.cursor }),
      'updates_token_invalid',
    );
    assert.equal(
      await code(prefix + 'members', { cursor: result.cursor }),
      'updates_token_invalid',
    );
    assert.equal(
      await code('/api/v1/shared-changes/query', { cursor: result.cursor }),
      'shared_token_invalid',
    );
    assert.equal(
      await code(prefix + 'observe', { view: other.page_cursor, cursor: result.cursor }),
      'updates_token_invalid',
    );
    assert.equal(
      await code(prefix + 'observe', { view: view.page_cursor }, f.admin),
      'updates_token_invalid',
    );
    assert.equal(
      await code('/api/v1/me/updates/query', { refresh_from_view: view.page_cursor }),
      'invalid_request',
    );
    const legacy = await f.ready(reader.client);
    assert.equal(
      await code(prefix + 'observe', { view: legacy.page_cursor }),
      'updates_token_invalid',
    );
    const check = async (token = view.page_cursor) => code(prefix + 'observe', { view: token });
    const key = (await f.observer.query('SELECT cursor_key FROM loom.updates_state')).rows[0]
      .cursor_key;
    assert.equal(
      await check(
        editUpdatesToken(
          view.page_cursor,
          key,
          (b) => {
            b.expires = 0;
          },
          'combined-updates-2',
        ),
      ),
      'updates_descriptor_expired',
    );
    await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=1');
    assert.equal(await check(), 'updates_shared_history_gap');
    await f.observer.query('UPDATE loom.shared_retrieval_state SET retained_after=0');
    await f.observer.query(
      'INSERT INTO loom.participant_delivery_clocks(participant_id,position,retained_after) VALUES($1,1,1)',
      [reader.id],
    );
    assert.equal(await check(), 'updates_personal_history_gap');
    await f.observer.query(
      'UPDATE loom.participant_delivery_clocks SET position=0,retained_after=0 WHERE participant_id=$1',
      [reader.id],
    );
    await f.observer.query('DELETE FROM loom.updates_views WHERE id=$1', [other.traversal.id]);
    assert.equal(await check(other.page_cursor), 'updates_state_unavailable');
    await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [d.id]);
    assert.equal(await check(), 'updates_visibility_replay_required');
    assert.equal(
      await code(prefix + 'query', { refresh_from_view: view.page_cursor }),
      'updates_visibility_replay_required',
    );
    await f.observer.query('UPDATE loom.updates_state SET recovery_epoch=gen_random_uuid()');
    assert.equal(await check(), 'updates_epoch_changed');
  },
);
