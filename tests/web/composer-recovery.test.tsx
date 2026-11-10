import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { Composer } from '../../src/web/ParticipationComposer.js';
import { MentionEditor } from '../../src/web/MentionEditor.js';
import { IntentStore } from '../../src/web/participation-client.js';
import type { ComposerOperation } from '../../src/web/composer-draft.js';
import type { Context } from '../../src/web/participation-state.js';
import type { CommittedView, PageView } from '../../src/contracts/participation.js';
import { parseAuthored } from '../../src/contracts/authored.js';
import type { AuthoredContent } from '../../src/contracts/participation.js';

const locks = navigator.locks;
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
] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});
const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
  localStorage.clear();
});

for (const uncertain of [false, true])
  test(
    'temporary throttle retains composer command and reload recovery: ' + uncertain,
    async (t) => {
      const area = randomUUID(),
        body = {
          area_id: area,
          title: 'Throttle draft',
          content: authored('Keep these exact authored bytes'),
        };
      const f = await fixture(
        t,
        { kind: 'artifact.create', areaId: area },
        '/api/v1/artifacts',
        body,
        uncertain,
      );
      const first = await f.request(uncertain ? 'Retry same publication' : 'Publish');
      const exact = first.raw;
      await f.answer(
        first,
        failure('temporarily_throttled', 'Wait 17 seconds; keep the exact request.', 429),
      );
      assert.equal(f.record().state, 'uncertain');
      assert.deepEqual(f.record().body, { ...body, idempotency_key: f.original.key });
      assert.equal(!!screen.queryByRole('button', { name: 'Prepare corrected submission' }), false);
      f.remount();
      assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value, body.content.text);
      const status = await f.request('Check status');
      await f.answer(
        status,
        failure('temporarily_throttled', 'Recovery capacity temporarily full.', 429),
      );
      assert.equal(f.record().state, 'uncertain');
      const retry = await f.request('Retry same publication');
      assert.equal(retry.raw, exact);
      await f.answer(
        retry,
        Response.json({
          publication_state: 'committed',
          idempotency: 'replayed',
          operation_id: randomUUID(),
          resource_id: randomUUID(),
          revision_id: randomUUID(),
        }),
        true,
      );
      assert.equal(f.record().state, 'committed');
      f.assertIndependent();
    },
  );
const authored = (text: string) => ({ format: 'loom-markdown-v1' as const, text, mentions: [] });
const failure = (code: string, message: string, status = 503, rejected = false) =>
  Response.json(
    {
      error: {
        code,
        message,
        ...(rejected ? { operation_outcome: 'rejected' } : {}),
      },
    },
    { status },
  );
type Call = {
  path: string;
  method: string;
  raw: string | undefined;
  done: boolean;
  finish: (response: Response) => void;
};

async function fixture(
  t: TestContext,
  operation: ComposerOperation,
  path: string,
  body: Record<string, unknown>,
  uncertain = false,
  focusOnOpen = false,
) {
  const instance = randomUUID(),
    participant = randomUUID(),
    slot = 'composer fixture';
  const context = {
    self: {
      participant_id: participant,
      nickname: 'Current author',
      kind: 'human',
      csrf: 'fixture',
    },
    community: { instance_id: instance },
    store: new IntentStore(instance, participant, localStorage, location.origin, locks),
  } as Context;
  let original = context.store.create(slot, operation.kind, path, body);
  original = await context.store.saveDraft(original, body);
  if (uncertain) original = await context.store.prepareDispatch(original, original.body);
  const other = context.store.create('independent reply', 'reply.create', '/api/v1/replies', {
    discussion_id: randomUUID(),
    parent_id: randomUUID(),
    content: authored('Independent draft remains untouched'),
  });
  await context.store.saveDraft(other, other.body);
  const otherRaw = localStorage.getItem(context.store.prefix + other.key);
  const saved: (() => void)[] = [],
    settled: (() => void)[] = [];
  const saveDraft = context.store.saveDraft.bind(context.store),
    settle = context.store.settle.bind(context.store);
  // These barriers observe actual journal completion under the real Web Lock.
  t.mock.method(context.store, 'saveDraft', async (...args: Parameters<typeof saveDraft>) => {
    try {
      return await saveDraft(...args);
    } finally {
      saved.shift()?.();
    }
  });
  t.mock.method(context.store, 'settle', async (...args: Parameters<typeof settle>) => {
    try {
      return await settle(...args);
    } finally {
      settled.shift()?.();
    }
  });
  const nextSave = () => new Promise<void>((resolve) => saved.push(resolve));
  const nextSettlement = () => new Promise<void>((resolve) => settled.push(resolve));
  const calls: Call[] = [],
    requests: ((call: Call) => void)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (requestPath: string, options?: RequestInit) =>
      new Promise<Response>((resolve) => {
        const call: Call = {
          path: requestPath,
          method: options?.method ?? 'GET',
          raw: options?.body === undefined ? undefined : String(options.body),
          done: false,
          finish: (response) => {
            assert.equal(call.done, false);
            call.done = true;
            resolve(response);
          },
        };
        calls.push(call);
        requests.shift()?.(call);
      }),
  );
  const committed: CommittedView[] = [];
  let closed = 0;
  let router: ReturnType<typeof createMemoryRouter>, view: ReturnType<typeof render>;
  function mount() {
    router = createMemoryRouter(
      [
        {
          path: '/compose',
          element: (
            <AuthorizationBoundary>
              <Composer
                context={context}
                operation={operation}
                slot={slot}
                heading="Authored draft"
                initialText="Newer defaults must not replace retained text"
                initialTitle="Newer default title"
                focusOnOpen={focusOnOpen}
                onCommitted={(value) => committed.push(value)}
                onClose={() => {
                  closed++;
                }}
              />
            </AuthorizationBoundary>
          ),
        },
      ],
      { initialEntries: ['/compose?intent=' + original.key] },
    );
    view = render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  }
  function remount() {
    view.unmount();
    router.dispose();
    mount();
  }
  t.after(async () => {
    view?.unmount();
    router?.dispose();
    await act(async () => {
      for (const call of calls.filter((call) => !call.done))
        call.finish(failure('service_unavailable', 'Fixture cleanup'));
    });
  });
  async function request(name: string) {
    const pending = new Promise<Call>((resolve) => requests.push(resolve));
    let call: Call;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
      call = await pending;
    });
    return call!;
  }
  async function answer(call: Call, response: Response, settlement = false) {
    const completion = settlement ? nextSettlement() : Promise.resolve();
    await act(async () => {
      call.finish(response);
      await completion;
    });
  }
  const raw = () => localStorage.getItem(context.store.prefix + original.key);
  const record = () => context.store.all().find((value) => value.key === original.key)!;
  const assertIndependent = () => {
    assert.equal(localStorage.getItem(context.store.prefix + other.key), otherRaw);
    assert.equal(context.store.all().length, 2);
  };
  mount();
  return {
    context,
    original,
    calls,
    committed,
    request,
    answer,
    remount,
    nextSave,
    nextSettlement,
    raw,
    record,
    assertIndependent,
    closed: () => closed,
  };
}

