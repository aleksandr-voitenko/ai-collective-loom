import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { OrganizationPage, OrganizationRecovery } from '../../src/web/Organization.js';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { IntentStore, invalidateIdentity, type Intent } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { OrganizationResourceView, OrganizationResult } from '../../src/contracts/organization.js';
import { contractVersion, guideRevision, limits } from '../../src/contracts/participation.js';

const locks = navigator.locks;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'location', 'localStorage', 'Event', 'CustomEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act, waitFor } = await import('@testing-library/react');
afterEach(() => { cleanup(); localStorage.clear(); });

type Call = { path: string; method: string; body: unknown; raw: string | undefined; done: boolean; finish: (response: Response) => void };
function fixture(t: TestContext, kind: 'area.edit' | 'area.create' = 'area.edit') {
  const instance = randomUUID(), participant = randomUUID();
  const resource: OrganizationResourceView = {
    resource_id: randomUUID(), kind: 'area', parent_id: null, version: 1, hierarchy_version: 1,
    title: 'Current topic', description: 'Current scope', metadata_version: 1,
    local_open: true, publication_open: true, can_organize: true, ancestors: [],
    contacts_url: '/api/v1/contacts', proposal_route_url: '/api/v1/areas/proposal-route',
  };
  const context: Context = {
    self: { participant_id: participant, credential_id: randomUUID(), nickname: 'administrator', kind: 'human', role: 'administrator' },
    community: {
      moderation_contract: 'moderation-state-1', moderation_url: '/api/v1/admin/moderation/targets',
      instance_id: instance, contract_version: contractVersion, guide_revision: guideRevision,
      profile: 'synthetic', community_name: 'Synthetic community', settings_version: 1,
      overview: { state: 'setup_incomplete' }, proposal_area: { state: 'setup_incomplete' }, contacts: [],
      contacts_url: '/api/v1/contacts', guide_url: '/api/v1/guide', openapi_url: '/api/v1/openapi.json', limits,
      replay_retention: 'retained_without_automatic_expiry; destructive_restore_unsupported',
      derived_effects: 'search_and_personal_direct_attention; other_projections_disabled',
      notification_contract: 'personal-attention-1', notifications_url: '/api/v1/me/notifications/query',
      following_contract: 'following-1', following_url: '/api/v1/me/following',
      attention_contract: 'attention-controls-1', attention_url: '/api/v1/me/attention/list',
      routine_updates_contract: 'combined-updates-2', routine_updates_url: '/api/v1/me/routine-updates/query',
      reading_contract: 'reading-state-1', reading_url: '/api/v1/me/reading/lookup',
      updates_contract: 'combined-updates-1', updates_url: '/api/v1/me/updates/query',
      shared_changes_contract: 'shared-changes-1', shared_changes_url: '/api/v1/shared-changes/query',
    },
    store: new IntentStore(instance, participant, localStorage, location.origin, locks),
    refreshCommunity: () => { throw new Error('Recovery must not refresh community automatically'); },
  };
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, options?: RequestInit) => new Promise<Response>(resolve => {
    const raw = options?.body === undefined ? undefined : String(options.body);
    const call: Call = { path, method: options?.method ?? 'GET', raw, body: raw ? JSON.parse(raw) : undefined, done: false,
      finish(response) { assert.equal(call.done, false, 'A request settles only once'); call.done = true; resolve(response); } };
    calls.push(call);
  }));
  let router: ReturnType<typeof createMemoryRouter>;
  function mount(entry = '/loom/organize?intent=missing') {
    router = createMemoryRouter([
      { path: '/loom/organize', element: <AuthorizationBoundary><OrganizationPage context={context} /></AuthorizationBoundary> },
      { path: '/recovery', element: <OrganizationRecovery context={context} /> },
      { path: '/loom', element: <h1>Topics</h1> },
      { path: '/loom/area/:id', element: <h1>Created topic</h1> },
      { path: '/elsewhere', element: <h1>Another view</h1> },
    ], { initialEntries: [entry] });
    t.after(() => router.dispose());
    render(<StrictMode><RouterProvider router={router} /></StrictMode>);
    return router;
  }
  const rawRecords = () => Object.fromEntries(Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)));
  const saved = () => context.store.all();
  const get = () => calls.filter(c => c.method === 'GET');
  const posts = () => calls.filter(c => c.method === 'POST');
  async function loadContext(value = resource) {
    await waitFor(() => assert.ok(get().some(c => !c.done)));
    await act(async () => { for (const call of get().filter(c => !c.done)) {
      assert.equal(call.path, kind === 'area.create' ? '/api/v1/organization/children?limit=1' : '/api/v1/organization/resources/' + resource.resource_id);
      call.finish(Response.json(kind === 'area.create' ? { items: [], next_cursor: null, hierarchy_version: 1,
        complete: true, work_budget_reached: false, scope: 'community', limit: 1, max_response_bytes: 65536 } : value));
    } });
    await screen.findByLabelText(kind === 'area.create' ? 'Topic name' : 'Topic title');
  }
  async function seed(state: Intent['state'] = 'uncertain', title = 'Retained authored title') {
    let record = context.store.create('organization:' + kind + ':' + (kind === 'area.create' ? 'root' : resource.resource_id), 'organization.change', '/api/v1/organization/changes', {
      kind, ...(kind === 'area.create' ? { parent_id: null } : { resource_id: resource.resource_id, expected_version: 1 }), expected_hierarchy_version: 1,
      title, description: 'Retained scope with Unicode: café',
    });
    record = await context.store.saveDraft(record, record.body);
    if (state !== 'draft') record = await context.store.prepareDispatch(record, record.body);
    if (state === 'rejected' || state === 'committed') record = await context.store.settle(record, { state });
    return record;
  }
  async function unrelated() {
    const record = context.store.create('/loom/area/independent?compose=artifacts', 'artifact.create', '/api/v1/artifacts', {
      area_id: randomUUID(), title: 'Independent authored draft', content: { format: 'loom-markdown-v1', text: 'Keep this draft', mentions: [] },
    });
    return context.store.saveDraft(record, record.body);
  }
  function result(): OrganizationResult {
    if (kind === 'area.create') return {
      operation_state: 'committed', operation_id: randomUUID(), kind, idempotency: 'replayed',
      outcome: { resource_id: resource.resource_id, parent_id: null, version: 1, hierarchy_version: 2, local_open: true },
      current: { ...resource, hierarchy_version: 3 },
    };
    const currentParent = randomUUID();
    return {
      operation_state: 'committed', operation_id: randomUUID(), kind: 'area.edit', idempotency: 'replayed',
      outcome: { resource_id: resource.resource_id, parent_id: null, version: 2, hierarchy_version: 2, local_open: true },
      current: { ...resource, parent_id: currentParent, title: 'Retained authored title', description: 'Retained scope with Unicode: café', version: 4, hierarchy_version: 5,
        metadata_version: 2, local_open: false, publication_open: false, ancestors: [{ id: currentParent, title: 'Later destination' }] },
    };
  }
  return { context, resource, calls, mount, rawRecords, saved, get, posts, loadContext, seed, unrelated, result };
}
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
async function status(f: ReturnType<typeof fixture>, record: Intent) {
  const count = f.posts().length;
  await click('Check organization status');
  await waitFor(() => assert.equal(f.posts().length, count + 1));
  const call = f.posts().at(-1)!;
  assert.equal(call.path, '/api/v1/organization/status');
  assert.deepEqual(call.body, { kind: record.body.kind, idempotency_key: record.key });
  return call;
}
const unavailable = (message: string) => Response.json({ error: { code: 'service_unavailable', message } }, { status: 503 });

