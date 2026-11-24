import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { StrictMode } from 'react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import type {
  DirectoryObservationView,
  OrganizationResourceView,
} from '../../src/contracts/organization.js';
import type { PageView, ResourceView } from '../../src/contracts/participation.js';
import { topicFreshnessContract } from '../../src/contracts/topic-discussion-freshness.js';
import { ActiveView } from '../../src/web/ParticipationRoutes.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import { TopicNavigation, type TopicDirectoryPosition } from '../../src/web/topic-navigation.js';
import {
  holdReads,
  organizationContext,
  topic,
  topicPage,
} from '../helpers/topic-directory-fixtures.js';

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
] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});
const { render, screen, fireEvent, cleanup, act, within } = await import('@testing-library/react');
afterEach(() => {
  cleanup();
  invalidateIdentity();
  localStorage.clear();
});

async function browse(
  t: TestContext,
  options: {
    parent?: OrganizationResourceView;
    goal?: TopicDirectoryPosition;
    search?: string;
  } = {},
) {
  const { parent, goal, search } = options;
  const reads = holdReads(t);
  const owner = new TopicNavigation();
  const context = organizationContext('participant');
  context.topicNavigation = owner;
  const sourcePath = parent ? '/loom/area/' + parent.resource_id : '/loom';
  const key = 'source-entry';
  if (goal) owner.remember(key, parent?.resource_id ?? null, { kind: 'directory', position: goal });
  const router = createMemoryRouter(
    [
      { path: sourcePath, element: <ActiveView context={context} /> },
      { path: '*', element: <h1>Opened destination</h1> },
    ],
    { initialEntries: [{ pathname: sourcePath, key, search: search ?? '' }] },
  );
  t.after(() => router.dispose());
  const scroll: ScrollToOptions[] = [];
  t.mock.method(window, 'scrollBy', (options: ScrollToOptions) => scroll.push(options));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
  });
  t.after(() => Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'));
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  await act(async () => {});
  const last = reads.latest;
  const directoryPath = '/api/v1/organization/children';
  const directory = () =>
    within(screen.getByRole('region', { name: parent ? 'Subtopics' : 'Root topics' }));
  const summary = () => screen.getByText('Subtopics', { selector: 'summary' });
  const pending = () => last(directoryPath);
  const count = () => reads.calls.filter((call) => call.url.pathname === directoryPath).length;
  async function metadata() {
    assert.ok(parent);
    await reads.respond(
      Response.json(parent),
      last('/api/v1/organization/resources/' + parent.resource_id),
    );
  }
  async function page(
    cursor: string | null,
    rows: OrganizationResourceView[],
    next: string | null = null,
    observation?: DirectoryObservationView,
  ) {
    const call = pending();
    assert.equal(call.url.searchParams.get('cursor'), cursor);
    assert.equal(call.url.searchParams.get('parent_id'), parent?.resource_id ?? null);
    await reads.respond(
      topicPage(rows, next, {
        scope: 'children:' + (parent?.resource_id ?? 'root'),
        ...(observation ? { hierarchy_version: observation.hierarchy_version, observation } : {}),
      }),
      call,
    );
  }
  async function back() {
    await act(async () => {
      await router.navigate(-1);
    });
    assert.equal(router.state.location.key, key);
  }
  async function open(title: string) {
    fireEvent.click(directory().getByRole('link', { name: title }));
    await screen.findByRole('heading', { name: 'Opened destination' });
  }
  return {
    ...reads,
    context,
    directory,
    pending,
    last,
    count,
    metadata,
    summary,
    page,
    back,
    open,
    router,
    scroll,
  };
}

