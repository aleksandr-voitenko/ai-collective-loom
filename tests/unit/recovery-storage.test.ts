import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { attentionLimits } from '../../src/contracts/attention.js';
import { readingLimits, type ReadingUpdateInput } from '../../src/contracts/reading.js';
import type { SharedPageView } from '../../src/contracts/following.js';
import type { UpdatesPageView } from '../../src/contracts/updates.js';
import { AttentionRecovery, type AttentionCommandView, type AttentionIntent } from '../../src/web/attention-recovery.js';
import { ReadingRecovery, type ReadingIntent } from '../../src/web/reading-recovery.js';
import { SharedRecovery } from '../../src/web/shared-recovery.js';
import { UpdatesRecovery } from '../../src/web/updates-recovery.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';

const dom = new JSDOM('', { url: 'https://loom.example/' });
for (const key of ['window', 'navigator', 'location', 'localStorage', 'Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(navigator, 'locks', { value: { request: async (_name: string, work: () => unknown) => work() }, configurable: true });
afterEach(() => localStorage.clear());
const contents = () => Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b));

type State = { attempts: number; state: 'uncertain' | 'rejected' | 'conflicted' };
type Journal<C, I extends State> = {
  prefix: string;
  all(): I[];
  save(command: C, active: () => boolean): Promise<I>;
  begin(record: I): Promise<I>;
  rejectFirst(record: I): Promise<void>;
  recordConflict(record: I): Promise<void>;
  finish(record: I, resolvedOnly?: boolean): Promise<void>;
  clear(): Promise<void>;
};
function perIntentCases<C, I extends State>(adapter: {
  name: string; event: string;
  limits: { requestBytes: number; localBytes: number; localOperations: number };
  create(instance: string, owner: string): Journal<C, I>;
  command(): C;
  id(command: C): string;
  commandOf(record: I): C;
  change(command: C): C;
  withCommand(record: I, command: C): I;
}) {
  const { name, limits, command } = adapter;
  const journal = () => adapter.create(randomUUID(), randomUUID());
  const keyOf = (store: Journal<C, I>, record: I) => store.prefix + 'intent:' + adapter.id(adapter.commandOf(record));
  function events(t: TestContext) {
    let count = 0;
    const changed = () => { count++; };
    window.addEventListener(adapter.event, changed);
    t.after(() => window.removeEventListener(adapter.event, changed));
    return () => count;
  }

  for (const corruption of ['unreadable', 'schema', 'key', 'oversized', 'multibyte'] as const)
    test(`${name}: ${corruption} recovery blocks mutation and preserves every stored byte`, async () => {
      const store = journal(), saved = await store.save(command(), () => true), key = keyOf(store, saved);
      const raw = corruption === 'unreadable' ? '{' : corruption === 'schema' ? JSON.stringify({ ...saved, version: 2 }) :
        corruption === 'key' ? JSON.stringify(adapter.withCommand(saved, command())) : corruption === 'multibyte'
          ? '界'.repeat(Math.floor(limits.requestBytes / 3) + 1) : 'x'.repeat(limits.requestBytes + 1);
      if (corruption === 'multibyte') assert.ok(raw.length < limits.requestBytes, 'The UTF-8 limit precedes parsing and counts bytes, not code units.');
      localStorage.setItem(key, raw); localStorage.setItem('loom.intent.unrelated', 'preserve');
      const before = contents(), expected = corruption === 'unreadable' ? /unreadable/ : ['oversized', 'multibyte'].includes(corruption) ? /exceeds/ : /incompatible/;
      assert.throws(() => store.all(), expected);
      await assert.rejects(store.save(command(), () => true), expected);
      await assert.rejects(store.clear(), expected);
      assert.deepEqual(contents(), before, 'Unknown command bytes must not be discarded or repaired.');
    });

  test(`${name}: corrupt sibling owners and instances stay independent`, async () => {
    const instance = randomUUID(), owner = randomUUID(), store = adapter.create(instance, owner);
    for (const other of [adapter.create(instance, randomUUID()), adapter.create(randomUUID(), owner)])
      localStorage.setItem(other.prefix + 'intent:' + randomUUID(), '{');
    const before = contents(), saved = await store.save(command(), () => true);
    assert.deepEqual(store.all(), [saved]);
    assert.deepEqual(adapter.create(instance, owner).all(), [saved], 'A replacement client recovers the same exact command.');
    await store.clear(); assert.deepEqual(contents(), before);
  });

  test(`${name}: reusing an operation key cannot replace its exact command`, async () => {
    const store = journal(), saved = await store.save(command(), () => true), before = contents();
    await assert.rejects(store.save(adapter.change(adapter.commandOf(saved)), () => true), /already exists/);
    assert.deepEqual(contents(), before);
  });

  for (const operation of ['begin', 'recordConflict', 'finish'] as const)
    test(`${name}: ${operation} refuses changed same-key bytes`, async () => {
      const store = journal(), saved = await store.save(command(), () => true), before = contents();
      const altered = adapter.withCommand(saved, adapter.change(adapter.commandOf(saved)));
      await assert.rejects(store[operation](altered), /intent changed/);
      assert.deepEqual(contents(), before);
    });

  test(`${name}: resolved-only removal retains uncertainty and late settlement leaves siblings intact`, async () => {
    const store = journal(), saved = await store.save(command(), () => true), sibling = await store.save(command(), () => true), before = contents();
    await assert.rejects(store.finish(saved, true), /intent changed/); assert.deepEqual(contents(), before);
    await store.recordConflict(saved); await assert.rejects(store.begin(saved), /intent changed/);
    await store.finish(saved, true); const after = contents();
    await store.finish(saved); await store.recordConflict(saved); await store.rejectFirst(saved);
    await assert.rejects(store.begin(saved), /intent changed/);
    assert.deepEqual(contents(), after); assert.deepEqual(store.all(), [sibling]);
  });

  for (const departure of ['view', 'identity'] as const)
    test(`${name}: ${departure} departure while queued cannot save a new command`, async t => {
      let release!: () => void, active = true;
      t.mock.method(navigator.locks, 'request', async (_name: string, work: () => unknown) => {
        await new Promise<void>(resolve => { release = resolve; }); return work();
      });
      const store = journal(), before = contents(), count = events(t), pending = store.save(command(), () => active);
      if (departure === 'view') active = false; else invalidateIdentity();
      release(); await assert.rejects(pending, { name: 'AbortError' });
      assert.deepEqual(contents(), before); assert.equal(count(), 0);
    });

  test(`${name}: missing Web Locks leaves recovery readable but refuses mutation`, async t => {
    const store = journal(), saved = await store.save(command(), () => true), before = contents();
    t.mock.property(navigator, 'locks', undefined);
    await assert.rejects(store.begin(saved), /require Web Locks/);
    assert.deepEqual(store.all(), [saved]); assert.deepEqual(contents(), before);
  });

  for (const fault of ['write', 'readback'] as const)
    for (const operation of ['save', 'begin', 'recordConflict'] as const)
      test(`${name}: failed ${operation} ${fault} restores exact raw bytes without an event`, async t => {
        const store = journal(), saved = await store.save(command(), () => true);
        await store.save(command(), () => true); localStorage.setItem('loom.intent.unrelated', 'preserve');
        localStorage.setItem(keyOf(store, saved), JSON.stringify(saved, null, 2) + '\n');
        const before = contents(), count = events(t), setItem = dom.window.Storage.prototype.setItem; let fail = true;
        t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
          if (fail) { fail = false; if (fault === 'write') throw new Error('Synthetic write failure'); setItem.call(this, key, 'incomplete'); }
          else setItem.call(this, key, value);
        });
        const pending = operation === 'save' ? store.save(command(), () => true) : store[operation](saved);
        await assert.rejects(pending, operation === 'recordConflict' ? /conflict could not be saved/ : /intent could not be saved/);
        assert.deepEqual(contents(), before); assert.equal(count(), 0);
      });

  test(`${name}: failed removal preserves recovery and emits no event`, async t => {
    const store = journal(), saved = await store.save(command(), () => true), before = contents(), count = events(t);
    t.mock.method(dom.window.Storage.prototype, 'removeItem', () => { throw new Error('Synthetic removal failure'); });
    await assert.rejects(store.finish(saved), /removal failure/);
    assert.deepEqual(contents(), before); assert.equal(count(), 0);
  });

  test(`${name}: capacity permits replacement; a competing attempt keeps a late refusal uncertain`, async t => {
    const store = journal();
    for (let i = 0; i < limits.localOperations; i++) await store.save(command(), () => true);
    const before = contents(), count = events(t), saved = store.all()[0]!;
    await assert.rejects(store.save(command(), () => true), /full/); assert.deepEqual(contents(), before); assert.equal(count(), 0);
    const first = await store.begin(saved), second = await store.begin(saved);
    await store.rejectFirst(first);
    assert.equal(store.all().length, limits.localOperations);
    assert.deepEqual(store.all()[0], second); assert.equal(second.attempts, 2); assert.equal(count(), 2);
  });

  test(`${name}: raw byte limits include whitespace and reject excess before any mutation`, async () => {
    const store = journal(), saved = await store.save(command(), () => true), key = keyOf(store, saved);
    const raw = JSON.stringify(saved), padded = raw + ' '.repeat(limits.requestBytes - new TextEncoder().encode(raw).length);
    localStorage.setItem(key, padded); assert.deepEqual(store.all(), [saved]);
    localStorage.setItem(key, padded + ' '); const oversized = contents();
    assert.throws(() => store.all(), /exceeds/); await assert.rejects(store.begin(saved), /exceeds/); assert.deepEqual(contents(), oversized);
    localStorage.setItem(key, padded);
    for (let size = limits.requestBytes; size < limits.localBytes; size += limits.requestBytes) {
      const next = adapter.withCommand(saved, command()), encoded = JSON.stringify(next);
      localStorage.setItem(keyOf(store, next), encoded + ' '.repeat(limits.requestBytes - new TextEncoder().encode(encoded).length));
    }
    assert.equal(store.all().length, limits.localBytes / limits.requestBytes);
    const extra = adapter.withCommand(saved, command()); localStorage.setItem(keyOf(store, extra), JSON.stringify(extra));
    const full = contents(); assert.throws(() => store.all(), /exceeds/);
    await assert.rejects(store.clear(), /exceeds/); assert.deepEqual(contents(), full);
  });
}

