import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../helpers/attention.js';
import { bounded } from '../helpers/search-races.js';
import { gates } from '../helpers/updates-gates.js';

const prefix = '/api/v1/me/routine-updates/';
const viewRead = (sql: string) =>
  sql.includes('FROM loom.updates_views WHERE id=$1 AND participant_id=$2');
const snapshot = (sql: string) => sql.includes('FROM loom.updates_state u CROSS JOIN');
const timeout = 90000;

for (const observerFirst of [false, true])
  test(
    `ongoing preparation and observation complete independently with ${observerFirst ? 'custody checked' : 'progress committed'} first`,
    { timeout },
    async (t) => {
      const gatekeeper = gates(),
        f = await fixture(t, { transactionWrapper: gatekeeper.wrapper }),
        reader = await f.participant('observe_preparation_barrier');
      await f.follow(reader.client, f.settings('area', f.area, true, ['artifact_revisions']));
      // Populate more than one scan of irrelevant, well-formed structural entries.
      await f.observer.query(
        `WITH clock AS (
        UPDATE loom.community_clocks SET shared_position=shared_position+101 RETURNING shared_position)
        INSERT INTO loom.shared_activity (id,position,kind,resource_id,publisher_id,area_scope_ids,before_area_scope_ids,after_area_scope_ids)
        SELECT gen_random_uuid(),shared_position-offset_n,'organization.changed',$1,$2,ARRAY[$1::uuid],
          ARRAY[$1::uuid],ARRAY[$1::uuid] FROM clock,generate_series(0,100) AS offset_n`,
        [f.area, f.administratorId],
      );
      const opening = await f.routine(reader.client);
      assert.equal(opening.stage, 'preparing');
      assert.equal(opening.traversal.shared.scan_complete, false);
      if (observerFirst) await f.artifact();
      const held = gatekeeper.pause(observerFirst ? viewRead : snapshot);
      const checking = reader.client.call(prefix + 'observe', { view: opening.page_cursor });
      let next;
      try {
        await bounded(held.entered.promise);
        next = await reader.client.call(prefix + 'query', { cursor: opening.next_cursor });
      } finally {
        held.release.release();
      }
      const result = await checking;
      assert.equal(next.status, 200, JSON.stringify(next.body));
      assert.equal(next.body.traversal.shared.scan_complete, true);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.new_activity, observerFirst);
      assert.equal(result.body.scan_complete, true);
    },
  );

test(
  'an overlapping policy change preserves the observation snapshot and then requires explicit attention refresh',
  { timeout },
  async (t) => {
    const gatekeeper = gates(),
      f = await fixture(t, { transactionWrapper: gatekeeper.wrapper }),
      reader = await f.participant('observer_private_barrier'),
      d = await f.discussion();
    await f.follow(reader.client, f.settings('discussion', d.id));
    const priorMute = await f.artifact();
    await f.mute(reader.client, 'artifact', priorMute.resource_id);
    const page = await f.readyRoutine(reader.client);
    await f.reply(d);
    const held = gatekeeper.pause(snapshot);
    const checking = reader.client.call(prefix + 'observe', { view: page.page_cursor });
    try {
      await bounded(held.entered.promise);
      await f.mute(reader.client, 'discussion', d.id);
    } finally {
      held.release.release();
    }
    const prior = await checking;
    assert.equal(prior.status, 200, JSON.stringify(prior.body));
    assert.equal(prior.body.new_activity, true);
    const stale = await reader.client.call(prefix + 'observe', {
      view: page.page_cursor,
      cursor: prior.body.cursor,
    });
    assert.equal(stale.body.error.code, 'updates_attention_refresh_required');
    const adopted = await f.readyRoutine(reader.client, {
      recovery: { action: 'attention_refresh', token: page.page_cursor },
    });
    const current = await reader.client.call(prefix + 'observe', { view: adopted.page_cursor });
    assert.equal(current.status, 200);
    assert.equal(current.body.new_activity, false);
  },
);

for (const withdrawal of [false, true])
  test(
    `an observation interrupted by ${withdrawal ? 'source withdrawal requires replay' : 'ordinary editing retries the same position'}`,
    { timeout },
    async (t) => {
      const gatekeeper = gates(),
        f = await fixture(t, { transactionWrapper: gatekeeper.wrapper }),
        reader = await f.participant('observe_source_guard'),
        artifact = await f.artifact();
      const page = await f.readyRoutine(reader.client, {
        scope: { kind: 'explicit', definition: f.settings('artifact', artifact.resource_id) },
      });
      const first = await reader.client.call(prefix + 'observe', { view: page.page_cursor });
      assert.equal(first.status, 200);
      assert.equal(first.body.new_activity, false);
      const latest = await f.revise(f.admin, artifact, 'Newer available', []);
      const held = gatekeeper.pause((sql) =>
        sql.includes('WHERE e.position>$1 AND e.position<=$2 ORDER BY e.position LIMIT 101'),
      );
      const request = { view: page.page_cursor, cursor: first.body.cursor };
      const checking = reader.client.call(prefix + 'observe', request);
      try {
        await bounded(held.entered.promise);
        if (withdrawal)
          await f.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
            artifact.resource_id,
          ]);
        else await f.revise(f.admin, latest, 'An overlapping edit', []);
      } finally {
        held.release.release();
      }
      const interrupted = await checking;
      assert.equal(
        interrupted.body.error?.code,
        withdrawal ? 'updates_visibility_replay_required' : 'updates_work_limit',
      );
      assert.equal(interrupted.body.cursor, undefined);
      assert.equal(interrupted.body.new_activity, undefined);
      const retried = await reader.client.call(prefix + 'observe', request);
      if (withdrawal) assert.equal(retried.body.error?.code, 'updates_visibility_replay_required');
      else {
        assert.equal(retried.status, 200);
        assert.equal(retried.body.new_activity, true);
        assert.equal(retried.body.scan_complete, true);
      }
    },
  );

test(
  'sustained source lock contention leaves the observed position available for retry',
  { timeout },
  async (t) => {
    const f = await fixture(t),
      reader = await f.participant('observe_held_source_lock'),
      artifact = await f.artifact();
    const page = await f.readyRoutine(reader.client, {
      scope: { kind: 'explicit', definition: f.settings('artifact', artifact.resource_id) },
    });
    const first = await reader.client.call(prefix + 'observe', { view: page.page_cursor });
    assert.equal(first.status, 200);
    assert.equal(first.body.new_activity, false);
    await f.revise(f.admin, artifact, 'An eligible change', []);
    const request = { view: page.page_cursor, cursor: first.body.cursor };
    await f.observer.query('BEGIN');
    try {
      // Both bounded authorization attempts encounter an ordinary writer. No
      // availability, visibility or identity changes occur in this transaction.
      await f.observer.query('SELECT id FROM loom.resources WHERE id=$1 FOR UPDATE', [
        artifact.resource_id,
      ]);
      const blocked = await reader.client.call(prefix + 'observe', request);
      assert.equal(blocked.body.error?.code, 'updates_work_limit');
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.cursor, undefined);
      assert.equal(blocked.body.new_activity, undefined);
    } finally {
      await f.observer.query('ROLLBACK');
    }
    const retried = await reader.client.call(prefix + 'observe', request);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.new_activity, true);
    assert.equal(retried.body.scan_complete, true);
  },
);