test('close composer keeps the visible draft open when local persistence fails', async (t) => {
  const area = randomUUID(),
    body = { area_id: area, title: 'Keep this draft', content: authored('Visible saved text') };
  const f = await fixture(
    t,
    { kind: 'discussion.create', areaId: area },
    '/api/v1/discussions',
    body,
  );
  const save = t.mock.method(f.context.store, 'saveDraft', async () => {
    throw new Error('Draft could not be saved');
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close composer' }));
  });
  assert.equal(f.closed(), 0, 'A failed save cannot close the editor and discard local fields');
  assert.ok(
    document.activeElement === screen.getByRole('alert').parentElement,
    'Close failure is brought into view',
  );
  assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value, body.content.text);
  save.mock.restore();
  const saved = f.nextSave();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close composer' }));
    await saved;
  });
  assert.equal(f.closed(), 1);
  assert.deepEqual(f.record().body.content, body.content);
  f.assertIndependent();
});

for (const text of ['A question\n\n> A quoted ending', '```ts\nconst ready = true;\n```'])
  test('mention picker produces publishable prose after Markdown: ' + text, async (t) => {
    const area = randomUUID(),
      body = { area_id: area, title: 'Mention placement', content: authored(text) };
    const f = await fixture(
      t,
      { kind: 'discussion.create', areaId: area },
      '/api/v1/discussions',
      body,
    );
    const person = { id: randomUUID(), nickname: 'Ada', kind: 'human' };
    const input = screen.getByLabelText('Text') as HTMLTextAreaElement;
    input.setSelectionRange(text.length, text.length);
    const call = await f.request('Mention a participant');
    await act(async () => {
      for (const pending of f.calls.filter((value) => !value.done))
        pending.finish(
          Response.json({
            items: [person],
            scope: 'participants:all',
            representation: 'metadata',
            omitted_detail: 'bodies',
            next_cursor: null,
            complete: true,
            work_budget_reached: false,
            limit: 12,
            max_response_bytes: 131072,
          }),
        );
    });
    assert.equal(call.path, '/api/v1/participants');
    const saved = f.nextSave();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '@Ada' }));
      await saved;
    });
    const content = f.record().body.content as AuthoredContent;
    assert.doesNotThrow(
      () => parseAuthored(content),
      'Picker-created mentions must be valid authored content',
    );
    assert.equal(content.mentions[0]!.participant_id, person.id);
    assert.ok(input.value.includes('@Ada'), 'The editing field names the participant');
    assert.ok(!input.value.includes('[[mention:'), 'Wire markers stay out of the editing field');
    assert.ok(content.text.startsWith(text), 'Existing Markdown is preserved');
    input.setSelectionRange(0, input.value.length);
    const pasted = f.nextSave();
    await act(async () => {
      fireEvent.paste(input, { clipboardData: { getData: () => input.value } });
      await pasted;
    });
    assert.deepEqual(
      (f.record().body.content as AuthoredContent).mentions,
      [],
      'Pasting the identical displayed label cannot create or retain a hidden binding',
    );
    const undone = f.nextSave();
    await act(async () => {
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
      await undone;
    });
    assert.deepEqual(
      f.record().body.content,
      content,
      'Undo explicitly restores the original binding',
    );

    fireEvent.click(screen.getByText('Preview', { exact: true }));
    assert.ok(screen.getByText('@Ada', { exact: true }), 'Preview names the selected participant');
    f.assertIndependent();
  });