test('root Back follows new cursors, preserves a partial goal across another departure, and counts empty pages', async (t) => {
  const view = await browse(t);
  const first = topic('Original first');
  const tail = topic('Original tenth', { publication_open: false });
  await view.page(null, [first], 'before-1');
  for (let i = 1; i < 10; i++) {
    fireEvent.click(view.directory().getByRole('button', { name: 'Load more topics' }));
    await view.page('before-' + i, i === 9 ? [tail] : [], i === 9 ? null : 'before-' + (i + 1));
  }
  await view.open(tail.title);
  for (const run of ['first', 'second']) {
    await view.back();
    assert.ok(!screen.queryByText(tail.title));
    assert.ok(!screen.queryByText(first.title));
    const count = view.count();
    await view.page(null, [{ ...first, title: 'Current first' }], run + '-1');
    for (let i = 1; i < 8; i++) await view.page(run + '-' + i, [], run + '-' + (i + 1));
    assert.equal(view.count(), count + 7);
    assert.ok(view.directory().getByText(/hasn.t been fully restored/i));
    assert.ok(!view.directory().queryByText(/no longer in this list/i));
    const more = view.directory().getByRole('button', { name: 'Continue restoring topics' });
    if (run === 'first') {
      await view.open('Current first');
    } else {
      fireEvent.click(more);
      await view.page('second-8', [], 'second-9');
      await view.page(
        'second-9',
        [{ ...tail, title: 'Current tenth', description: 'Current description' }],
        'second-10',
      );
      assert.ok(view.directory().getByRole('link', { name: 'Current tenth' }));
      assert.ok(view.directory().getByText('Current description'));
      assert.ok(view.directory().getByText('Closed to contributions'));
      assert.ok(!view.directory().queryByRole('button', { name: 'Continue restoring topics' }));
      assert.ok(view.directory().getByRole('button', { name: 'Load more topics' }));
    }
  }
});

test('root restoration retries only its failed read and Reload supersedes the held continuation and old goal', async (t) => {
  const former = topic('Former tail');
  const fresh = topic('Still authorized');
  const view = await browse(t, {
    goal: { pages: 5, tailId: former.resource_id, topicId: former.resource_id, offset: 90 },
  });
  await view.page(null, [fresh], 'return-next');
  const failed = view.pending();
  const fail = () =>
    Response.json(
      { error: { code: 'service_unavailable', message: 'Injected read failure.' } },
      { status: 503 },
    );
  await view.respond(fail(), failed);
  const first = view.directory().getByRole('link', { name: fresh.title });
  fireEvent.click(view.directory().getByRole('button', { name: 'Retry restoring topics' }));
  const held = view.pending();
  assert.equal(held.url.href, failed.url.href);
  assert.notEqual(held, failed);
  assert.equal(view.directory().getByRole('link', { name: fresh.title }), first);
  fireEvent.click(view.directory().getByRole('button', { name: 'Reload topics' }));
  assert.ok(held.signal.aborted);
  await view.page(null, [fresh], 'new-next');
  await view.respond(topicPage([former]), held);
  assert.ok(!view.directory().queryByRole('link', { name: former.title }));
  assert.ok(!view.directory().queryByRole('button', { name: 'Continue restoring topics' }));
  await view.open(fresh.title);
  await view.back();
  const count = view.count();
  await view.page(null, [{ ...fresh, title: 'Current reading place' }], 'different-next');
  assert.equal(view.count(), count);
  assert.equal(
    document.activeElement,
    view.directory().getByRole('link', { name: 'Current reading place' }),
  );
});

for (const anchorRemains of [false, true]) {
  test(
    'fresh end of a changed collection with ' +
      (anchorRemains ? 'an available anchor' : 'a missing anchor'),
    async (t) => {
      const anchor = topic('Activated topic'),
        replacement = topic('Another current topic');
      const view = await browse(t, {
        goal: { pages: 4, tailId: randomUUID(), topicId: anchor.resource_id, offset: 120 },
      });
      t.mock.method(
        HTMLElement.prototype,
        'getBoundingClientRect',
        () => new dom.window.DOMRect(0, 230, 200, 55),
      );
      await view.page(null, anchorRemains ? [anchor, replacement] : [replacement]);
      assert.ok(view.directory().getByRole('link', { name: replacement.title }));
      assert.ok(!view.directory().queryByRole('button', { name: 'Continue restoring topics' }));
      const notice = view
        .directory()
        .getByText(
          anchorRemains
            ? /list changed while you were away/i
            : /previous place.*no longer in this list/i,
        );
      if (anchorRemains) {
        assert.equal(
          document.activeElement,
          view.directory().getByRole('link', { name: anchor.title }),
        );
        assert.equal(view.scroll.at(-1)?.top, 110);
      } else {
        assert.equal(document.activeElement, notice);
      }
    },
  );
}

test('same-URL visits have independent authorized pages and cannot settle an older return', async (t) => {
  const former = topic('From older entry');
  const view = await browse(t, { goal: { pages: 2, topicId: former.resource_id, offset: 93 } });
  await view.page(null, [topic('Older first')], 'old-return');
  const held = view.pending();
  await act(async () => {
    await view.router.navigate('/loom');
  });
  assert.ok(held.signal.aborted);
  assert.ok(!screen.queryByText('Older first'));
  const count = view.count();
  await view.page(null, [topic('Independent visit')], 'independent-next');
  await view.respond(topicPage([former]), held);
  assert.equal(view.count(), count);
  assert.ok(!screen.queryByText(former.title));
  assert.deepEqual(view.scroll, []);
  await view.back();
  await view.page(null, [], 'fresh-return');
  await view.page('fresh-return', [former]);
  assert.equal(document.activeElement, view.directory().getByRole('link', { name: former.title }));
});

