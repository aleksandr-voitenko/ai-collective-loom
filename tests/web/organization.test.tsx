import { AuthorizationBoundary, useAuthorization } from '../../src/web/AuthorizationBoundary.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { StrictMode, type ReactNode } from 'react';
import { createMemoryRouter, MemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { OrganizationPage } from '../../src/web/Organization.js';
import { Topics } from '../../src/web/ParticipationTopics.js';
import { TopicDirectory } from '../../src/web/TopicDirectory.js';
import { IntentStore, invalidateIdentity } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';
import type {
  OrganizationPageView,
  OrganizationResourceView,
  OrganizationResult,
} from '../../src/contracts/organization.js';
import { contractVersion, guideRevision, limits } from '../../src/contracts/participation.js';

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
] as const) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});
const { render, screen, fireEvent, cleanup, act, waitFor, within } =
  await import('@testing-library/react');
afterEach(() => {
  cleanup();
  invalidateIdentity();
  localStorage.clear();
});

function organizationContext(role: Context['self']['role']): Context {
  const participant = randomUUID(),
    instance = randomUUID();
  return {
    self: {
      participant_id: participant,
      credential_id: randomUUID(),
      nickname: role,
      kind: 'human',
      role,
    },
    community: {
      moderation_contract: 'moderation-state-1',
      moderation_url: '/api/v1/admin/moderation/targets',
      instance_id: instance,
      contract_version: contractVersion,
      guide_revision: guideRevision,
      profile: 'synthetic',
      community_name: 'Synthetic community',
      settings_version: 1,
      overview: { state: 'setup_incomplete' },
      proposal_area: { state: 'setup_incomplete' },
      contacts: [],
      contacts_url: '/api/v1/contacts',
      guide_url: '/api/v1/guide',
      openapi_url: '/api/v1/openapi.json',
      limits,
      replay_retention: 'retained_without_automatic_expiry; destructive_restore_unsupported',
      derived_effects: 'search_and_personal_direct_attention; other_projections_disabled',
      notification_contract: 'personal-attention-1',
      notifications_url: '/api/v1/me/notifications/query',
      following_contract: 'following-1',
      following_url: '/api/v1/me/following',
      attention_contract: 'attention-controls-1',
      attention_url: '/api/v1/me/attention/list',
      routine_updates_contract: 'combined-updates-2',
      routine_updates_url: '/api/v1/me/routine-updates/query',
      reading_contract: 'reading-state-1',
      reading_url: '/api/v1/me/reading/lookup',
      updates_contract: 'combined-updates-1',
      updates_url: '/api/v1/me/updates/query',
      shared_changes_contract: 'shared-changes-1',
      shared_changes_url: '/api/v1/shared-changes/query',
    },
    store: new IntentStore(instance, participant, localStorage, location.origin, locks),
    refreshCommunity: () => {},
  };
}

function topic(title: string, extra: Partial<OrganizationResourceView> = {}) {
  return {
    resource_id: randomUUID(),
    kind: 'area',
    parent_id: null,
    version: 1,
    hierarchy_version: 1,
    title,
    description: 'Synthetic topic scope',
    metadata_version: 1,
    local_open: true,
    publication_open: true,
    can_organize: false,
    ancestors: [],
    contacts_url: '/api/v1/contacts',
    proposal_route_url: '/api/v1/areas/proposal-route',
    ...extra,
  } satisfies OrganizationResourceView;
}

function topicPage(
  items: OrganizationResourceView[],
  next: string | null = null,
  extra: Partial<OrganizationPageView> = {},
) {
  return Response.json({
    items,
    next_cursor: next,
    hierarchy_version: 1,
    scope: 'children:root',
    complete: next === null,
    limit: 12,
    max_response_bytes: 65_536,
    work_budget_reached: items.length === 0 && next !== null,
    ...extra,
  } satisfies OrganizationPageView);
}

