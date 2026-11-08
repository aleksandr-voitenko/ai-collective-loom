import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import assert from 'node:assert/strict';
import { test, afterEach, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import {
  ReadingProvider,
  ReadingText,
  ReadingMarkUnread,
  ReadingPageViewComponent,
  useReadingSession,
} from '../../src/web/Reading.js';
import { ReadingRecovery } from '../../src/web/reading-recovery.js';
import { readingLimits } from '../../src/contracts/reading.js';
import { viewportPresentation } from '../../src/web/reading-presentation.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://loom.example/',
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'MutationObserver',
  'location',
  'localStorage',
  'Event',
  'CustomEvent',
  'StorageEvent',
] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'innerWidth', { value: 1000, configurable: true });
Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true });
Object.defineProperty(navigator, 'locks', {
  value: { request: async (_name: string, work: () => unknown) => work() },
  configurable: true,
});
const { render, screen, fireEvent, cleanup, act, waitFor, within } =
  await import('@testing-library/react');
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const target = { resource_id: randomUUID(), revision_id: randomUUID() };
function mount(
  t: TestContext,
  automatic: boolean | 'default' | 'invalid' = false,
  targets = [target],
) {
  const context = {
    community: { instance_id: randomUUID() },
    self: { participant_id: randomUUID(), csrf: 'fixture' },
  } as Context;
  const recovery = new ReadingRecovery(context.community.instance_id, context.self.participant_id);
  if (automatic !== 'default') localStorage.setItem(recovery.preference, String(automatic));
  let session: ReturnType<typeof useReadingSession>;
  function Commands() {
    session = useReadingSession();
    return null;
  }
  const calls: { path: string; body: any; finish: (r: Response) => void }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (path: string, options: any) =>
      new Promise<Response>((finish) =>
        calls.push({ path, body: JSON.parse(options.body), finish }),
      ),
  );
  const router = createMemoryRouter(
    [
      {
        path: '/read',
        element: (
          <ReadingProvider context={context}>
            <AuthorizationBoundary>
              <Commands />
              {targets.map((target) => (
                <div className="test-message" key={target.revision_id}>
                  <ReadingText
                    target={target}
                    content={{
                      format: 'loom-markdown-v1',
                      text: 'Exact readable text',
                      mentions: [],
                    }}
                    participants={[]}
                  />
                  <details open>
                    <summary>More</summary>
                    <ReadingMarkUnread target={target} />
                  </details>
                </div>
              ))}
              <ReadingPageViewComponent />
            </AuthorizationBoundary>
          </ReadingProvider>
        ),
      },
      { path: '/other', element: <h1>Other</h1> },
    ],
    { initialEntries: ['/read'] },
  );
  t.after(() => router.dispose());
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return {
    context,
    recovery,
    calls,
    router,
    get session() {
      return session!;
    },
  };
}
const page = (read = false, version = 0) => ({
  scope: 'own_exact_revisions',
  items: [{ ...target, read, version, availability: 'available' }],
});
function presentedFixture(t: TestContext) {
  const hidden = new Set<string>();
  t.mock.method(document, 'hasFocus', () => true);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
    const id = this.closest('[data-reading-target]')?.getAttribute('data-reading-target');
    const top =
      id && hidden.has(id) ? 900 : this === document.querySelectorAll('.prose')[1] ? 250 : 100;
    return {
      top,
      left: 0,
      bottom: top + 100,
      right: 500,
      width: 500,
      height: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
  Object.defineProperty(document, 'elementFromPoint', {
    value: (_x: number, y: number) => document.querySelectorAll('.prose')[y >= 250 ? 1 : 0],
    configurable: true,
  });
  return {
    hide: (id: string) => {
      hidden.add(id);
      fireEvent.scroll(window);
    },
    show: (id: string) => {
      hidden.delete(id);
      fireEvent.scroll(window);
    },
  };
}
function selectivelyPresentedFixture(t: TestContext, qualified: Set<string>) {
  t.mock.method(document, 'hasFocus', () => true);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(globalThis, 'innerHeight', { value: 20000, configurable: true });
  t.after(() =>
    Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true }),
  );
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
    const index = [...document.querySelectorAll('.prose')].indexOf(this);
    const top = 100 + index * 110;
    return {
      top,
      left: 0,
      bottom: top + 100,
      right: 500,
      width: 500,
      height: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
  Object.defineProperty(document, 'elementFromPoint', {
    value: (_x: number, y: number) => {
      const prose = document.querySelectorAll<HTMLElement>('.prose')[Math.floor((y - 100) / 110)];
      return qualified.has(
        prose?.closest('[data-reading-target]')?.getAttribute('data-reading-target') ?? '',
      )
        ? prose
        : null;
    },
    configurable: true,
  });
}
async function twoAutomatic(t: TestContext) {
  const visibility = presentedFixture(t);
  const other = { resource_id: randomUUID(), revision_id: randomUUID() };
  const f = mount(t, true, [target, other]);
  await waitFor(() =>
    assert.ok(
      f.calls.some((call) => call.path.endsWith('/lookup') && call.body.targets.length === 2),
    ),
  );
  await act(async () => {
    for (const call of f.calls.filter((entry) => entry.path.endsWith('/lookup')))
      call.finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, other].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      );
  });
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/state'))), {
    timeout: 4000,
  });
  const original = f.calls.find((call) => call.path.endsWith('/state'))!;
  assert.equal(original.body.basis, 'presentation');
  assert.equal(original.body.targets.length, 2);
  return { ...f, other, original, visibility };
}
function receipt(
  command: { body: any },
  operation_state: 'applied' | 'version_conflict',
  current: any[],
) {
  return Response.json({
    operation_state,
    operation_id: randomUUID(),
    idempotency: 'created',
    outcome: {
      basis: command.body.basis,
      episode_id: command.body.episode_id,
      targets: command.body.targets.map((member: any) => ({
        ...member,
        result_version:
          current.find((item) => item.revision_id === member.revision_id)?.version ?? 0,
      })),
    },
    current,
  });
}
async function settle(calls: ReturnType<typeof mount>['calls'], read = false, version = 0) {
  await waitFor(() => assert.ok(calls.some((c) => c.path.endsWith('/lookup'))));
  await act(async () => {
    for (const c of calls.filter((c) => c.path.endsWith('/lookup')))
      c.finish(Response.json(page(read, version)));
  });
  await waitFor(() =>
    assert.equal(
      (screen.getByRole('button', { name: 'Mark unread' }) as HTMLButtonElement).disabled,
      false,
    ),
  );
}
test('missing preference enables automation, explicit opt-out stays off, and invalid storage pauses', async (t) => {
  const visibility = presentedFixture(t);
  const f = mount(t, 'default');
  assert.equal(f.recovery.enabled(), true);
  await settle(f.calls);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1),
  );
  visibility.hide(target.revision_id);
  const another = new ReadingRecovery(randomUUID(), randomUUID());
  localStorage.setItem(another.preference, 'false');
  assert.equal(another.enabled(), false);
  localStorage.setItem(another.preference, 'invalid');
  assert.throws(() => another.enabled(), /preference is invalid/);
  const inaccessible = new ReadingRecovery(randomUUID(), randomUUID(), {
    getItem() {
      throw new Error('Storage unavailable');
    },
  } as unknown as Storage);
  assert.throws(() => inaccessible.enabled(), /Storage unavailable/);
});

test('invalid preference and a silently failed opt-in cannot enable browser writes', async (t) => {
  presentedFixture(t);
  const f = mount(t, 'invalid');
  await settle(f.calls);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 0);
  assert.ok(screen.getAllByText(/Reading preference is invalid/).length);
  const storage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  } as unknown as Storage;
  const journal = new ReadingRecovery(randomUUID(), randomUUID(), storage);
  await assert.rejects(journal.setEnabled(true), /could not be saved/);
});