for (const event of ['wheel', 'focusin'] as const) {
  test(`reader ${event} during parent metadata loading keeps ownership through the first directory read`, async (t) => {
    const parent = topic('Parent');
    const child = topic('Earlier anchor', { parent_id: parent.resource_id });
    const view = await browse(t, {
      parent,
      goal: { pages: 3, topicId: child.resource_id, offset: 120 },
    });
    assert.ok(screen.getByText('Opening topic…'));
    const input = document.createElement('input');
    document.body.append(input);
    t.after(() => input.remove());
    if (event === 'wheel') fireEvent.wheel(window);
    else input.focus();
    const focus = document.activeElement;
    await view.metadata();
    assert.ok(view.summary().closest('details')?.open);
    const count = view.count();
    await view.page(null, [child], 'next');
    assert.equal(view.count(), count);
    assert.equal(document.activeElement, focus);
    assert.deepEqual(view.scroll, []);
    assert.ok(view.directory().getByRole('button', { name: 'Continue restoring subtopics' }));
  });
}

test('scrollbar movement at the parent metadata handoff interrupts directory restoration', async (t) => {
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  Object.defineProperties(window, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.set(++sequence, callback);
        return sequence;
      },
    },
    cancelAnimationFrame: { configurable: true, value: (id: number) => frames.delete(id) },
  });
  t.after(() => {
    cleanup();
    Reflect.deleteProperty(window, 'requestAnimationFrame');
    Reflect.deleteProperty(window, 'cancelAnimationFrame');
  });
  const parent = topic('Parent'),
    anchor = topic('Activated child', { parent_id: parent.resource_id });
  const view = await browse(t, {
    parent,
    goal: { pages: 3, topicId: anchor.resource_id, offset: 120 },
  });
  assert.ok(screen.getByText('Opening topic…'));
  // Let the browser's initial history scroll settle while the parent read is held.
  for (const time of [16, 32]) {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  }
  await view.metadata();
  const count = view.count();
  const focus = document.activeElement;
  fireEvent.scroll(window);
  await view.page(null, [anchor], 'fresh-next');
  assert.equal(view.count(), count, 'scrollbar input must stop the next automatic page');
  assert.equal(document.activeElement, focus);
  assert.deepEqual(view.scroll, []);
  assert.ok(view.directory().getByRole('button', { name: 'Continue restoring subtopics' }));
});

for (const interruption of ['input', 'collapse'] as const) {
  test(`${interruption} while a returned subtopic page is held stops later paging and position changes`, async (t) => {
    const parent = topic('Parent');
    const child = topic('Previously activated', { parent_id: parent.resource_id });
    const view = await browse(t, {
      parent,
      goal: { pages: 3, topicId: child.resource_id, offset: 120 },
    });
    await view.metadata();
    const summary = view.summary(),
      details = summary.closest('details')!;
    assert.ok(details.open);
    await view.page(null, [], 'held');
    summary.focus();
    if (interruption === 'collapse') fireEvent.click(summary);
    else fireEvent.keyDown(summary, { key: 'Tab' });
    const count = view.count();
    await view.page('held', [child], 'more');
    assert.equal(view.count(), count);
    assert.equal(details.open, interruption !== 'collapse');
    assert.equal(document.activeElement, summary);
    assert.deepEqual(view.scroll, []);
    if (interruption === 'collapse') {
      assert.equal(screen.getByText(child.title).closest('details:not([open])'), details);
      fireEvent.click(summary);
    }
    assert.ok(view.directory().getByRole('link', { name: child.title }));
    assert.ok(view.directory().getByRole('button', { name: 'Continue restoring subtopics' }));
  });
}

test('a directory return preserves the artifact composer and proposal disclosure from the source URL', async (t) => {
  const parent = topic('Parent');
  const child = topic('Child', { parent_id: parent.resource_id });
  const view = await browse(t, {
    parent,
    goal: { pages: 1, topicId: child.resource_id, offset: 50 },
    search: '?compose=artifacts&proposal=1',
  });
  await view.metadata();
  await view.page(null, [child]);
  assert.equal(
    screen.getByRole('button', { name: 'Artifacts' }).getAttribute('aria-pressed'),
    'true',
  );
  assert.ok(screen.getByRole('heading', { name: 'New text artifact' }));
  assert.ok(screen.getByText('About this topic', { selector: 'summary' }).closest('details')?.open);
  assert.ok(view.summary().closest('details')?.open);
  assert.ok(!view.calls.some(({ url }) => url.pathname.includes('/discussions')));
});