function holdReads(t: TestContext) {
  const calls: { url: URL; signal: AbortSignal; respond: (response: Response) => void }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (path: string, options: RequestInit) =>
      new Promise<Response>((respond) => {
        calls.push({ url: new URL(path, location.origin), signal: options.signal!, respond });
      }),
  );
  function latest() {
    const call = calls.at(-1);
    assert.ok(call, 'expected a directory request');
    return call;
  }
  async function respond(response: Response, call = latest()) {
    await act(async () => call.respond(response));
  }
  return { calls, latest, respond };
}

function mountTopics(sibling?: ReactNode) {
  const context = organizationContext('participant');
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={['/loom']}>
        <AuthorizationBoundary>
          <Topics context={context} />
        </AuthorizationBoundary>
        {sibling}
      </MemoryRouter>
    </StrictMode>,
  );
}

function readFailure(status = 503, code = 'service_unavailable') {
  return Response.json({ error: { code, message: 'Injected directory failure.' } }, { status });
}

const rootTopics = () => within(screen.getByRole('region', { name: 'Root topics' }));

function form(t: TestContext) {
  const resource = topic('Original topic', { description: 'Original scope', can_organize: true });
  const context = organizationContext('administrator');
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => {
    if (options?.method === 'POST') {
      assert.equal(path, '/api/v1/organization/changes');
      requests.push(JSON.parse(String(options.body)));
      return response;
    }
    assert.equal(path, '/api/v1/organization/resources/' + resource.resource_id);
    return Response.json(resource);
  });
  const router = createMemoryRouter(
    [
      {
        path: '/loom/organize',
        element: (
          <AuthorizationBoundary>
            <OrganizationPage context={context} />
          </AuthorizationBoundary>
        ),
      },
      { path: '/elsewhere', element: <h1>Another view</h1> },
    ],
    { initialEntries: ['/loom/organize?action=area.edit&target=' + resource.resource_id] },
  );
  t.after(() => router.dispose());
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  const committed: OrganizationResult = {
    operation_state: 'committed',
    operation_id: randomUUID(),
    kind: 'area.edit',
    idempotency: 'created',
    outcome: {
      resource_id: resource.resource_id,
      parent_id: null,
      version: 2,
      hierarchy_version: 2,
      local_open: true,
    },
    current: { ...resource, version: 2, hierarchy_version: 2, metadata_version: 2 },
  };
  return { context, router, requests, finish, committed };
}

async function submit(requests: Record<string, unknown>[]) {
  await screen.findByLabelText('Topic title');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save topic' }));
  });
  await waitFor(() => assert.equal(requests.length, 1));
  assert.ok(screen.getByText('Waiting for confirmation…'));
}

test('StrictMode organization success leaves the busy state and shows the confirmed result', async (t) => {
  const { context, requests, finish, committed } = form(t);
  await submit(requests);
  await act(async () => {
    finish(Response.json(committed));
  });
  await waitFor(() =>
    assert.ok(
      !screen.queryByText('Waiting for confirmation…'),
      'The completed request must leave the busy state',
    ),
  );
  assert.ok(screen.getByText('Organization change confirmed.'));
  assert.ok(screen.getByRole('link', { name: 'View current location' }));
  assert.equal(context.store.all()[0]?.state, 'committed');
});

test('StrictMode organization rejection leaves the busy state and permits explicit correction', async (t) => {
  const { context, requests, finish } = form(t);
  await submit(requests);
  await act(async () => {
    finish(
      Response.json(
        {
          error: {
            code: 'organization_conflict',
            message: 'Organization changed. Review the latest version.',
          },
        },
        { status: 409 },
      ),
    );
  });
  await waitFor(() =>
    assert.ok(
      !screen.queryByText('Waiting for confirmation…'),
      'The completed request must leave the busy state',
    ),
  );
  assert.match(screen.getByRole('alert').textContent ?? '', /Organization changed/);
  assert.equal(
    (
      screen.getByRole('button', {
        name: 'Review latest organization and prepare correction',
      }) as HTMLButtonElement
    ).disabled,
    false,
  );
  assert.equal(context.store.all()[0]?.state, 'rejected');
});

