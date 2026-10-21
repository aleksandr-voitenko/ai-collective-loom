import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode, useState, type ReactNode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { CoverageDetails, CoverageEditor, SourceResults, SummaryMaintenance } from '../../src/web/Summaries.js';
import { IntentStore } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type { CoverageDeclarationValue, CoverageDetailView, MaintenanceEntryView, MaintenancePageView, PreparationView, SourceEntryView, SourcePageView, SourcePairValue } from '../../src/contracts/summaries.js';
import type { OrganizationPageView, OrganizationResourceView } from '../../src/contracts/organization.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'location', 'localStorage', 'Event'] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
Object.defineProperty(navigator, 'locks', { value: { request: async (_name: string, work: () => unknown) => work() }, configurable: true });
const { render, screen, within, fireEvent, cleanup, act } = await import('@testing-library/react');
afterEach(() => { cleanup(); localStorage.clear(); });
const failure = (code: string, message: string, status = 503, rejected = false) => Response.json({ error: {
  code, message, ...(rejected ? { operation_outcome: 'rejected' } : {}),
} }, { status });
type Call = { path: string; body: string | undefined; done: boolean; finish: (response: Response) => void };
function mount(t: TestContext, content: (context: Context) => ReactNode, entry = '/summary') {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', (path: string, options?: RequestInit) => new Promise<Response>(resolve => {
    const call: Call = { path, body: options?.body === undefined ? undefined : String(options.body), done: false,
      finish: response => { call.done = true; resolve(response); } };
    calls.push(call);
  }));
  const context = { self: { participant_id: randomUUID(), csrf: 'fixture' }, community: { instance_id: randomUUID() } } as Context;
  context.store = new IntentStore(context.community.instance_id, context.self.participant_id);
  const element = <AuthorizationBoundary>{content(context)}</AuthorizationBoundary>;
  const router = createMemoryRouter([{ path: '/summary', element }, { path: '/loom/summaries', element }], { initialEntries: [entry] });
  render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  t.after(async () => {
    await act(async () => { for (const call of calls.filter(c => !c.done)) call.finish(failure('service_unavailable', 'Fixture cleanup')); });
    router.dispose();
  });
  const answer = async (path: string, value: unknown) => act(async () => {
    const pending = calls.filter(call => !call.done && call.path === path);
    assert.ok(pending.length, 'Expected pending request: ' + path);
    for (const call of pending) call.finish(Response.json(value));
  });
  const reject = async (path: string, code: string, message: string, status = 503) => act(async () => {
    const pending = calls.filter(call => !call.done && call.path === path);
    assert.ok(pending.length, 'Expected pending request: ' + path);
    for (const call of pending) call.finish(failure(code, message, status));
  });
  return { calls, context, router, answer, reject };
}
const click = async (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const change = async (label: string, value: string) => act(async () => { fireEvent.change(screen.getByLabelText(label), { target: { value } }); });
const sourcePage = (items: SourceEntryView[] = [], patch: Partial<SourcePageView> = {}): SourcePageView => ({
  items, unknown: false, next_cursor: null, complete: true, work_budget_reached: false, limit: 12,
  max_response_bytes: 131072, omitted_detail: 'bodies; unavailable_members', expires_at: '2026-10-22T12:00:00Z', ...patch,
});
function source(discussion: string, title: string): SourceEntryView {
  const resource = randomUUID(), revision = randomUUID(), person = { id: randomUUID(), nickname: 'author', kind: 'human' };
  return { source: { resource_id: resource, revision_id: revision, kind: 'contribution', title, revision_number: '2',
    author: person, publisher: person, created_at: '2026-10-22T00:00:00Z', area_id: randomUUID(), area_title: 'General',
    discussion_id: discussion, parent_id: null, can_edit: true, publication_open: true,
    full_content_url: `/api/v1/resources/${resource}/revisions/${revision}` }, status: 'changed', declared_revision_id: randomUUID(),
    browser_url: `/loom/resource/${resource}/${revision}`, context_url: `/loom/discussion/${discussion}?focus=${resource}` };
}
const pair = (entry: SourceEntryView): SourcePairValue => ({ contribution_id: entry.source.resource_id, revision_id: entry.source.revision_id });

test('summary maintenance resets continuation on filter/topic changes, preserves empty scans and retries the exact page', async t => {
  const topic = randomUUID();
  const area: OrganizationResourceView = { resource_id: topic, kind: 'area', parent_id: null, version: 1, hierarchy_version: 1,
    title: 'Evidence', description: 'Summary scope', metadata_version: 1, local_open: true, publication_open: true,
    can_organize: true, ancestors: [], contacts_url: '/api/v1/contacts', proposal_route_url: '/api/v1/areas/proposal-route' };
  const topics: OrganizationPageView = { items: [area], hierarchy_version: 1, next_cursor: null, complete: true,
    work_budget_reached: false, scope: 'destinations', limit: 12, max_response_bytes: 131072 };
  const empty: MaintenancePageView = { items: [], next_cursor: null, complete: true, work_budget_reached: false,
    limit: 5, max_response_bytes: 131072, omitted_detail: 'bodies; unavailable_members', expires_at: '2026-10-22T12:00:00Z' };
  const f = mount(t, context => <SummaryMaintenance context={context}/>, '/loom/summaries?filter=unknown&cursor=earlier&unrelated=ignored');
  const first = '/api/v1/summaries/maintenance?filter=unknown&cursor=earlier';
  await f.answer(first, { ...empty, complete: false, work_budget_reached: true, next_cursor: 'next-summary' });
  assert.ok(screen.getByText('No eligible matches in this bounded page. Continue to inspect later candidates.'));
  await click('Next maintenance page');
  const second = '/api/v1/summaries/maintenance?filter=unknown&cursor=next-summary';
  await f.reject(second, 'service_unavailable', 'Maintenance temporarily unavailable');
  assert.match(screen.getByRole('alert').textContent!, /Maintenance temporarily unavailable/);
  await click('Retry maintenance page');
  assert.equal(f.calls.at(-1)!.path, second);
  await f.answer(second, empty);
  assert.equal(document.activeElement, screen.getByRole('heading', { name: 'Summary maintenance' }));
  await change('Editing eligibility', 'true');
  await f.answer('/api/v1/summaries/maintenance?filter=unknown&editable=true', empty);
  await click('Choose maintenance topic');
  await f.answer('/api/v1/organization/destinations?', topics);
  await click('Select Evidence');
  await f.answer(`/api/v1/summaries/maintenance?filter=unknown&editable=true&topic=${topic}`, empty);
  assert.equal(!!screen.queryByRole('region', { name: 'Choose maintenance topic' }), false);
  await act(async () => { fireEvent.click(screen.getByLabelText('Include descendant topics')); });
  await f.answer(`/api/v1/summaries/maintenance?filter=unknown&editable=true&topic=${topic}&descendants=true`, empty);
  await click('Clear maintenance topic');
  await f.answer('/api/v1/summaries/maintenance?filter=unknown&editable=true', empty);
  assert.equal(!!screen.queryByLabelText('Include descendant topics'), false);
  assert.equal(new URLSearchParams(f.router.state.location.search).has('cursor'), false);
  await change('Maintenance condition', '');
  await f.answer('/api/v1/summaries/maintenance?editable=true', empty);
  await change('Editing eligibility', '');
  const partialSource = source(randomUUID(), 'Partial evidence summary').source;
  const unknownSource = source(randomUUID(), 'Summary without active editors').source;
  const entries: MaintenanceEntryView[] = [
    { summary: { ...partialSource, kind: 'summary' },
      coverage: { scope: 'selected', uncovered_eligible: 2, changed_eligible: 1, unknown: false, comparison: 'complete', claim: 'author_declared; not_read_or_correctness_proof' },
      editors: [{ id: f.context.self.participant_id, nickname: 'current editor', kind: 'human' }], no_active_editor: false,
      browser_url: `/loom/resource/${partialSource.resource_id}`,
      coverage_url: `/api/v1/summaries/${partialSource.resource_id}/revisions/${partialSource.revision_id}/coverage` },
    { summary: { ...unknownSource, kind: 'summary', can_edit: false },
      coverage: { scope: 'full', uncovered_eligible: null, changed_eligible: null, unknown: true, comparison: 'work_limited', claim: 'author_declared; not_read_or_correctness_proof' },
      editors: [], no_active_editor: true,
      browser_url: `/loom/resource/${unknownSource.resource_id}`,
      coverage_url: `/api/v1/summaries/${unknownSource.resource_id}/revisions/${unknownSource.revision_id}/coverage` },
  ];
  await f.answer('/api/v1/summaries/maintenance?', { ...empty, items: entries });
  const cards = screen.getAllByRole('listitem');
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map(card => within(card).getAllByRole('link').map(link => ({ text: link.textContent, href: link.getAttribute('href') }))), [
    [ { text: 'Partial evidence summary', href: `/loom/resource/${partialSource.resource_id}` },
      { text: 'Underlying discussion', href: `/loom/discussion/${partialSource.discussion_id}` },
      { text: 'Update summary', href: `/loom/resource/${partialSource.resource_id}?edit=1` } ],
    [ { text: 'Summary without active editors', href: `/loom/resource/${unknownSource.resource_id}` },
      { text: 'Underlying discussion', href: `/loom/discussion/${unknownSource.discussion_id}` } ],
  ]);
  assert.ok(within(cards[0]!).getByText('General · Editors: current editor'));
  assert.ok(within(cards[0]!).getByText('Selected sources · partial scope'));
  assert.ok(within(cards[0]!).getByText('2 eligible contributions outside this declaration · 1 eligible covered contributions changed.'));
  assert.ok(within(cards[1]!).getByText('General · Editors: None · No active editor'));
  assert.ok(within(cards[1]!).getByText(/Comparison exceeds the supported source limit/));
  assert.equal(!!screen.queryByText('No known gaps in the declared discussion scope.'), false);
  await click('Refresh maintenance');
  await f.answer('/api/v1/summaries/maintenance?', empty);
  assert.ok(screen.getByText('No eligible matching summaries in this view.'));
});