for (const withdrawal of ['sign-out', 'source denial'] as const) {
  test(`a held restoration response cannot revive its rows or focus after ${withdrawal}`, async (t) => {
    const parent = topic('Parent');
    const child = topic('Earlier child', { parent_id: parent.resource_id });
    const view = await browse(t, {
      parent,
      goal: { pages: 3, topicId: child.resource_id, offset: 65 },
    });
    await view.metadata();
    await view.page(
      null,
      [topic('Previously authorized child', { parent_id: parent.resource_id })],
      'held',
    );
    const held = view.pending();
    if (withdrawal === 'sign-out') {
      await act(async () => invalidateIdentity());
    } else {
      const direct = view.last('/api/v1/areas/' + parent.resource_id + '/proposal-route');
      await view.respond(
        Response.json(
          { error: { code: 'unavailable', message: 'Topic unavailable.' } },
          { status: 404 },
        ),
        direct,
      );
    }
    assert.ok(screen.getAllByText(/protected view was withdrawn/i).length);
    await view.respond(topicPage([child], null, { scope: 'children:' + parent.resource_id }), held);
    assert.ok(!screen.queryByText(child.title));
    assert.ok(!screen.queryByText('Previously authorized child'));
    assert.ok(!screen.queryByText('Continue restoring subtopics'));
    assert.deepEqual(view.scroll, []);
  });
}

test('a discussion row and a subtopic supersede each other on successive returns to one parent entry', async (t) => {
  const parent = topic('Parent with two collections');
  const child = topic('Later child', { parent_id: parent.resource_id });
  const view = await browse(t, { parent });
  const discussions = '/api/v1/areas/' + parent.resource_id + '/discussions';
  const participant = { id: randomUUID(), nickname: 'Test author', kind: 'human' as const };
  const opening = {
    resource_id: randomUUID(),
    revision_id: randomUUID(),
    kind: 'contribution',
    title: 'Later discussion',
    revision_number: '1',
    author: participant,
    publisher: participant,
    created_at: '2026-11-15T00:00:00.000Z',
    discussion_created_at: '2026-11-15T00:00:00.000000Z',
    discussion_observation_tags: Array.from({ length: 2 }, () =>
      randomBytes(32).toString('base64url'),
    ),
    area_id: parent.resource_id,
    area_title: parent.title,
    discussion_id: randomUUID(),
    parent_id: null,
    can_edit: false,
    publication_open: true,
    full_content_url: '/api/v1/resources/' + randomUUID(),
  } satisfies ResourceView;
  async function baseline() {
    await view.respond(
      Response.json({
        contract: topicFreshnessContract,
        cursor: 'current',
        complete: true,
        scanned: 0,
        visibility_scanned: 0,
        change: 'none',
        withdrawn_tags: [],
      }),
      view.last(discussions + '/freshness'),
    );
  }
  async function discussionPage(cursor: string | null, items: ResourceView[], next: string | null) {
    const call = view.last(discussions);
    assert.equal(call.url.searchParams.get('cursor'), cursor);
    await view.respond(
      Response.json({
        items,
        scope: parent.resource_id,
        representation: 'metadata',
        omitted_detail: 'bodies',
        next_cursor: next,
        complete: !next,
        work_budget_reached: !items.length && !!next,
        limit: 12,
        max_response_bytes: 65_536,
      } satisfies PageView),
      call,
    );
  }
  await view.metadata();
  assert.equal(view.summary().closest('details')?.open, false);
  await view.page(null, [], 'dir-1');
  await baseline();
  await discussionPage(null, [], 'disc-1');
  fireEvent.click(screen.getByRole('button', { name: 'Load more discussions' }));
  await discussionPage('disc-1', [opening], null);
  fireEvent.click(screen.getByRole('link', { name: opening.title }));
  await view.back();
  await view.metadata();
  assert.equal(view.summary().closest('details')?.open, false);
  let count = view.count();
  await view.page(null, [], 'dir-2');
  assert.equal(view.count(), count);
  await baseline();
  await discussionPage(null, [], 'disc-2');
  await discussionPage('disc-2', [opening], null);
  assert.equal(document.activeElement, screen.getByRole('link', { name: opening.title }));
  fireEvent.click(view.summary());
  fireEvent.click(view.directory().getByRole('button', { name: 'Load more subtopics' }));
  await view.page('dir-2', [child]);
  await view.open(child.title);

  await view.back();
  await view.metadata();
  assert.ok(view.summary().closest('details')?.open);
  await view.page(null, [], 'dir-3');
  await view.page('dir-3', [{ ...child, title: 'Current child title' }]);
  const childLink = view.directory().getByRole('link', { name: 'Current child title' });
  assert.equal(document.activeElement, childLink);
  await baseline();
  const discCount = view.calls.filter(({ url }) => url.pathname === discussions).length;
  await discussionPage(null, [opening], 'disc-3');
  assert.equal(view.calls.filter(({ url }) => url.pathname === discussions).length, discCount);
  assert.equal(document.activeElement, childLink);
  fireEvent.click(screen.getByRole('link', { name: opening.title }));
  await view.back();
  await view.metadata();
  assert.equal(view.summary().closest('details')?.open, false);
  count = view.count();
  await view.page(null, [], 'dir-4');
  assert.equal(view.count(), count);
  await baseline();
  await discussionPage(null, [opening], 'disc-4');
  assert.equal(document.activeElement, screen.getByRole('link', { name: opening.title }));
});

