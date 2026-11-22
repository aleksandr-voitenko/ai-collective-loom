import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TopicNavigation, type TopicReturnTarget } from '../../src/web/topic-navigation.js';

const directory = {
  kind: 'directory',
  position: { topicId: 'child', offset: 170, pages: 2, tailId: 'last-child' },
} as const;
const discussions = {
  kind: 'discussions',
  position: { discussionId: 'opening', offset: 99, pages: 3, tailId: 'oldest' },
} as const;

test('each history entry returns to its last departure from the matching collection', () => {
  const history = new TopicNavigation();
  history.remember('parent', 'ABC', directory);
  history.remember('same-url', 'abc', discussions);
  history.remember('topics', null, directory);
  assert.deepEqual(history.get('parent', 'abc'), directory);
  assert.deepEqual(history.get('same-url', 'ABC'), discussions);
  assert.equal(history.get('parent', 'another-parent'), undefined);
  assert.equal(history.get('parent', null), undefined);
  assert.equal(history.get('topics', 'abc'), undefined);
  assert.deepEqual(history.get('topics', null), directory);
  assert.equal(new TopicNavigation().get('parent', 'abc'), undefined);

  history.remember('parent', 'abc', discussions);
  assert.deepEqual(history.get('parent', 'abc'), discussions);
  history.remember('parent', 'abc', directory);
  assert.deepEqual(history.get('parent', 'abc'), directory);
  history.remember('parent', 'abc', undefined);
  assert.equal(history.get('parent', 'abc'), undefined);
  assert.deepEqual(history.get('same-url', 'abc'), discussions);
});

test('root, subtopic and discussion departures share the sixteen-entry limit', () => {
  const history = new TopicNavigation();
  const collections: Array<[string | null, TopicReturnTarget]> = [
    [null, directory],
    ['parent', discussions],
    ['another-parent', directory],
  ];
  for (let entry = 0; entry < 16; entry++) {
    const [source, target] = collections[entry % collections.length]!;
    history.remember(String(entry), source, target);
  }
  history.remember('0', null, directory);
  history.remember('16', 'parent', discussions);
  assert.equal(history.get('1', 'parent'), undefined);
  assert.deepEqual(history.get('0', null), directory);
  assert.deepEqual(history.get('2', 'another-parent'), directory);
  assert.deepEqual(history.get('16', 'parent'), discussions);
});
