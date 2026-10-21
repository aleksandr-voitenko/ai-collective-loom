import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { UpdatesPage } from '../../src/web/Updates.js';
import { UpdatesRecovery } from '../../src/web/updates-recovery.js';
import { IntentStore } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { SharedItemView } from '../../src/contracts/following.js';
import type { UpdatesPageView, UpdatesMembersPageView } from '../../src/contracts/updates.js';

const locks = navigator.locks;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'location', 'localStorage', 'Event', 'CustomEvent'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
// Keep actual Web Lock exclusion, with rejected promises releasing Node's lock after a storage fault.
Object.defineProperty(navigator, 'locks', { value: { request: (name: string, work: () => unknown) => locks.request(name, async () => work()) }, configurable: true });
const { render, screen, fireEvent, cleanup, act, within } = await import('@testing-library/react');
afterEach(() => { cleanup(); localStorage.clear(); });
const scopeKey = JSON.stringify([{ kind: 'following' }, 'all']);
const overviewRequest = { cursor: 'displayed-overview', limit: 12, max_response_bytes: 131072 };
const memberRequest = { cursor: 'displayed-members', limit: 12, max_response_bytes: 131072 };
const reasonText = 'An ancestor of the selected target changed · area · structural';
type Call = { path: string; method: string; raw: string; done: boolean; finish: (response: Response) => void };
const requestValue = ({ path, method, raw }: Call) => ({ path, method, raw });

function pages() {
  const resource = randomUUID(), event = randomUUID(), group = randomUUID(), traversal = randomUUID();
  // Moving one ancestor can affect 17 independently followed descendant areas.
  const reasons: SharedItemView['reasons'] = Array.from({ length: 17 }, () => randomUUID()).sort().map((resource_id, definition) => ({
    definition, target: { kind: 'area', resource_id }, preferences: ['structural'], relevance: 'ancestor_impact',
  }));
  const source: SharedItemView = {
    event_id: event, kind: 'area.move', resource_id: resource, discussion_id: null, revision_id: null, revision_number: null,
    actor: { id: randomUUID(), nickname: 'Topic organizer', kind: 'human' }, occurred_at: '2026-10-22T00:00:00Z',
    current: { state: 'available', title: 'Moved ancestor', path: [{ id: resource, title: 'Moved ancestor' }], browser_url: '/loom/area/' + resource },
    exact_url: null, context_url: '/loom/area/' + resource, full_content_url: null, change_note_url: null,
    reasons: reasons.slice(0, 8), reasons_complete: false, next_reason: 8, detail_url: '/api/v1/me/updates/reasons',
  };
  const overview: UpdatesPageView = {
    contract_version: 'combined-updates-1', stage: 'ready', items: [{
      id: group, kind: 'structural', current: source.current, context_url: source.context_url,
      counts: { certainty: 'exact', source_records: 1, shared_changes: 1, personal_signals: 0, reply_publications: 0,
        reply_revisions: 0, summary_changes: 0, artifact_changes: 0, opening_changes: 0, structural_changes: 1 },
      direct_sources: [], direct_sources_complete: true, members_cursor: 'structural-members', direct_cursor: null,
      explanation: null, omitted_detail: 'remaining_member_metadata; full_bodies; summary_coverage_not_computed',
    }],
    traversal: { id: traversal, scope: 'following', definitions: reasons.map(({ target, preferences }) => ({ target, preferences, include_descendants: false, version: 1 })),
      reason: 'all', selection: 'highlights', settings_current: true, grouping: 'ownership; area_event', order: 'direct_first; frozen_recent_then_identity', expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      shared: { contract: 'shared-changes-1', lower: 'shared-zero', upper: 'shared-upper', scan_complete: true, coverage: 'known', history: 'retained' },
      personal: { contract: 'personal-attention-1', lower: 'personal-zero', upper: 'personal-zero', scan_complete: true, coverage: 'known', history: 'retained' } },
    page_cursor: overviewRequest.cursor, next_cursor: null, checkpoint: null, complete_cursor: 'complete-groups', direct_cursor: 'direct-groups', records_cursor: 'all-records',
    page_exhausted: true, selection_exhausted: true, grouped_interval_complete: false, member_metadata_complete: false, full_contents_fetched: false,
    projection: { state: 'complete', coverage: 'currently_eligible_supported_sources' }, work_budget_reached: false, recovery: 'none', baseline_established: false,
    inventory: [], limit: overviewRequest.limit, max_response_bytes: overviewRequest.max_response_bytes,
  };
  const members: UpdatesMembersPageView = { contract_version: 'combined-updates-1', traversal_id: traversal, group_id: group, direct_only: false,
    items: [{ source, shared_in_interval: true, personal: null }], page_cursor: memberRequest.cursor, next_cursor: null, complete: true,
    full_contents_fetched: false, limit: memberRequest.limit, max_response_bytes: memberRequest.max_response_bytes };
  const detail = (offset: number): SharedItemView => ({ ...source, reasons: reasons.slice(offset, offset + 8),
    reasons_complete: offset + 8 >= reasons.length, next_reason: offset + 8 < reasons.length ? offset + 8 : null });
  return { source, overview, members, detail };
}

