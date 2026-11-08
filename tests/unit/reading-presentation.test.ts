import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PresentationEpisode } from '../../src/web/reading-presentation.js';

test('manual unread survives partial presence and component replay until a measured full exit', () => {
  const episode = new PresentationEpisode(2);
  const first = Symbol('first');
  episode.presence('revision', first, true);
  episode.manualUnread('revision');
  assert.equal(episode.excludes('revision'), true);
  episode.unregister('revision', first);
  assert.equal(episode.excludes('revision'), true);
  episode.presence('revision', first, true);
  assert.equal(episode.excludes('revision'), true);
  episode.presence('revision', first, false);
  assert.equal(episode.excludes('revision'), false);
  episode.presence('revision', first, true);
  assert.equal(episode.excludes('revision'), false);
});

test('duplicate occurrences need a full measured exit and the tracker remains bounded', () => {
  const episode = new PresentationEpisode(2);
  const first = Symbol('first');
  const second = Symbol('second');
  episode.presence('revision', first, true);
  episode.presence('revision', second, true);
  episode.manualUnread('revision');
  episode.unregister('revision', first);
  assert.equal(episode.excludes('revision'), true);
  episode.presence('revision', second, false);
  assert.equal(episode.excludes('revision'), false);
  episode.presence('other', Symbol('other'), true);
  episode.presence('overflow', Symbol('overflow'), true);
  assert.equal(episode.paused, true);
  assert.equal(episode.excludes('overflow'), true);
});

test('an attempted automatic visit can rearm after exit, without changing manual intent', () => {
  const episode = new PresentationEpisode();
  const occurrence = Symbol('text');
  episode.presence('revision', occurrence, true);
  episode.attempted('revision');
  assert.equal(episode.excludes('revision'), true);
  episode.presence('revision', occurrence, false);
  episode.presence('revision', occurrence, true);
  assert.equal(episode.excludes('revision'), false);
});
