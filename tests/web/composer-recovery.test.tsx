import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { Composer } from '../../src/web/ParticipationComposer.js';
import { IntentStore } from '../../src/web/participation-client.js';
import type { ComposerOperation } from '../../src/web/composer-draft.js';
import type { Context } from '../../src/web/participation-state.js';
import type { CommittedView, PageView } from '../../src/contracts/participation.js';

const locks = navigator.locks;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'location', 'localStorage', 'Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
afterEach(() => { cleanup(); localStorage.clear(); });

for (const uncertain of [false,true]) test('temporary throttle retains composer command and reload recovery: '+uncertain,async t=>{
  const area=randomUUID(),body={area_id:area,title:'Throttle draft',content:authored('Keep these exact authored bytes')};
  const f=await fixture(t,{kind:'artifact.create',areaId:area},'/api/v1/artifacts',body,uncertain);
  const first=await f.request(uncertain?'Retry same publication':'Publish');
  const exact=first.raw;
  await f.answer(first,failure('temporarily_throttled','Wait 17 seconds; keep the exact request.',429));
  assert.equal(f.record().state,'uncertain');assert.deepEqual(f.record().body,{...body,idempotency_key:f.original.key});
  assert.equal(!!screen.queryByRole('button',{name:'Prepare corrected submission'}),false);
  f.remount();assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value,body.content.text);
  const status=await f.request('Check status');await f.answer(status,failure('temporarily_throttled','Recovery capacity temporarily full.',429));
  assert.equal(f.record().state,'uncertain');
  const retry=await f.request('Retry same publication');assert.equal(retry.raw,exact);
  await f.answer(retry,Response.json({publication_state:'committed',idempotency:'replayed',operation_id:randomUUID(),resource_id:randomUUID(),revision_id:randomUUID()}),true);
  assert.equal(f.record().state,'committed');f.assertIndependent();
});
const authored = (text: string) => ({ format: 'loom-markdown-v1' as const, text, mentions: [] });
const failure = (code: string, message: string, status = 503, rejected = false) => Response.json({ error: {
  code, message, ...(rejected ? { operation_outcome: 'rejected' } : {}),
} }, { status });
type Call = { path: string; method: string; raw: string | undefined; done: boolean; finish: (response: Response) => void };