test('topic creation opens the confirmed topic and keeps its receipt without blocking another creation', async t => {
  const f = fixture(t, 'area.create'), router = f.mount('/loom/organize?action=area.create');
  await f.loadContext();
  assert.equal(screen.queryByText('Parent: Community root'), null);
  await act(async () => fireEvent.change(screen.getByLabelText('Topic name'), { target: { value: 'Research' } }));
  await click('Create topic');
  await waitFor(() => assert.equal(f.posts().length, 1));
  const chosen = f.saved()[0]!;
  assert.deepEqual(f.posts()[0]!.body, {
    kind: 'area.create', parent_id: null, expected_hierarchy_version: 1,
    title: 'Research', description: '', idempotency_key: chosen.key,
  });
  await act(async () => f.posts()[0]!.finish(Response.json(f.result())));
  await screen.findByRole('heading', { name: 'Created topic' });
  assert.equal(router.state.location.pathname, '/loom/area/' + f.resource.resource_id);
  assert.equal(router.state.historyAction, 'REPLACE');
  assert.deepEqual(f.saved(), [{ ...chosen, state: 'committed', sequence: chosen.sequence + 1 }]);
  assert.equal(router.state.location.state.topicCreated.participantId, f.context.self.participant_id);
  await act(async () => { await router.navigate('/recovery'); });
  assert.equal(screen.queryByRole('link'), null);
  await act(async () => { await router.navigate('/loom/organize?action=area.create'); });
  await f.loadContext();
  assert.equal((screen.getByLabelText('Topic name') as HTMLInputElement).value, '');
  assert.equal((screen.getByRole('button', { name: 'Create topic' }) as HTMLButtonElement).disabled, false);
  assert.equal(f.saved()[0]!.key, chosen.key);
  assert.equal(f.posts().length, 1, 'Reopening the form never dispatches');
});