for (const reply of [false, true])
  test('explicit composer opening focuses its first field: reply=' + reply, async (t) => {
    const area = randomUUID(),
      discussion = randomUUID(),
      parent = randomUUID();
    await fixture(
      t,
      reply
        ? { kind: 'reply.create', discussionId: discussion, parentId: parent }
        : { kind: 'discussion.create', areaId: area },
      reply ? '/api/v1/replies' : '/api/v1/discussions',
      reply
        ? { discussion_id: discussion, parent_id: parent, content: authored('Saved reply') }
        : { area_id: area, title: 'Saved title', content: authored('Saved opening') },
      false,
      true,
    );
    assert.ok(document.activeElement === screen.getByLabelText(reply ? 'Your reply' : 'Title'));
  });

test('deleting a mention marker removes only its declaration from an editable draft', async (t) => {
  const area = randomUUID(),
    person = randomUUID();
  const body = {
    area_id: area,
    title: 'Editing mentions',
    content: {
      format: 'loom-markdown-v1',
      text: 'Hello [[mention:ada]] and [[mention:bo]].',
      mentions: [
        { token: 'ada', participant_id: person },
        { token: 'bo', participant_id: randomUUID() },
      ],
    },
  };
  const f = await fixture(
    t,
    { kind: 'discussion.create', areaId: area },
    '/api/v1/discussions',
    body,
  );
  const saved = f.nextSave();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Text'), {
      target: { value: 'Hello Ada and @participant.' },
    });
    await saved;
  });
  const content = f.record().body.content as AuthoredContent;
  assert.deepEqual(content.mentions, [body.content.mentions[1]]);
  assert.doesNotThrow(() => parseAuthored(content));
  f.assertIndependent();
});

for (const uncertain of [false, true])
  test(
    'unconfirmed composer action focuses recovery without changing exact custody: ' + uncertain,
    async (t) => {
      const discussion = randomUUID(),
        parent = randomUUID(),
        body = {
          discussion_id: discussion,
          parent_id: parent,
          content: authored('Retained exact reply'),
        };
      const f = await fixture(
        t,
        { kind: 'reply.create', discussionId: discussion, parentId: parent },
        '/api/v1/replies',
        body,
        uncertain,
      );
      const action = uncertain ? 'Check status' : 'Post reply';
      screen.getByRole('button', { name: action }).focus();
      const request = await f.request(action);
      await f.answer(
        request,
        uncertain
          ? Response.json({ operation_state: 'not_recorded' })
          : failure('service_unavailable', 'Confirmation unavailable'),
      );
      const recovery = screen.getByRole('group', { name: 'Submission recovery' });
      assert.ok(
        document.activeElement === recovery,
        'The unconfirmed action focuses its recovery controls',
      );
      assert.equal(f.record().state, 'uncertain');
      assert.deepEqual(f.record().body, { ...body, idempotency_key: f.original.key });
      assert.equal(f.calls.length, 1);
      f.assertIndependent();
      f.remount();
      assert.ok(
        document.activeElement !== screen.getByRole('group', { name: 'Submission recovery' }),
        'Restoring a draft does not steal focus',
      );
    },
  );

test('late unconfirmed composer action preserves focus deliberately moved elsewhere', async (t) => {
  const discussion = randomUUID(),
    parent = randomUUID(),
    body = { discussion_id: discussion, parent_id: parent, content: authored('Original reply') };
  const f = await fixture(
    t,
    { kind: 'reply.create', discussionId: discussion, parentId: parent },
    '/api/v1/replies',
    body,
  );
  const request = await f.request('Post reply');
  const elsewhere = document.createElement('button');
  elsewhere.textContent = 'Another task';
  document.body.append(elsewhere);
  try {
    elsewhere.focus();
    await f.answer(request, failure('service_unavailable', 'Confirmation unavailable'));
    assert.ok(document.activeElement === elsewhere, 'Deliberate focus elsewhere is preserved');
    assert.equal(f.record().state, 'uncertain');
    f.assertIndependent();
  } finally {
    elsewhere.remove();
  }
});