test('modified, context-menu and prevented directory activations leave the existing return place intact', async (t) => {
  const activated = topic('Original anchor'),
    alternate = topic('Other destination');
  const view = await browse(t, { goal: { pages: 1, topicId: activated.resource_id, offset: 60 } });
  await view.page(null, [activated, alternate]);
  const link = view.directory().getByRole<HTMLAnchorElement>('link', { name: alternate.title });
  for (const modifiers of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    window.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, modifiers);
  }
  fireEvent.contextMenu(link);
  link.addEventListener('click', (event) => event.preventDefault(), { once: true });
  fireEvent.click(link);
  assert.equal(view.router.state.location.pathname, '/loom');
  await act(async () => {
    await view.router.navigate('/another-place');
  });
  await view.back();
  await view.page(null, [alternate, activated]);
  assert.equal(
    document.activeElement,
    view.directory().getByRole('link', { name: activated.title }),
  );
});

test('a first-page refusal can be retried, and incompatible restoration stops at the accepted prefix until Reload', async (t) => {
  const anchor = topic('Anchor');
  const view = await browse(t, { goal: { pages: 3, topicId: anchor.resource_id, offset: 80 } });
  const first = view.pending();
  await view.respond(
    Response.json(
      { error: { code: 'service_unavailable', message: 'Temporary refusal.' } },
      { status: 503 },
    ),
    first,
  );
  fireEvent.click(view.directory().getByRole('button', { name: 'Retry restoring topics' }));
  assert.equal(view.pending().url.href, first.url.href);
  await view.page(null, [topic('Accepted prefix')], 'current');
  const held = view.pending(),
    count = view.count();
  assert.equal(held.url.searchParams.get('cursor'), 'current');
  await view.respond(
    topicPage([topic('Incompatible successor', { hierarchy_version: 2 })], null, {
      hierarchy_version: 2,
    }),
    held,
  );
  assert.equal(view.count(), count);
  assert.ok(view.directory().getByRole('link', { name: 'Accepted prefix' }));
  assert.ok(!view.directory().queryByRole('link', { name: 'Incompatible successor' }));
  assert.ok(view.directory().getByText(/list needs refreshing/i));
  assert.ok(!view.directory().queryByRole('button', { name: /Continue|Retry/ }));
  fireEvent.click(view.directory().getByRole('button', { name: 'Reload topics' }));
  await view.page(null, [anchor], 'fresh-cursor');
  assert.ok(view.directory().getByRole('link', { name: 'Anchor' }));
  assert.ok(!view.directory().queryByRole('link', { name: 'Accepted prefix' }));
  assert.ok(view.directory().getByRole('button', { name: 'Load more topics' }));
});

function directoryClock(t: TestContext) {
  t.mock.getter(document, 'hidden', () => false);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return async (delay = 15000) =>
    act(async () => {
      now += delay;
      t.mock.timers.tick(delay);
    });
}

const observationPath = '/api/v1/organization/children/observation';
const rootBoundary = (
  directory_version: number,
  hierarchy_version = 1,
): DirectoryObservationView => ({
  parent_id: null,
  directory_version,
  inherited_closure: false,
  hierarchy_version,
});
const directoryFailure = () =>
  Response.json(
    { error: { code: 'service_unavailable', message: 'Temporary directory failure.' } },
    { status: 503 },
  );

