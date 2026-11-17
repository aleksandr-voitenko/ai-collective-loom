import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshnessPolicy, selectFreshnessWatches } from '../../src/web/DiscussionFreshness.js';
import { freshnessLimits } from '../../src/contracts/discussion-freshness.js';

test('bounded watch selection reaches visible and collapsed branches across batches', () => {
  const watched = [
    ...Array.from({ length: 24 }, (_, i) => ({ id: `visible-${i}`, visible: true })),
    ...Array.from({ length: 24 }, (_, i) => ({ id: `hidden-${i}`, visible: false })),
  ];
  const seen = new Set<string>();
  for (let round = 0; round < 24; round++) {
    const selected = selectFreshnessWatches(watched, freshnessLimits.parents, round);
    assert.equal(selected.length, freshnessLimits.parents);
    assert.equal(selected.filter((item) => !item.visible).length, 2);
    for (const item of selected) seen.add(item.id);
  }
  assert.equal(seen.size, watched.length);
  assert.equal(freshnessPolicy.intervalMs, 15000);
  assert.equal(freshnessPolicy.maxBackoffMs, 120000);
});