async function fixture(t: TestContext) {
  const data = pages(), instance = randomUUID(), participant = randomUUID();
  const store = new IntentStore(instance, participant, localStorage, location.origin, locks);
  const context = { community: { instance_id: instance, routine_updates_contract: 'combined-updates-2' },
    self: { participant_id: participant, csrf: 'fixture' }, store } as Context;
  const draft = store.create('independent reply', 'reply.create', '/api/v1/replies', {
    discussion_id: randomUUID(), parent_id: randomUUID(), content: { format: 'loom-markdown-v1', text: 'Independent authored draft', mentions: [] },
  });
  await store.saveDraft(draft, draft.body);
  const draftRaw = localStorage.getItem(store.prefix + draft.key);
  const routine = new UpdatesRecovery(instance, participant, localStorage, true);
  await routine.save(scopeKey, { ...data.overview, contract_version: 'combined-updates-2', page_cursor: 'independent-routine-view',
    attention: { policy_version: 0, selection: 'remaining_routine_inputs', counts: 'source_records; shared_events; personal_signals_are_distinct_units',
      refresh: 'explicit_same_scope_and_intervals' } }, 0, () => true, []);
  const routineRaw = localStorage.getItem(routine.prefix);
  const recovery = new UpdatesRecovery(instance, participant);
  // Reauthorize an already displayed ready view; a fresh traversal must first prepare.
  await recovery.save(scopeKey, data.overview, 0, () => true, []);
  const saved: (() => void)[] = [], originalSave = UpdatesRecovery.prototype.save;
  t.mock.method(UpdatesRecovery.prototype, 'save', async function (this: UpdatesRecovery, ...args: Parameters<typeof originalSave>) {
    try { return await originalSave.apply(this, args); } finally { saved.shift()?.(); }
  });
  const nextSave = () => new Promise<void>(resolve => saved.push(resolve));
  const calls: Call[] = [], requests: ((call: Call) => void)[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, options: RequestInit) => new Promise<Response>(resolve => {
    const call: Call = { path, method: options.method ?? 'GET', raw: String(options.body), done: false,
      finish: response => { assert.equal(call.done, false); call.done = true; resolve(response); } };
    calls.push(call); requests.shift()?.(call);
  }));
  const router = createMemoryRouter([{ path: '/loom/updates', element: <UpdatesPage context={context}/> }], { initialEntries: ['/loom/updates?contract=legacy'] });
  const view = render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  t.after(async () => {
    view.unmount(); router.dispose();
    await act(async () => { for (const call of calls.filter(call => !call.done)) call.finish(Response.json({ error: { code: 'service_unavailable', message: 'Fixture cleanup' } }, { status: 503 })); });
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(requestValue), [1, 2].map(() => ({ path: '/api/v1/me/updates/query', method: 'POST', raw: JSON.stringify(overviewRequest) })));
  const ready = nextSave();
  await act(async () => { for (const call of calls) call.finish(Response.json(data.overview)); await ready; });
  async function request(name: string) {
    const pending = new Promise<Call>(resolve => requests.push(resolve));
    let call: Call;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name })); call = await pending; });
    return call!;
  }
  async function answer(call: Call, response: Response, saves = false) {
    const completion = saves ? nextSave() : Promise.resolve();
    await act(async () => { call.finish(response); await completion; });
  }
  const expansionCall = await request('Inspect changes');
  assert.deepEqual(requestValue(expansionCall), { path: '/api/v1/me/updates/members', method: 'POST', raw: JSON.stringify({ cursor: 'structural-members', limit: 12 }) });
  await answer(expansionCall, Response.json(data.members), true);
  const expansion = screen.getByRole('complementary', { name: 'Expanded changes' });
  assert.equal(document.activeElement, expansion);
  const reasonDetails = within(expansion).getByText('Why this shared change is included').closest('details')!;
  await act(async () => { reasonDetails.open = true; });
  const raw = () => localStorage.getItem(recovery.prefix);
  const assertIndependent = () => {
    assert.equal(localStorage.getItem(store.prefix + draft.key), draftRaw);
    assert.equal(localStorage.getItem(routine.prefix), routineRaw);
    assert.equal(localStorage.length, 3);
  };
  const expandedRecord = { version: 1, sequence: 3, request: overviewRequest, previous_request: overviewRequest,
    expansion: memberRequest, past: [], next_cursor: null, checkpoint: null };
  assert.deepEqual(JSON.parse(raw()!), { [scopeKey]: expandedRecord });
  const assertSource = () => {
    assert.ok(screen.getByRole('heading', { name: 'Moved ancestor' }));
    assert.equal(screen.getByRole('link', { name: 'Open current context' }).getAttribute('href'), data.source.context_url);
    assert.equal(within(expansion).getByRole('link', { name: 'Current context' }).getAttribute('href'), data.source.context_url);
    assert.match(within(expansion).getByText(/area move · Topic organizer/).textContent!, /^area move · Topic organizer · /);
    assert.equal(within(expansion).getByText('Included shared change.').textContent, 'Included shared change.');
    assert.equal(within(expansion).queryByRole('link', { name: /Exact revision/ }), null);
  };
  const assertReasons = (count: number) => assert.deepEqual(within(reasonDetails).getAllByRole('listitem').map(item => item.textContent), Array(count).fill(reasonText));
  assertSource(); assertReasons(8); assertIndependent();
  return { ...data, calls, request, answer, nextSave, recovery, raw, assertIndependent, assertSource, assertReasons, expansion };
}