async function fixture(t: TestContext, operation: ComposerOperation, path: string, body: Record<string, unknown>, uncertain = false) {
  const instance = randomUUID(), participant = randomUUID(), slot = 'composer fixture';
  const context = { self: { participant_id: participant, nickname: 'Current author', kind: 'human', csrf: 'fixture' },
    community: { instance_id: instance }, store: new IntentStore(instance, participant, localStorage, location.origin, locks) } as Context;
  let original = context.store.create(slot, operation.kind, path, body);
  original = await context.store.saveDraft(original, body);
  if (uncertain) original = await context.store.prepareDispatch(original, original.body);
  const other = context.store.create('independent reply', 'reply.create', '/api/v1/replies', {
    discussion_id: randomUUID(), parent_id: randomUUID(), content: authored('Independent draft remains untouched'),
  });
  await context.store.saveDraft(other, other.body);
  const otherRaw = localStorage.getItem(context.store.prefix + other.key);
  const saved: (() => void)[] = [], settled: (() => void)[] = [];
  const saveDraft = context.store.saveDraft.bind(context.store), settle = context.store.settle.bind(context.store);
  // These barriers observe actual journal completion under the real Web Lock.
  t.mock.method(context.store, 'saveDraft', async (...args: Parameters<typeof saveDraft>) => {
    try { return await saveDraft(...args); } finally { saved.shift()?.(); }
  });
  t.mock.method(context.store, 'settle', async (...args: Parameters<typeof settle>) => {
    try { return await settle(...args); } finally { settled.shift()?.(); }
  });
  const nextSave = () => new Promise<void>(resolve => saved.push(resolve));
  const nextSettlement = () => new Promise<void>(resolve => settled.push(resolve));
  const calls: Call[] = [], requests: ((call: Call) => void)[] = [];
  t.mock.method(globalThis, 'fetch', (requestPath: string, options?: RequestInit) => new Promise<Response>(resolve => {
    const call: Call = { path: requestPath, method: options?.method ?? 'GET', raw: options?.body === undefined ? undefined : String(options.body), done: false,
      finish: response => { assert.equal(call.done, false); call.done = true; resolve(response); } };
    calls.push(call); requests.shift()?.(call);
  }));
  const committed: CommittedView[] = [];
  let router: ReturnType<typeof createMemoryRouter>, view: ReturnType<typeof render>;
  function mount() {
    router = createMemoryRouter([{ path: '/compose', element: <AuthorizationBoundary><Composer context={context} operation={operation}
      slot={slot} heading="Authored draft" initialText="Newer defaults must not replace retained text" initialTitle="Newer default title"
      onCommitted={value => committed.push(value)}/></AuthorizationBoundary> }], { initialEntries: ['/compose?intent=' + original.key] });
    view = render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  }
  function remount() { view.unmount(); router.dispose(); mount(); }
  t.after(async () => {
    view?.unmount(); router?.dispose();
    await act(async () => { for (const call of calls.filter(call => !call.done)) call.finish(failure('service_unavailable', 'Fixture cleanup')); });
  });
  async function request(name: string) {
    const pending = new Promise<Call>(resolve => requests.push(resolve));
    let call: Call;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name })); call = await pending; });
    return call!;
  }
  async function answer(call: Call, response: Response, settlement = false) {
    const completion = settlement ? nextSettlement() : Promise.resolve();
    await act(async () => { call.finish(response); await completion; });
  }
  const raw = () => localStorage.getItem(context.store.prefix + original.key);
  const record = () => context.store.all().find(value => value.key === original.key)!;
  const assertIndependent = () => {
    assert.equal(localStorage.getItem(context.store.prefix + other.key), otherRaw);
    assert.equal(context.store.all().length, 2);
  };
  mount();
  return { context, original, calls, committed, request, answer, remount, nextSave, raw, record, assertIndependent };
}