const readingCommand = (): ReadingUpdateInput => ({ idempotency_key: randomUUID(), basis: 'manual', episode_id: null,
  targets: [{ resource_id: randomUUID(), revision_id: randomUUID(), read: true, expected_version: 0 }] });
perIntentCases<ReadingUpdateInput, ReadingIntent>({ name: 'Reading', event: 'loom-reading', limits: readingLimits,
  create: (instance, owner) => new ReadingRecovery(instance, owner), command: readingCommand,
  id: command => command.idempotency_key, commandOf: record => record.body,
  change: command => ({ ...command, targets: command.targets.map(target => ({ ...target, read: !target.read })) }),
  withCommand: (record, body) => ({ ...record, body }),
});
perIntentCases<AttentionCommandView, AttentionIntent>({ name: 'Attention', event: 'loom-attention', limits: attentionLimits,
  create: (instance, owner) => new AttentionRecovery(instance, owner),
  command: () => ({ kind: 'mute', body: { target: { kind: 'artifact', resource_id: randomUUID() },
    include_descendants: false, muted: true, expected_version: 0, idempotency_key: randomUUID() } }),
  id: command => command.body.idempotency_key, commandOf: record => record.command,
  change: command => ({ ...command, body: { ...command.body, expected_version: 1 } }) as AttentionCommandView,
  withCommand: (record, command) => ({ ...record, command }),
});