test('StrictMode organization completion after unmount settles only the retained intent', async (t) => {
  const { context, router, requests, finish, committed } = form(t);
  await submit(requests);
  await act(async () => {
    await router.navigate('/elsewhere');
  });
  await act(async () => {
    finish(Response.json(committed));
  });
  await waitFor(() => assert.equal(context.store.all()[0]?.state, 'committed'));
  assert.ok(screen.getByRole('heading', { name: 'Another view' }));
  assert.ok(!screen.queryByText('Organization change confirmed.'));
});

test('StrictMode organization completion cannot update a different identity', async (t) => {
  const { context, requests, finish, committed } = form(t);
  await submit(requests);
  const retained = context.store.all();
  // Keep this view mounted to exercise generation ownership independently of cleanup.
  t.mock.method(window, 'dispatchEvent', () => true);
  const other = new IntentStore(
    context.community.instance_id,
    randomUUID(),
    localStorage,
    location.origin,
    locks,
  );
  await act(async () => {
    invalidateIdentity();
    finish(Response.json(committed));
  });
  assert.deepEqual(context.store.all(), retained);
  assert.deepEqual(other.all(), []);
  assert.ok(!screen.queryByText('Organization change confirmed.'));
  assert.ok(!screen.queryByRole('alert'));
});

test('root Topics appends bounded groups in server order and keeps row identity through retry', async (t) => {
  const { calls, latest, respond } = holdReads(t);
  mountTopics();
  await act(async () => {});
  const directory = rootTopics();
  assert.equal(directory.getByRole('status').textContent?.trim(), 'Loading topics…');
  assert.equal(latest().url.pathname, '/api/v1/organization/children');
  assert.equal(latest().url.searchParams.has('parent_id'), false);
  assert.equal(latest().url.searchParams.has('cursor'), false);

  const opening = 'A topic about our shared spaces.';
  const first = topic('Zebra topic', {
    description: `${opening} `.repeat(8) + 'The description ends here.',
  });
  const closed = topic('Closed for editing', {
    description: null,
    publication_open: false,
  });
  await respond(topicPage([first, closed], 'first-page'));
  const original = directory.getByRole('link', { name: first.title });
  const closedLink = directory.getByRole('link', { name: closed.title });
  assert.equal(original.getAttribute('href'), `/loom/area/${first.resource_id}`);
  assert.equal(closedLink.getAttribute('href'), `/loom/area/${closed.resource_id}`);
  const preview = directory.getByText((text) => text.startsWith(opening));
  assert.ok(preview.textContent?.endsWith('…'));
  assert.ok(!preview.textContent?.includes('The description ends here.'));
  assert.ok(directory.getByText('Closed to contributions'));
  const more = directory.getByRole('button', { name: 'Load more topics' });
  assert.ok(!directory.queryByRole('heading', { name: 'Root topics' }));
  const beforeAppend = calls.length;
  more.focus();
  await act(async () => {
    fireEvent.click(more);
    fireEvent.click(more);
  });
  assert.equal(calls.length, beforeAppend + 1);
  const failed = latest().url.href;
  assert.equal(latest().url.searchParams.get('cursor'), 'first-page');
  assert.ok(directory.getByRole('link', { name: first.title }) === original);
  assert.ok(directory.getByText('Loading more topics…'));
  assert.ok(document.activeElement === more);
  await respond(readFailure());
  assert.ok(directory.getByText('More topics could not be loaded.'));
  assert.ok(directory.getByRole('link', { name: closed.title }) === closedLink);
  const retry = directory.getByRole('button', { name: 'Retry loading more topics' });
  assert.ok(retry === more && document.activeElement === retry);
  fireEvent.click(retry);
  assert.equal(latest().url.href, failed);

  const second = topic('Aardvark topic');
  await respond(
    topicPage(
      [{ ...first, title: 'Repeated topic with replacement title' }, second, second],
      'second-page',
    ),
  );
  const secondLink = directory.getByRole('link', { name: second.title });
  assert.deepEqual(
    directory.getAllByRole('link').map((link) => link.textContent),
    [first.title, closed.title, second.title],
  );
  assert.ok(directory.getByRole('link', { name: first.title }) === original);
  const finish = directory.getByRole('button', { name: 'Load more topics' });
  finish.focus();
  fireEvent.click(finish);
  assert.equal(latest().url.searchParams.get('cursor'), 'second-page');
  const third = topic('Last topic');
  await respond(topicPage([third]));
  assert.deepEqual(
    directory.getAllByRole('link').map((link) => link.textContent),
    [first.title, closed.title, second.title, third.title],
  );
  assert.ok(directory.getByRole('link', { name: second.title }) === secondLink);
  assert.ok(!directory.queryByRole('button', { name: /load more|previous|next/i }));
  assert.ok(directory.getByText('All topics loaded.'));
  assert.ok(directory.getByRole('button', { name: 'Reload topics' }));
  assert.ok(screen.getByRole('region', { name: 'Root topics' }).contains(document.activeElement));
});

