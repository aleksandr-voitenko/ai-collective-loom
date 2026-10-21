import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode, useState, type ReactNode } from 'react';
import { createMemoryRouter, useParams } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Value } from '@sinclair/typebox/value';
import { ChangeAccountEditor, ChangeDetails, ChangeNoteEditor } from '../../src/web/Changes.js';
import { AuthorizationBoundary } from '../../src/web/AuthorizationBoundary.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import { Page, Revision, type ChangeAccountValue, type NoteContent, type PageView, type ResourceView, type RevisionView } from '../../src/contracts/participation.js';
import { ChangeCoverage, NoteDetail, type ChangeCoverageView, type NoteDetailView } from '../../src/contracts/changes.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://loom.example/' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'MutationObserver', 'location', 'localStorage', 'Event', 'CustomEvent'] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
const { render, screen, fireEvent, cleanup, act, waitFor, within } = await import('@testing-library/react');
afterEach(() => { cleanup(); invalidateIdentity(); localStorage.clear(); });

type Call = { path: string; method: string; done: boolean; finish: (response: Response) => void };
const failure = (message: string) => Response.json({ error: { code: 'service_unavailable', message } }, { status: 503 });
function mount(t: TestContext, element: ReactNode, path = '/test', entry = '/test') {
  const calls: Call[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, options?: RequestInit) => new Promise<Response>(resolve => {
    const method = options?.method ?? 'GET';
    assert.equal(method, 'GET', 'These read/editor interactions must not publish automatically');
    assert.equal(options?.body, undefined);
    const call: Call = { path: url, method, done: false, finish(response) {
      assert.equal(call.done, false, 'A held request must settle only once'); call.done = true; resolve(response);
    } };
    calls.push(call);
  }));
  const router = createMemoryRouter([
    { path, element: <AuthorizationBoundary>{element}</AuthorizationBoundary> },
    { path: '/other', element: <h1>Other context</h1> },
  ], { initialEntries: [entry] });
  const view = render(<StrictMode><RouterProvider router={router} /></StrictMode>);
  t.after(async () => {
    view.unmount(); router.dispose();
    await act(async () => { for (const call of calls.filter(c => !c.done)) call.finish(failure('Fixture cleanup')); });
  });
  const pending = (url: string) => calls.filter(c => !c.done && c.path === url);
  async function answer(url: string, value: unknown) {
    await waitFor(() => assert.ok(pending(url).length, 'Expected request: ' + url));
    await act(async () => { for (const call of pending(url)) call.finish(Response.json(value)); });
  }
  async function refuse(url: string, message: string) {
    await waitFor(() => assert.ok(pending(url).length, 'Expected request: ' + url));
    await act(async () => { for (const call of pending(url)) call.finish(failure(message)); });
  }
  return { calls, router, pending, answer, refuse };
}
async function click(name: string) { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); }
const output = (label: string) => JSON.parse(screen.getByLabelText(label).textContent!);
function resource(kind: 'artifact' | 'contribution', title: string): ResourceView {
  const id = randomUUID(), revision = randomUUID();
  return { resource_id: id, revision_id: revision, kind, title, revision_number: '2',
    author: { id: randomUUID(), nickname: 'Original author', kind: 'human' },
    publisher: { id: randomUUID(), nickname: 'Revision publisher', kind: 'human' },
    created_at: '2026-10-16T12:00:00Z', area_id: randomUUID(), area_title: 'General',
    discussion_id: kind === 'contribution' ? randomUUID() : null, parent_id: null,
    can_edit: false, publication_open: true, full_content_url: `/api/v1/resources/${id}/revisions/${revision}` };
}
const notePath = (source: ResourceView) => source.full_content_url + '/change-note';
const coveragePath = (source: ResourceView) => source.full_content_url + '/change-coverage';
function revision(source: ResourceView, declared = false): RevisionView {
  return { ...source, content: { format: 'loom-markdown-v3', text: 'Independent main text', mentions: [], references: [] },
    mentioned_participants: [], current_revision_id: source.revision_id,
    change_note: { state: source.kind === 'artifact' ? 'available' : 'absent', full_content_url: notePath(source) },
    change_account: { state: declared ? 'declared' : 'absent', coverage_url: coveragePath(source) } };
}