test('current source selection replaces an earlier revision, preserves independent selection and requires refresh after invalidation', async t => {
  const discussion = randomUUID(), a = source(discussion, 'Opening'), b = source(discussion, 'Reply');
  b.source.parent_id = a.source.resource_id;
  b.source.title = null;
  b.source.area_id = a.source.area_id;
  const initial = [{ contribution_id: a.source.resource_id, revision_id: a.declared_revision_id! }, pair(b)];
  const path = `/api/v1/summaries/${randomUUID()}/revisions/${randomUUID()}/sources`;
  function Selection() {
    const [selected, setSelected] = useState(initial);
    return <><SourceResults path={path} selected={selected} onSelect={setSelected}/><output aria-label="Selected exact sources">{JSON.stringify(selected)}</output></>;
  }
  const f = mount(t, () => <Selection/>);
  // The scan reached 100 candidates, including unavailable rows, before the item limit.
  const bounded = sourcePage([a, b], { unknown: true, next_cursor: 'later-sources', complete: false, work_budget_reached: true });
  await f.answer(path + '?limit=12', bounded);
  assert.equal(screen.getAllByRole('link', { name: 'Declared earlier revision' })[0]!.getAttribute('href'), `/loom/resource/${a.source.resource_id}/${a.declared_revision_id}`);
  assert.ok(screen.getByText('Some members are unavailable or unknown; protected details and counts are omitted.'));
  await act(async () => { fireEvent.click(screen.getByLabelText('Select Opening · revision 2')); });
  assert.deepEqual(JSON.parse(screen.getByLabelText('Selected exact sources').textContent!), [pair(b), pair(a)]);
  await act(async () => { fireEvent.click(screen.getByLabelText('Select Opening · revision 2')); });
  assert.deepEqual(JSON.parse(screen.getByLabelText('Selected exact sources').textContent!), [pair(b)]);
  await click('Next source revisions');
  await f.reject(path + '?limit=12&cursor=later-sources', 'summary_changed', 'Source snapshot changed', 409);
  assert.ok(screen.getByText('The previous page is retained for context and may be out of date.'));
  assert.equal(!!screen.queryByRole('button', { name: 'Retry source page' }), false);
  assert.equal((screen.getByLabelText('Select Comment by author · revision 2') as HTMLInputElement).disabled, true);
  await click('Refresh source view');
  assert.equal(f.calls.at(-1)!.path, path + '?limit=12');
  await f.answer(path + '?limit=12', bounded);
  assert.equal(document.activeElement, screen.getByRole('heading', { name: 'Source revisions' }));
  assert.deepEqual(JSON.parse(screen.getByLabelText('Selected exact sources').textContent!), [pair(b)]);
});