test('brief valid main-text appearance remains queued after ordinary scrolling away', async (t) => {
  const visibility = presentedFixture(t);
  const f = mount(t, true);
  await settle(f.calls);
  visibility.hide(target.revision_id);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1),
  );
  assert.equal(f.calls.find((call) => call.path.endsWith('/state'))!.body.basis, 'presentation');
});
test('More keeps its focused Mark unread action after successful marking', async (t) => {
  const f = mount(t);
  const details = document.querySelector<HTMLDetailsElement>('.test-message details')!;
  await settle(f.calls);
  const button = screen.getByRole('button', { name: 'Mark unread' });
  button.focus();
  await act(async () => fireEvent.click(button));
  await waitFor(() => assert.ok(f.calls.some((c) => c.path.endsWith('/state'))));
  const command = f.calls.find((c) => c.path.endsWith('/state'))!;
  await act(async () =>
    command.finish(
      Response.json({
        operation_state: 'applied',
        operation_id: randomUUID(),
        idempotency: 'created',
        outcome: {
          basis: 'manual',
          episode_id: null,
          targets: [{ ...command.body.targets[0], result_version: 1 }],
        },
        current: page(false, 1).items,
      }),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 0));
  assert.equal(details.open, true, 'Successful marking does not close More');
  assert.ok(document.activeElement === button);
});
test('reading lookup withdrawal clears its text host while a pending private command settles and a fresh read recovers', async (t) => {
  const f = mount(t);
  await settle(f.calls);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() => assert.ok(f.calls.some((c) => c.path.endsWith('/state'))));
  const command = f.calls.find((c) => c.path.endsWith('/state'))!,
    frozen = JSON.stringify(f.recovery.all()[0]!.body),
    before = f.calls.length;
  await act(async () => f.session.refresh());
  await waitFor(() => assert.ok(f.calls.length > before));
  await act(async () =>
    f.calls
      .at(-1)!
      .finish(
        Response.json(
          { error: { code: 'unavailable', message: 'Source denied' } },
          { status: 404 },
        ),
      ),
  );
  assert.equal(!!screen.queryByText('Exact readable text'), false);
  assert.equal(JSON.stringify(f.recovery.all()[0]!.body), frozen);
  await act(async () =>
    command.finish(
      Response.json({
        operation_state: 'applied',
        operation_id: randomUUID(),
        idempotency: 'created',
        outcome: {
          basis: 'manual',
          episode_id: null,
          targets: [{ ...command.body.targets[0], result_version: 1 }],
        },
        current: page(false, 1).items,
      }),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 0));
  assert.equal(!!screen.queryByText('Exact readable text'), false);
  const deniedCount = f.calls.length;
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Retry protected view' })),
  );
  await waitFor(() => assert.ok(f.calls.length > deniedCount));
  await act(async () => f.calls.at(-1)!.finish(Response.json(page(false, 1))));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole('button', { name: 'Mark unread' }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  assert.ok(screen.getByText('Exact readable text'));
});
test('StrictMode saves exact manual unread before dispatch; old status cannot replace a newer state', async (t) => {
  const f = mount(t);
  await settle(f.calls);
  const button = screen.getByRole('button', { name: 'Mark unread' });
  button.focus();
  await act(async () => fireEvent.click(button));
  await waitFor(() => assert.ok(f.calls.some((c) => c.path.endsWith('/state'))));
  const sent = f.calls.find((c) => c.path.endsWith('/state'))!;
  assert.deepEqual(f.recovery.all()[0]!.body, sent.body);
  assert.equal(sent.body.targets[0].expected_version, 0);
  await act(async () =>
    sent.finish(
      Response.json({
        operation_state: 'applied',
        operation_id: randomUUID(),
        idempotency: 'created',
        outcome: {
          basis: 'manual',
          episode_id: null,
          targets: [{ ...sent.body.targets[0], result_version: 1 }],
        },
        current: page(false, 1).items,
      }),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 0));
  await act(async () => f.session.refresh());
  await waitFor(() => assert.ok(f.calls.filter((c) => c.path.endsWith('/lookup')).length >= 2));
  const lookups = f.calls.filter((c) => c.path.endsWith('/lookup'));
  await act(async () => lookups.at(-1)!.finish(Response.json(page(false, 2))));
  await act(async () => {
    for (const c of lookups.slice(0, -1)) c.finish(Response.json(page(true, 1)));
  });
  await waitFor(() =>
    assert.equal(
      document.querySelector('[data-reading-version]')!.getAttribute('data-reading-version'),
      '2',
    ),
  );
  assert.ok(screen.getByText('Unread'));
  assert.equal(document.activeElement, button);
});
for (const conflictFirst of [true, false])
  test(`conflict feedback belongs to its exact revision and survives ${conflictFirst ? 'a later unrelated success' : 'an earlier unrelated success'}, refresh and reopening`, async (t) => {
    const other = { resource_id: randomUUID(), revision_id: randomUUID() },
      targets = [target, other],
      f = mount(t, false, targets);
    const controls = (source: typeof target) =>
      within(
        document
          .querySelector<HTMLElement>(`[data-reading-target="${source.revision_id}"]`)!
          .closest<HTMLElement>('.test-message')!,
      );
    const lookup = (version: number) => ({
      scope: 'own_exact_revisions',
      items: targets.map((source, index) => ({
        ...source,
        read: version > 0 && index === 1,
        version,
        availability: 'available',
      })),
    });
    await waitFor(() => assert.ok(f.calls.some((c) => c.path.endsWith('/lookup'))));
    await act(async () => {
      for (const c of f.calls.filter((c) => c.path.endsWith('/lookup')))
        c.finish(Response.json(lookup(0)));
    });
    await waitFor(() => assert.ok(f.session.states.get(target.revision_id)?.item));
    await act(async () => {
      for (const source of targets)
        void f.session.mark([{ ...source, read: true, expected_version: 0 }], 'manual');
    });
    await waitFor(() => assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 2));
    const commands = f.calls.filter((c) => c.path.endsWith('/state'));
    for (const index of conflictFirst ? [0, 1] : [1, 0]) {
      const command = commands[index]!;
      await act(async () =>
        command.finish(
          Response.json({
            operation_state: index === 0 ? 'version_conflict' : 'applied',
            operation_id: randomUUID(),
            idempotency: 'created',
            outcome: {
              basis: 'manual',
              episode_id: null,
              targets: command.body.targets.map((v: any) => ({ ...v, result_version: 1 })),
            },
            current: [lookup(1).items[index]],
          }),
        ),
      );
    }
    await waitFor(() => assert.ok(controls(target).queryByText(/Reading change conflicted/)));
    assert.equal(!!controls(other).queryByText(/Reading change conflicted/), false);
    const retained = f.recovery.all();
    assert.equal(retained.length, 1);
    assert.deepEqual(retained[0]!.body, commands[0]!.body);
    assert.equal(retained[0]!.state, 'conflicted');
    await act(async () => f.session.refresh());
    await waitFor(() => assert.ok(f.calls.filter((c) => c.path.endsWith('/lookup')).length >= 2));
    await act(async () => {
      for (const c of f.calls.filter((c) => c.path.endsWith('/lookup')))
        c.finish(Response.json(lookup(1)));
    });
    assert.ok(controls(target).queryByText(/Reading change conflicted/));
    await act(async () => f.router.navigate('/other'));
    await act(async () => f.router.navigate('/read'));
    await waitFor(() => assert.ok(controls(target).queryByText(/Reading change conflicted/)));
    assert.equal(!!controls(other).queryByText(/Reading change conflicted/), false);
    assert.equal(
      f.calls.filter((c) => c.path.endsWith('/state')).length,
      2,
      'Reopening must not retry a recorded conflict',
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss reading conflict' })),
    );
    await waitFor(() =>
      assert.equal(!!controls(target).queryByText(/Reading change conflicted/), false),
    );
    assert.equal(f.recovery.all().length, 0);
  });