test('note participant continuation retries its exact cursor and selective removal preserves the complete authored note', async t => {
  const people = Array.from({ length: 26 }, (_, i) => ({ id: randomUUID(), nickname: i === 0 ? 'Current author' : 'Person ' + i, kind: i % 2 ? 'agent' : 'human' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const retained: NoteContent = { format: 'loom-markdown-v2', text: 'Authored scope [[mention:kept]] and [[mention:removed]].',
    mentions: [{ token: 'kept', participant_id: people[0]!.id }, { token: 'removed', participant_id: people[1]!.id }],
    references: [{ reference_id: randomUUID(), target: { kind: 'artifact', resource_id: randomUUID(), revision_id: randomUUID() }, relationship: 'related_to', rationale: 'Retained exact evidence' }] };
  function Editor() {
    const [value, setValue] = useState<NoteContent | null>(retained);
    return <><ChangeNoteEditor value={value} disabled={false} onChange={setValue} /><output aria-label="Complete authored note">{JSON.stringify(value)}</output></>;
  }
  const page = (items: typeof people, next: string | null): PageView => ({ items, scope: 'participants:all', representation: 'metadata',
    omitted_detail: 'bodies', next_cursor: next, complete: next === null, work_budget_reached: false, limit: 25, max_response_bytes: 131072 });
  const first = page(people.slice(0, 25), 'participants-next'), second = page(people.slice(25), null);
  assert.equal(Value.Check(Page, first), true); assert.equal(Value.Check(Page, second), true);
  const f = mount(t, <Editor/>), initialUrl = '/api/v1/participants?limit=25', nextUrl = initialUrl + '&cursor=participants-next';
  await click('Mention someone in the note');
  await f.answer(initialUrl, first);
  const picker = screen.getByRole('group', { name: 'Note participant selection' });
  assert.deepEqual(within(picker).getAllByRole('button').map(button => button.textContent), [
    ...people.slice(0, 25).map(p => 'Mention @' + p.nickname + ' in note'), 'Next note participants',
  ]);
  await click('Next note participants');
  await f.refuse(nextUrl, 'Participant page temporarily unavailable');
  assert.ok(screen.getByRole('alert'));
  assert.deepEqual(output('Complete authored note'), retained);
  assert.equal(!!screen.queryByRole('button', { name: 'Mention @' + people[0]!.nickname + ' in note' }), false);
  const count = f.calls.length;
  await click('Retry note participants');
  await f.answer(nextUrl, second);
  assert.deepEqual(f.calls.slice(count).map(c => c.path), [nextUrl]);
  const token = 'm111111111111', person = people[25]!;
  const random = t.mock.method(crypto, 'randomUUID', () => '11111111-1111-4111-8111-111111111111');
  await click('Mention @' + person.nickname + ' in note');
  random.mock.restore();
  const selected: NoteContent = { ...retained, text: retained.text + ` [[mention:${token}]]`, mentions: [...retained.mentions, { token, participant_id: person.id }] };
  assert.deepEqual(output('Complete authored note'), selected);
  assert.equal(document.activeElement, screen.getByLabelText('Change note'));
  assert.equal(!!screen.queryByRole('group', { name: 'Note participant selection' }), false);
  await click('Remove note mention removed');
  const edited = { ...selected, text: selected.text.replace('[[mention:removed]]', ''), mentions: selected.mentions.filter(m => m.token !== 'removed') };
  assert.deepEqual(output('Complete authored note'), edited);
  assert.equal((screen.getByLabelText('Change note') as HTMLTextAreaElement).value, edited.text);
  assert.ok(f.calls.every(c => c.done && [initialUrl, nextUrl].includes(c.path)));
});

test('a failed exact comparison read retains old carry until an explicit successful declaration choice', async t => {
  const source = resource('contribution', 'Authored change account'), oldBase = randomUUID();
  // Accounts are ordinary contributions: only their original author may publish another revision.
  source.publisher = source.author;
  const comparison = revision(source, true), retained = { carry_forward_revision_id: oldBase };
  assert.equal(Value.Check(Revision, comparison), true);
  function Editor() {
    const [value, setValue] = useState<ChangeAccountValue | null>(retained);
    return <><ChangeAccountEditor source={source.resource_id} base={source.revision_id} value={value} disabled={false} onChange={setValue}/>
      <output aria-label="Complete change declaration">{JSON.stringify(value)}</output></>;
  }
  const f = mount(t, <Editor/>);
  await waitFor(() => assert.ok(f.pending(source.full_content_url).length));
  assert.equal(screen.getByRole('link', { name: 'Inspect the comparison revision and its declaration' }).getAttribute('href'), `/loom/resource/${source.resource_id}/${source.revision_id}`);
  assert.equal(!!screen.queryByRole('button', { name: 'Keep declaration from comparison revision' }), false);
  assert.deepEqual(output('Complete change declaration'), retained);
  await f.refuse(source.full_content_url, 'Comparison declaration temporarily unavailable');
  assert.deepEqual(output('Complete change declaration'), retained);
  assert.equal(!!screen.queryByRole('button', { name: 'Keep declaration from comparison revision' }), false);
  const count = f.calls.length;
  await click('Retry comparison declaration');
  await f.answer(source.full_content_url, comparison);
  assert.deepEqual(f.calls.slice(count).map(c => c.path), [source.full_content_url]);
  assert.deepEqual(output('Complete change declaration'), retained, 'A successful read does not select its declaration');
  await click('Keep declaration from comparison revision');
  assert.deepEqual(output('Complete change declaration'), { carry_forward_revision_id: source.revision_id });
  assert.equal(!!screen.queryByText(/This attempted declaration belongs to the old base/), false);
  assert.ok(screen.getByText(/including unavailable members. No newer revisions are added/));
  await click('Replace described set');
  assert.deepEqual(output('Complete change declaration'), { revisions: [] });
  assert.ok(screen.getByLabelText('Described resource ID or exact Loom link'));
  assert.ok(f.calls.every(c => c.done && c.path === source.full_content_url), 'Carry does not expand or disclose the described set');
});

test('exact note retry preserves attribution and a late replaced revision cannot restore its note', async t => {
  const earlier = resource('artifact', 'Versioned artifact'), newerId = randomUUID();
  const newer: ResourceView = { ...earlier, revision_id: newerId, revision_number: '3', publisher: { id: randomUUID(), nickname: 'Later editor', kind: 'human' },
    created_at: '2026-10-17T12:00:00Z', full_content_url: `/api/v1/resources/${earlier.resource_id}/revisions/${newerId}` };
  const recipient = { id: randomUUID(), nickname: 'Note recipient', kind: 'human' };
  const earlierView = { ...revision(earlier), current_revision_id: newer.revision_id }, newerView = revision(newer);
  const note = (source: ResourceView, text: string): NoteDetailView => ({ source, source_field: 'change_note', state: 'available',
    described_scope: 'owning_revision_only; no_interval_claim', content: { format: 'loom-markdown-v2', text, mentions: [{ token: 'person', participant_id: recipient.id }], references: [] },
    mentioned_participants: [recipient] });
  const earlierNote = note(earlier, 'Exact earlier explanation for [[mention:person]].'), newerNote = note(newer, 'Later explanation for [[mention:person]].');
  assert.equal(Value.Check(NoteDetail, earlierNote), true); assert.equal(Value.Check(NoteDetail, newerNote), true);
  function Detail() { const params = useParams(); return <ChangeDetails revision={params.revision === earlier.revision_id ? earlierView : newerView}/>; }
  const f = mount(t, <Detail/>, '/inspect/:revision', '/inspect/' + earlier.revision_id);
  await f.refuse(notePath(earlier), 'Exact note temporarily unavailable');
  const count = f.calls.length;
  await click('Retry change note');
  await f.answer(notePath(earlier), earlierNote);
  assert.deepEqual(f.calls.slice(count).map(c => c.path), [notePath(earlier)]);
  const section = document.getElementById('change-note')!;
  assert.match(section.textContent!, /Editor’s note for revision 2 · published by Revision publisher/);
  assert.match(section.textContent!, /Exact earlier explanation for @Note recipient\./);
  assert.equal(!!screen.queryByText('Independent main text'), false);
  await act(async () => { await f.router.navigate('/inspect/' + newer.revision_id); });
  await waitFor(() => assert.ok(f.pending(notePath(newer)).length));
  const held = [...f.pending(notePath(newer))];
  await act(async () => { await f.router.navigate('/inspect/' + earlier.revision_id); });
  await f.answer(notePath(earlier), earlierNote);
  await act(async () => { for (const call of held) call.finish(Response.json(newerNote)); });
  assert.match(document.getElementById('change-note')!.textContent!, /Exact earlier explanation for @Note recipient\./);
  assert.equal(!!screen.queryByText(/Later explanation/), false);
  assert.equal(!!screen.queryByText(/Later editor/), false);
  assert.ok(f.calls.every(c => c.done && [notePath(earlier), notePath(newer)].includes(c.path)));
});

test('declared revision continuation retains the prior page on failure and retries the exact cursor with qualified unknown coverage', async t => {
  const source = resource('contribution', 'Ordinary change account'); source.publisher = source.author;
  const account = revision(source, true);
  const members = Array.from({ length: 13 }, (_, i) => resource('artifact', 'Exact target ' + i))
    .sort((a, b) => a.resource_id.localeCompare(b.resource_id) || a.revision_id.localeCompare(b.revision_id));
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  // Fourteen declared members: thirteen eligible rows plus one unavailable member after them.
  // The server authorizes the entire set before paging, so every page remains unknown.
  const page = (items: ResourceView[], next: string | null): ChangeCoverageView => ({ source, state: 'declared',
    described_scope: 'exact_set; no_intermediate_revision_claim', claim: 'author_declared; not_read_correctness_approval_or_currency_proof',
    items: items.map(representation => ({ target: { kind: 'artifact', resource_id: representation.resource_id, revision_id: representation.revision_id },
      representation, browser_url: `/loom/resource/${representation.resource_id}/${representation.revision_id}`, context_url: '/loom/resource/' + representation.resource_id })),
    unknown: true, omitted_detail: 'bodies; unavailable_members', order: 'target_resource_uuid_then_revision_uuid',
    next_cursor: next, complete: next === null, work_budget_reached: false, limit: 12, max_response_bytes: 131072, expires_at: expiresAt });
  const first = page(members.slice(0, 12), 'declared-next'), second = page(members.slice(12), null);
  assert.equal(Value.Check(ChangeCoverage, first), true); assert.equal(Value.Check(ChangeCoverage, second), true);
  const f = mount(t, <ChangeDetails revision={account}/>), initialUrl = coveragePath(source) + '?limit=12', nextUrl = initialUrl + '&cursor=declared-next';
  const links = () => screen.getAllByRole('listitem').map(li => {
    const a = within(li).getByRole('link'); return { href: a.getAttribute('href'), text: li.textContent };
  });
  const expected = (items: ResourceView[]) => items.map(item => ({ href: `/loom/resource/${item.resource_id}/${item.revision_id}`, text: `${item.title} · revision ${item.revision_number} by ${item.publisher.nickname}` }));
  await f.answer(initialUrl, first);
  assert.deepEqual(links(), expected(members.slice(0, 12)));
  assert.ok(screen.getByText(/This is an author’s claim, not proof of reading, correctness, approval or currency/));
  const unknown = 'Some described material is unavailable; the complete described set is unknown here.';
  assert.ok(screen.getByText(unknown));
  await click('Next described revisions');
  await waitFor(() => assert.ok(f.pending(nextUrl).length));
  assert.equal((screen.getByRole('button', { name: 'Next described revisions' }) as HTMLButtonElement).disabled, true);
  assert.deepEqual(links(), expected(members.slice(0, 12)));
  await f.refuse(nextUrl, 'Declared page temporarily unavailable');
  assert.deepEqual(links(), expected(members.slice(0, 12)));
  assert.equal(!!screen.queryByRole('button', { name: 'Next described revisions' }), false);
  screen.getByRole('button', { name: 'Retry described revisions' }).focus();
  const count = f.calls.length;
  await click('Retry described revisions');
  await waitFor(() => assert.ok(f.pending(nextUrl).length));
  assert.notEqual(document.activeElement, screen.getByRole('heading', { name: 'Described revisions' }));
  assert.deepEqual(links(), expected(members.slice(0, 12)));
  await f.answer(nextUrl, second);
  assert.deepEqual(f.calls.slice(count).map(c => c.path), [nextUrl]);
  assert.deepEqual(links(), expected(members.slice(12)));
  assert.equal(document.activeElement, screen.getByRole('heading', { name: 'Described revisions' }));
  assert.ok(screen.getByText(unknown));
  assert.ok(screen.getByText('End of the selected declaration. Unavailable members remain undisclosed.'));
  const refresh = f.calls.length;
  await click('Refresh described revisions');
  await f.answer(initialUrl, first);
  assert.deepEqual(f.calls.slice(refresh).map(c => c.path), [initialUrl]);
  assert.deepEqual(links(), expected(members.slice(0, 12)));
  assert.equal(document.activeElement, screen.getByRole('heading', { name: 'Described revisions' }));
  assert.ok(f.calls.every(c => c.done && [initialUrl, nextUrl].includes(c.path)));
});