test('matching reasons page exactly through 8/8/1, reject duplicate admission and retry a transient failure without changing saved views', async t => {
  const f = await fixture(t), original = f.raw();
  const second = await f.request('More matching reasons');
  const button = screen.getByRole('button', { name: 'More matching reasons' });
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  await act(async () => fireEvent.click(button));
  assert.equal(f.calls.length, 4);
  await f.answer(second, Response.json(f.detail(8)));
  f.assertReasons(8); f.assertSource(); assert.equal(f.raw(), original); f.assertIndependent();
  const third = await f.request('More matching reasons');
  await f.answer(third, Response.json({ error: { code: 'service_unavailable', message: 'Matching reasons temporarily unavailable' } }, { status: 503 }));
  assert.match(screen.getByRole('alert').textContent!, /Matching reasons temporarily unavailable/);
  f.assertReasons(8); f.assertSource(); assert.equal(f.raw(), original); f.assertIndependent();
  const retry = await f.request('More matching reasons');
  assert.deepEqual(f.calls.slice(3).map(requestValue), [8, 16, 16].map(reason_offset => ({
    path: '/api/v1/me/updates/reasons', method: 'POST', raw: JSON.stringify({ cursor: 'displayed-members', event_id: f.source.event_id, reason_offset }),
  })));
  await f.answer(retry, Response.json(f.detail(16)));
  f.assertReasons(1); f.assertSource(); assert.equal(f.raw(), original); f.assertIndependent();
  assert.equal(screen.queryByRole('button', { name: 'More matching reasons' }), null);
  assert.equal(screen.getByText('Matching reasons complete for this source.').textContent, 'Matching reasons complete for this source.');
  assert.equal(f.calls.length, 6);
});

test('collapse retains the expanded view after a failed save, then saves before closing and fences a held reason response', async t => {
  const f = await fixture(t), original = f.raw();
  const pending = await f.request('More matching reasons');
  assert.deepEqual(requestValue(pending), { path: '/api/v1/me/updates/reasons', method: 'POST',
    raw: JSON.stringify({ cursor: 'displayed-members', event_id: f.source.event_id, reason_offset: 8 }) });
  const setItem = dom.window.Storage.prototype.setItem;
  let failed = false;
  const fault = t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (key === f.recovery.prefix && !failed) { failed = true; throw new Error('Synthetic collapse storage failure'); }
    setItem.call(this, key, value);
  });
  const refused = f.nextSave();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Close changes' })); await refused; });
  assert.equal(failed, true);
  assert.match(screen.getByRole('alert').textContent!, /Updates recovery could not be saved/);
  assert.equal(screen.getByRole('complementary', { name: 'Expanded changes' }), f.expansion);
  f.assertReasons(8); f.assertSource(); assert.equal(f.raw(), original); f.assertIndependent();
  fault.mock.restore();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const blocker = locks.request(f.recovery.prefix, async () => { entered(); await gate; });
  await held;
  const saved = f.nextSave();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close changes' })));
  assert.equal(screen.getByRole('button', { name: 'Close changes' }).getAttribute('aria-disabled'), 'true');
  assert.equal(screen.getByRole('complementary', { name: 'Expanded changes' }), f.expansion);
  f.assertReasons(8); f.assertSource(); assert.equal(f.raw(), original); f.assertIndependent();
  await act(async () => { release(); await blocker; await saved; });
  assert.equal(screen.queryByRole('complementary', { name: 'Expanded changes' }), null);
  assert.equal(document.activeElement, screen.getByRole('button', { name: 'Inspect changes' }));
  assert.deepEqual(JSON.parse(f.raw()!), { [scopeKey]: { version: 1, sequence: 4, request: overviewRequest,
    previous_request: overviewRequest, past: [], next_cursor: null, checkpoint: null } });
  const closed = f.raw();
  await f.answer(pending, Response.json(f.detail(8)));
  assert.equal(screen.queryByRole('complementary', { name: 'Expanded changes' }), null);
  assert.equal(screen.queryByText('Why this shared change is included'), null);
  assert.equal(document.activeElement, screen.getByRole('button', { name: 'Inspect changes' }));
  assert.ok(screen.getByRole('heading', { name: 'Moved ancestor' }));
  assert.equal(f.raw(), closed); f.assertIndependent();
  assert.equal(f.calls.length, 4);
});