test('uncertain topic creation retains missing status and opens only after an exact confirmed retry', async t => {
  const f = fixture(t, 'area.create'), chosen = await f.seed();
  const router = f.mount('/loom/organize?action=area.create');
  await f.loadContext();
  const before = f.rawRecords(), call = await status(f, chosen);
  await act(async () => call.finish(Response.json({ operation_state: 'not_recorded' })));
  await screen.findByText('Confirmation is unavailable. Keep this exact request; it may still commit.');
  assert.equal(router.state.location.pathname, '/loom/organize');
  assert.deepEqual(f.rawRecords(), before);
  assert.equal(screen.queryByRole('button', { name: 'Create topic' }), null);
  await click('Retry same organization change');
  await waitFor(() => assert.equal(f.posts().length, 2));
  assert.equal(f.posts()[1]!.raw, JSON.stringify(chosen.body));
  await act(async () => f.posts()[1]!.finish(Response.json(f.result())));
  await screen.findByRole('heading', { name: 'Created topic' });
  assert.deepEqual(f.saved(), [{ ...chosen, state: 'committed', sequence: chosen.sequence + 2 }]);
});

for (const change of ['moved', 'edited', 'closed'] as const) test(`recovered topic creation keeps original/current detail when ${change}`, async t => {
  const f = fixture(t, 'area.create'), chosen = await f.seed('committed');
  const router = f.mount('/loom/organize?intent=' + chosen.key);
  await f.loadContext();
  const call = await status(f, chosen), result = f.result();
  if (change === 'moved') result.current.parent_id = randomUUID();
  if (change === 'edited') result.current.version = 2;
  if (change === 'closed') result.current.publication_open = false;
  await act(async () => call.finish(Response.json(result)));
  await screen.findByRole('link', { name: 'View current location' });
  assert.equal(router.state.location.pathname, '/loom/organize');
  assert.ok(screen.getByText('Original result: version 1, parent Community root.'));
  assert.equal(f.saved()[0]!.key, chosen.key);
});

for (const departure of ['route', 'identity'] as const) test(`confirmed topic creation cannot navigate after ${departure} departure`, async t => {
  const f = fixture(t, 'area.create'), chosen = await f.seed();
  const router = f.mount('/loom/organize?intent=' + chosen.key);
  await f.loadContext();
  const call = await status(f, chosen), before = f.rawRecords();
  if (departure === 'route') await act(async () => { await router.navigate('/elsewhere'); });
  else {
    t.mock.method(window, 'dispatchEvent', () => true);
    await act(async () => { invalidateIdentity(); });
  }
  await act(async () => call.finish(Response.json(f.result())));
  assert.equal(router.state.location.pathname, departure === 'route' ? '/elsewhere' : '/loom/organize');
  if (departure === 'identity') assert.deepEqual(f.rawRecords(), before);
  else assert.equal(f.saved()[0]!.state, 'committed');
});