test('bounded coverage comparison keeps unknown counts distinct and switches declared/current inspection without stale sources', async t => {
  const summary = randomUUID(), revision = randomUUID(), discussion = randomUUID();
  const base = `/api/v1/summaries/${summary}/revisions/${revision}`;
  const coverage: CoverageDetailView = { summary_id: summary, revision_id: revision, discussion_id: discussion,
    coverage: { scope: 'full', uncovered_eligible: null, changed_eligible: null, unknown: true, comparison: 'work_limited', claim: 'author_declared; not_read_or_correctness_proof' },
    members_url: base + '/members', sources_url: base + '/sources' };
  const f = mount(t, () => <CoverageDetails id={summary} revision={revision}/>);
  await f.reject(base + '/coverage', 'service_unavailable', 'Comparison unavailable');
  await click('Retry coverage comparison');
  await f.answer(base + '/coverage', coverage);
  assert.ok(screen.getByText(/Comparison exceeds the supported source limit/));
  assert.equal(!!screen.queryByText('No known gaps in the declared discussion scope.'), false);
  assert.equal(!!screen.queryByText(/eligible contributions outside this declaration/), false);
  assert.ok(screen.getByText("An author's coverage claim does not establish reading or correctness."));
  await click('Inspect declared sources');
  assert.equal(screen.getByRole('button', { name: 'Inspect declared sources' }).getAttribute('aria-expanded'), 'true');
  await click('Inspect current discussion sources');
  const current = source(discussion, 'Current contribution');
  await f.answer(base + '/sources?limit=12', sourcePage([current], {
    unknown: true, complete: false, work_budget_reached: true, next_cursor: 'later-candidates',
  }));
  const declared: SourceEntryView = { ...current, source: { ...current.source, title: 'Old declared contribution',
    revision_id: current.declared_revision_id!, revision_number: '1',
    full_content_url: `/api/v1/resources/${current.source.resource_id}/revisions/${current.declared_revision_id}` },
    status: 'covered', browser_url: `/loom/resource/${current.source.resource_id}/${current.declared_revision_id}` };
  await f.answer(base + '/members?limit=12', sourcePage([declared]));
  assert.equal(!!screen.queryByRole('link', { name: 'Old declared contribution · revision 1' }), false);
  assert.ok(screen.getByRole('link', { name: 'Current contribution · revision 2' }));
  await click('Inspect current discussion sources');
  assert.equal(!!screen.queryByRole('heading', { name: 'Source revisions' }), false);
  await click('Inspect declared sources');
  await f.answer(base + '/members?limit=12', sourcePage([declared]));
  assert.ok(screen.getByRole('link', { name: 'Old declared contribution · revision 1' }));
  await click('Refresh coverage comparison');
  await f.answer(base + '/coverage', coverage);
  assert.ok(screen.getByText(/Comparison exceeds the supported source limit/));
  assert.equal(!!screen.queryByText('No known gaps in the declared discussion scope.'), false);
});

