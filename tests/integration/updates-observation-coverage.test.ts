import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  RoutineObservationView,
  RoutinePageView,
} from '../../src/contracts/routine-updates.js';
import { fixture } from '../helpers/attention.js';

type Client = Awaited<ReturnType<typeof fixture>>['admin'];
const prefix = '/api/v1/me/routine-updates/';

async function observe(client: Client, page: RoutinePageView, cursor?: string) {
  const response = await client.call(prefix + 'observe', { view: page.page_cursor, cursor });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as RoutineObservationView;
}

test(
  'unknown structural coverage survives catch-up and enlarging the unfinished interval',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observe_unknown'),
      d = await f.discussion();
    const page = await f.readyRoutine(reader.client, {
      scope: {
        kind: 'explicit',
        definition: f.settings('discussion', d.id, false, ['structural']),
      },
      selection: 'complete',
    });
    // Historical area events can lack an impact set. Construct that retained
    // row shape in one committed clock step, as if this batch crossed an upgrade.
    await f.observer.query(
      `WITH clock AS (UPDATE loom.community_clocks SET shared_position=shared_position+1
        RETURNING shared_position)
       INSERT INTO loom.shared_activity(id,position,kind,resource_id,publisher_id,
         area_scope_ids,before_area_scope_ids,after_area_scope_ids)
       SELECT gen_random_uuid(),shared_position,'organization.changed',$1,$2,
         ARRAY[$1::uuid],ARRAY[$1::uuid],ARRAY[$1::uuid] FROM clock`,
      [f.area, f.administratorId],
    );
    const checked = await observe(reader.client, page);
    assert.deepEqual(
      [checked.new_activity, checked.scan_complete, checked.coverage],
      [false, true, 'unknown'],
    );
    assert.equal((await observe(reader.client, page, checked.cursor)).coverage, 'unknown');
    const extended = await f.readyRoutine(reader.client, { refresh_from_view: page.page_cursor });
    assert.equal(extended.traversal.shared.coverage, 'unknown');
    assert.equal(extended.checkpoint, null);
    const again = await f.readyRoutine(reader.client, { refresh_from_view: extended.page_cursor });
    assert.equal(again.traversal.shared.coverage, 'unknown');
    assert.equal(again.grouped_interval_complete, false);
  },
);

test(
  'current owner and exact revision gate delayed replies; Complete remains available across a mute',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observe_filtered'),
      d = await f.discussion(reader.client);
    await f.follow(reader.client, f.settings('discussion', d.id));
    const hidden = await f.reply(d);
    await f.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1", [
      hidden.revision_id,
    ]);
    const direct = await f.readyRoutine(reader.client, { selection: 'direct' }),
      complete = await f.readyRoutine(reader.client, {
        switch: { token: direct.page_cursor, selection: 'complete' },
      }),
      previous = await observe(reader.client, complete);
    await f.mute(reader.client, 'discussion', d.id);
    assert.equal(
      (await reader.client.call(prefix + 'observe', { view: direct.page_cursor })).body.error.code,
      'updates_attention_refresh_required',
    );
    const replies = await f.readyRoutine(reader.client, {
        scope: { kind: 'personal' },
        reason: 'reply',
        selection: 'direct',
      }),
      mentions = await f.readyRoutine(reader.client, {
        scope: { kind: 'personal' },
        reason: 'mention',
        selection: 'direct',
      });
    await f.drain();
    const deliveries = () =>
      f.observer.query(
        'SELECT s.revision_id FROM loom.personal_deliveries d JOIN loom.notification_signals s ON s.id=d.signal_id WHERE d.recipient_id=$1',
        [reader.id],
      );
    assert.deepEqual((await deliveries()).rows, [{ revision_id: hidden.revision_id }]);
    const unavailable = await observe(reader.client, replies);
    assert.equal(unavailable.new_activity, false);
    assert.equal((await observe(reader.client, complete, previous.cursor)).new_activity, false);
    assert.deepEqual((await f.page(reader.client)).items, []);
    const visible = await f.reply(d);
    assert.equal((await observe(reader.client, complete, previous.cursor)).new_activity, true);
    assert.equal((await observe(reader.client, replies, unavailable.cursor)).new_activity, false);
    await f.drain();
    assert.equal((await observe(reader.client, replies, unavailable.cursor)).new_activity, true);
    assert.equal((await observe(reader.client, mentions)).new_activity, false);
    const extended = await f.readyRoutine(reader.client, {
      refresh_from_view: replies.page_cursor,
    });
    assert.deepEqual(
      extended.items.flatMap((g) => g.direct_sources.map((m) => m.source.revision_id)),
      [visible.revision_id],
    );
    const all = await f.readyRoutine(reader.client, { refresh_from_view: complete.page_cursor });
    assert.equal(all.traversal.selection, 'complete');
    assert.equal(all.attention.policy_version, complete.attention.policy_version);
    assert.deepEqual(
      (await f.allRoutineMembers(reader.client, all.records_cursor!))
        .map((m) => m.source.revision_id)
        .sort(),
      [d.opening.revision_id, visible.revision_id].sort(),
    );
  },
);