test('directory checks keep the accepted first boundary through append and show commits during replacement after it is adopted', async (t) => {
  const tick = directoryClock(t);
  const view = await browse(t);
  assert.equal(view.pending().url.searchParams.get('observe'), '1');
  const first = topic('First row');
  const tail = topic('Earlier tail');
  // The server committed v2 after capturing this first page and before delivery.
  await view.page(null, [first], 'old-tail', rootBoundary(1));
  const original = view.directory().getByRole('link', { name: first.title });
  original.focus();
  const load = view.directory().getByRole('button', { name: 'Load more topics' });
  fireEvent.click(load);
  const append = view.pending();
  await tick();
  await view.respond(Response.json(rootBoundary(2, 2)), view.last(observationPath));
  assert.equal(document.activeElement, original);
  assert.equal(view.directory().getByRole('link', { name: first.title }), original);
  await view.respond(topicPage([tail]), append);
  assert.ok(view.directory().getByText('Topics updated'));
  assert.ok(view.directory().getByText('2 topics shown'));
  await tick();
  await view.respond(directoryFailure(), view.last(observationPath));
  assert.ok(view.directory().getByText(/Couldn’t check for updates/));
  assert.ok(view.directory().getByText('Topics updated'));

  fireEvent.click(view.directory().getByRole('button', { name: 'Show updated topics' }));
  await view.respond(directoryFailure(), view.pending());
  assert.ok(view.directory().getByText(/list is still here/));
  assert.ok(view.directory().getByText(/Couldn’t check for updates/));
  assert.equal(view.directory().getByRole('link', { name: first.title }), original);
  fireEvent.click(view.directory().getByRole('button', { name: 'Retry updating topics' }));
  const later = rootBoundary(2, 2);
  const after = (row: OrganizationResourceView) => ({ ...row, hierarchy_version: 2 });
  await view.page(null, [after(first)], 'fresh-tail', later);
  assert.equal(
    view.directory().getByRole('link', { name: tail.title }).dataset.topicId,
    tail.resource_id,
  );
  const waiting = view.pending();
  // A v3 change happens while the replacement's response is still on the wire.
  await tick(30000);
  await view.respond(Response.json(rootBoundary(3, 3)), view.last(observationPath));
  await view.respond(topicPage([after(tail)], 'fresh-next', { hierarchy_version: 2 }), waiting);
  assert.equal(view.directory().getByRole('link', { name: first.title }), original);
  assert.ok(view.directory().getByText('Topics updated'));
  assert.ok(view.directory().getByText('2 topics loaded'));
  assert.equal(
    view
      .directory()
      .getByRole('button', { name: 'Load more topics' })
      .getAttribute('aria-disabled'),
    'true',
  );
  await tick();
  await view.respond(directoryFailure(), view.last(observationPath));
  assert.ok(view.directory().getByText(/Couldn’t check for updates/));
  assert.ok(view.directory().getByText('Topics updated'));
  assert.equal(
    view
      .directory()
      .getByRole('button', { name: 'Load more topics' })
      .getAttribute('aria-disabled'),
    'true',
  );
});

test('directory application counts empty pages, retries the exact failed cursor and records its accepted extent for Back', async (t) => {
  const view = await browse(t);
  const first = topic('Initial title');
  const tail = topic('Tail title');
  const later = topic('Fresh continuation');
  await view.page(null, [first], 'old');
  fireEvent.click(view.directory().getByRole('button', { name: 'Load more topics' }));
  await view.page('old', [tail]);
  const original = view.directory().getByRole('link', { name: first.title });
  fireEvent.click(view.directory().getByRole('button', { name: 'Show updated topics' }));
  const startCount = view.count();
  await view.page(null, [{ ...first, title: 'Updated title' }], 'fresh-1');
  for (let i = 1; i < 8; i++) await view.page('fresh-' + i, [], 'fresh-' + (i + 1));
  assert.equal(view.count(), startCount + 7);
  assert.equal(view.directory().getByRole('link', { name: first.title }), original);
  assert.ok(!view.directory().queryByRole('link', { name: 'Updated title' }));
  fireEvent.click(view.directory().getByRole('button', { name: 'Continue updating topics' }));
  assert.equal(view.pending().url.searchParams.get('cursor'), 'fresh-8');
  await view.respond(directoryFailure(), view.pending());
  assert.ok(view.directory().getByText(/list is still here/));
  assert.equal(view.directory().getByRole('link', { name: first.title }), original);
  fireEvent.click(view.directory().getByRole('button', { name: 'Retry updating topics' }));
  await view.page('fresh-8', [tail], 'fresh-9');
  assert.equal(view.directory().getByRole('link', { name: 'Updated title' }), original);
  assert.ok(!view.directory().queryByText('All topics loaded.'));
  fireEvent.click(view.directory().getByRole('button', { name: 'Load more topics' }));
  await view.page('fresh-9', [later]);
  await view.open(later.title);
  await view.back();
  const backStart = view.count();
  await view.page(null, [first, tail, later], 'return-1');
  for (let i = 1; i < 8; i++) await view.page('return-' + i, [], 'return-' + (i + 1));
  assert.equal(view.count(), backStart + 7);
  fireEvent.click(view.directory().getByRole('button', { name: 'Continue restoring topics' }));
  await view.page('return-8', [], 'return-9');
  await view.page('return-9', [], 'return-10');
  assert.ok(!view.directory().queryByRole('button', { name: 'Continue restoring topics' }));
  assert.ok(view.directory().getByRole('button', { name: 'Load more topics' }));
});