test('automatic reconnect status does not move focus from the restored view', async (t) => {
  const discussion = randomUUID(),
    parent = randomUUID(),
    body = {
      discussion_id: discussion,
      parent_id: parent,
      content: authored('Original uncertain reply'),
    };
  const f = await fixture(
    t,
    { kind: 'reply.create', discussionId: discussion, parentId: parent },
    '/api/v1/replies',
    body,
    true,
  );
  const original = f.raw();
  assert.ok(document.activeElement === document.body, 'Restored recovery does not move focus');
  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.path, '/api/v1/operations/status');
  await f.answer(call, Response.json({ operation_state: 'not_recorded' }));
  assert.ok(document.activeElement === document.body, 'Automatic status leaves focus unchanged');
  assert.equal(f.raw(), original);
  f.assertIndependent();
});

test('participant selection saves exact mentions before remount and removal preserves the other declaration and text', async (t) => {
  const area = randomUUID(),
    body = { area_id: area, title: 'Authored title', content: authored('Opening text') };
  const f = await fixture(
    t,
    { kind: 'discussion.create', areaId: area },
    '/api/v1/discussions',
    body,
  );
  const ada = { id: randomUUID(), nickname: 'Ada', kind: 'human' },
    bo = { id: randomUUID(), nickname: 'Bo', kind: 'agent' };
  // A complete active-participant page includes the current author too.
  const people: PageView = {
    items: [
      ada,
      bo,
      { id: f.context.self.participant_id, nickname: 'Current author', kind: 'human' },
    ].sort((a, b) => a.id.localeCompare(b.id)),
    scope: 'participants:all',
    representation: 'metadata',
    omitted_detail: 'bodies',
    next_cursor: null,
    complete: true,
    work_budget_reached: false,
    limit: 12,
    max_response_bytes: 131072,
  };
  const mentions = [
    { token: 'm111111111111', participant_id: ada.id },
    { token: 'm222222222222', participant_id: bo.id },
  ];
  for (const [index, person] of [ada, bo].entries()) {
    const call = await f.request('Mention a participant');
    assert.deepEqual(
      { path: call.path, method: call.method, raw: call.raw },
      { path: '/api/v1/participants', method: 'GET', raw: undefined },
    );
    await act(async () => {
      for (const pending of f.calls.filter(
        (value) => !value.done && value.path === '/api/v1/participants',
      ))
        pending.finish(Response.json(people));
    });
    const uuid =
      index === 0 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const random = t.mock.method(crypto, 'randomUUID', () => uuid);
    const saved = f.nextSave();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '@' + person.nickname }));
      await saved;
    });
    random.mock.restore();
    assert.equal(!!screen.queryByRole('button', { name: '@' + person.nickname }), false);
    assert.equal(document.activeElement, screen.getByLabelText('Text'));
  }
  // A draft may contain a duplicated marker; removal must clear every occurrence before publishing.
  const duplicated =
    'Opening text [[mention:m111111111111]] [[mention:m222222222222]]\nTail [[mention:m111111111111]] stays.';
  const saved = f.nextSave();
  await act(async () => {
    await f.context.store.saveDraft(f.record(), {
      ...f.record().body,
      content: { format: 'loom-markdown-v1', text: duplicated, mentions },
    });
    await saved;
  });
  f.remount();
  const expected = {
    ...body,
    content: { format: 'loom-markdown-v1', text: duplicated, mentions },
    idempotency_key: f.original.key,
  };
  assert.deepEqual(f.record(), {
    ...f.original,
    sequence: f.original.sequence + 3,
    body: expected,
  });
  f.remount();
  assert.equal(
    (screen.getByLabelText('Text') as HTMLTextAreaElement).value,
    'Opening text @participant @participant\nTail @participant stays.',
  );
  assert.equal((screen.getByLabelText('Title') as HTMLInputElement).value, 'Authored title');
  assert.equal(screen.getAllByRole('button', { name: 'Remove mention @participant' }).length, 2);
  const removed = f.nextSave();
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove mention @participant' })[0]!);
    await removed;
  });
  const remaining = 'Opening text  [[mention:m222222222222]]\nTail  stays.';
  assert.deepEqual(f.record(), {
    ...f.original,
    sequence: f.original.sequence + 4,
    body: {
      ...body,
      content: { format: 'loom-markdown-v1', text: remaining, mentions: [mentions[1]] },
      idempotency_key: f.original.key,
    },
  });
  f.remount();
  assert.equal(
    (screen.getByLabelText('Text') as HTMLTextAreaElement).value,
    'Opening text  @participant\nTail  stays.',
  );
  assert.equal(screen.getAllByRole('button', { name: 'Remove mention @participant' }).length, 1);
  assert.ok(f.calls.length >= 2);
  assert.deepEqual(
    [...new Set(f.calls.map((call) => call.method + ' ' + call.path))],
    ['GET /api/v1/participants'],
  );
  await act(async () => {
    for (const call of f.calls.filter((call) => !call.done)) call.finish(Response.json(people));
  });
  assert.ok(f.calls.every((call) => call.done));
  assert.equal(
    (screen.getByLabelText('Text') as HTMLTextAreaElement).value,
    'Opening text  @Bo\nTail  stays.',
  );
  f.assertIndependent();
});