test('completion leaves focus and selection in a nearby editor after the reader moves on', async (t) => {
  const { respond } = holdReads(t);
  mountTopics(<textarea aria-label="Nearby editor" defaultValue="Unfinished draft" />);
  await act(async () => {});
  const directory = rootTopics();
  await respond(topicPage([topic('First topic')], 'pending'));
  const button = directory.getByRole('button', { name: 'Load more topics' });
  button.focus();
  fireEvent.click(button);
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Nearby editor' });
  editor.focus();
  editor.setSelectionRange(1, 8);
  await respond(topicPage([topic('Final topic')]));
  assert.ok(document.activeElement === editor);
  assert.deepEqual(
    [editor.value, editor.selectionStart, editor.selectionEnd],
    ['Unfinished draft', 1, 8],
  );
  assert.ok(directory.getByText('All topics loaded.'));
});

test('initial retry and empty incomplete pages keep continuation until true exhaustion', async (t) => {
  const { calls, latest, respond } = holdReads(t);
  mountTopics();
  await act(async () => {});
  const directory = rootTopics();
  const initial = latest().url.href;
  await respond(readFailure());
  assert.ok(directory.getByText('Topics could not be loaded.'));
  fireEvent.click(directory.getByRole('button', { name: 'Retry topics' }));
  assert.equal(latest().url.href, initial);
  const requestCount = calls.length;
  await respond(topicPage([], 'filtered-first'));
  assert.equal(calls.length, requestCount);
  assert.ok(!directory.queryByText('No topics here yet.'));
  assert.ok(!directory.queryByText('All topics loaded.'));
  fireEvent.click(directory.getByRole('button', { name: 'Load more topics' }));
  assert.equal(latest().url.searchParams.get('cursor'), 'filtered-first');
  await respond(topicPage([]));
  assert.equal(directory.queryAllByRole('link').length, 0);
  assert.ok(directory.getByText('No topics here yet.'));
  assert.ok(!directory.queryByRole('button', { name: 'Load more topics' }));
});