test('an incompatible update prefix is discarded only for the explicit restart while the original list remains visible', async (t) => {
  const view = await browse(t);
  const tail = topic('Original tail');
  await view.page(null, [tail]);
  fireEvent.click(view.directory().getByRole('button', { name: 'Show updated topics' }));
  const provisional = topic('First replacement prefix');
  await view.page(null, [provisional], 'incompatible');
  const beforeFailure = view.count();
  await view.page('incompatible', [{ ...tail, hierarchy_version: 2 }], null, rootBoundary(2, 2));
  assert.equal(view.count(), beforeFailure);
  assert.ok(view.directory().getByText(/Organization changed again/));
  assert.ok(view.directory().queryByRole('link', { name: tail.title }));
  assert.ok(!view.directory().queryByRole('link', { name: provisional.title }));
  fireEvent.click(view.directory().getByRole('button', { name: 'Restart update' }));
  assert.equal(view.pending().url.searchParams.get('cursor'), null);
  await view.page(null, [{ ...tail, title: 'From the valid restart' }]);
  assert.ok(view.directory().getByRole('link', { name: 'From the valid restart' }));
  assert.ok(!view.directory().queryByRole('link', { name: provisional.title }));
});

for (const interrupted of [false, true]) {
  test(
    'a moved update anchor ' +
      (interrupted
        ? 'yields positioning to later reader input'
        : 'focuses a surviving neighbor near its former offset'),
    async (t) => {
      const view = await browse(t);
      const lost = topic('Topic that moved');
      const neighbor = topic('Nearby topic');
      await view.page(null, [lost, neighbor]);
      const retained = view.directory().getByRole('link', { name: neighbor.title });
      t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
        const top =
          this.dataset.topicId === lost.resource_id
            ? 80
            : this.dataset.topicId === neighbor.resource_id
              ? 205
              : 0;
        return new dom.window.DOMRect(0, top, 180, 30);
      });
      const lostLink = view.directory().getByRole('link', { name: lost.title });
      lostLink.focus();
      fireEvent.click(view.directory().getByRole('button', { name: 'Show updated topics' }));
      if (interrupted) {
        fireEvent.scroll(window);
        retained.focus();
      }
      await view.page(null, [neighbor]);
      assert.equal(view.directory().getByRole('link', { name: neighbor.title }), retained);
      assert.equal(document.activeElement, retained);
      assert.ok(view.directory().getByText('Your previous place is no longer in this list.'));
      if (interrupted) assert.deepEqual(view.scroll, []);
      else assert.deepEqual(view.scroll, [{ top: 125, behavior: 'instant' }]);
    },
  );
}

test('applying preserves a partly read description even when its title is behind the sticky controls', async (t) => {
  const view = await browse(t);
  const row = topic('Above the sticky controls');
  await view.page(null, [row]);
  const link = view.directory().getByRole('link', { name: row.title });
  const apply = view.directory().getByRole('button', { name: 'Show updated topics' });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
    const start = link.textContent === row.title ? 12 : 152;
    if (this === link) return new dom.window.DOMRect(0, start, 120, 18);
    if (this === link.closest('li')) return new dom.window.DOMRect(0, start - 8, 200, 130);
    if (this === apply.parentElement) return new dom.window.DOMRect(0, 0, 300, 64);
    return new dom.window.DOMRect();
  });
  apply.focus();
  fireEvent.click(apply);
  await view.page(null, [{ ...row, title: 'Same topic below the controls' }]);
  assert.deepEqual(view.scroll, [{ top: 140, behavior: 'instant' }]);
  assert.equal(document.activeElement, apply);
});

