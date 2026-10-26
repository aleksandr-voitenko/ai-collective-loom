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

test('cold verification accepts only correlated verifier observations and bounded expiry/replacement', async () => {
  const {createHash} = await import('node:crypto');
  const capture='loom.operational_capture', samples='loom.operational_observations';
  const table = records => {const observationRows=records.map(row=>({row:JSON.stringify(row)})).sort((a,b)=>a.row.localeCompare(b.row));return {classification:'observational-captured',rows:records.length,sha256:createHash('sha256').update(JSON.stringify(observationRows)).digest('hex'),observationRows};};
  const prior={...before,tables:{...before.tables,[capture]:table([{id:1,position:0,admitted_at:null}]),[samples]:table([])}};
  const sample={slot:1,position:1,request_id:'server-request',observed_at:new Date(start+500).toISOString(),family:'administration',code:'forbidden',status:403};
  const next=()=>({...prior,tables:{...prior.tables,[capture]:table([{id:1,position:1,admitted_at:sample.observed_at}]),[samples]:table([sample])}});
  const observed=new Map([[sample.request_id,{family:sample.family,code:sample.code,status:sample.status}]]);
  assert.equal(preserved(prior,next(),new Map(),start,end,observed),true);
  assert.equal(preserved(prior,next(),new Map(),start,end),false);
  for(const mutation of [r=>({...r,code:'idempotency_conflict'}),r=>({...r,request_id:'foreign'}),r=>({...r,slot:2}),r=>({...r,position:2}),r=>({...r,body:'private'}),r=>({...r,observed_at:new Date(end+1).toISOString()})]){
    const altered=next();altered.tables[samples]=table([mutation(sample)]);assert.equal(preserved(prior,altered,new Map(),start,end,observed),false);
  }
  const old={...sample,slot:0,position:0,request_id:'retained',observed_at:new Date(start-1000).toISOString()};
  const existing={...prior,tables:{...prior.tables,[samples]:table([old])}};
  assert.equal(preserved(existing,next(),new Map(),start,end,observed),false,'cannot discard a retained sample');
  const expired={...existing,tables:{...existing.tables,[samples]:table([{...old,observed_at:new Date(start-86400001).toISOString()}])}};
  assert.equal(preserved(expired,next(),new Map(),start,end,observed),true);
  const extra=next();extra.tables.content={sha256:'changed'};assert.equal(preserved(prior,extra,new Map(),start,end,observed),false);
});