test('topic creation stays recoverable when local settlement fails', async t => {
  const f = fixture(t, 'area.create'), chosen = await f.seed();
  const router = f.mount('/loom/organize?intent=' + chosen.key);
  await f.loadContext();
  const call = await status(f, chosen), before = f.rawRecords(), originalSet = dom.window.Storage.prototype.setItem;
  t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (key === f.context.store.prefix + chosen.key && JSON.parse(value).state === 'committed') throw new Error('Receipt storage unavailable');
    originalSet.call(this, key, value);
  });
  await act(async () => call.finish(Response.json(f.result())));
  await screen.findByText('Receipt storage unavailable');
  assert.equal(router.state.location.pathname, '/loom/organize');
  assert.deepEqual(f.rawRecords(), before);
  assert.ok(screen.getByRole('button', { name: 'Retry same organization change' }));
});

test('selected Organization status preserves exact uncertainty through not-recorded and transport failure before explicit retry', async t => {
  const f = fixture(t), chosen = await f.seed(), other = await f.seed('draft', 'Independent organization draft');
  await f.unrelated();
  const before = f.rawRecords();
  const router = f.mount('/recovery');
  assert.deepEqual(screen.getAllByRole('link').map(a => a.getAttribute('href')), [chosen, other].map(r => '/loom/organize?intent=' + r.key));
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'area.edit · uncertain' })); });
  await f.loadContext();
  assert.equal((screen.getByLabelText('Topic title') as HTMLInputElement).value, chosen.body.title);
  assert.equal((screen.getByLabelText('Scope description') as HTMLTextAreaElement).value, chosen.body.description);
  assert.equal(router.state.location.search, '?intent=' + chosen.key);
  const first = await status(f, chosen);
  await act(async () => first.finish(Response.json({ operation_state: 'not_recorded' })));
  await screen.findByText('Confirmation is unavailable. Keep this exact request; it may still commit.');
  assert.deepEqual(f.rawRecords(), before);
  const second = await status(f, chosen);
  await act(async () => second.finish(unavailable('Status temporarily unavailable')));
  await screen.findByText('Status temporarily unavailable');
  assert.deepEqual(f.rawRecords(), before);
  assert.ok(f.posts().every(c => c.path.endsWith('/status')));
  await click('Retry same organization change');
  await waitFor(() => assert.equal(f.posts().length, 3));
  const retry = f.posts().at(-1)!;
  assert.equal(retry.path, chosen.path);
  assert.equal(retry.raw, JSON.stringify(chosen.body));
  await act(async () => retry.finish(unavailable('Retry outcome remains unknown')));
  await screen.findByText('Retry outcome remains unknown');
  assert.deepEqual(f.saved().find(r => r.key === chosen.key), { ...chosen, sequence: chosen.sequence + 1 });
  for (const [key, value] of Object.entries(before)) if (key !== f.context.store.prefix + chosen.key) assert.equal(f.rawRecords()[key], value);
});

test('committed Organization status shows original outcome and later current location, and removes only the selected resolved record', async t => {
  const f = fixture(t), chosen = await f.seed(), independent = await f.unrelated(), before = f.rawRecords();
  const router = f.mount('/loom/organize?intent=' + chosen.key + '&action=area.close&target=' + randomUUID());
  await f.loadContext();
  const call = await status(f, chosen), value = f.result();
  await act(async () => call.finish(Response.json(value)));
  await screen.findByText('Organization change confirmed.');
  assert.equal(screen.getByRole('heading', { level: 1 }).textContent, 'Edit topic');
  assert.ok(screen.getByText('Original result: version 2, parent Community root.'));
  assert.ok(screen.getByText('Current location: Later destination › Retained authored title · version 4 · Closed.'));
  assert.equal(screen.getByRole('link', { name: 'View current location' }).getAttribute('href'), '/loom/area/' + value.current.resource_id);
  assert.deepEqual(f.saved().find(r => r.key === chosen.key), { ...chosen, state: 'committed', sequence: chosen.sequence + 1 });
  assert.equal(f.rawRecords()[f.context.store.prefix + independent.key], before[f.context.store.prefix + independent.key]);
  const committed = f.rawRecords(), originalRemove = dom.window.Storage.prototype.removeItem;
  let fail = true;
  t.mock.method(dom.window.Storage.prototype, 'removeItem', function (this: Storage, key: string) {
    if (fail && key === f.context.store.prefix + chosen.key) { fail = false; throw new Error('Resolved record cannot be removed'); }
    originalRemove.call(this, key);
  });
  await click('Dismiss resolved organization change');
  await screen.findByText('Resolved record cannot be removed');
  assert.deepEqual(f.rawRecords(), committed);
  await click('Dismiss resolved organization change');
  await screen.findByRole('heading', { name: 'Topics' });
  assert.equal(router.state.location.pathname, '/loom');
  assert.deepEqual(f.saved(), [independent]);
  assert.equal(f.posts().length, 1);
});

