import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationStatePreserved as preserved } from '../../scripts/lib/recovery.mjs';
const table = 'loom.participation_rate_windows',
  start = Date.parse('2026-10-26T00:00:10Z'),
  end = start + 10000;
const row = {
  participant_id: 'participant-a',
  category: 'ordinary_requests',
  window_started_at: '2026-10-26T00:00:00Z',
  used: 3,
};
const before = {
  tables: {
    [table]: {
      classification: 'authoritative-captured',
      rows: 2,
      sha256: 'all',
      publicationSha256: 'publication',
      requestWindows: [row],
    },
    policy: { sha256: 'policy' },
    content: { sha256: 'content' },
  },
  buckets: { exact: 'versions' },
};
const allowed = new Map([
  ['participant-a:ordinary_requests', 2],
  ['participant-b:recovery_control', 1],
]);
const candidate = () => {
  const after = structuredClone(before);
  after.tables[table].sha256 = 'charged';
  after.tables[table].requestWindows[0].used = 5;
  return after;
};
test('cold verification permits only bounded authenticated read charges and legal database-time expiry', () => {
  assert.equal(preserved(before, candidate(), allowed, start, end), true);
  const expired = candidate();
  expired.tables[table].requestWindows[0] = {
    ...row,
    window_started_at: '2026-10-26T00:01:10Z',
    used: 2,
  };
  assert.equal(preserved(before, expired, allowed, start + 60000, end + 60000), true);
  const added = candidate();
  added.tables[table].rows++;
  added.tables[table].requestWindows.push({
    participant_id: 'participant-b',
    category: 'recovery_control',
    window_started_at: '2026-10-26T00:00:15Z',
    used: 1,
  });
  assert.equal(preserved(before, added, allowed, start, end), true);
  assert.equal(preserved(before, before, new Map(), start, end), true);
});
for (const [name, mutate] of Object.entries({
  overcharge: (a) => (a.tables[table].requestWindows[0].used = 6),
  decrement: (a) => (a.tables[table].requestWindows[0].used = 2),
  'early reset': (a) =>
    Object.assign(a.tables[table].requestWindows[0], {
      window_started_at: '2026-10-26T00:00:15Z',
      used: 1,
    }),
  'future window': (a) =>
    Object.assign(a.tables[table].requestWindows[0], {
      window_started_at: '2026-10-26T00:02:00Z',
      used: 1,
    }),
  'foreign participant': (a) => (a.tables[table].requestWindows[0].participant_id = 'foreign'),
  'other category': (a) => (a.tables[table].requestWindows[0].category = 'new_publications'),
  'row deletion': (a) => (a.tables[table].requestWindows = []),
  duplicate: (a) => a.tables[table].requestWindows.push({ ...a.tables[table].requestWindows[0] }),
  'extra field': (a) => (a.tables[table].requestWindows[0].surprise = true),
  'row count': (a) => a.tables[table].rows++,
  'publication allowance': (a) => (a.tables[table].publicationSha256 = 'changed'),
  classification: (a) => (a.tables[table].classification = 'ignored'),
  policy: (a) => (a.tables.policy.sha256 = 'changed'),
  content: (a) => (a.tables.content.sha256 = 'changed'),
  'native version': (a) => (a.buckets.exact = 'replaced'),
}))
  test('cold verification rejects ' + name, () => {
    const after = candidate();
    mutate(after);
    assert.equal(preserved(before, after, allowed, start, end), false);
  });
test('cold verification rejects stale-window charging and invalid time bounds', () => {
  assert.equal(preserved(before, candidate(), allowed, start + 60000, end + 60000), false);
  assert.equal(preserved(before, candidate(), allowed, NaN, end), false);
  assert.equal(preserved(before, candidate(), allowed, end, start), false);
});