test('not-recorded and unavailable reply status preserve exact uncertainty until explicit same-body retry commits', async (t) => {
  const discussion = randomUUID(),
    parent = randomUUID();
  const body = {
    discussion_id: discussion,
    parent_id: parent,
    content: authored('Original reply · café\nExact  spacing'),
  };
  const f = await fixture(
    t,
    { kind: 'reply.create', discussionId: discussion, parentId: parent },
    '/api/v1/replies',
    body,
    true,
  );
  const originalRaw = f.raw(),
    statusBody = JSON.stringify({
      operation_kind: 'reply.create',
      idempotency_key: f.original.key,
    });
  const first = await f.request('Check status');
  assert.deepEqual(
    { path: first.path, method: first.method, raw: first.raw },
    { path: '/api/v1/operations/status', method: 'POST', raw: statusBody },
  );
  assert.equal((screen.getByLabelText('Your reply') as HTMLTextAreaElement).disabled, true);
  assert.equal(f.calls.length, 1);
  await f.answer(first, Response.json({ operation_state: 'not_recorded' }));
  assert.ok(
    screen.getByText('Confirmation is still unavailable. The original request may still commit.'),
  );
  assert.equal(f.raw(), originalRaw);
  assert.ok(screen.getByRole('button', { name: 'Retry same reply' }));
  const second = await f.request('Check status');
  assert.equal(second.raw, statusBody);
  await f.answer(second, failure('service_unavailable', 'Status is temporarily unavailable'));
  assert.equal(screen.getByRole('alert').textContent, 'Status is temporarily unavailable');
  assert.equal(f.raw(), originalRaw);
  assert.equal(!!screen.queryByRole('button', { name: 'Prepare corrected submission' }), false);
  const retry = await f.request('Retry same reply');
  assert.deepEqual(
    { path: retry.path, method: retry.method, raw: retry.raw },
    { path: '/api/v1/replies', method: 'POST', raw: JSON.stringify(f.original.body) },
  );
  const dispatched = f.record();
  assert.deepEqual(dispatched, { ...f.original, sequence: f.original.sequence + 1 });
  const result: CommittedView = {
    publication_state: 'committed',
    idempotency: 'replayed',
    operation_id: randomUUID(),
    resource_id: randomUUID(),
    revision_id: randomUUID(),
  };
  await f.answer(retry, Response.json(result), true);
  assert.deepEqual(f.record(), {
    ...dispatched,
    sequence: dispatched.sequence + 1,
    state: 'committed',
    result,
  });
  assert.deepEqual(f.committed, [result]);
  assert.ok(screen.getByText('Your reply was posted.'));
  assert.equal(
    screen.getByRole('link', { name: 'Inspect exact revision' }).getAttribute('href'),
    `/loom/resource/${result.resource_id}/${result.revision_id}`,
  );
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/api/v1/operations/status', '/api/v1/operations/status', '/api/v1/replies'],
  );
  f.assertIndependent();
});

for (const action of ['status', 'retry'] as const)
  test(`recorded file expiry through ${action} retains uncertainty when local rejection settlement fails`, async (t) => {
    const area = randomUUID(),
      body = {
        area_id: area,
        title: 'Retained file artifact',
        content: authored('Original file context'),
        file_set: {
          version: 'artifact-files-v1',
          files: [{ path: 'evidence.txt', source: { upload_id: randomUUID() } }],
        },
      };
    const f = await fixture(
      t,
      { kind: 'artifact.create', areaId: area },
      '/api/v1/artifacts',
      body,
      true,
    );
    const button = action === 'status' ? 'Check status' : 'Retry same publication';
    const expectedRequest = {
      path: action === 'status' ? '/api/v1/operations/status' : '/api/v1/artifacts',
      method: 'POST',
      raw: JSON.stringify(
        action === 'status'
          ? { operation_kind: 'artifact.create', idempotency_key: f.original.key }
          : f.original.body,
      ),
    };
    const first = await f.request(button),
      beforeFailure = f.raw();
    assert.deepEqual({ path: first.path, method: first.method, raw: first.raw }, expectedRequest);
    const setItem = dom.window.Storage.prototype.setItem;
    let refused = false;
    const fault = t.mock.method(
      dom.window.Storage.prototype,
      'setItem',
      function (this: Storage, key: string, value: string) {
        if (
          !refused &&
          key === f.context.store.prefix + f.original.key &&
          JSON.parse(value).state === 'rejected'
        ) {
          refused = true;
          throw new Error('Synthetic rejection settlement failure');
        }
        return setItem.call(this, key, value);
      },
    );
    await f.answer(
      first,
      failure('file_expired', 'The prepared file expired; reconcile this publication.', 409, true),
      true,
    );
    assert.equal(refused, true);
    assert.equal(f.raw(), beforeFailure);
    assert.equal(f.record().state, 'uncertain');
    assert.equal(
      screen.getByRole('alert').textContent,
      action === 'status'
        ? 'The prepared file expired; reconcile this publication.'
        : 'Synthetic rejection settlement failure',
    );
    assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).disabled, true);
    assert.equal((screen.getByLabelText('File path 1') as HTMLInputElement).disabled, true);
    assert.equal(!!screen.queryByRole('button', { name: 'Prepare corrected submission' }), false);
    assert.ok(screen.getByRole('button', { name: button }));
    fault.mock.restore();
    const second = await f.request(button),
      beforeSuccess = f.record();
    assert.deepEqual(
      { path: second.path, method: second.method, raw: second.raw },
      expectedRequest,
    );
    await f.answer(
      second,
      failure('file_expired', 'The prepared file expired; reconcile this publication.', 409, true),
      true,
    );
    assert.deepEqual(f.record(), {
      ...beforeSuccess,
      state: 'rejected',
      sequence: beforeSuccess.sequence + 1,
    });
    assert.deepEqual(f.record().body, f.original.body);
    assert.ok(screen.getByRole('button', { name: 'Prepare corrected submission' }));
    assert.equal(!!screen.queryByRole('button', { name: 'Retry same publication' }), false);
    assert.deepEqual(f.committed, []);
    assert.deepEqual(
      f.calls.map((call) => ({ path: call.path, method: call.method, raw: call.raw })),
      [expectedRequest, expectedRequest],
    );
    f.assertIndependent();
  });