test('failed local save and failed lookup leave source readable and unrelated publication custody intact', async (t) => {
  const f = mount(t);
  await settle(f.calls);
  localStorage.setItem('loom.intent.unrelated', 'preserve');
  const original = dom.window.Storage.prototype.setItem;
  t.mock.method(
    dom.window.Storage.prototype,
    'setItem',
    function (this: Storage, key: string, value: string) {
      if (key.includes('intent:')) throw new Error('storage full');
      original.call(this, key, value);
    },
  );
  await act(
    async () => void f.session.mark([{ ...target, read: true, expected_version: 0 }], 'manual'),
  );
  await waitFor(() => assert.ok(screen.getAllByText(/could not be saved/).length));
  assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 0);
  assert.equal(localStorage.getItem('loom.intent.unrelated'), 'preserve');
  assert.equal(f.recovery.all().length, 0);
  await act(async () => f.session.refresh());
  await waitFor(() => assert.ok(f.calls.length >= 2));
  await act(async () =>
    f.calls
      .at(-1)!
      .finish(
        Response.json(
          { error: { code: 'service_unavailable', message: 'Status unavailable' } },
          { status: 503 },
        ),
      ),
  );
  await waitFor(() => assert.ok(screen.getByText('Reading status unavailable')));
  assert.ok(screen.getByText('Exact readable text'));
});
test('late route and identity responses cannot create progress or repopulate cleared recovery', async (t) => {
  const f = mount(t, true);
  await waitFor(() => assert.ok(f.calls.length));
  await act(async () => f.router.navigate('/other'));
  await act(async () => {
    for (const call of f.calls) call.finish(Response.json(page()));
  });
  assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 0);
  assert.equal(f.recovery.all().length, 0);
  await act(async () => f.router.navigate('/read'));
  await waitFor(() => assert.ok(f.calls.length >= 2));
  await act(async () => {
    invalidateIdentity();
    f.calls.at(-1)!.finish(Response.json(page()));
  });
  assert.equal(f.recovery.all().length, 0);
  assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 0);
});
test('qualified revisions share one automatic presentation request', async (t) => {
  t.mock.method(document, 'hasFocus', () => true);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
    const top = this === document.querySelectorAll('.prose')[1] ? 250 : 100;
    return {
      top,
      left: 0,
      bottom: top + 100,
      right: 500,
      width: 500,
      height: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
  Object.defineProperty(document, 'elementFromPoint', {
    value: (_x: number, y: number) => document.querySelectorAll('.prose')[y >= 250 ? 1 : 0],
    configurable: true,
  });
  const other = { resource_id: randomUUID(), revision_id: randomUUID() };
  const f = mount(t, true, [target, other]);
  await waitFor(() =>
    assert.ok(f.calls.some((c) => c.path.endsWith('/lookup') && c.body.targets.length === 2)),
  );
  await act(async () => {
    for (const call of f.calls.filter((c) => c.path.endsWith('/lookup')))
      call.finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, other].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      );
  });
  await waitFor(() => assert.ok(f.calls.some((c) => c.path.endsWith('/state'))), {
    timeout: 4000,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const presentations = f.calls.filter((c) => c.path.endsWith('/state'));
  assert.equal(presentations.length, 1);
  assert.equal(presentations[0]!.body.basis, 'presentation');
  assert.deepEqual(
    presentations[0]!.body.targets.map((v: any) => v.revision_id).sort(),
    [target.revision_id, other.revision_id].sort(),
  );
});
test('manual unread dispatches beside a held frozen batch and keeps its exact body', async (t) => {
  const f = await twoAutomatic(t);
  const frozen = JSON.stringify(f.recovery.all()[0]!.body);
  const controls = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  await act(async () => fireEvent.click(controls.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const manual = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  assert.equal(manual.body.basis, 'manual');
  assert.equal(JSON.stringify(f.original.body), frozen);
  assert.equal(
    JSON.stringify(f.recovery.all().find((record) => record.body.basis === 'presentation')!.body),
    frozen,
  );
  await act(async () =>
    f.original.finish(
      receipt(
        f.original,
        'applied',
        [target, f.other].map((source) => ({
          ...source,
          read: true,
          version: 1,
          availability: 'available',
        })),
      ),
    ),
  );
  await act(async () =>
    manual.finish(
      receipt(manual, 'applied', [
        { ...target, read: false, version: 2, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(
      document
        .querySelector(`[data-reading-target="${target.revision_id}"]`)
        ?.getAttribute('data-reading-version'),
      '2',
    ),
  );
  assert.ok(controls.getByText('Unread'));
});
test('manual unread during pre-freeze custody removes only its candidate', async (t) => {
  presentedFixture(t);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (reached = resolve));
  let first = true;
  let tail = Promise.resolve();
  t.mock.method(navigator.locks!, 'request', (_name: string, work: () => unknown) => {
    const run = tail.then(async () => {
      if (first) {
        first = false;
        reached();
        await gate;
      }
      return work();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
  const other = { resource_id: randomUUID(), revision_id: randomUUID() };
  const f = mount(t, true, [target, other]);
  await waitFor(() =>
    assert.ok(
      f.calls.some((call) => call.path.endsWith('/lookup') && call.body.targets.length === 2),
    ),
  );
  await act(async () =>
    f.calls
      .find((call) => call.path.endsWith('/lookup'))!
      .finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, other].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      ),
  );
  await waiting;
  const a = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  await act(async () => fireEvent.click(a.getByRole('button', { name: 'Mark unread' })));
  await act(async () => release());
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/state'))));
  const automatic = f.calls.find((call) => call.path.endsWith('/state'))!;
  assert.equal(automatic.body.basis, 'presentation');
  assert.deepEqual(automatic.body.targets, [{ ...other, read: true, expected_version: 0 }]);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state'))[1]!.body.basis, 'manual');
});

test('atomic automatic refusal continues only unchanged B with a new key and retains A conflict', async (t) => {
  const f = await twoAutomatic(t);
  await act(async () =>
    f.original.finish(
      receipt(f.original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...f.other, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const continuation = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  assert.notEqual(continuation.body.idempotency_key, f.original.body.idempotency_key);
  assert.equal(continuation.body.episode_id, f.original.body.episode_id);
  assert.deepEqual(continuation.body.targets, [{ ...f.other, read: true, expected_version: 0 }]);
  await act(async () =>
    continuation.finish(
      receipt(continuation, 'applied', [
        { ...f.other, read: true, version: 1, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 1));
  const retained = f.recovery.all()[0]!;
  assert.equal(retained.state, 'conflicted');
  assert.deepEqual(retained.body, f.original.body);
  assert.deepEqual(retained.superseded_revisions, [f.other.revision_id]);
  const a = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  const b = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${f.other.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  assert.ok(a.queryByText(/Reading change conflicted/));
  assert.equal(!!b.queryByText(/Reading change conflicted/), false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
});

test('manual Unread wins A, B continues, and A re-enters with a fresh version and key', async (t) => {
  const f = await twoAutomatic(t);
  const a = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  await act(async () => fireEvent.click(a.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const manual = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  await act(async () =>
    manual.finish(
      receipt(manual, 'applied', [
        { ...target, read: false, version: 1, availability: 'available' },
      ]),
    ),
  );
  await act(async () =>
    f.original.finish(
      receipt(f.original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...f.other, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 3),
  );
  const continuation = f.calls.filter((call) => call.path.endsWith('/state'))[2]!;
  assert.deepEqual(continuation.body.targets, [{ ...f.other, read: true, expected_version: 0 }]);
  await act(async () =>
    continuation.finish(
      receipt(continuation, 'applied', [
        { ...f.other, read: true, version: 1, availability: 'available' },
      ]),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 3);
  f.visibility.hide(target.revision_id);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  f.visibility.show(target.revision_id);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 4),
  );
  const fresh = f.calls.filter((call) => call.path.endsWith('/state'))[3]!;
  assert.notEqual(fresh.body.idempotency_key, f.original.body.idempotency_key);
  assert.notEqual(fresh.body.idempotency_key, continuation.body.idempotency_key);
  assert.deepEqual(fresh.body.targets, [{ ...target, read: true, expected_version: 1 }]);
  assert.deepEqual(
    f.recovery
      .all()
      .find((record) => record.body.idempotency_key === f.original.body.idempotency_key)?.body,
    f.original.body,
  );
});

test('an unresolved automatic operation cannot be bypassed by leaving and re-entering', async (t) => {
  const f = await twoAutomatic(t);
  await act(async () =>
    f.original.finish(
      Response.json(
        {
          error: { code: 'service_unavailable', message: 'Synthetic uncertain outcome' },
        },
        { status: 503 },
      ),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all()[0]?.state, 'uncertain'));
  f.visibility.hide(target.revision_id);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  f.visibility.show(target.revision_id);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1);
});

test('an old cross-tab Unread notification is consumed once; a new intent holds the new visit', async (t) => {
  const visibility = presentedFixture(t);
  const f = mount(t, true);
  await settle(f.calls);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1),
  );
  const first = f.calls.find((call) => call.path.endsWith('/state'))!;
  await act(async () =>
    first.finish(
      receipt(first, 'applied', [{ ...target, read: true, version: 1, availability: 'available' }]),
    ),
  );
  const intent = (key: string) => ({
    version: 1,
    body: {
      idempotency_key: key,
      basis: 'manual',
      episode_id: null,
      targets: [{ ...target, read: false, expected_version: 1 }],
    },
    attempts: 1,
    state: 'uncertain',
  });
  const oldKey = randomUUID();
  const announce = async (key: string) =>
    act(async () =>
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: f.recovery.prefix + 'intent:' + key,
          newValue: JSON.stringify(intent(key)),
        }),
      ),
    );
  await announce(oldKey);
  await act(async () => f.session.refresh());
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/lookup')).length, 2),
  );
  await act(async () =>
    f.calls
      .filter((call) => call.path.endsWith('/lookup'))[1]!
      .finish(Response.json(page(false, 2))),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1);
  visibility.hide(target.revision_id);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  visibility.show(target.revision_id);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const fresh = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  assert.deepEqual(fresh.body.targets, [{ ...target, read: true, expected_version: 2 }]);
  await announce(oldKey);
  await act(async () =>
    fresh.finish(
      receipt(fresh, 'applied', [{ ...target, read: true, version: 3, availability: 'available' }]),
    ),
  );
  await announce(randomUUID());
  await act(async () => f.session.refresh());
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/lookup')).length, 3),
  );
  await act(async () =>
    f.calls
      .filter((call) => call.path.endsWith('/lookup'))[2]!
      .finish(Response.json(page(false, 4))),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
});
test('fresh work ahead of a continuation cannot give it a second continuation', async (t) => {
  const b = { resource_id: randomUUID(), revision_id: randomUUID() };
  const c = { resource_id: randomUUID(), revision_id: randomUUID() };
  const qualified = new Set([target.revision_id, b.revision_id]);
  selectivelyPresentedFixture(t, qualified);
  const f = mount(t, true, [target, b, c]);
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/lookup'))));
  await act(async () => {
    for (const call of f.calls.filter((entry) => entry.path.endsWith('/lookup')))
      call.finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, b, c].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      );
  });
  await waitFor(
    () => assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1),
    {
      timeout: 4000,
    },
  );
  const original = f.calls.find((call) => call.path.endsWith('/state'))!;
  assert.deepEqual(
    original.body.targets.map((member: { revision_id: string }) => member.revision_id).sort(),
    [target.revision_id, b.revision_id].sort(),
  );
  qualified.add(c.revision_id);
  await new Promise((resolve) => setTimeout(resolve, 1250));
  await act(async () =>
    original.finish(
      receipt(original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...b, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const continuation = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  assert.deepEqual(
    continuation.body.targets.map((member: any) => member.revision_id),
    [b.revision_id],
  );
  await act(async () =>
    continuation.finish(
      receipt(continuation, 'version_conflict', [
        { ...b, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 3),
  );
  const fresh = f.calls.filter((call) => call.path.endsWith('/state'))[2]!;
  assert.deepEqual(
    fresh.body.targets.map((member: any) => member.revision_id),
    [c.revision_id],
  );
  await act(async () =>
    fresh.finish(
      receipt(fresh, 'version_conflict', [
        { ...c, read: false, version: 1, availability: 'available' },
      ]),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    f.calls.filter(
      (call) =>
        call.path.endsWith('/state') &&
        call.body.targets.some((member: any) => member.revision_id === b.revision_id),
    ).length,
    2,
  );
});
test('a continuation ahead of fresh work leaves the fresh members their first allowance', async (t) => {
  const b = { resource_id: randomUUID(), revision_id: randomUUID() };
  const c = { resource_id: randomUUID(), revision_id: randomUUID() };
  const d = { resource_id: randomUUID(), revision_id: randomUUID() };
  const qualified = new Set([target.revision_id, b.revision_id]);
  selectivelyPresentedFixture(t, qualified);
  const f = mount(t, true, [target, b, c, d]);
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/lookup'))));
  await act(async () => {
    for (const call of f.calls.filter((entry) => entry.path.endsWith('/lookup')))
      call.finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, b, c, d].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      );
  });
  await waitFor(
    () => assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1),
    {
      timeout: 4000,
    },
  );
  const original = f.calls.find((call) => call.path.endsWith('/state'))!;
  const realSetTimeout = setTimeout;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  await act(async () =>
    original.finish(
      receipt(original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...b, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  qualified.add(c.revision_id);
  qualified.add(d.revision_id);
  await new Promise((resolve) => realSetTimeout(resolve, 1250));
  await act(async () => t.mock.timers.tick(0));
  t.mock.timers.reset();
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
  const bContinuation = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  assert.deepEqual(
    bContinuation.body.targets.map((member: any) => member.revision_id),
    [b.revision_id],
  );
  await act(async () =>
    bContinuation.finish(
      receipt(bContinuation, 'applied', [
        { ...b, read: true, version: 1, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 3),
  );
  const fresh = f.calls.filter((call) => call.path.endsWith('/state'))[2]!;
  assert.deepEqual(
    fresh.body.targets.map((member: any) => member.revision_id).sort(),
    [c.revision_id, d.revision_id].sort(),
  );
  await act(async () =>
    fresh.finish(
      receipt(fresh, 'version_conflict', [
        { ...c, read: false, version: 0, availability: 'available' },
        { ...d, read: false, version: 1, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 4),
  );
  assert.deepEqual(
    f.calls
      .filter((call) => call.path.endsWith('/state'))[3]!
      .body.targets.map((member: any) => member.revision_id),
    [c.revision_id],
  );
});
test('a full fresh buffer still dispatches an eligible continuation', async (t) => {
  const b = { resource_id: randomUUID(), revision_id: randomUUID() };
  const fresh = Array.from({ length: 129 }, () => ({
    resource_id: randomUUID(),
    revision_id: randomUUID(),
  }));
  const qualified = new Set([target.revision_id, b.revision_id]);
  selectivelyPresentedFixture(t, qualified);
  const all = [target, b, ...fresh];
  const f = mount(t, true, all);
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/lookup')).length, 6),
  );
  await act(async () => {
    for (const call of f.calls.filter((entry) => entry.path.endsWith('/lookup')))
      call.finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: call.body.targets.map((source: typeof target) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      );
  });
  await waitFor(
    () => assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1),
    {
      timeout: 5000,
    },
  );
  const original = f.calls.find((call) => call.path.endsWith('/state'))!;
  assert.deepEqual(
    original.body.targets.map((member: { revision_id: string }) => member.revision_id).sort(),
    [target.revision_id, b.revision_id].sort(),
  );
  for (const source of fresh) qualified.add(source.revision_id);
  fireEvent.scroll(window);
  await waitFor(() => assert.ok(screen.getAllByText(/Automatic reading buffer is full/).length), {
    timeout: 5000,
  });
  await act(async () =>
    original.finish(
      receipt(original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...b, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  assert.deepEqual(
    f.calls
      .filter((call) => call.path.endsWith('/state'))[1]!
      .body.targets.map((member: any) => member.revision_id),
    [b.revision_id],
  );
});

test('later manual choice cancels pending automatic continuation', async (t) => {
  const f = await twoAutomatic(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  await act(async () =>
    f.original.finish(
      receipt(f.original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...f.other, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  const b = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${f.other.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  await act(async () => fireEvent.click(b.getByRole('button', { name: 'Mark unread' })));
  await act(async () => t.mock.timers.tick(0));
  t.mock.timers.reset();
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state'))[1]!.body.basis, 'manual');
});
for (const retained of [true, false])
  test(`a cross-tab ${retained ? 'pending' : 'already settled'} manual intent cancels a queued continuation`, async (t) => {
    const f = await twoAutomatic(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => t.mock.timers.reset());
    await act(async () =>
      f.original.finish(
        receipt(f.original, 'version_conflict', [
          { ...target, read: false, version: 1, availability: 'available' },
          { ...f.other, read: false, version: 0, availability: 'available' },
        ]),
      ),
    );
    const manual = {
      version: 1,
      body: {
        idempotency_key: randomUUID(),
        basis: 'manual',
        episode_id: null,
        targets: [{ ...f.other, read: false, expected_version: 0 }],
      },
      attempts: 0,
      state: 'uncertain',
    };
    const key = f.recovery.prefix + 'intent:' + manual.body.idempotency_key;
    if (retained) localStorage.setItem(key, JSON.stringify(manual));
    const lookups = f.calls.filter((call) => call.path.endsWith('/lookup')).length;
    await act(async () =>
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(manual) })),
    );
    await act(async () => t.mock.timers.tick(0));
    t.mock.timers.reset();
    assert.ok(f.calls.filter((call) => call.path.endsWith('/lookup')).length > lookups);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1);
    assert.equal(
      document
        .querySelector(`[data-reading-target="${f.other.revision_id}"]`)
        ?.getAttribute('data-reading-version'),
      '0',
    );
  });
test('a continuation conflict stops and an uncertain original makes no subset', async (t) => {
  const f = await twoAutomatic(t);
  await act(async () =>
    f.original.finish(
      receipt(f.original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...f.other, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const continuation = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  await act(async () =>
    continuation.finish(
      receipt(continuation, 'version_conflict', [
        { ...f.other, read: false, version: 1, availability: 'available' },
      ]),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
  assert.deepEqual(
    f.recovery.all().map((record) => record.state),
    ['conflicted', 'conflicted'],
  );
});

test('transport uncertainty and not-recorded status never create a subset', async (t) => {
  const f = await twoAutomatic(t);
  await act(async () =>
    f.original.finish(
      Response.json(
        {
          error: { code: 'service_unavailable', message: 'Held outcome unknown' },
        },
        { status: 503 },
      ),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 1));
  assert.equal(f.recovery.all()[0]!.state, 'uncertain');
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Check reading outcome' })),
  );
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/status'))));
  await act(async () =>
    f.calls
      .find((call) => call.path.endsWith('/status'))!
      .finish(Response.json({ operation_state: 'not_recorded' })),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1);
  assert.deepEqual(f.recovery.all()[0]!.body, f.original.body);
});

test('local reading save, begin and finish do not repeat whole-provider lookups', async (t) => {
  const other = { resource_id: randomUUID(), revision_id: randomUUID() };
  const f = mount(t, false, [target, other]);
  await waitFor(() =>
    assert.ok(
      f.calls.some((call) => call.path.endsWith('/lookup') && call.body.targets.length === 2),
    ),
  );
  const initial = f.calls.filter((call) => call.path.endsWith('/lookup'));
  await act(async () =>
    initial[0]!.finish(
      Response.json({
        scope: 'own_exact_revisions',
        items: [target, other].map((source) => ({
          ...source,
          read: false,
          version: 0,
          availability: 'available',
        })),
      }),
    ),
  );
  const a = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  await act(async () => fireEvent.click(a.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/state'))));
  const command = f.calls.find((call) => call.path.endsWith('/state'))!;
  await act(async () =>
    command.finish(
      receipt(command, 'applied', [
        { ...target, read: false, version: 1, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/lookup')).length, 1);
  assert.equal(
    document
      .querySelector(`[data-reading-target="${target.revision_id}"]`)
      ?.getAttribute('data-reading-version'),
    '1',
  );
});
test('automatic storage failure prevents batch dispatch and leaves unrelated custody intact', async (t) => {
  presentedFixture(t);
  const other = { resource_id: randomUUID(), revision_id: randomUUID() };
  const f = mount(t, true, [target, other]);
  localStorage.setItem('loom.intent.unrelated', 'preserve');
  await waitFor(() =>
    assert.ok(
      f.calls.some((call) => call.path.endsWith('/lookup') && call.body.targets.length === 2),
    ),
  );
  const original = dom.window.Storage.prototype.setItem;
  t.mock.method(
    dom.window.Storage.prototype,
    'setItem',
    function (this: Storage, key: string, value: string) {
      if (key.includes(':intent:')) throw new Error('Synthetic automatic storage failure');
      return original.call(this, key, value);
    },
  );
  await act(async () =>
    f.calls
      .find((call) => call.path.endsWith('/lookup'))!
      .finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, other].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      ),
  );
  await waitFor(() => assert.ok(screen.getAllByText(/could not be saved/).length), {
    timeout: 4000,
  });
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 0);
  assert.equal(f.recovery.all().length, 0);
  assert.equal(localStorage.getItem('loom.intent.unrelated'), 'preserve');
});
test('identity withdrawal while an automatic batch waits for custody prevents dispatch', async (t) => {
  presentedFixture(t);
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const waiting = new Promise<void>((resolve) => (reached = resolve));
  t.mock.method(navigator.locks!, 'request', async (_name: string, work: () => unknown) => {
    reached();
    await gate;
    return work();
  });
  const f = mount(t, true);
  await settle(f.calls);
  await waiting;
  await act(async () => invalidateIdentity());
  await act(async () => release());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 0);
  assert.equal(f.recovery.all().length, 0);
});

test('a frozen automatic batch survives navigation with the same saved body and key', async (t) => {
  const f = await twoAutomatic(t);
  const frozen = f.recovery.all()[0]!.body;
  assert.deepEqual(frozen, f.original.body);
  await act(async () => f.router.navigate('/other'));
  assert.deepEqual(f.recovery.all()[0]!.body, frozen);
  await act(async () => f.router.navigate('/read'));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Retry same reading change' })));
  assert.deepEqual(f.recovery.all()[0]!.body, frozen);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 1);
});
test('automatic StrictMode observation is once per viewport visit; manual unread and refresh do not rearm it', async (t) => {
  t.mock.method(document, 'hasFocus', () => true);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', () => ({
    top: 100,
    left: 0,
    bottom: 200,
    right: 500,
    width: 500,
    height: 100,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  }));
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => document.querySelector('.prose'),
    configurable: true,
  });
  const f = mount(t, true);
  await settle(f.calls);
  await waitFor(() => assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 1), {
    timeout: 3000,
  });
  const automatic = f.calls.find((c) => c.path.endsWith('/state'))!;
  assert.equal(automatic.body.basis, 'presentation');
  assert.equal(automatic.body.targets[0].revision_id, target.revision_id);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() => assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 2));
  const manual = f.calls.filter((c) => c.path.endsWith('/state'))[1]!;
  await act(async () =>
    manual.finish(
      Response.json({
        operation_state: 'applied',
        operation_id: randomUUID(),
        idempotency: 'created',
        outcome: {
          basis: 'manual',
          episode_id: null,
          targets: [{ ...manual.body.targets[0], result_version: 1 }],
        },
        current: page(false, 1).items,
      }),
    ),
  );
  await act(async () =>
    automatic.finish(
      Response.json({
        operation_state: 'version_conflict',
        operation_id: randomUUID(),
        idempotency: 'created',
        outcome: {
          basis: 'presentation',
          episode_id: automatic.body.episode_id,
          targets: [{ ...automatic.body.targets[0], result_version: 1 }],
        },
        current: page(false, 1).items,
      }),
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 2);
  assert.deepEqual(
    f.recovery.all().map((r) => ({ state: r.state, key: r.body.idempotency_key })),
    [{ state: 'conflicted', key: automatic.body.idempotency_key }],
  );
});

test('recovery cap preserves every exact intent; a competing retry prevents a late first refusal becoming dismissible', async () => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID()),
    body = () => ({
      idempotency_key: randomUUID(),
      basis: 'manual' as const,
      episode_id: null,
      targets: [{ ...target, read: false, expected_version: 0 }],
    });
  localStorage.setItem('loom.intent.unrelated', 'preserve');
  for (let i = 0; i < 128; i++) await journal.save(body(), () => true);
  const before = journal.all();
  await assert.rejects(
    journal.save(body(), () => true),
    /full/,
  );
  assert.deepEqual(journal.all(), before);
  assert.equal(localStorage.getItem('loom.intent.unrelated'), 'preserve');
  const first = await journal.begin(before[0]!),
    second = await journal.begin(before[0]!);
  await journal.rejectFirst(first);
  assert.equal(
    journal.all().find((r) => r.body.idempotency_key === first.body.idempotency_key)!.state,
    'uncertain',
  );
  assert.equal(second.attempts, 2);
  await journal.finish(first);
  assert.equal(journal.all().length, 127);
});

test('confirmed conflicts retain exact bounded custody; failed dismissal and late responses cannot lose or recreate feedback', async (t) => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID()),
    body = {
      idempotency_key: randomUUID(),
      basis: 'manual' as const,
      episode_id: null,
      targets: [{ ...target, read: true, expected_version: 0 }],
    };
  const saved = await journal.save(body, () => true),
    sent = await journal.begin(saved);
  await assert.rejects(
    journal.finish(sent, true),
    /changed/,
    'Uncertain commands cannot be dismissed as conflicts',
  );
  const write = t.mock.method(dom.window.Storage.prototype, 'setItem', () => {
    throw new Error('Synthetic save failure');
  });
  await assert.rejects(
    journal.recordConflict(sent),
    /Reading conflict could not be saved.*check its outcome again/,
  );
  write.mock.restore();
  assert.deepEqual(journal.all(), [sent], 'A failed conflict save must preserve exact recovery');
  await journal.recordConflict(sent);
  await journal.rejectFirst(sent);
  assert.deepEqual(journal.all(), [{ ...sent, state: 'conflicted' }]);
  await assert.rejects(
    journal.begin(sent),
    /changed/,
    'Confirmed conflicts cannot be retried as uncertain commands',
  );
  const remove = t.mock.method(dom.window.Storage.prototype, 'removeItem', () => {
    throw new Error('Synthetic removal failure');
  });
  await assert.rejects(journal.finish(sent, true), /removal failure/);
  assert.deepEqual(journal.all(), [{ ...sent, state: 'conflicted' }]);
  remove.mock.restore();
  await journal.finish(sent, true);
  await journal.recordConflict(sent);
  await journal.rejectFirst(sent);
  assert.deepEqual(journal.all(), []);
});
test('historical conflict feedback retires only after a newer successful version', async () => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID());
  const body = {
    idempotency_key: randomUUID(),
    basis: 'presentation' as const,
    episode_id: randomUUID(),
    targets: [{ ...target, read: true, expected_version: 0 }],
  };
  const saved = await journal.save(body, () => true);
  const sent = await journal.begin(saved);
  const refusal = {
    operation_state: 'version_conflict' as const,
    operation_id: randomUUID(),
    idempotency: 'created' as const,
    outcome: {
      basis: body.basis,
      episode_id: body.episode_id,
      targets: [{ ...body.targets[0]!, result_version: 2 }],
    },
    current: [{ ...target, read: false, version: 2, availability: 'available' as const }],
  };
  await journal.recordConflict(sent, refusal);
  const success = async (version: number) => {
    const record = await journal.save(
      { ...body, idempotency_key: randomUUID(), basis: 'manual', episode_id: null },
      () => true,
    );
    await journal.settleSuccess(record, [{ ...body.targets[0]!, result_version: version }]);
  };
  await success(1);
  assert.deepEqual(journal.all()[0]!.superseded_revisions, undefined);
  await success(3);
  assert.deepEqual(journal.all()[0]!.superseded_revisions, [target.revision_id]);
  assert.deepEqual(journal.all()[0]!.body, body);
  assert.equal(journal.successEvidence().length, 1, 'newer evidence subsumes older evidence');
});
test('mixed-target receipts release obsolete slots after other targets are dismissed', async () => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID());
  const b = { resource_id: randomUUID(), revision_id: randomUUID() };
  const body = (
    targets: { resource_id: string; revision_id: string; expected_version: number }[],
  ) => ({
    idempotency_key: randomUUID(),
    basis: 'manual' as const,
    episode_id: null,
    targets: targets.map((item) => ({ ...item, read: true })),
  });
  const bIntent = await journal.save(body([{ ...b, expected_version: 0 }]), () => true);
  for (let i = 0; i < 126; i++) {
    const a = { resource_id: randomUUID(), revision_id: randomUUID() };
    const aIntent = await journal.save(body([{ ...a, expected_version: 0 }]), () => true);
    const success = await journal.save(
      body([
        { ...a, expected_version: 299 - i },
        { ...b, expected_version: i },
      ]),
      () => true,
    );
    await journal.settleSuccess(success, [
      { ...success.body.targets[0]!, result_version: 300 - i },
      { ...success.body.targets[1]!, result_version: i + 1 },
    ]);
    await journal.finish(aIntent);
  }
  assert.deepEqual(journal.all(), [bIntent]);
  const unrelated = () => [
    { resource_id: randomUUID(), revision_id: randomUUID(), expected_version: 0 },
  ];
  await journal.save(body(unrelated()), () => true);
  await journal.save(body(unrelated()), () => true);
  assert.equal(journal.successEvidence().length, 1);
  assert.equal(
    journal.successEvidence()[0]!.targets.find((item) => item.revision_id === b.revision_id)
      ?.version,
    126,
  );
});
test('a full prior receipt journal frees obsolete slots before saving new work', async () => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID());
  const b = { resource_id: randomUUID(), revision_id: randomUUID() };
  const unresolved = await journal.save(
    {
      idempotency_key: randomUUID(),
      basis: 'manual',
      episode_id: null,
      targets: [{ ...b, read: true, expected_version: 0 }],
    },
    () => true,
  );
  let oldKey = '';
  for (let i = 1; i < readingLimits.localOperations; i++) {
    const idempotency_key = randomUUID();
    if (i === 1) oldKey = idempotency_key;
    localStorage.setItem(
      journal.prefix + 'intent:' + idempotency_key,
      JSON.stringify({
        version: 1,
        state: 'acknowledged',
        idempotency_key,
        targets: [
          { resource_id: randomUUID(), revision_id: randomUUID(), version: 400 - i },
          { ...b, version: i },
        ],
      }),
    );
  }
  assert.equal(journal.successEvidence().length, readingLimits.localOperations - 1);
  await assert.rejects(
    journal.save(
      {
        idempotency_key: oldKey,
        basis: 'manual',
        episode_id: null,
        targets: [
          { resource_id: randomUUID(), revision_id: randomUUID(), read: true, expected_version: 0 },
        ],
      },
      () => true,
    ),
    /operation already exists/,
  );
  const fresh = await journal.save(
    {
      idempotency_key: randomUUID(),
      basis: 'manual',
      episode_id: null,
      targets: [
        { resource_id: randomUUID(), revision_id: randomUUID(), read: true, expected_version: 0 },
      ],
    },
    () => true,
  );
  assert.deepEqual(journal.all(), [unresolved, fresh]);
  assert.equal(journal.successEvidence().length, 1);
  assert.equal(
    journal.successEvidence()[0]!.targets.find((item) => item.revision_id === b.revision_id)
      ?.version,
    readingLimits.localOperations - 1,
  );
});
test('a near-full journal settles success before later conflict feedback', async () => {
  const instance = randomUUID(),
    participant = randomUUID();
  const journal = new ReadingRecovery(instance, participant);
  const targets = Array.from({ length: 25 }, () => ({
    resource_id: randomUUID(),
    revision_id: randomUUID(),
  }));
  const body = () => ({
    idempotency_key: randomUUID(),
    basis: 'manual' as const,
    episode_id: null,
    targets: targets.map((target) => ({ ...target, read: true, expected_version: 0 })),
  });
  for (let n = 0; n < 128; n++) await journal.save(body(), () => true);
  const initial = journal.all();
  const successful = await journal.begin(initial[0]!);
  const resultTargets = successful.body.targets.map((target) => ({
    ...target,
    result_version: 1,
  }));
  await journal.settleSuccess(successful, resultTargets);
  assert.equal(journal.all().length, 127);
  await journal.settleSuccess(successful, resultTargets);
  assert.equal(journal.all().length, 127);
  const refused = await journal.begin(initial[1]!);
  await journal.recordConflict(refused, {
    operation_state: 'version_conflict',
    operation_id: randomUUID(),
    idempotency: 'created',
    outcome: {
      basis: refused.body.basis,
      episode_id: refused.body.episode_id,
      targets: refused.body.targets.map((target) => ({ ...target, result_version: 0 })),
    },
    current: targets.map((target) => ({
      ...target,
      read: false,
      version: 0,
      availability: 'available',
    })),
  });
  const current = journal
    .all()
    .find((record) => record.body.idempotency_key === refused.body.idempotency_key)!;
  assert.equal(current.state, 'conflicted');
  assert.deepEqual(
    current.superseded_revisions?.sort(),
    targets.map((target) => target.revision_id).sort(),
  );
  assert.deepEqual(current.body, refused.body);
  assert.equal(journal.successEvidence().length, 1);
  const reopened = new ReadingRecovery(instance, participant);
  assert.deepEqual(
    reopened
      .all()
      .find((record) => record.body.idempotency_key === refused.body.idempotency_key)
      ?.superseded_revisions?.sort(),
    targets.map((target) => target.revision_id).sort(),
  );
});
test('partially expanded legacy journal compacts only durably covered success metadata', async () => {
  const instance = randomUUID(),
    participant = randomUUID();
  const journal = new ReadingRecovery(instance, participant);
  const targets = Array.from({ length: readingLimits.batch }, () => ({
    resource_id: randomUUID(),
    revision_id: randomUUID(),
  }));
  const body = () => ({
    idempotency_key: randomUUID(),
    basis: 'manual' as const,
    episode_id: null,
    targets: targets.map((item) => ({ ...item, read: true, expected_version: 0 })),
  });
  for (let i = 0; i < readingLimits.localOperations; i++) await journal.save(body(), () => true);
  const initial = journal.all();
  const successful = await journal.begin(initial[0]!);
  const results = successful.body.targets.map((item) => ({ ...item, result_version: 1 }));
  const bytes = (raw: string) => new TextEncoder().encode(raw).length;
  let total = initial.reduce((sum, record) => sum + bytes(JSON.stringify(record)), 0);
  let expanded = 0;
  for (const record of initial.slice(1)) {
    const key = journal.prefix + 'intent:' + record.body.idempotency_key;
    const oldRaw = localStorage.getItem(key)!;
    const nextRaw = JSON.stringify({
      ...record,
      successful_versions: results.map((item) => ({ revision_id: item.revision_id, version: 1 })),
    });
    if (total - bytes(oldRaw) + bytes(nextRaw) > readingLimits.localBytes) break;
    localStorage.setItem(key, nextRaw);
    total += bytes(nextRaw) - bytes(oldRaw);
    expanded++;
  }
  assert.ok(expanded > 0 && expanded < initial.length - 1);
  assert.ok(total > readingLimits.localBytes - 100);
  await journal.settleSuccess(successful, results);
  await journal.settleSuccess(successful, results);
  const refused = await journal.begin(initial[1]!);
  await journal.recordConflict(refused, {
    operation_state: 'version_conflict',
    operation_id: randomUUID(),
    idempotency: 'created',
    outcome: {
      basis: refused.body.basis,
      episode_id: refused.body.episode_id,
      targets: refused.body.targets.map((item, index) => ({
        ...item,
        result_version: index === 0 ? 2 : 0,
      })),
    },
    current: targets.map((item, index) => ({
      ...item,
      read: false,
      version: index === 0 ? 2 : 0,
      availability: 'available',
    })),
  });
  const reopened = new ReadingRecovery(instance, participant);
  const current = reopened
    .all()
    .find((item) => item.body.idempotency_key === refused.body.idempotency_key)!;
  assert.equal(current.state, 'conflicted');
  assert.deepEqual(current.body, refused.body);
  assert.deepEqual(
    current.superseded_revisions?.sort(),
    targets
      .slice(1)
      .map((item) => item.revision_id)
      .sort(),
  );
  assert.equal(reopened.all().filter((item) => item.successful_versions?.length).length, 0);
  const originalBodies = new Map(
    initial.map((item) => [item.body.idempotency_key, JSON.stringify(item.body)]),
  );
  for (const intent of reopened.all())
    assert.equal(JSON.stringify(intent.body), originalBodies.get(intent.body.idempotency_key));
});
test('legacy success metadata remains until exact equal-or-newer receipt evidence is durable', async (t) => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID());
  const a = { resource_id: randomUUID(), revision_id: randomUUID() };
  const unresolved = await journal.save(
    {
      idempotency_key: randomUUID(),
      basis: 'manual',
      episode_id: null,
      targets: [a, target].map((item) => ({ ...item, read: true, expected_version: 0 })),
    },
    () => true,
  );
  const key = journal.prefix + 'intent:' + unresolved.body.idempotency_key;
  localStorage.setItem(
    key,
    JSON.stringify({
      ...unresolved,
      successful_versions: [
        { revision_id: a.revision_id, version: 3 },
        { revision_id: target.revision_id, version: 1 },
      ],
    }),
  );
  const successful = await journal.save(
    {
      idempotency_key: randomUUID(),
      basis: 'manual',
      episode_id: null,
      targets: [{ ...target, read: true, expected_version: 0 }],
    },
    () => true,
  );
  const outcome = [{ ...successful.body.targets[0]!, result_version: 1 }];
  const failure = t.mock.method(dom.window.Storage.prototype, 'setItem', () => {
    throw new Error('Synthetic receipt write failure');
  });
  await assert.rejects(
    journal.settleSuccess(successful, outcome),
    /success evidence could not be saved/,
  );
  failure.mock.restore();
  assert.deepEqual(
    journal.all().find((item) => item.body.idempotency_key === unresolved.body.idempotency_key)
      ?.successful_versions,
    [
      { revision_id: a.revision_id, version: 3 },
      { revision_id: target.revision_id, version: 1 },
    ],
  );
  const setItem = dom.window.Storage.prototype.setItem;
  let refusedCompaction = false;
  const compactionFailure = t.mock.method(
    dom.window.Storage.prototype,
    'setItem',
    function (this: Storage, storageKey: string, raw: string) {
      if (storageKey === key && !refusedCompaction) {
        refusedCompaction = true;
        throw new Error('Synthetic compaction failure');
      }
      return setItem.call(this, storageKey, raw);
    },
  );
  await assert.rejects(journal.settleSuccess(successful, outcome), /acknowledgement compaction/);
  compactionFailure.mock.restore();
  assert.equal(journal.successEvidence().length, 1);
  assert.equal(journal.all()[0]!.successful_versions?.length, 2);
  await journal.recordConflict(unresolved, {
    operation_state: 'version_conflict',
    operation_id: randomUUID(),
    idempotency: 'created',
    outcome: {
      basis: 'manual',
      episode_id: null,
      targets: [
        { ...unresolved.body.targets[0]!, result_version: 2 },
        { ...unresolved.body.targets[1]!, result_version: 0 },
      ],
    },
    current: [
      { ...a, read: false, version: 2, availability: 'available' },
      { ...target, read: false, version: 0, availability: 'available' },
    ],
  });
  assert.deepEqual(journal.all()[0]!.successful_versions, [
    { revision_id: a.revision_id, version: 3 },
  ]);
  assert.deepEqual(
    journal.all()[0]!.superseded_revisions?.sort(),
    [a.revision_id, target.revision_id].sort(),
  );
});
test('success evidence preserves an exact uncertain body on failed write and clears with custody', async (t) => {
  const journal = new ReadingRecovery(randomUUID(), randomUUID());
  const body = () => ({
    idempotency_key: randomUUID(),
    basis: 'manual' as const,
    episode_id: null,
    targets: [{ ...target, read: true, expected_version: 0 }],
  });
  const older = await journal.save(body(), () => true);
  const successful = await journal.begin(await journal.save(body(), () => true));
  const result = [{ ...successful.body.targets[0]!, result_version: 1 }];
  const write = t.mock.method(dom.window.Storage.prototype, 'setItem', () => {
    throw new Error('Synthetic save failure');
  });
  await assert.rejects(
    journal.settleSuccess(successful, result),
    /success evidence could not be saved/,
  );
  write.mock.restore();
  assert.deepEqual(
    journal.all().find((record) => record.body.idempotency_key === successful.body.idempotency_key),
    successful,
  );
  await journal.settleSuccess(successful, result);
  assert.equal(journal.successEvidence().length, 1);
  await journal.finish(older);
  assert.deepEqual(journal.successEvidence(), []);
  await journal.clear();
  assert.deepEqual(journal.all(), []);
});
test('cross-tab success evidence removal looks up only its registered target', async (t) => {
  const other = { resource_id: randomUUID(), revision_id: randomUUID() };
  const f = mount(t, false, [target, other]);
  await waitFor(() => assert.ok(f.calls.some((call) => call.path.endsWith('/lookup'))));
  await act(async () => {
    for (const call of f.calls.filter((entry) => entry.path.endsWith('/lookup')))
      call.finish(
        Response.json({
          scope: 'own_exact_revisions',
          items: [target, other].map((source) => ({
            ...source,
            read: false,
            version: 0,
            availability: 'available',
          })),
        }),
      );
  });
  const prior = f.calls.filter((call) => call.path.endsWith('/lookup')).length;
  const idempotency_key = randomUUID();
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: f.recovery.prefix + 'intent:' + idempotency_key,
        oldValue: JSON.stringify({
          version: 1,
          state: 'acknowledged',
          idempotency_key,
          targets: [{ ...target, version: 1 }],
        }),
        newValue: null,
      }),
    ),
  );
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/lookup')).length, prior + 1),
  );
  assert.deepEqual(f.calls.filter((call) => call.path.endsWith('/lookup')).at(-1)!.body.targets, [
    target,
  ]);
});
test('a delayed refusal keeps historical custody without restoring a newer target warning', async (t) => {
  const f = await twoAutomatic(t);
  const b = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${f.other.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  await act(async () => fireEvent.click(b.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  const manual = f.calls.filter((call) => call.path.endsWith('/state'))[1]!;
  await act(async () =>
    manual.finish(
      receipt(manual, 'applied', [
        { ...f.other, read: false, version: 1, availability: 'available' },
      ]),
    ),
  );
  await act(async () =>
    f.original.finish(
      receipt(f.original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...f.other, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all()[0]?.state, 'conflicted'));
  assert.deepEqual(f.recovery.all()[0]!.body, f.original.body);
  assert.deepEqual(f.recovery.all()[0]!.superseded_revisions, [f.other.revision_id]);
  assert.equal(!!b.queryByText(/Reading change conflicted/), false);
  assert.equal(
    document
      .querySelector(`[data-reading-target="${f.other.revision_id}"]`)
      ?.getAttribute('data-reading-version'),
    '1',
  );
  const a = within(
    document
      .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
      .closest<HTMLElement>('.test-message')!,
  );
  assert.ok(a.queryByText(/Reading change conflicted/));
  await act(async () => f.router.navigate('/other'));
  await act(async () => f.router.navigate('/read'));
  await waitFor(() =>
    assert.equal(
      !!within(
        document
          .querySelector<HTMLElement>(`[data-reading-target="${f.other.revision_id}"]`)!
          .closest<HTMLElement>('.test-message')!,
      ).queryByText(/Reading change conflicted/),
      false,
    ),
  );
  assert.ok(
    within(
      document
        .querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!
        .closest<HTMLElement>('.test-message')!,
    ).queryByText(/Reading change conflicted/),
  );
});

test('presentation requires displayed, focused, uncovered main text but accepts a partial long view', (t) => {
  const element = document.createElement('div');
  document.body.append(element);
  t.after(() => element.remove());
  let visible = true,
    focused = true,
    top = 100,
    covered = false;
  Object.defineProperty(document, 'visibilityState', {
    get: () => (visible ? 'visible' : 'hidden'),
    configurable: true,
  });
  t.mock.method(document, 'hasFocus', () => focused);
  t.mock.method(element, 'getBoundingClientRect', () => ({
    top,
    left: 0,
    bottom: top + 100,
    right: 500,
    width: 500,
    height: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }));
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => (covered ? document.body : element),
    configurable: true,
  });
  const qualifies = () => viewportPresentation(element).eligible;
  assert.equal(qualifies(), true);
  visible = false;
  assert.equal(qualifies(), false);
  assert.equal(viewportPresentation(element).present, true);
  visible = true;
  focused = false;
  assert.equal(qualifies(), false);
  focused = true;
  covered = true;
  assert.equal(qualifies(), false);
  covered = false;
  top = 900;
  assert.equal(qualifies(), false);
  assert.equal(viewportPresentation(element).present, false);
  top = 100;
  element.style.display = 'none';
  assert.equal(qualifies(), false);
  element.style.display = '';
  const code = document.createElement('pre');
  element.append(code);
  Object.defineProperty(code, 'scrollWidth', { value: 600 });
  Object.defineProperty(code, 'clientWidth', { value: 500 });
  assert.equal(qualifies(), true);
});