test('applying an empty replacement keeps the directory in reach when the whole visible extent moved away', async (t) => {
  const view = await browse(t);
  const row = topic('Previously visible');
  await view.page(null, [row]);
  const apply = view.directory().getByRole('button', { name: 'Show updated topics' });
  const link = view.directory().getByRole('link', { name: row.title });
  t.mock.method(HTMLElement.prototype, 'getBoundingClientRect', function (this: HTMLElement) {
    return new dom.window.DOMRect(
      0,
      this === link || this === link.closest('li') ? 150 : 0,
      160,
      32,
    );
  });
  const revealed: HTMLElement[] = [];
  t.mock.method(HTMLElement.prototype, 'scrollIntoView', function (this: HTMLElement) {
    revealed.push(this);
  });
  apply.focus();
  fireEvent.click(apply);
  await view.page(null, []);
  assert.equal(revealed.length, 1);
  assert.equal(revealed[0], view.directory().getByText('No topics here yet.').closest('section'));
  assert.equal(document.activeElement, apply);
  assert.ok(view.directory().getByText('Your previous place is no longer in this list.'));
});

test('a late foreground throttle defers the timer already scheduled for the new traversal', async (t) => {
  const tick = directoryClock(t);
  const view = await browse(t);
  await view.page(null, [topic('Previous directory')]);
  await tick(5000);
  fireEvent.click(view.directory().getByRole('button', { name: 'Show updated topics' }));
  const held = view.pending();
  fireEvent.click(view.directory().getByRole('button', { name: 'Reload topics' }));
  assert.equal(held.signal.aborted, true);
  await view.page(null, [topic('Replacement directory')]);
  await view.respond(
    Response.json(
      { error: { code: 'temporarily_throttled', message: 'Synthetic read limit.' } },
      {
        status: 429,
        headers: { 'Retry-After': '42' },
      },
    ),
    held,
  );
  const checks = () => view.calls.filter((call) => call.url.pathname === observationPath);
  await tick(10000);
  assert.equal(checks().length, 0);
  await tick(31999);
  assert.equal(checks().length, 0);
  await tick(1);
  assert.equal(checks().length, 1);
  assert.ok(view.directory().getByRole('link', { name: 'Replacement directory' }));
  assert.ok(!view.directory().queryByText(/couldn’t check for updates/i));
});

test('an explicitly requested append finishes behind closed Subtopics, and reopening resumes observation from the original baseline', async (t) => {
  const tick = directoryClock(t);
  const parent = topic('Main topic');
  const view = await browse(t, { parent });
  await view.metadata();
  const child = topic('First child', { parent_id: parent.resource_id });
  const nextChild = topic('Next child', { parent_id: parent.resource_id });
  await view.page(null, [child], 'one-more-child');
  const summary = view.summary();
  const details = summary.closest('details')!;
  fireEvent.click(summary);
  details.dispatchEvent(new Event('toggle'));
  await tick(0);
  const boundary = {
    parent_id: parent.resource_id,
    directory_version: 1,
    hierarchy_version: 1,
    inherited_closure: false,
  };
  await view.respond(Response.json(boundary), view.last(observationPath));
  assert.ok(view.directory().getByText('Subtopics updated'));
  fireEvent.click(view.directory().getByRole('button', { name: 'Load more subtopics' }));
  const next = view.pending();
  assert.equal(next.url.searchParams.get('cursor'), 'one-more-child');
  fireEvent.click(summary);
  details.dispatchEvent(new Event('toggle'));
  assert.equal(details.open, false);
  assert.equal(next.signal.aborted, false);
  await view.page('one-more-child', [nextChild]);
  const checks = () => view.calls.filter((call) => call.url.pathname === observationPath);
  await tick(60000);
  assert.equal(checks().length, 1);
  assert.ok(details.textContent?.includes(nextChild.title));
  fireEvent.click(summary);
  details.dispatchEvent(new Event('toggle'));
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  await tick(0);
  assert.equal(checks().length, 2);
  await view.respond(
    Response.json({ ...boundary, directory_version: 0 }),
    view.last(observationPath),
  );
  assert.ok(view.directory().getByText('Subtopics updated'));
  assert.ok(view.directory().getByRole('link', { name: nextChild.title }));
  assert.ok(view.directory().getByText('2 subtopics shown'));
});