test('local save feedback waits for the latest queued edit and reports its failure', async (t) => {
  const area = randomUUID(),
    body = { area_id: area, title: 'Save state', content: authored('Before') };
  const f = await fixture(t, { kind: 'artifact.create', areaId: area }, '/api/v1/artifacts', body);
  const save = f.context.store.saveDraft.bind(f.context.store);
  let release!: () => void, second!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      second = resolve;
    });
  let count = 0;
  t.mock.method(f.context.store, 'saveDraft', async (...args: Parameters<typeof save>) => {
    if (++count === 1) {
      await gate;
      return save(...args);
    }
    second();
    throw new Error('Latest edit could not be stored');
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'First' } });
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Latest' } });
  });
  assert.ok(screen.getByText('Saving…', { exact: true }));
  await act(async () => {
    release();
    await started;
  });
  assert.ok(screen.getByText('Couldn’t save on this device', { exact: true }));
  assert.equal(screen.queryByText('Saved on this device', { exact: true }), null);
  assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value, 'Latest');
  assert.equal((f.record().body.content as AuthoredContent).text, 'First');
});

test('Drafts checks an uncertain publication without fetching its source or changing retained bytes', async (t) => {
  const { Drafts } = await import('../../src/web/ParticipationHelp.js');
  const discussion = randomUUID(),
    parent = randomUUID(),
    body = {
      discussion_id: discussion,
      parent_id: parent,
      content: authored('Exact uncertain text'),
    };
  const f = await fixture(
    t,
    { kind: 'reply.create', discussionId: discussion, parentId: parent },
    '/api/v1/replies',
    body,
    true,
  );
  const raw = f.raw();
  const router = createMemoryRouter(
    [
      {
        path: '/loom/drafts',
        element: (
          <AuthorizationBoundary sourcePolicy="settings">
            <Drafts context={f.context} />
          </AuthorizationBoundary>
        ),
      },
    ],
    { initialEntries: ['/loom/drafts'] },
  );
  const view = render(<RouterProvider router={router} />);
  t.after(() => {
    view.unmount();
    router.dispose();
  });
  assert.equal(f.calls.length, 0, 'Draft discovery does not hydrate source content');
  assert.ok(screen.getByRole('link', { name: /Review submission · Reply/ }));
  const status = await f.request('Check publication status');
  assert.equal(status.path, '/api/v1/operations/status');
  await f.answer(status, Response.json({ operation_state: 'not_recorded' }));
  assert.equal(f.raw(), raw);
  assert.ok(
    screen.getByText(/Confirmation is still unavailable; the earlier attempt may still commit/),
  );
  f.assertIndependent();
});

test('composition edits undo as one unit and native history input can redo without binding pasted names', async (t) => {
  const area = randomUUID(),
    body = { area_id: area, title: 'Composition', content: authored('Hello') };
  const f = await fixture(t, { kind: 'artifact.create', areaId: area }, '/api/v1/artifacts', body);
  const input = screen.getByLabelText('Text') as HTMLTextAreaElement;
  fireEvent.compositionStart(input);
  for (const value of ['Hello 日', 'Hello 日本 @Ada']) {
    const saved = f.nextSave();
    await act(async () => {
      fireEvent.change(input, { target: { value } });
      await saved;
    });
  }
  fireEvent.compositionEnd(input);
  let saved = f.nextSave();
  await act(async () => {
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    await saved;
  });
  assert.equal(input.value, 'Hello');
  saved = f.nextSave();
  await act(async () => {
    input.dispatchEvent(
      new dom.window.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'historyRedo',
      }),
    );
    await saved;
  });
  assert.equal(input.value, 'Hello 日本 @Ada');
  assert.deepEqual((f.record().body.content as AuthoredContent).mentions, []);
  f.assertIndependent();
});