test('an invalid cursor and failed reload keep the authorized traversal until fresh acceptance', async (t) => {
  const { calls, latest, respond } = holdReads(t);
  mountTopics();
  await act(async () => {});
  const directory = rootTopics();
  const initial = latest().url.href;
  await respond(topicPage([topic('Previously accepted topic')], 'stale-continuation'));
  const first = directory.getByRole('link', { name: 'Previously accepted topic' });
  const continuation = directory.getByRole('button', { name: 'Load more topics' });
  continuation.focus();
  fireEvent.click(continuation);
  const requestCount = calls.length;
  await respond(readFailure(400, 'invalid_cursor'));
  assert.equal(calls.length, requestCount);
  assert.ok(directory.getByText('This list needs refreshing before more topics can be loaded.'));
  assert.ok(!directory.queryByRole('button', { name: 'Retry loading more topics' }));
  assert.ok(directory.getByRole('link', { name: 'Previously accepted topic' }) === first);

  const reload = directory.getByRole('button', { name: 'Reload topics' });
  assert.ok(document.activeElement === reload);
  fireEvent.click(reload);
  assert.equal(latest().url.href, initial);
  assert.ok(directory.getByRole('link', { name: 'Previously accepted topic' }) === first);
  await respond(readFailure());
  assert.ok(directory.getByText('Topics could not be reloaded.'));
  assert.ok(directory.getByRole('link', { name: 'Previously accepted topic' }) === first);
  fireEvent.click(directory.getByRole('button', { name: 'Retry reloading topics' }));
  assert.equal(latest().url.href, initial);

  const fresh = topic('Fresh traversal', { hierarchy_version: 2 });
  await respond(topicPage([fresh], 'fresh-continuation', { hierarchy_version: 2 }));
  assert.deepEqual(
    directory.getAllByRole('link').map((link) => link.textContent),
    [fresh.title],
  );
  fireEvent.click(directory.getByRole('button', { name: 'Load more topics' }));
  assert.equal(latest().url.searchParams.get('cursor'), 'fresh-continuation');
});

for (const [failure, response] of Object.entries({
  'a repeated continuation': () => topicPage([topic('Unaccepted row')], 'first-cursor'),
  'an earlier continuation': () => topicPage([topic('Unaccepted row')], 'earlier-cursor'),
  'an inconsistent completion flag': () =>
    topicPage([topic('Unaccepted row')], null, { complete: false }),
  'a continuation on a complete page': () =>
    topicPage([topic('Unaccepted row')], 'after-completion', { complete: true }),
  'an empty continuation': () => topicPage([topic('Unaccepted row')], ''),
  'a different directory scope': () =>
    topicPage([topic('Unaccepted row')], null, { scope: 'destinations:root' }),
  'a different hierarchy version': () =>
    topicPage([topic('Unaccepted row', { hierarchy_version: 2 })], null, { hierarchy_version: 2 }),
  'a row from a different hierarchy version': () =>
    topicPage([topic('Unaccepted row', { hierarchy_version: 2 })]),
  'a row with a different parent': () =>
    topicPage([topic('Unaccepted row', { parent_id: randomUUID() })]),
  'a non-topic row': () => topicPage([topic('Unaccepted row', { kind: 'discussion' })]),
})) {
  test(`append refuses ${failure} and offers a fresh traversal`, async (t) => {
    const { calls, respond } = holdReads(t);
    mountTopics();
    await act(async () => {});
    const directory = rootTopics();
    await respond(topicPage([topic('Accepted topic')], 'earlier-cursor'));
    fireEvent.click(directory.getByRole('button', { name: 'Load more topics' }));
    await respond(topicPage([], 'first-cursor'));
    fireEvent.click(directory.getByRole('button', { name: 'Load more topics' }));
    const requestCount = calls.length;
    await respond(response());
    assert.equal(calls.length, requestCount);
    assert.ok(!directory.queryByRole('link', { name: 'Unaccepted row' }));
    assert.ok(directory.getByRole('link', { name: 'Accepted topic' }));
    assert.ok(!directory.queryByRole('button', { name: 'Load more topics' }));
    assert.ok(directory.getByRole('button', { name: 'Reload topics' }));
  });
}

test('explicit reload supersedes a pending continuation without letting it restore old rows', async (t) => {
  const { latest, respond } = holdReads(t);
  mountTopics();
  await act(async () => {});
  const directory = rootTopics();
  await respond(topicPage([topic('Old traversal')], 'pending'));
  fireEvent.click(directory.getByRole('button', { name: 'Load more topics' }));
  const held = latest();
  fireEvent.click(directory.getByRole('button', { name: 'Reload topics' }));
  assert.equal(latest().url.searchParams.has('cursor'), false);
  assert.equal(held.signal.aborted, true);
  await respond(
    topicPage([topic('Current traversal', { hierarchy_version: 2 })], null, {
      hierarchy_version: 2,
    }),
  );
  await respond(topicPage([topic('Late old continuation')]), held);
  assert.deepEqual(
    directory.getAllByRole('link').map((link) => link.textContent),
    ['Current traversal'],
  );
});