test('Reading preference has separate custody and is cleared with only its own journal', async () => {
  const store = new ReadingRecovery(randomUUID(), randomUUID());
  localStorage.setItem('loom.intent.unrelated', 'preserve'); await store.setEnabled(true);
  assert.equal(store.enabled(), true); assert.deepEqual(store.all(), []);
  await store.save(readingCommand(), () => true); await store.clear();
  assert.equal(store.enabled(), false); assert.deepEqual(contents(), [['loom.intent.unrelated', 'preserve']]);
});

test('Attention dismissal selection preserves Unicode at the exact byte limit and refuses excess bytes', async () => {
  const store = new AttentionRecovery(randomUUID(), randomUUID());
  const command = { kind: 'dismissal' as const, body: { idempotency_key: randomUUID(), selection: '',
    inputs: [{ kind: 'shared_event' as const, id: randomUUID(), dismissed: true, expected_version: 0 }] } };
  const overhead = new TextEncoder().encode(JSON.stringify({ version: 1, command, attempts: 0, state: 'uncertain' })).length;
  const available = attentionLimits.requestBytes - overhead;
  command.body.selection = '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  const saved = await store.save(command, () => true);
  assert.equal(new TextEncoder().encode(JSON.stringify(saved)).length, attentionLimits.requestBytes);
  assert.deepEqual(store.all(), [saved]);
  await store.finish(saved); const before = contents();
  const oversized = { ...command, body: { ...command.body, idempotency_key: randomUUID(), selection: command.body.selection + '界' } };
  assert.ok(oversized.body.selection.length < attentionLimits.selectionBytes);
  await assert.rejects(store.save(oversized, () => true), /Attention recovery is full/);
  assert.deepEqual(contents(), before);
});

