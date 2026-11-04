import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { SearchMaintenanceRecovery } from '../../src/web/search-maintenance-recovery.js';
import { ApiError, invalidateIdentity } from '../../src/web/participation-client.js';
const dom = new JSDOM('', { url: 'https://loom.example/' });
for (const key of ['window', 'navigator', 'location', 'localStorage', 'Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
function locks() {
  let tail = Promise.resolve();
  return {
    request: (_key: string, work: () => any) => {
      const result = tail.then(work);
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
Object.defineProperty(navigator, 'locks', { value: locks(), configurable: true });
afterEach(() => {
  localStorage.clear();
  invalidateIdentity();
  Object.defineProperty(navigator, 'locks', { value: locks(), configurable: true });
});
const request = { kind: 'rebuild', body: { expected_generation: 1 } } as const;
const store = () => new SearchMaintenanceRecovery(randomUUID(), randomUUID());
const failure = () => {
  throw new Error('Synthetic response loss');
};
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, promise };
}
for (const raw of ['invalid', ' '.repeat(2049), '界'.repeat(800), JSON.stringify({ version: 99 })])
  test('malformed or oversized custody cannot be replaced: ' + raw.slice(0, 12), async () => {
    const s = store();
    localStorage.setItem(s.key, raw);
    assert.throws(() => s.read(), /unreadable/);
    let sent = false;
    await assert.rejects(
      s.attempt(
        request,
        0,
        () => true,
        async () => {
          sent = true;
        },
      ),
      /unreadable/,
    );
    assert.equal(sent, false);
    assert.equal(localStorage.getItem(s.key), raw);
  });
test('only the original owner and instance recover a retained exact request; clear preserves sibling storage', async () => {
  const instance = randomUUID(),
    owner = randomUUID(),
    s = new SearchMaintenanceRecovery(instance, owner);
  const result = await s.attempt(
    request,
    0,
    () => true,
    async () => failure(),
  );
  assert.equal(result.record.state, 'uncertain');
  assert.deepEqual(new SearchMaintenanceRecovery(instance, owner).read(), result.record);
  const other = new SearchMaintenanceRecovery(instance, randomUUID()),
    another = new SearchMaintenanceRecovery(randomUUID(), owner);
  assert.equal(other.read(), undefined);
  assert.equal(another.read(), undefined);
  localStorage.setItem(other.key, 'private sibling');
  await s.clear();
  assert.equal(s.read(), undefined);
  assert.equal(localStorage.getItem(other.key), 'private sibling');
});
test('cross-tab pending dispatch is serialized; stale attempts and replacement payloads cannot dispatch', async () => {
  const s = store(),
    hold = barrier(),
    entered = barrier();
  let sends = 0;
  const first = s.attempt(
    request,
    0,
    () => true,
    async () => {
      sends++;
      entered.release();
      await hold.promise;
      failure();
    },
  );
  await entered.promise;
  const other = s.attempt(
    request,
    0,
    () => true,
    async () => {
      sends++;
    },
  );
  const rejected = assert.rejects(other, /Another tab/);
  assert.equal(sends, 1);
  hold.release();
  const result = await first;
  await rejected;
  await assert.rejects(
    s.attempt(
      { kind: 'rebuild', body: { expected_generation: 2 } },
      result.record.sequence,
      () => true,
      async () => {
        sends++;
      },
    ),
    /original maintenance request/,
  );
  assert.equal(sends, 1);
  const replay = await s.attempt(
    request,
    result.record.sequence,
    () => true,
    async () => {
      sends++;
    },
  );
  assert.equal(replay.record.state, 'acknowledged');
  assert.equal(sends, 2);
});
for (const code of [
  'forbidden',
  'unavailable',
  'invalid_input',
  'service_unavailable',
  'search_changed',
])
  test('uncertain ' + code + ' refusal never establishes rollback', async () => {
    const s = store(),
      first = await s.attempt(
        request,
        0,
        () => true,
        async () => failure(),
      );
    const next = await s.attempt(
      request,
      first.record.sequence,
      () => true,
      async () => {
        throw new ApiError(code, 'Synthetic refusal');
      },
    );
    assert.equal(next.record.state, 'uncertain');
    assert.deepEqual(next.record.request, request);
  });
for (const code of ['invalid_input', 'search_changed'])
  test('first ' + code + ' rejection allows a deliberate later guarded request', async () => {
    const s = store(),
      first = await s.attempt(
        request,
        0,
        () => true,
        async () => {
          throw new ApiError(code, 'Synthetic refusal');
        },
      );
    assert.equal(first.record.state, 'rejected');
    const next = await s.attempt(
      { kind: 'rebuild', body: { expected_generation: 2 } },
      first.record.sequence,
      () => true,
      async () => {},
    );
    assert.equal(next.record.state, 'acknowledged');
  });
test('late completion after view or identity loss cannot settle custody', async () => {
  const s = store(),
    hold = barrier(),
    entered = barrier();
  let active = true;
  const pending = s.attempt(
    request,
    0,
    () => active,
    async () => {
      entered.release();
      await hold.promise;
    },
  );
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise;
  active = false;
  hold.release();
  await rejected;
  assert.equal(s.read()!.state, 'uncertain');
  invalidateIdentity();
  await assert.rejects(
    s.attempt(
      request,
      s.read()!.sequence,
      () => true,
      async () => {},
    ),
    { name: 'AbortError' },
  );
  await assert.rejects(s.clear(), { name: 'AbortError' });
});
test('missing locks fail closed for dispatch and cleanup', async () => {
  const s = store();
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  await assert.rejects(
    s.attempt(
      request,
      0,
      () => true,
      async () => {},
    ),
    /Web Locks/,
  );
  await assert.rejects(s.clear(), /Web Locks/);
});
test('acknowledgement custody failure preserves uncertain bytes and never reports successful settlement', async (t) => {
  const s = store();
  const set = localStorage.setItem.bind(localStorage),
    prototype = Object.getPrototypeOf(localStorage);
  t.mock.method(prototype, 'setItem', (key: string, value: string) => {
    if (JSON.parse(value).state === 'acknowledged') throw new Error('Synthetic storage refusal');
    set(key, value);
  });
  const result = await s.attempt(
    request,
    0,
    () => true,
    async () => {},
  );
  assert.equal(result.record.state, 'uncertain');
  assert.equal(s.read()!.state, 'uncertain');
  assert.ok(result.error);
});
test('invalid request shapes and failed removal remain explicit', async (t) => {
  const s = store();
  await assert.rejects(
    s.attempt(
      { kind: 'rebuild', body: { expected_generation: 0 } } as any,
      0,
      () => true,
      async () => {},
    ),
    /limit/,
  );
  await s.attempt(
    request,
    0,
    () => true,
    async () => failure(),
  );
  t.mock.method(Object.getPrototypeOf(localStorage), 'removeItem', () => {});
  await assert.rejects(s.clear(), /could not be cleared/);
  assert.equal(s.read()!.state, 'uncertain');
});