function preparation(discussion: string): PreparationView {
  const id = randomUUID();
  return { preparation_id: id, discussion_id: discussion, scope: 'full', expires_at: '2026-10-23T00:00:00Z', eligible_members: 1,
    unknown: false, members_url: `/api/v1/summary-preparations/${id}/members` };
}
function editor(t: TestContext, discussion: string, save: (value: CoverageDeclarationValue) => Promise<boolean> = async () => true) {
  function Draft({ context }: { context: Context }) {
    const [value, setValue] = useState<CoverageDeclarationValue>();
    return <CoverageEditor context={context} discussion={discussion} value={value} disabled={false} onChange={async next => {
      if (!(await save(next))) return false;
      setValue(next); return true;
    }}/>;
  }
  return mount(t, context => <Draft context={context}/>);
}
const preparationCall = (calls: Call[]) => calls.filter(call => call.path === '/api/v1/summary-preparations' && call.body !== undefined).at(-1)!;

test('failed draft attachment retains the exact preparation request until explicit retry and saved declaration', async t => {
  const discussion = randomUUID(), prepared = preparation(discussion), attached: CoverageDeclarationValue[] = [];
  let save = false;
  const f = editor(t, discussion, async value => { attached.push(value); return save; });
  await click('Prepare declared sources');
  const sent = preparationCall(f.calls), original = f.context.store.all()[0]!;
  assert.deepEqual(JSON.parse(sent.body!), { discussion_id: discussion, scope: 'full', idempotency_key: original.key });
  assert.equal(original.state, 'uncertain');
  await act(async () => sent.finish(Response.json(prepared)));
  assert.match(screen.getByRole('alert').textContent!, /source declaration could not be saved with your draft/);
  assert.deepEqual(f.context.store.all(), [original]);
  assert.deepEqual(attached, [{ preparation_id: prepared.preparation_id }]);
  assert.equal((screen.getByLabelText('Source scope') as HTMLSelectElement).disabled, true);
  save = true;
  await click('Retry same source preparation');
  assert.equal(preparationCall(f.calls).body, sent.body);
  await act(async () => preparationCall(f.calls).finish(Response.json(prepared)));
  assert.deepEqual(f.context.store.all(), []);
  const detail = `/api/v1/summary-preparations/${prepared.preparation_id}`;
  await f.reject(detail, 'service_unavailable', 'Preparation details unavailable');
  await click('Retry preparation details');
  assert.equal(f.calls.at(-1)!.path, detail);
  await f.answer(detail, prepared);
  const member = source(discussion, 'Prepared opening');
  member.status = 'prepared'; member.declared_revision_id = member.source.revision_id;
  await f.answer(prepared.members_url + '?limit=12', sourcePage([member]));
  assert.ok(screen.getByText(/Full discussion snapshot · 1 currently eligible declared sources/));
  assert.ok(screen.getByRole('link', { name: 'Prepared opening · revision 2' }));
  assert.deepEqual(attached, [{ preparation_id: prepared.preparation_id }, { preparation_id: prepared.preparation_id }]);
});