test('forward word deletion cannot swap two recipients with unresolved display names', async (t) => {
  const area = randomUUID(),
    first = { token: 'first', participant_id: randomUUID() },
    second = { token: 'second', participant_id: randomUUID() };
  const body = {
    area_id: area,
    title: 'Ambiguous labels',
    content: {
      format: 'loom-markdown-v1',
      text: '[[mention:first]]\n[[mention:second]]',
      mentions: [first, second],
    },
  };
  const f = await fixture(t, { kind: 'artifact.create', areaId: area }, '/api/v1/artifacts', body);
  const input = screen.getByLabelText('Text') as HTMLTextAreaElement;
  assert.equal(input.value, '@participant\n@participant');
  input.setSelectionRange(0, 0);
  input.dispatchEvent(
    new dom.window.InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'deleteWordForward',
    }),
  );
  const saved = f.nextSave();
  await act(async () => {
    fireEvent.change(input, {
      target: { value: '@participant', selectionStart: 0, selectionEnd: 0 },
    });
    await saved;
  });
  assert.deepEqual(f.record().body.content, {
    format: 'loom-markdown-v1',
    text: '[[mention:second]]',
    mentions: [second],
  });
  f.assertIndependent();
});

for (const reply of [false, true])
  test(
    'confirmation appears only after durable settlement and retains explicit next-draft controls: reply=' +
      reply,
    async (t) => {
      const area = randomUUID(),
        discussion = randomUUID(),
        parent = randomUUID();
      const body = reply
        ? {
            discussion_id: discussion,
            parent_id: parent,
            content: authored('Exact reply awaiting settlement'),
          }
        : {
            area_id: area,
            title: 'Exact artifact title',
            content: authored('Exact artifact awaiting settlement'),
          };
      const f = await fixture(
        t,
        reply
          ? { kind: 'reply.create', discussionId: discussion, parentId: parent }
          : { kind: 'artifact.create', areaId: area },
        reply ? '/api/v1/replies' : '/api/v1/artifacts',
        body,
      );
      let reached!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settle = f.context.store.settle.bind(f.context.store);
      t.mock.method(f.context.store, 'settle', async (...args: Parameters<typeof settle>) => {
        reached();
        await gate;
        return settle(...args);
      });
      t.after(() => release());
      const call = await f.request(reply ? 'Post reply' : 'Publish');
      const committed: CommittedView = {
        publication_state: 'committed',
        idempotency: 'created',
        operation_id: randomUUID(),
        resource_id: randomUUID(),
        revision_id: randomUUID(),
      };
      await act(async () => {
        call.finish(Response.json(committed));
        await entered;
      });
      assert.ok(screen.getByText('Waiting for confirmation…'));
      assert.equal(screen.queryByText('Publication confirmed.'), null);
      assert.equal(screen.queryByRole('link', { name: 'Inspect exact revision' }), null);
      assert.deepEqual(f.committed, []);
      assert.equal(f.record().state, 'uncertain');
      const settled = f.nextSettlement();
      await act(async () => {
        release();
        await settled;
      });
      assert.ok(screen.getByText('Publication confirmed.'));
      assert.equal(
        screen.getByRole('link', { name: 'Inspect exact revision' }).getAttribute('href'),
        `/loom/resource/${committed.resource_id}/${committed.revision_id}`,
      );
      assert.deepEqual(f.committed, [committed]);
      assert.equal(f.record().state, 'committed');
      assert.deepEqual(f.record().body, { ...body, idempotency_key: f.original.key });
      assert.equal(screen.queryByRole('group', { name: 'Submission recovery' }), null);
      assert.equal(screen.queryByLabelText(reply ? 'Your reply' : 'Text'), null);
      assert.equal(!!screen.queryByRole('button', { name: 'Write another' }), !reply);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Close composer' }));
      });
      assert.equal(f.closed(), 1);
      assert.equal(f.calls.length, 1, 'Displaying or closing confirmation cannot dispatch again');
      f.assertIndependent();
    },
  );

test('status recovery preserves mounted editor and disclosure state through busy and uncertain feedback', async (t) => {
  const discussion = randomUUID(),
    parent = randomUUID();
  const body = {
    discussion_id: discussion,
    parent_id: parent,
    content: authored('Frozen reply through recovery rendering'),
  };
  const f = await fixture(
    t,
    { kind: 'reply.create', discussionId: discussion, parentId: parent },
    '/api/v1/replies',
    body,
    true,
  );
  const input = screen.getByLabelText('Your reply') as HTMLTextAreaElement;
  const preview = screen.getByText('Preview', { exact: true }).closest('details')!;
  preview.open = true;
  const original = f.raw();
  screen.getByRole('button', { name: 'Check status' }).focus();
  const call = await f.request('Check status');
  assert.equal(screen.queryByRole('group', { name: 'Submission recovery' }), null);
  assert.ok(screen.getByLabelText('Your reply') === input);
  assert.ok(preview.open);
  await f.answer(call, failure('service_unavailable', 'Status is temporarily unavailable.'));
  assert.ok(screen.getByLabelText('Your reply') === input);
  assert.ok(screen.getByText('Preview', { exact: true }).closest('details') === preview);
  assert.ok(preview.open);
  assert.ok(input.disabled);
  assert.equal(input.value, body.content.text);
  assert.ok(document.activeElement === screen.getByRole('group', { name: 'Submission recovery' }));
  assert.equal(f.raw(), original);
  f.assertIndependent();
});