for (const departure of ['route', 'identity'] as const) test(`a pending Organization status respects ${departure} ownership`, async t => {
  const f = fixture(t), chosen = await f.seed();
  const router = f.mount('/loom/organize?intent=' + chosen.key);
  await f.loadContext();
  const call = await status(f, chosen), before = f.rawRecords(), replacement = new IntentStore(f.context.community.instance_id, randomUUID(), localStorage, location.origin, locks);
  if (departure === 'route') await act(async () => { await router.navigate('/elsewhere'); });
  else {
    // Keep this mounted, as in the original ownership regression, to isolate identity from cleanup.
    t.mock.method(window, 'dispatchEvent', () => true);
    await act(async () => { invalidateIdentity(); });
  }
  await act(async () => call.finish(Response.json(f.result())));
  if (departure === 'route') {
    await waitFor(() => assert.deepEqual(f.saved(), [{ ...chosen, state: 'committed', sequence: chosen.sequence + 1 }]));
    assert.ok(screen.getByRole('heading', { name: 'Another view' }));
    assert.equal(router.state.location.pathname, '/elsewhere');
  } else assert.deepEqual(f.rawRecords(), before);
  assert.deepEqual(replacement.all(), []);
  assert.equal(!!screen.queryByText('Organization change confirmed.'), false);
  assert.equal(!!screen.queryByRole('link', { name: 'View current location' }), false);
  assert.equal(f.posts().length, 1);
});

test('reviewing a separately saved Organization draft preserves both authored bodies until its review write succeeds', async t => {
  const f = fixture(t), draft = await f.seed('draft'), original = await f.context.store.prepareDispatch(draft, draft.body);
  const separate = await f.context.store.saveDraft(draft, { ...draft.body, title: 'Separate authored title', description: 'Separate scope' });
  await f.unrelated();
  assert.equal(separate.blocked_by, original.key);
  f.mount('/loom/organize?intent=' + separate.key);
  await f.loadContext();
  const before = f.rawRecords(), originalSet = dom.window.Storage.prototype.setItem;
  let fail = true;
  t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (fail && key === f.context.store.prefix + separate.key) { fail = false; throw new Error('Separate review could not be saved'); }
    originalSet.call(this, key, value);
  });
  assert.equal((screen.getByRole('button', { name: 'Save topic' }) as HTMLButtonElement).disabled, true);
  await click('Continue with separate draft');
  await screen.findByText('Separate review could not be saved');
  assert.deepEqual(f.rawRecords(), before);
  assert.equal((screen.getByLabelText('Topic title') as HTMLInputElement).disabled, true);
  await click('Continue with separate draft');
  await waitFor(() => assert.equal(!!screen.queryByText('Your changes were saved separately.'), false));
  const { blocked_by: _blocked, ...reviewed } = separate;
  assert.deepEqual(f.saved().find(r => r.key === separate.key), { ...reviewed, sequence: separate.sequence + 1 });
  assert.equal((screen.getByLabelText('Topic title') as HTMLInputElement).value, 'Separate authored title');
  assert.equal((screen.getByLabelText('Scope description') as HTMLTextAreaElement).value, 'Separate scope');
  assert.equal((screen.getByRole('button', { name: 'Save topic' }) as HTMLButtonElement).disabled, false);
  for (const [key, value] of Object.entries(before)) if (key !== f.context.store.prefix + separate.key) assert.equal(f.rawRecords()[key], value);
  assert.equal(f.posts().length, 0);
});

