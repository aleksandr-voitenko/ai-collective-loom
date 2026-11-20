import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TopicDiscussionNavigation } from '../../src/web/topic-discussion-navigation.js';

test('topic discussion return controls belong to a specific entry, topic and store lifetime', () => {
  const history = new TopicDiscussionNavigation();
  const position = { discussionId: 'chosen', offset: 99, pages: 3, tailId: 'oldest' };
  history.remember('entry', 'first-topic', position);
  assert.deepEqual(history.get('entry', 'first-topic'), position);
  assert.equal(history.get('another-entry', 'first-topic'), undefined);
  assert.equal(history.get('entry', 'second-topic'), undefined);
  assert.equal(new TopicDiscussionNavigation().get('entry', 'first-topic'), undefined);
  history.remember('entry', 'first-topic', undefined);
  assert.equal(history.get('entry', 'first-topic'), undefined);
});

test('topic discussion return controls evict the oldest of more than sixteen saved entries', () => {
  const history = new TopicDiscussionNavigation();
  const position = { discussionId: 'chosen', offset: 99, pages: 3 };
  for (let entry = 0; entry < 16; entry++) history.remember(String(entry), 'topic', position);
  history.remember('0', 'topic', { ...position, pages: 4 });
  history.remember('16', 'topic', position);
  assert.equal(history.get('1', 'topic'), undefined);
  assert.deepEqual(history.get('0', 'topic'), { ...position, pages: 4 });
  assert.deepEqual(history.get('16', 'topic'), position);
});
