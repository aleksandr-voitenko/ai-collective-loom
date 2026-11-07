import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AutomaticReadingQueue,
  automaticReadingCandidateLimit,
} from '../../src/web/reading-coordinator.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('sixty automatic candidates drain as 25, 25 and 10 with one request in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const batches: number[][] = [];
  const releases: (() => void)[] = [];
  const queue = new AutomaticReadingQueue<{ id: string; n: number }>(async (batch) => {
    batches.push(batch.map((candidate) => candidate.n));
    await new Promise<void>((resolve) => releases.push(resolve));
  });
  for (let n = 0; n < 60; n++) assert.equal(queue.enqueue({ id: String(n), n }), 'added');
  t.mock.timers.tick(0);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [25],
  );
  assert.equal(queue.size, 35);
  releases.shift()!();
  await turn();
  t.mock.timers.tick(0);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [25, 25],
  );
  releases.shift()!();
  await turn();
  t.mock.timers.tick(249);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [25, 25],
  );
  t.mock.timers.tick(1);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [25, 25, 10],
  );
  assert.deepEqual(
    batches.flat(),
    Array.from({ length: 60 }, (_, n) => n),
  );
  releases.shift()!();
  await turn();
  queue.close();
});

test('oldest candidate deadline survives continuous arrivals and cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const batches: string[][] = [];
  const queue = new AutomaticReadingQueue<{ id: string }>(async (batch) => {
    batches.push(batch.map((candidate) => candidate.id));
  });
  queue.enqueue({ id: 'a' });
  t.mock.timers.tick(100);
  queue.enqueue({ id: 'b' });
  queue.enqueue({ id: 'b' });
  queue.cancel('b');
  t.mock.timers.tick(100);
  queue.enqueue({ id: 'c' });
  t.mock.timers.tick(49);
  assert.deepEqual(batches, []);
  t.mock.timers.tick(1);
  assert.deepEqual(batches, [['a', 'c']]);
  await turn();
  queue.close();
});

test('occupied automatic capacity retains a finite candidate buffer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let release: (() => void) | undefined;
  const queue = new AutomaticReadingQueue<{ id: string }>(async () => {
    await new Promise<void>((resolve) => (release = resolve));
  });
  for (let n = 0; n < 25; n++) queue.enqueue({ id: String(n) });
  t.mock.timers.tick(0);
  for (let n = 25; n < 25 + automaticReadingCandidateLimit; n++)
    assert.equal(queue.enqueue({ id: String(n) }), 'added');
  assert.equal(queue.enqueue({ id: 'overflow' }), 'full');
  assert.equal(queue.size, automaticReadingCandidateLimit);
  queue.close();
  release!();
  await turn();
  assert.equal(queue.size, 0);
});

test('a reserved continuation stays separate when fresh work arrives afterward', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const batches: string[][] = [];
  const queue = new AutomaticReadingQueue<{ id: string }>(async (batch) => {
    batches.push(batch.map((candidate) => candidate.id));
    if (batches.length === 1) return [{ id: 'b' }];
  });
  queue.enqueue({ id: 'a' });
  queue.enqueue({ id: 'b' });
  t.mock.timers.tick(250);
  await turn();
  queue.enqueue({ id: 'c' });
  assert.equal(queue.has('b'), true);
  t.mock.timers.tick(0);
  await turn();
  assert.deepEqual(batches, [['a', 'b'], ['b']]);
  t.mock.timers.tick(250);
  await turn();
  assert.deepEqual(batches, [['a', 'b'], ['b'], ['c']]);
  queue.close();
});