test('participant selection saves exact mentions before remount and removal preserves the other declaration and text', async t => {
  const area = randomUUID(), body = { area_id: area, title: 'Authored title', content: authored('Opening text') };
  const f = await fixture(t, { kind: 'discussion.create', areaId: area }, '/api/v1/discussions', body);
  const ada = { id: randomUUID(), nickname: 'Ada', kind: 'human' }, bo = { id: randomUUID(), nickname: 'Bo', kind: 'agent' };
  // A complete active-participant page includes the current author too.
  const people: PageView = { items: [ada, bo, { id: f.context.self.participant_id, nickname: 'Current author', kind: 'human' }].sort((a, b) => a.id.localeCompare(b.id)),
    scope: 'participants:all', representation: 'metadata', omitted_detail: 'bodies', next_cursor: null,
    complete: true, work_budget_reached: false, limit: 12, max_response_bytes: 131072 };
  const mentions = [ { token: 'm111111111111', participant_id: ada.id }, { token: 'm222222222222', participant_id: bo.id } ];
  for (const [index, person] of [ada, bo].entries()) {
    const call = await f.request('＠ Mention a participant');
    assert.deepEqual({ path: call.path, method: call.method, raw: call.raw }, { path: '/api/v1/participants', method: 'GET', raw: undefined });
    await act(async () => {
      for (const pending of f.calls.filter(value => !value.done && value.path === '/api/v1/participants'))
        pending.finish(Response.json(people));
    });
    const uuid = index === 0 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const random = t.mock.method(crypto, 'randomUUID', () => uuid);
    const saved = f.nextSave();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '@' + person.nickname })); await saved; });
    random.mock.restore();
    assert.equal(!!screen.queryByRole('button', { name: '@' + person.nickname }), false);
    assert.equal(document.activeElement, screen.getByLabelText('Text'));
  }
  // A draft may contain a duplicated marker; removal must clear every occurrence before publishing.
  const duplicated = 'Opening text [[mention:m111111111111]] [[mention:m222222222222]]\nTail [[mention:m111111111111]] stays.';
  const saved = f.nextSave();
  await act(async () => { fireEvent.change(screen.getByLabelText('Text'), { target: { value: duplicated } }); await saved; });
  const expected = { ...body, content: { format: 'loom-markdown-v1', text: duplicated, mentions }, idempotency_key: f.original.key };
  assert.deepEqual(f.record(), { ...f.original, sequence: f.original.sequence + 3, body: expected });
  f.remount();
  assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value, duplicated);
  assert.equal((screen.getByLabelText('Title') as HTMLInputElement).value, 'Authored title');
  assert.ok(screen.getByRole('button', { name: 'Remove mention m111111111111' }));
  assert.ok(screen.getByRole('button', { name: 'Remove mention m222222222222' }));
  const removed = f.nextSave();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove mention m111111111111' })); await removed; });
  const remaining = 'Opening text  [[mention:m222222222222]]\nTail  stays.';
  assert.deepEqual(f.record(), { ...f.original, sequence: f.original.sequence + 4,
    body: { ...body, content: { format: 'loom-markdown-v1', text: remaining, mentions: [mentions[1]] }, idempotency_key: f.original.key } });
  f.remount();
  assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).value, remaining);
  assert.equal(!!screen.queryByRole('button', { name: 'Remove mention m111111111111' }), false);
  assert.ok(screen.getByRole('button', { name: 'Remove mention m222222222222' }));
  assert.ok(f.calls.length >= 2);
  assert.deepEqual([...new Set(f.calls.map(call => call.method + ' ' + call.path))], ['GET /api/v1/participants']);
  assert.ok(f.calls.every(call => call.done));
  f.assertIndependent();
});

test('not-recorded and unavailable reply status preserve exact uncertainty until explicit same-body retry commits', async t => {
  const discussion = randomUUID(), parent = randomUUID();
  const body = { discussion_id: discussion, parent_id: parent, content: authored('Original reply · café\nExact  spacing') };
  const f = await fixture(t, { kind: 'reply.create', discussionId: discussion, parentId: parent }, '/api/v1/replies', body, true);
  const originalRaw = f.raw(), statusBody = JSON.stringify({ operation_kind: 'reply.create', idempotency_key: f.original.key });
  const first = await f.request('Check status');
  assert.deepEqual({ path: first.path, method: first.method, raw: first.raw }, { path: '/api/v1/operations/status', method: 'POST', raw: statusBody });
  assert.equal((screen.getByLabelText('Your reply') as HTMLTextAreaElement).disabled, true);
  assert.equal(f.calls.length, 1);
  await f.answer(first, Response.json({ operation_state: 'not_recorded' }));
  assert.ok(screen.getByText('Confirmation is still unavailable. The original request may still commit.'));
  assert.equal(f.raw(), originalRaw);
  assert.ok(screen.getByRole('button', { name: 'Retry same reply' }));
  const second = await f.request('Check status');
  assert.equal(second.raw, statusBody);
  await f.answer(second, failure('service_unavailable', 'Status is temporarily unavailable'));
  assert.equal(screen.getByRole('alert').textContent, 'Status is temporarily unavailable');
  assert.equal(f.raw(), originalRaw);
  assert.equal(!!screen.queryByRole('button', { name: 'Prepare corrected submission' }), false);
  const retry = await f.request('Retry same reply');
  assert.deepEqual({ path: retry.path, method: retry.method, raw: retry.raw }, { path: '/api/v1/replies', method: 'POST', raw: JSON.stringify(f.original.body) });
  const dispatched = f.record();
  assert.deepEqual(dispatched, { ...f.original, sequence: f.original.sequence + 1 });
  const result: CommittedView = { publication_state: 'committed', idempotency: 'replayed', operation_id: randomUUID(), resource_id: randomUUID(), revision_id: randomUUID() };
  await f.answer(retry, Response.json(result), true);
  assert.deepEqual(f.record(), { ...dispatched, sequence: dispatched.sequence + 1, state: 'committed', result });
  assert.deepEqual(f.committed, [result]);
  assert.ok(screen.getByText('Your reply was posted.'));
  assert.equal(screen.getByRole('link', { name: 'Inspect exact revision' }).getAttribute('href'), `/loom/resource/${result.resource_id}/${result.revision_id}`);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/v1/operations/status', '/api/v1/operations/status', '/api/v1/replies']);
  f.assertIndependent();
});