test('changing parents discards the previous rows and fences held child responses', async (t) => {
  const { latest, respond } = holdReads(t);
  const otherParent = randomUUID();
  const firstParent = randomUUID();
  const renderParent = (parent: string) => (
    <StrictMode>
      <MemoryRouter>
        <AuthorizationBoundary>
          <TopicDirectory parent={parent} />
        </AuthorizationBoundary>
      </MemoryRouter>
    </StrictMode>
  );
  const view = render(renderParent(firstParent));
  await act(async () => {});
  const directory = () => within(screen.getByRole('region', { name: 'Subtopics' }));
  assert.equal(latest().url.searchParams.get('parent_id'), firstParent);
  await respond(
    topicPage([topic('First parent child', { parent_id: firstParent })], 'pending', {
      scope: `children:${firstParent}`,
    }),
  );
  fireEvent.click(directory().getByRole('button', { name: 'Load more subtopics' }));
  const held = latest();
  view.rerender(renderParent(otherParent));
  await act(async () => {});
  assert.ok(!directory().queryByRole('link', { name: 'First parent child' }));
  assert.equal(held.signal.aborted, true);
  assert.equal(latest().url.searchParams.get('parent_id'), otherParent);
  assert.equal(latest().url.searchParams.has('cursor'), false);
  await respond(
    topicPage([topic('Current parent child', { parent_id: otherParent })], null, {
      scope: `children:${otherParent}`,
    }),
  );
  await respond(
    topicPage([topic('Late first parent child', { parent_id: firstParent })], null, {
      scope: `children:${firstParent}`,
    }),
    held,
  );
  assert.deepEqual(
    directory()
      .getAllByRole('link')
      .map((link) => link.textContent),
    ['Current parent child'],
  );
  fireEvent.click(directory().getByRole('button', { name: 'Reload subtopics' }));
  await respond(topicPage([], null, { scope: `children:${otherParent}` }));
  assert.ok(directory().getByText('No subtopics yet.'));
});

test('independent source denial withdraws retained rows and fences an outstanding append', async (t) => {
  const { latest, respond } = holdReads(t);
  function CheckAccess() {
    const authority = useAuthorization();
    return (
      <button
        onClick={() =>
          void authority.read(`/api/v1/organization/resources/${randomUUID()}`).catch(() => {})
        }
      >
        Check organization access
      </button>
    );
  }
  mountTopics(
    <AuthorizationBoundary>
      <CheckAccess />
    </AuthorizationBoundary>,
  );
  await act(async () => {});
  await respond(topicPage([topic('Authorized until withdrawal')], 'pending'));
  fireEvent.click(rootTopics().getByRole('button', { name: 'Load more topics' }));
  const held = latest();
  fireEvent.click(screen.getByRole('button', { name: 'Check organization access' }));
  await respond(readFailure(404, 'unavailable'));
  assert.ok(screen.getAllByText(/protected view was withdrawn/i).length >= 1);
  assert.equal(screen.queryAllByRole('link').length, 0);
  await respond(topicPage([topic('Late withdrawn topic')]), held);
  assert.equal(screen.queryAllByRole('link').length, 0);
});

test('identity invalidation removes loaded rows before a late successor settles', async (t) => {
  const { latest, respond } = holdReads(t);
  mountTopics();
  await act(async () => {});
  await respond(topicPage([topic('Current account topic')], 'pending'));
  fireEvent.click(rootTopics().getByRole('button', { name: 'Load more topics' }));
  const held = latest();
  await act(async () => invalidateIdentity());
  assert.ok(screen.getByText(/protected view was withdrawn/i));
  assert.equal(screen.queryAllByRole('link').length, 0);
  await respond(topicPage([topic('Old account continuation')]), held);
  assert.equal(screen.queryAllByRole('link').length, 0);
});