const sharedPage = (cursor: string): SharedPageView => ({ contract_version: 'shared-changes-1', items: [],
  traversal: { id: randomUUID(), scope: 'following', definitions: [], settings_current: true, selection: 'complete', grouping: 'none',
    order: 'committed_event_ascending', expires_at: '2026-10-17T00:00:00Z', boundaries: 'fixed_shared_interval', history_start: 'retained_history' },
  page_cursor: cursor, next_cursor: 'next', checkpoint: null, page_exhausted: false, interval_complete: false, no_subscriptions: false,
  work_budget_reached: false, coverage: 'known', coverage_limit: null, recovery: 'none', history: 'retained', baseline_established: false,
  inventory: [], omitted_detail: 'full_bodies', limit: 12, max_response_bytes: 131072 });
const updatesPage = (cursor: string): UpdatesPageView => ({ contract_version: 'combined-updates-1', stage: 'ready', items: [],
  traversal: { id: randomUUID(), scope: 'following', definitions: [], reason: 'all', selection: 'highlights', settings_current: true,
    grouping: 'ownership; area_event', order: 'direct_first; frozen_recent_then_identity', expires_at: '2026-10-17T00:00:00Z',
    shared: { contract: 'shared-changes-1', lower: 'sl', upper: 'su', scan_complete: true, coverage: 'known', history: 'retained' },
    personal: { contract: 'personal-attention-1', lower: 'pl', upper: 'pu', scan_complete: true, coverage: 'known', history: 'retained' } },
  page_cursor: cursor, next_cursor: 'next', checkpoint: null, complete_cursor: 'complete', direct_cursor: 'direct', records_cursor: 'records',
  page_exhausted: false, selection_exhausted: false, grouped_interval_complete: false, member_metadata_complete: false, full_contents_fetched: false,
  projection: { state: 'complete', coverage: 'currently_eligible_supported_sources' }, work_budget_reached: false, recovery: 'none',
  baseline_established: false, inventory: [], limit: 12, max_response_bytes: 131072 });

for (const mode of ['Shared', 'Updates', 'Routine Updates'] as const) {
  function journal() {
    const instance = randomUUID(), owner = randomUUID();
    if (mode === 'Shared') {
      const store = new SharedRecovery(instance, owner);
      return { prefix: store.prefix, read: () => store.read('view'), save: (expected: number) => store.save('view', sharedPage('page-' + expected), expected, () => true) };
    }
    const store = new UpdatesRecovery(instance, owner, localStorage, mode === 'Routine Updates');
    return { prefix: store.prefix, read: () => store.read('view'), save: (expected: number) => store.save('view', updatesPage('page-' + expected), expected, () => true, []) };
  }
  for (const existing of [false, true])
    for (const fault of ['write', 'readback'] as const)
      test(`${mode}: failed ${existing ? 'successor' : 'first page'} ${fault} preserves exact map custody`, async t => {
        const store = journal();
        if (existing) {
          await store.save(0);
          localStorage.setItem(store.prefix, JSON.stringify(JSON.parse(localStorage.getItem(store.prefix)!), null, 2) + '\n');
        }
        localStorage.setItem('loom.intent.unrelated', 'preserve');
        const before = contents(), setItem = dom.window.Storage.prototype.setItem; let fail = true;
        t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
          if (fail) { fail = false; if (fault === 'write') throw new Error('Synthetic write failure'); setItem.call(this, key, 'incomplete'); }
          else setItem.call(this, key, value);
        });
        await assert.rejects(store.save(existing ? 1 : 0), /recovery could not be saved.*successor has not been exposed/);
        assert.deepEqual(contents(), before);
        assert.equal(store.read()?.sequence, existing ? 1 : undefined);
      });
}