test('Organization correction retains rejected custody through context and save failures, then saves a complete new command before retirement', async t => {
  const f = fixture(t), rejected = await f.seed('rejected'), independent = await f.unrelated();
  const router = f.mount('/loom/organize?intent=' + rejected.key);
  await f.loadContext();
  const before = f.rawRecords();
  await click('Review latest organization and prepare correction');
  await waitFor(() => assert.ok(f.get().some(c => !c.done)));
  const first = f.get().at(-1)!;
  assert.equal(first.path, '/api/v1/organization/resources/' + f.resource.resource_id);
  await act(async () => first.finish(unavailable('Latest organization unavailable')));
  await screen.findByText('Latest organization unavailable');
  assert.deepEqual(f.rawRecords(), before);
  const latest = { ...f.resource, version: 7, hierarchy_version: 9, metadata_version: 4 };
  const originalSet = dom.window.Storage.prototype.setItem;
  let fail = true;
  t.mock.method(dom.window.Storage.prototype, 'setItem', function (this: Storage, key: string, value: string) {
    if (fail && key.startsWith(f.context.store.prefix) && !(key in before)) { fail = false; throw new Error('Correction could not be retained'); }
    originalSet.call(this, key, value);
  });
  await click('Review latest organization and prepare correction');
  await waitFor(() => assert.ok(f.get().some(c => !c.done)));
  await act(async () => f.get().at(-1)!.finish(Response.json(latest)));
  await screen.findByText('Correction could not be retained');
  assert.deepEqual(f.rawRecords(), before);
  assert.equal((screen.getByLabelText('Topic title') as HTMLInputElement).disabled, true);
  await click('Review latest organization and prepare correction');
  await waitFor(() => assert.ok(f.get().some(c => !c.done)));
  await act(async () => f.get().at(-1)!.finish(Response.json(latest)));
  await screen.findByText('Latest versions loaded. Review source and destination before confirming.');
  const corrected = f.saved().find(r => r.kind === 'organization.change')!;
  assert.notEqual(corrected.key, rejected.key);
  assert.deepEqual(corrected, { ...rejected, key: corrected.key, created_at: corrected.created_at, sequence: 1, state: 'draft',
    body: { ...rejected.body, idempotency_key: corrected.key, expected_version: 7, expected_hierarchy_version: 9 } });
  assert.equal(f.rawRecords()[f.context.store.prefix + independent.key], before[f.context.store.prefix + independent.key]);
  assert.equal(localStorage.getItem(f.context.store.prefix + rejected.key), null);
  assert.equal(router.state.location.search, '?intent=' + corrected.key);
  assert.equal((screen.getByLabelText('Topic title') as HTMLInputElement).disabled, false);
  assert.equal(f.posts().length, 0);
});

test('Organization context retries preserve retained intent and missing selected records do not offer mutation', async t => {
  const f = fixture(t), retained = await f.seed(), before = f.rawRecords();
  const router = f.mount('/loom/organize?intent=' + retained.key);
  await waitFor(() => assert.equal(f.get().length, 2));
  await act(async () => { for (const call of f.get()) call.finish(unavailable('Organization context unavailable')); });
  await screen.findByText('Organization context unavailable Any saved intent is retained in Local drafts.');
  assert.deepEqual(f.rawRecords(), before);
  await click('Retry organization context');
  await f.loadContext();
  assert.deepEqual(f.rawRecords(), before);
  assert.equal((screen.getByLabelText('Topic title') as HTMLInputElement).value, retained.body.title);
  await act(async () => { await router.navigate('/loom/organize?intent=' + randomUUID()); });
  await screen.findByText('This organization record is no longer available. It may have been resolved in another view.');
  await waitFor(() => assert.ok(f.get().some(c => !c.done)));
  const missingContext = f.get().at(-1)!;
  assert.equal(missingContext.path, '/api/v1/organization/children?limit=1');
  await act(async () => missingContext.finish(Response.json({ items: [f.resource], hierarchy_version: 1,
    next_cursor: null, complete: true, work_budget_reached: false, scope: 'children:root', limit: 1, max_response_bytes: 131072 })));
  assert.ok(screen.getByText('This organization record is no longer available. It may have been resolved in another view.'));
  assert.equal(!!screen.queryByRole('button', { name: 'Save topic' }), false);
  assert.equal(!!screen.queryByRole('button', { name: 'Check organization status' }), false);
  assert.deepEqual(f.rawRecords(), before);
  assert.equal(f.posts().length, 0);
});
