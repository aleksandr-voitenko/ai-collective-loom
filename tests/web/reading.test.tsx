import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import assert from 'node:assert/strict';
import { test, afterEach, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { ReadingProvider, ReadingText, ReadingPageViewComponent } from '../../src/web/Reading.js';
import { ReadingRecovery } from '../../src/web/reading-recovery.js';
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
function mount(t: TestContext, automatic = false, targets = [target], compact = false) {
  const context = {
    community: { instance_id: randomUUID() },
    self: { participant_id: randomUUID(), csrf: 'fixture' },
  } as Context;
  const recovery = new ReadingRecovery(context.community.instance_id, context.self.participant_id);
  if (automatic) localStorage.setItem(recovery.preference, 'true');
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
              {targets.map((target, index) => (
                <ReadingText
                  key={target.revision_id}
                  target={target}
                  number={String(index + 1)}
                  content={{
                    format: 'loom-markdown-v1',
                    text: 'Exact readable text',
                    mentions: [],
                  }}
                  participants={[]}
                  compact={compact}
                />
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
  return { context, recovery, calls, router };
}
const page = (read = false, version = 0) => ({
  scope: 'own_exact_revisions',
  items: [{ ...target, read, version, availability: 'available' }],
});
function presentedFixture(t: TestContext) {
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
}
async function twoAutomatic(t: TestContext) {
  presentedFixture(t);
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
  return { ...f, other, original };
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
test('compact reading controls preserve the open disclosure and focused button after successful marking', async (t) => {
  const f = mount(t, false, [target], true);
  const details = document.querySelector<HTMLDetailsElement>('.reading-details')!;
  await act(async () => fireEvent.click(details.querySelector('summary')!));
  await settle(f.calls);
  const button = screen.getByRole('button', { name: 'Mark read' });
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
        current: page(true, 1).items,
      }),
    ),
  );
  await waitFor(() => assert.equal(f.recovery.all().length, 0));
  assert.equal(details.open, true, 'Successful marking does not close the user-opened controls');
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
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reading status' })),
  );
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
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reading status' })),
  );
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
  assert.ok(screen.getByText(/Marked unread · private/));
  assert.equal(document.activeElement, button);
});
for (const conflictFirst of [true, false])
  test(`conflict feedback belongs to its exact revision and survives ${conflictFirst ? 'a later unrelated success' : 'an earlier unrelated success'}, refresh and reopening`, async (t) => {
    const other = { resource_id: randomUUID(), revision_id: randomUUID() },
      targets = [target, other],
      f = mount(t, false, targets);
    const controls = (source: typeof target) =>
      within(document.querySelector<HTMLElement>(`[data-reading-target="${source.revision_id}"]`)!);
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
    await waitFor(() =>
      assert.equal(
        (controls(target).getByRole('button', { name: 'Mark read' }) as HTMLButtonElement).disabled,
        false,
      ),
    );
    await act(async () => {
      for (const source of targets)
        fireEvent.click(controls(source).getByRole('button', { name: 'Mark read' }));
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
    await act(async () =>
      fireEvent.click(controls(other).getByRole('button', { name: 'Refresh reading status' })),
    );
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
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Mark read' })));
  await waitFor(() => assert.ok(screen.getAllByText(/could not be saved/).length));
  assert.equal(f.calls.filter((c) => c.path.endsWith('/state')).length, 0);
  assert.equal(localStorage.getItem('loom.intent.unrelated'), 'preserve');
  assert.equal(f.recovery.all().length, 0);
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reading status' })),
  );
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
  await waitFor(() => assert.ok(screen.getByText(/Reading status unavailable · private/)));
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
    document.querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!,
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
  assert.ok(controls.getByText(/Marked unread · private/));
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
    document.querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!,
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
    document.querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!,
  );
  const b = within(
    document.querySelector<HTMLElement>(`[data-reading-target="${f.other.revision_id}"]`)!,
  );
  assert.ok(a.queryByText(/Reading change conflicted/));
  assert.equal(!!b.queryByText(/Reading change conflicted/), false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
});

test('later manual choice cancels pending automatic continuation', async (t) => {
  const f = await twoAutomatic(t);
  await act(async () =>
    f.original.finish(
      receipt(f.original, 'version_conflict', [
        { ...target, read: false, version: 1, availability: 'available' },
        { ...f.other, read: false, version: 0, availability: 'available' },
      ]),
    ),
  );
  const b = within(
    document.querySelector<HTMLElement>(`[data-reading-target="${f.other.revision_id}"]`)!,
  );
  await act(async () => fireEvent.click(b.getByRole('button', { name: 'Mark unread' })));
  await waitFor(() =>
    assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2),
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state')).length, 2);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/state'))[1]!.body.basis, 'manual');
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
    document.querySelector<HTMLElement>(`[data-reading-target="${target.revision_id}"]`)!,
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
test('automatic StrictMode observation is once per episode; manual unread and refresh cannot rearm it', async (t) => {
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
    await new Promise((resolve) => setTimeout(resolve, 1200));
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
  await journal.supersedeConflicts([{ ...body.targets[0]!, result_version: 1 }]);
  assert.deepEqual(journal.all()[0]!.superseded_revisions, undefined);
  await journal.supersedeConflicts([{ ...body.targets[0]!, result_version: 3 }]);
  assert.deepEqual(journal.all()[0]!.superseded_revisions, [target.revision_id]);
  assert.deepEqual(journal.all()[0]!.body, body);
});

test('presentation gate excludes hidden, unfocused, covered, offscreen and horizontally incomplete main text', (t) => {
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
  const qualifies = () => viewportPresentation(element).visible(0, 100);
  assert.equal(qualifies(), true);
  visible = false;
  assert.equal(qualifies(), false);
  visible = true;
  focused = false;
  assert.equal(qualifies(), false);
  focused = true;
  covered = true;
  assert.equal(qualifies(), false);
  covered = false;
  top = 900;
  assert.equal(qualifies(), false);
  top = 100;
  const code = document.createElement('pre');
  element.append(code);
  Object.defineProperty(code, 'scrollWidth', { value: 600 });
  Object.defineProperty(code, 'clientWidth', { value: 500 });
  assert.equal(qualifies(), false);
});