test('first source-limit refusal stays rejected until explicit durable removal and a new selected request', async t => {
  const discussion = randomUUID(), f = editor(t, discussion);
  localStorage.setItem('loom.notifications:independent', 'personal checkpoint');
  await click('Prepare declared sources');
  const first = preparationCall(f.calls);
  await act(async () => first.finish(failure('summary_source_limit', 'Choose at most 100 exact sources', 429)));
  const rejected = f.context.store.all()[0]!, raw = localStorage.getItem(f.context.store.prefix + rejected.key);
  assert.equal(rejected.state, 'rejected');
  const removeItem = dom.window.Storage.prototype.removeItem;
  const remove = t.mock.method(dom.window.Storage.prototype, 'removeItem', function(this: Storage, key: string) {
    if (key === f.context.store.prefix + rejected.key) throw new Error('Synthetic preparation removal failure');
    return removeItem.call(this, key);
  });
  await click('Prepare a new source request');
  assert.match(screen.getByRole('alert').textContent!, /Synthetic preparation removal failure/);
  assert.equal(localStorage.getItem(f.context.store.prefix + rejected.key), raw);
  assert.equal(f.calls.length, 1);
  remove.mock.restore();
  await click('Prepare a new source request');
  assert.deepEqual(f.context.store.all(), []);
  await change('Source scope', 'selected');
  await f.answer(`/api/v1/discussions/${discussion}/summary-sources?limit=12`, sourcePage([], {
    unknown: true, complete: false, work_budget_reached: true, next_cursor: 'later-source-candidates',
  }));
  await click('Prepare declared sources');
  const next = preparationCall(f.calls), record = f.context.store.all()[0]!;
  assert.notEqual(record.key, rejected.key);
  assert.deepEqual(JSON.parse(next.body!), { discussion_id: discussion, scope: 'selected', members: [], idempotency_key: record.key });
  const prepared = { ...preparation(discussion), scope: 'selected', eligible_members: 0 };
  await act(async () => next.finish(Response.json(prepared)));
  await f.answer(`/api/v1/summary-preparations/${prepared.preparation_id}`, prepared);
  await f.answer(prepared.members_url + '?limit=12', sourcePage());
  assert.ok(screen.getByText(/Explicit partial selection · 0 currently eligible declared sources/));
  assert.equal(localStorage.getItem('loom.notifications:independent'), 'personal checkpoint');
});