test('title autosave retains the text editor undo history, selection and open formatting disclosure', async (t) => {
  const area = randomUUID(),
    body = { area_id: area, title: 'Original title', content: authored('Original prose') };
  const f = await fixture(t, { kind: 'artifact.create', areaId: area }, '/api/v1/artifacts', body);
  const input = screen.getByLabelText('Text') as HTMLTextAreaElement;
  const formatting = screen.getByText('Formatting help', { exact: true }).closest('details')!;
  formatting.open = true;
  let saved = f.nextSave();
  await act(async () => {
    fireEvent.change(input, { target: { value: 'Edited prose' } });
    await saved;
  });
  input.focus();
  input.setSelectionRange(2, 7);
  saved = f.nextSave();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    await saved;
  });
  assert.equal(screen.getByLabelText('Text'), input);
  assert.equal(screen.getByText('Formatting help', { exact: true }).closest('details'), formatting);
  assert.ok(formatting.open);
  assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 7]);
  saved = f.nextSave();
  await act(async () => {
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    await saved;
  });
  assert.equal(input.value, 'Original prose');
  assert.deepEqual(f.record().body, {
    ...body,
    title: 'Changed title',
    idempotency_key: f.original.key,
  });
  assert.equal(f.calls.length, 0, 'Local field changes cannot dispatch a publication');
  f.assertIndependent();
});

for (const [name, focused, start, end, direction, expected] of [
  ['selection before focus', false, 0, 26, 'forward', [0, 18]],
  ['already focused full selection', true, 0, 26, 'forward', [0, 18]],
  ['backward suffix selection', true, 19, 26, 'backward', [11, 18]],
  ['caret after mention', true, 19, 19, 'none', [11, 11]],
] as const)
  test('late mention names preserve native ' + name + ' before queued selection delivery', () => {
    const person = randomUUID(),
      value = {
        text: 'Before [[mention:person]] after.',
        mentions: [{ token: 'person', participant_id: person }],
      };
    const original = structuredClone(value),
      changes: unknown[] = [];
    const inputRef: { current: HTMLTextAreaElement | null } = { current: null };
    const editor = (names: Record<string, string>) => (
      <StrictMode>
        <MentionEditor
          value={value}
          names={names}
          disabled={false}
          label="Native editor"
          inputRef={inputRef}
          onChange={(next) => changes.push(next)}
          onSelection={() => {}}
        />
      </StrictMode>
    );
    const view = render(editor({})),
      input = screen.getByLabelText('Native editor') as HTMLTextAreaElement;
    if (focused) input.focus();
    input.setSelectionRange(start, end, direction);
    if (!focused) input.focus();
    view.rerender(editor({ [person]: 'Ada' }));
    assert.equal(screen.getByLabelText('Native editor'), input);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, 'Before @Ada after.');
    assert.deepEqual([input.selectionStart, input.selectionEnd], expected);
    assert.equal(input.selectionDirection, direction);
    assert.deepEqual(changes, [], 'A presentation-only name update cannot author or save content');
    assert.deepEqual(value, original, 'Canonical bytes and recipient bindings stay unchanged');
  });

test('late mention names keep a disabled editor mounted without authoring or stealing focus', () => {
  const person = randomUUID(),
    value = {
      text: 'Before [[mention:person]] after.',
      mentions: [{ token: 'person', participant_id: person }],
    };
  const original = structuredClone(value),
    changes: unknown[] = [],
    inputRef: { current: HTMLTextAreaElement | null } = { current: null };
  const editor = (names: Record<string, string>) => (
    <StrictMode>
      <MentionEditor
        value={value}
        names={names}
        disabled={true}
        label="Disabled native editor"
        inputRef={inputRef}
        onChange={(next) => changes.push(next)}
        onSelection={() => {}}
      />
    </StrictMode>
  );
  const view = render(editor({})),
    input = screen.getByLabelText('Disabled native editor') as HTMLTextAreaElement;
  input.setSelectionRange(19, 26, 'backward');
  const focus = document.activeElement;
  view.rerender(editor({ [person]: 'Ada' }));
  assert.equal(screen.getByLabelText('Disabled native editor'), input);
  assert.equal(input.disabled, true);
  assert.equal(document.activeElement, focus);
  assert.deepEqual(
    [input.selectionStart, input.selectionEnd, input.selectionDirection],
    [11, 18, 'backward'],
  );
  assert.deepEqual(changes, []);
  assert.deepEqual(value, original);
});