for (const action of ['status', 'retry'] as const) test(`recorded file expiry through ${action} retains uncertainty when local rejection settlement fails`, async t => {
  const area = randomUUID(), body = { area_id: area, title: 'Retained file artifact', content: authored('Original file context'),
    file_set: { version: 'artifact-files-v1', files: [{ path: 'evidence.txt', source: { upload_id: randomUUID() } }] } };
  const f = await fixture(t, { kind: 'artifact.create', areaId: area }, '/api/v1/artifacts', body, true);
  const button = action === 'status' ? 'Check status' : 'Retry same publication';
  const expectedRequest = { path: action === 'status' ? '/api/v1/operations/status' : '/api/v1/artifacts', method: 'POST',
    raw: JSON.stringify(action === 'status' ? { operation_kind: 'artifact.create', idempotency_key: f.original.key } : f.original.body) };
  const first = await f.request(button), beforeFailure = f.raw();
  assert.deepEqual({ path: first.path, method: first.method, raw: first.raw }, expectedRequest);
  const setItem = dom.window.Storage.prototype.setItem;
  let refused = false;
  const fault = t.mock.method(dom.window.Storage.prototype, 'setItem', function(this: Storage, key: string, value: string) {
    if (!refused && key === f.context.store.prefix + f.original.key && JSON.parse(value).state === 'rejected') {
      refused = true; throw new Error('Synthetic rejection settlement failure');
    }
    return setItem.call(this, key, value);
  });
  await f.answer(first, failure('file_expired', 'The prepared file expired; reconcile this publication.', 409, true), true);
  assert.equal(refused, true);
  assert.equal(f.raw(), beforeFailure);
  assert.equal(f.record().state, 'uncertain');
  assert.equal(screen.getByRole('alert').textContent, action === 'status'
    ? 'The prepared file expired; reconcile this publication.' : 'Synthetic rejection settlement failure');
  assert.equal((screen.getByLabelText('Text') as HTMLTextAreaElement).disabled, true);
  assert.equal((screen.getByLabelText('File path 1') as HTMLInputElement).disabled, true);
  assert.equal(!!screen.queryByRole('button', { name: 'Prepare corrected submission' }), false);
  assert.ok(screen.getByRole('button', { name: button }));
  fault.mock.restore();
  const second = await f.request(button), beforeSuccess = f.record();
  assert.deepEqual({ path: second.path, method: second.method, raw: second.raw }, expectedRequest);
  await f.answer(second, failure('file_expired', 'The prepared file expired; reconcile this publication.', 409, true), true);
  assert.deepEqual(f.record(), { ...beforeSuccess, state: 'rejected', sequence: beforeSuccess.sequence + 1 });
  assert.deepEqual(f.record().body, f.original.body);
  assert.ok(screen.getByRole('button', { name: 'Prepare corrected submission' }));
  assert.equal(!!screen.queryByRole('button', { name: 'Retry same publication' }), false);
  assert.deepEqual(f.committed, []);
  assert.deepEqual(f.calls.map(call => ({ path: call.path, method: call.method, raw: call.raw })), [expectedRequest, expectedRequest]);
  f.assertIndependent();
});