test('an uncertain preparation keeps exact custody when recorded expiry cannot be saved locally', async t => {
  const discussion = randomUUID(), f = editor(t, discussion);
  await click('Prepare declared sources');
  const original = preparationCall(f.calls);
  await act(async () => original.finish(failure('service_unavailable', 'Lost preparation acknowledgement')));
  const stored = f.context.store.all()[0]!;
  assert.equal(stored.state, 'uncertain');
  assert.equal(!!screen.queryByRole('button', { name: 'Prepare a new source request' }), false);
  await click('Retry same source preparation');
  const retry = preparationCall(f.calls), raw = localStorage.getItem(f.context.store.prefix + stored.key);
  assert.equal(retry.body, original.body);
  const setItem = dom.window.Storage.prototype.setItem;
  let refuse = true;
  t.mock.method(dom.window.Storage.prototype, 'setItem', function(this: Storage, key: string, value: string) {
    if (refuse && key === f.context.store.prefix + stored.key && JSON.parse(value).state === 'rejected') {
      refuse = false; throw new Error('Synthetic expiry settlement failure');
    }
    setItem.call(this, key, value);
  });
  await act(async () => retry.finish(failure('summary_preparation_expired', 'Preparation has expired', 409, true)));
  assert.match(screen.getByRole('alert').textContent!, /Synthetic expiry settlement failure/);
  assert.equal(localStorage.getItem(f.context.store.prefix + stored.key), raw);
  assert.equal(!!screen.queryByRole('button', { name: 'Prepare a new source request' }), false);
  await click('Retry same source preparation');
  assert.equal(preparationCall(f.calls).body, original.body);
  await act(async () => preparationCall(f.calls).finish(failure('summary_preparation_expired', 'Preparation has expired', 409, true)));
  assert.equal(f.context.store.all()[0]!.state, 'rejected');
  assert.deepEqual(f.context.store.all()[0]!.body, JSON.parse(original.body!));
  assert.ok(screen.getByRole('button', { name: 'Prepare a new source request' }));
});
