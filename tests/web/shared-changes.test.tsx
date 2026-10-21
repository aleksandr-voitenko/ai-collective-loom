import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { SharedChangesPage } from '../../src/web/SharedChanges.js';
import { IntentStore, invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { MatchReasonView, SharedItemView, SharedPageView } from '../../src/contracts/following.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'location', 'localStorage', 'Event', 'CustomEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(navigator, 'locks', { value: { request: async (_name: string, work: () => unknown) => work() }, configurable: true });
const { render, screen, within, fireEvent, cleanup, act, waitFor } = await import('@testing-library/react');
afterEach(() => { cleanup(); localStorage.clear(); });

type Call = { path: string; body: unknown; finish: (response: Response) => void };
function fixture() {
  // Moving one ancestor can affect many independently followed descendant topics.
  const reasons: MatchReasonView[] = Array.from({ length: 17 }, (_, definition) => ({
    definition, target: { kind: 'area', resource_id: randomUUID() }, preferences: ['structural'],
    relevance: 'ancestor_impact',
  }));
  const resource = randomUUID();
  const item: SharedItemView = {
    event_id: randomUUID(), kind: 'area.move', resource_id: resource, discussion_id: null,
    revision_id: null, revision_number: null, actor: { id: randomUUID(), nickname: 'publisher', kind: 'human' },
    occurred_at: '2026-10-22T00:00:00Z', current: { state: 'available', title: 'Retained topic change',
      path: [{ id: resource, title: 'Retained topic change' }], browser_url: '/loom/area/' + resource },
    exact_url: null, context_url: '/loom/area/' + resource,
    full_content_url: null, change_note_url: null,
    reasons: reasons.slice(0, 8), reasons_complete: false, next_reason: 8, detail_url: '/api/v1/shared-changes/detail',
  };
  const page: SharedPageView = {
    contract_version: 'shared-changes-1', items: [item], traversal: {
      id: randomUUID(), scope: 'following', definitions: reasons.map(reason => ({ target: reason.target, preferences: reason.preferences, include_descendants: false, version: 1 })),
      settings_current: true, selection: 'complete', grouping: 'none', order: 'committed_event_ascending',
      expires_at: '2026-10-23T00:00:00Z', boundaries: 'fixed_shared_interval', history_start: 'retained_history',
    }, page_cursor: 'displayed-page', next_cursor: null, checkpoint: 'completed-interval', page_exhausted: true,
    interval_complete: true, no_subscriptions: false, work_budget_reached: false, coverage: 'known', coverage_limit: null,
    recovery: 'none', history: 'retained', baseline_established: false, inventory: [], omitted_detail: 'full_bodies',
    limit: 12, max_response_bytes: 131072,
  };
  const detail = (offset: number): SharedItemView => ({ ...item, reasons: reasons.slice(offset, offset + 8),
    reasons_complete: offset + 8 >= reasons.length, next_reason: offset + 8 >= reasons.length ? null : offset + 8 });
  return { item, page, detail };
}
function mount(t: TestContext) {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, options: RequestInit) => new Promise<Response>(finish => {
    calls.push({ path, body: options.body ? JSON.parse(String(options.body)) : undefined, finish });
  }));
  const instance = randomUUID(), participant = randomUUID();
  const context = { community: { instance_id: instance }, self: { participant_id: participant, csrf: 'fixture' },
    store: new IntentStore(instance, participant) } as Context;
  const router = createMemoryRouter([
    { path: '/loom/changes', element: <AuthorizationBoundary><SharedChangesPage context={context}/></AuthorizationBoundary> },
    { path: '/other', element: <h1>Other view</h1> },
  ], { initialEntries: ['/loom/changes'] });
  t.after(() => router.dispose());
  render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  const prefix = `loom.shared-pages:${location.origin}:${instance}:${participant}`;
  return { calls, router, prefix, raw: () => localStorage.getItem(prefix) };
}
async function ready(t: TestContext) {
  const f = { ...mount(t), ...fixture() };
  await waitFor(() => assert.equal(f.calls.length, 2));
  await act(async () => { for (const call of f.calls) call.finish(Response.json(f.page)); });
  await screen.findByRole('heading', { name: 'Retained topic change' });
  assert.deepEqual(JSON.parse(f.raw()!), { '{"kind":"following"}': {
    version: 1, sequence: 1, request: { cursor: 'displayed-page', limit: 12, max_response_bytes: 131072 },
    recent_event_ids: [f.item.event_id],
  } });
  return f;
}
const click = async (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const visibleRows = () => [...document.querySelectorAll('.notification-list > li')].map(row => row.textContent);
const reasonText = (item: SharedItemView) => item.reasons.map(reason =>
  `Affected by an ancestor change · area ${reason.target.resource_id.slice(0, 8)} · Organization changes`);
const shownReasons = () => within(screen.getByRole('complementary', { name: 'Additional match reasons' })).getAllByRole('listitem').map(item => item.textContent);

test('shared explanation paging uses the displayed cursor and exact reason offsets without advancing recovery', async t => {
  const f = await ready(t), saved = f.raw(), rows = visibleRows();
  await click('More match reasons');
  const first = f.calls.at(-1)!;
  assert.deepEqual({ path: first.path, body: first.body }, { path: f.item.detail_url,
    body: { cursor: f.page.page_cursor, event_id: f.item.event_id, reason_offset: 8 } });
  assert.equal(screen.getByRole('button', { name: 'More match reasons' }).getAttribute('aria-disabled'), 'true');
  await click('More match reasons');
  await click('Check newer shared changes');
  assert.equal(f.calls.length, 3, 'Held explanation fetch prevents duplicate detail and page dispatch.');
  await act(async () => first.finish(Response.json(f.detail(8))));
  assert.deepEqual(shownReasons(), reasonText(f.detail(8)));
  assert.deepEqual(visibleRows(), rows);
  assert.equal(f.raw(), saved);
  await click('Next reasons');
  assert.deepEqual(f.calls.at(-1)!.body, { cursor: f.page.page_cursor, event_id: f.item.event_id, reason_offset: 16 });
  await act(async () => f.calls.at(-1)!.finish(Response.json(f.detail(16))));
  assert.deepEqual(shownReasons(), reasonText(f.detail(16)));
  assert.equal(!!screen.queryByRole('button', { name: 'Next reasons' }), false);
  await click('Close reasons');
  assert.equal(!!screen.queryByRole('complementary', { name: 'Additional match reasons' }), false);
  assert.deepEqual(visibleRows(), rows);
  assert.equal(f.raw(), saved);
});

test('shared reason failures retain old explanations for explicit retry and withdraw them on interval invalidation', async t => {
  const f = await ready(t), saved = f.raw(), rows = visibleRows();
  await click('More match reasons');
  await act(async () => f.calls.at(-1)!.finish(Response.json(f.detail(8))));
  await click('Next reasons');
  const failed = f.calls.at(-1)!;
  await act(async () => failed.finish(Response.json({ error: { code: 'service_unavailable', message: 'Reason service unavailable' } }, { status: 503 })));
  assert.match(screen.getByRole('alert').textContent!, /Reason service unavailable/);
  assert.deepEqual(shownReasons(), reasonText(f.detail(8)));
  assert.deepEqual(visibleRows(), rows);
  assert.equal(f.raw(), saved);
  await click('Next reasons');
  assert.deepEqual({ path: f.calls.at(-1)!.path, body: f.calls.at(-1)!.body }, { path: failed.path, body: failed.body });
  await act(async () => f.calls.at(-1)!.finish(Response.json(f.detail(16))));
  assert.deepEqual(shownReasons(), reasonText(f.detail(16)));
  await click('More match reasons');
  await act(async () => f.calls.at(-1)!.finish(Response.json({ error: { code: 'shared_visibility_replay_required', message: 'Visibility changed; replay required' } }, { status: 409 })));
  assert.deepEqual(visibleRows(), []);
  assert.equal(!!screen.queryByRole('complementary', { name: 'Additional match reasons' }), false);
  assert.equal(document.activeElement, screen.getByRole('alert'));
  assert.equal(f.raw(), saved);
  await click('Replay retained shared history');
  assert.deepEqual(f.calls.at(-1)!.body, { recovery: { action: 'replay', token: f.page.page_cursor } });
  await act(async () => f.calls.at(-1)!.finish(Response.json({ ...f.page, recovery: 'visibility_replay' })));
  assert.deepEqual(visibleRows(), rows);
  assert.equal(document.activeElement, screen.getByRole('heading', { name: 'Changes' }));
  assert.deepEqual(JSON.parse(f.raw()!)['{"kind":"following"}'].recent_event_ids, [f.item.event_id]);
});

for (const departure of ['route', 'identity'] as const) for (const outcome of ['success', 'failure'] as const)
test(`a late shared explanation ${outcome} cannot cross ${departure} ownership`, async t => {
  const f = await ready(t), saved = f.raw();
  await click('More match reasons');
  const pending = f.calls.at(-1)!;
  if (departure === 'route') await act(async () => f.router.navigate('/other'));
  else await act(async () => { invalidateIdentity(); });
  await act(async () => pending.finish(outcome === 'success' ? Response.json(f.detail(8))
    : Response.json({ error: { code: 'service_unavailable', message: 'Departed explanation failed' } }, { status: 503 })));
  assert.equal(!!screen.queryByRole('complementary', { name: 'Additional match reasons' }), false);
  assert.equal(!!screen.queryByText('Departed explanation failed'), false);
  if (departure === 'route') assert.ok(screen.getByRole('heading', { name: 'Other view' }));
  assert.equal(f.raw(), saved);
});

test('explicit shared baseline appears only after durable save and retries a failed save with its exact displayed request', async t => {
  const f = await ready(t), saved = f.raw(), rows = visibleRows();
  localStorage.setItem('loom.notifications:independent', 'retained personal checkpoint');
  const baseline: SharedPageView = { ...f.page, items: [], page_cursor: 'baseline-page', checkpoint: 'baseline-checkpoint',
    interval_complete: false, history: 'incomplete', recovery: 'retained_resynchronization', baseline_established: true,
    inventory: f.page.traversal.definitions.flatMap(definition => [
      { label: 'Current discussions in selected topic', url: `/api/v1/areas/${definition.target.resource_id}/discussions` },
      { label: 'Current artifacts in selected topic', url: `/api/v1/areas/${definition.target.resource_id}/artifacts` },
    ]) };
  let release!: () => void;
  const lock = t.mock.method(navigator.locks, 'request', (_name: string, work: () => unknown) => new Promise((resolve, reject) => {
    release = () => { try { resolve(work()); } catch (error) { reject(error); } };
  }));
  const original = dom.window.Storage.prototype.setItem;
  let fail = true;
  t.mock.method(dom.window.Storage.prototype, 'setItem', function(this: Storage, key: string, value: string) {
    if (key === f.prefix && fail) { fail = false; throw new Error('Synthetic baseline save failure'); }
    original.call(this, key, value);
  });
  await click('Establish new baseline and inspect retained content');
  assert.deepEqual(f.calls.at(-1)!.body, { recovery: { action: 'resynchronize', token: f.page.page_cursor } });
  await act(async () => f.calls.at(-1)!.finish(Response.json(baseline)));
  assert.ok(release, 'The returned baseline must reach the actual journal lock.');
  assert.equal(screen.queryAllByRole('link', { name: 'Current discussions in selected topic' }).length, 0);
  assert.deepEqual(visibleRows(), rows);
  assert.equal(f.raw(), saved);
  await act(async () => release());
  assert.match(screen.getByRole('alert').textContent!, /Shared recovery could not be saved/);
  assert.equal(!!screen.queryByText(/A new baseline is saved/), false);
  assert.deepEqual(visibleRows(), rows);
  assert.equal(f.raw(), saved);
  lock.mock.restore();
  await click('Retry shared page');
  assert.deepEqual(f.calls.at(-1)!.body, { cursor: 'baseline-page', limit: 12, max_response_bytes: 131072 });
  await act(async () => f.calls.at(-1)!.finish(Response.json(baseline)));
  assert.deepEqual(JSON.parse(f.raw()!), { '{"kind":"following"}': {
    version: 1, sequence: 2, request: { cursor: 'baseline-page', limit: 12, max_response_bytes: 131072 },
    previous_request: { cursor: 'displayed-page', limit: 12, max_response_bytes: 131072 }, recent_event_ids: [f.item.event_id],
  } });
  assert.deepEqual(visibleRows(), []);
  assert.match(screen.getByText(/A new baseline is saved/).textContent!, /No expired events or read state were reconstructed/);
  assert.ok(screen.getByText(/This view has an incomplete-history baseline/));
  const inventory = screen.getByText(/A new baseline is saved/).nextElementSibling as HTMLElement;
  assert.deepEqual(within(inventory).getAllByRole('link').map(link => ({ label: link.textContent, url: link.getAttribute('href') })), baseline.inventory);
  assert.equal(!!screen.queryByText(/Eligible shared changes in this named fixed interval have been retrieved/), false);
  assert.equal(localStorage.getItem('loom.notifications:independent'), 'retained personal checkpoint');
});

test('an empty Following selection exposes independent personal attention without inventing shared activity', async t => {
  const f = mount(t), { page } = fixture();
  const empty: SharedPageView = { ...page, items: [], traversal: { ...page.traversal, definitions: [] },
    no_subscriptions: true, checkpoint: null, interval_complete: false };
  await waitFor(() => assert.equal(f.calls.length, 2));
  await act(async () => { for (const call of f.calls) call.finish(Response.json(empty)); });
  assert.ok(screen.getByRole('heading', { name: 'No followed scopes' }));
  const emptyView = screen.getByRole('heading', { name: 'No followed scopes' }).parentElement!;
  assert.equal(within(emptyView).getByRole('link', { name: 'Mentions/replies' }).getAttribute('href'), '/loom/notifications');
  assert.deepEqual(visibleRows(), []);
  assert.equal(!!screen.queryByRole('button', { name: 'Check newer shared changes' }), false);
  assert.equal(!!screen.queryByText(/Eligible shared changes in this named fixed interval have been retrieved/), false);
  assert.deepEqual(JSON.parse(f.raw()!), { '{"kind":"following"}': {
    version: 1, sequence: 1, request: { cursor: page.page_cursor, limit: 12, max_response_bytes: 131072 }, recent_event_ids: [],
  } });
});
