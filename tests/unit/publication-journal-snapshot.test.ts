import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { publicationJournalBytes } from '../helpers/publication-journal-snapshot.js';

const draftKey = 'loom.intent.v1:fixture:draft';
const committedKey = 'loom.intent.v1:fixture:committed';
const draft = '{ "state": "draft", "body": { "text": "café" } }\n';
const committed = '{"state":"committed","body":{"text":"Earlier publication"}}';

function storage(t: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const records: Record<string, string> = { [draftKey]: draft, [committedKey]: committed };
  Object.defineProperty(records, 'getItem', {
    configurable: true,
    value: (key: string) => records[key] ?? null,
  });
  let reversed = false;
  const value = new Proxy(records, {
    ownKeys: (target) => reversed ? Reflect.ownKeys(target).reverse() : Reflect.ownKeys(target),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  return { records, reorder: () => { reversed = true; } };
}

test('journal preservation ignores enumeration changes after an unrelated storage insertion', t => {
  const fixture = storage(t);
  const before = publicationJournalBytes();
  fixture.records['loom.search-maintenance.v1:fixture'] = '{"state":"uncertain"}';
  fixture.reorder();
  assert.deepEqual({ [draftKey]: fixture.records[draftKey], [committedKey]: fixture.records[committedKey] },
    { [draftKey]: draft, [committedKey]: committed }, 'Every original key and stored byte is unchanged');
  assert.deepEqual(publicationJournalBytes(), before);
  assert.deepEqual(before, { [draftKey]: draft, [committedKey]: committed });
});

test('journal preservation detects changed raw bytes even when parsed JSON is identical', t => {
  const fixture = storage(t);
  const before = publicationJournalBytes();
  const compact = JSON.stringify(JSON.parse(draft));
  assert.notEqual(compact, draft);
  assert.deepEqual(JSON.parse(compact), JSON.parse(draft));
  fixture.records[draftKey] = compact;
  assert.notDeepEqual(publicationJournalBytes(), before);
});

for (const mutation of ['content', 'addition', 'removal'] as const)
test('journal preservation detects record ' + mutation, t => {
  const fixture = storage(t);
  const before = publicationJournalBytes();
  if (mutation === 'content') fixture.records[draftKey] = '{"state":"draft","body":{"text":"Changed"}}';
  if (mutation === 'addition') fixture.records['loom.intent.v1:fixture:extra'] = draft;
  if (mutation === 'removal') delete fixture.records[committedKey];
  assert.notDeepEqual(publicationJournalBytes(), before);
});
