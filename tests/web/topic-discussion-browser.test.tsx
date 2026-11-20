import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createRef, StrictMode, type Ref } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import type { PageView, ResourceView } from '../../src/contracts/participation.js';
import {
  topicFreshnessContract,
  type TopicFreshnessView,
} from '../../src/contracts/topic-discussion-freshness.js';
import { AuthorizationBoundary, useAuthorization } from '../../src/web/AuthorizationBoundary.js';
import { invalidateIdentity } from '../../src/web/participation-client.js';
import {
  TopicDiscussionBrowser,
  watchTopicDiscussionInteraction,
  type TopicDiscussionBrowserHandle,
} from '../../src/web/TopicDiscussionBrowser.js';
import type { TopicDiscussionPosition } from '../../src/web/topic-discussion-navigation.js';

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
  'Event',
  'CustomEvent',
] as const)
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});
const { render, screen, fireEvent, cleanup, act } = await import('@testing-library/react');
async function mount(...options: Parameters<typeof render>) {
  const view = render(...options);
  await act(async () => {});
  return view;
}
afterEach(() => {
  cleanup();
  invalidateIdentity();
});

const topic = randomUUID(),
  otherTopic = randomUUID();
const self = {
  participant_id: randomUUID(),
  credential_id: randomUUID(),
  nickname: 'Test reader',
  kind: 'human',
  role: 'participant',
  csrf: 'test-token',
};
const openingTime = '2026-11-14T12:00:00.012345Z';
function row(title: string, area = topic): ResourceView & { discussion_id: string } {
  const revision = randomUUID(),
    resource = randomUUID();
  return {
    resource_id: resource,
    kind: 'contribution',
    title,
    revision_id: revision,
    revision_number: '2',
    author: { id: randomUUID(), nickname: 'Original-author', kind: 'agent' },
    publisher: { id: randomUUID(), nickname: 'An-editor', kind: 'human' },
    created_at: '2026-11-15T00:00:00.000Z',
    discussion_created_at: openingTime,
    discussion_observation_tags: Array.from({ length: 2 }, () =>
      randomBytes(32).toString('base64url'),
    ),
    area_id: area,
    area_title: 'Synthetic topic',
    discussion_id: randomUUID(),
    parent_id: null,
    can_edit: false,
    publication_open: false,
    full_content_url: `/api/v1/resources/${resource}/revisions/${revision}`,
  };
}

function page(items: PageView['items'], next: string | null = null, area = topic) {
  return Response.json({
    items,
    scope: area,
    representation: 'metadata',
    omitted_detail: 'bodies',
    next_cursor: next,
    complete: next === null,
    work_budget_reached: items.length === 0 && next !== null,
    limit: 12,
    max_response_bytes: 65_536,
  } satisfies PageView);
}

const fail = (status = 503, code = 'service_unavailable') =>
  Response.json({ error: { code, message: 'Synthetic fixture refusal' } }, { status });

function freshness(
  cursor: string,
  change: TopicFreshnessView['change'] = 'none',
  tags: string[] = [],
) {
  return Response.json({
    contract: topicFreshnessContract,
    cursor,
    complete: true,
    scanned: 0,
    visibility_scanned: 0,
    change,
    withdrawn_tags: tags,
  } satisfies TopicFreshnessView);
}

function fixture(t: TestContext, manualFreshness = false) {
  type Call = {
    url: URL;
    signal: AbortSignal;
    body: { action?: string; cursor?: string; displayed?: unknown[] };
    respond: (response: Response) => void;
  };
  const calls: Call[] = [],
    checks: Call[] = [];
  const scroll: (ScrollIntoViewOptions | ScrollToOptions | undefined)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (path: string, options: RequestInit) =>
      new Promise<Response>((respond) => {
        const url = new URL(path, location.origin);
        const isCheck = url.pathname.endsWith('/freshness');
        const body = options.body ? JSON.parse(String(options.body)) : {};
        (isCheck ? checks : calls).push({ url, signal: options.signal!, body, respond });
        if (isCheck && !manualFreshness) respond(freshness('test-baseline'));
      }),
  );
  t.mock.method(window, 'scrollBy', (options: ScrollToOptions) => scroll.push(options));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: (options: ScrollIntoViewOptions) => scroll.push(options),
    configurable: true,
  });
  t.after(() => Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'));
  return {
    calls,
    checks,
    scroll,
    async respond(index: number, response: Response) {
      if (!calls[index]) await act(async () => {});
      assert.ok(calls[index], `expected request ${index + 1}`);
      await act(async () => calls[index]!.respond(response));
    },
    async observe(index: number, response: Response) {
      assert.ok(checks[index], `expected observation ${index + 1}`);
      await act(async () => checks[index]!.respond(response));
    },
  };
}

const control = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const titles = () => screen.queryAllByRole<HTMLAnchorElement>('link');

function Viewer({
  area = topic,
  instance = 'first',
  position,
  remember,
  positionRef,
}: {
  area?: string;
  instance?: string;
  position?: TopicDiscussionPosition;
  remember?: (position: TopicDiscussionPosition) => void;
  positionRef?: Ref<TopicDiscussionBrowserHandle> | undefined;
}) {
  return (
    <MemoryRouter>
      <textarea aria-label="Draft" defaultValue="Unfinished original thought" />
      <AuthorizationBoundary key={instance} scope={'topic:' + area}>
        <TopicDiscussionBrowser
          topicId={area}
          self={self}
          restoration={position}
          rememberPosition={remember}
          positionRef={positionRef}
        />
      </AuthorizationBoundary>
    </MemoryRouter>
  );
}

test('empty incomplete pages, exact-cursor retry and duplicate rows preserve loaded position and focus', async (t) => {
  const { calls, respond } = fixture(t);
  await mount(<Viewer />);
  assert.ok(screen.getByText('Loading discussions…'));
  assert.equal(calls[0]?.url.search, '?order=created_desc&observe=1');
  await respond(0, fail());
  assert.ok(screen.getByText('Discussions could not be loaded.'));
  fireEvent.click(control('Retry'));
  await respond(1, page([], 'filtered'));
  assert.ok(screen.getByText('More discussions may be available.'));
  assert.equal(screen.queryByText('No discussions yet.'), null);
  fireEvent.click(control('Load more discussions'));
  const opening = row('A sketch for the commons');
  await respond(2, page([opening], 'older'));
  const first = screen.getByRole('link', { name: opening.title! });
  assert.equal(first.getAttribute('href'), `/loom/discussion/${opening.discussion_id}`);
  assert.equal(first.querySelector('time')?.dateTime, openingTime);
  assert.ok(screen.getByText(opening.author.nickname));
  assert.ok(screen.getByText('Agent'));
  assert.equal(screen.queryByText(opening.publisher.nickname), null);
  assert.ok(screen.getByText('1 discussion loaded'));

  const more = control('Load more discussions');
  more.focus();
  fireEvent.click(more);
  fireEvent.click(more);
  assert.equal(calls.length, 4);
  assert.ok(screen.getByText('Loading more discussions…'));
  await respond(3, fail());
  assert.equal(titles()[0], first);
  assert.equal(control('Retry'), more);
  assert.equal(document.activeElement, more);
  fireEvent.click(more);
  assert.equal(calls[3]?.url.search, calls[4]?.url.search);
  const draft = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Draft' });
  draft.focus();
  draft.setSelectionRange(2, 12);
  await respond(
    4,
    page([{ ...opening, title: 'Stale repeat' }, row('An earlier sketch')], 'oldest'),
  );
  assert.deepEqual(
    titles().map((element) => element.textContent?.includes('A sketch for the commons')),
    [true, false],
  );
  assert.equal(titles()[0], first);
  assert.equal(document.activeElement, draft);
  assert.equal(draft.value, 'Unfinished original thought');
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [2, 12]);

  more.focus();
  fireEvent.click(more);
  await respond(5, page([row('The earliest sketch')]));
  assert.equal(titles()[0], first);
  assert.equal(titles().length, 3);
  assert.equal(document.activeElement, screen.getByText('End of discussions.'));
});

test('an invalid continuation and failed latest request retain authorized rows until an explicit restart succeeds', async (t) => {
  const { calls, respond, scroll } = fixture(t);
  await mount(<Viewer />);
  await respond(0, page([row('Retained topic row')], 'before-move'));
  const retained = titles()[0];
  fireEvent.click(control('Load more discussions'));
  await respond(1, fail(400, 'invalid_cursor'));
  assert.ok(
    screen.getByText('This discussion list changed. Show the latest discussions to continue.'),
  );
  fireEvent.click(control('Restart from latest'));
  await act(async () => {});
  assert.equal(calls[2]?.url.search, '?order=created_desc&observe=1');
  assert.equal(titles()[0], retained);
  await respond(2, fail());
  assert.equal(titles()[0], retained);
  assert.ok(
    screen.getByText(
      'The latest discussions could not be loaded. Try Show latest discussions again.',
    ),
  );
  assert.equal(screen.queryByRole('button', { name: 'Load more discussions' }), null);
  const restart = control('Restart from latest');
  restart.focus();
  fireEvent.click(restart);
  await respond(3, page([]));
  assert.ok(screen.getByText('No discussions yet.'));
  assert.deepEqual(titles(), []);
  assert.equal(document.activeElement?.textContent, 'Show latest discussions');
  assert.deepEqual(scroll, [{ block: 'start', behavior: 'instant' }]);
});

test('non-progressing continuations recover through a fresh listing', async (t) => {
  const { respond } = fixture(t);
  await mount(<Viewer />);
  await respond(0, page([row('Current row')], 'loop'));
  fireEvent.click(control('Load more discussions'));
  await respond(1, page([row('Ambiguous result')], 'loop'));
  assert.equal(screen.queryByRole('link', { name: 'Ambiguous result' }), null);
  assert.ok(screen.getByRole('link', { name: 'Current row' }));
  assert.ok(control('Restart from latest'));
});

test('an observed page without row withdrawal evidence leaves the prior traversal usable', async (t) => {
  const { calls, respond } = fixture(t);
  await mount(<Viewer />);
  await respond(0, page([row('Authorized first discussion')], 'more'));
  const accepted = titles();
  fireEvent.click(control('Load more discussions'));
  const untagged = row('Missing withdrawal evidence');
  delete untagged.discussion_observation_tags;
  await respond(1, page([untagged]));
  assert.deepEqual(titles(), accepted);
  fireEvent.click(control('Retry'));
  assert.equal(calls[2]?.url.searchParams.get('cursor'), 'more');
  await respond(2, page([row('Authorized next discussion')]));
  assert.equal(titles()[0], accepted[0]);
  assert.equal(titles().length, 2);
});

test('ordinary link activation remembers only the loaded extent and the row position', async (t) => {
  const { respond } = fixture(t);
  const remember = t.mock.fn<(position: TopicDiscussionPosition) => void>();
  function CurrentPath() {
    return <output>{useLocation().pathname}</output>;
  }
  await mount(
    <MemoryRouter>
      <AuthorizationBoundary>
        <TopicDiscussionBrowser topicId={topic} self={self} rememberPosition={remember} />
        <CurrentPath />
      </AuthorizationBoundary>
    </MemoryRouter>,
  );
  const opened = row('Discussion for opening');
  const tail = row('Older discussion');
  await respond(0, page([opened], 'more'));
  fireEvent.click(control('Load more discussions'));
  await respond(1, page([tail]));
  const anchor = screen.getByRole<HTMLAnchorElement>('link', { name: opened.title! });
  t.mock.method(anchor, 'getBoundingClientRect', () => new dom.window.DOMRect(0, 127, 400, 60));
  window.addEventListener('click', (event) => event.preventDefault(), { once: true });
  fireEvent.click(anchor, { ctrlKey: true });
  assert.equal(remember.mock.callCount(), 0);
  fireEvent.click(anchor);
  assert.deepEqual(remember.mock.calls[0]?.arguments, [
    {
      pages: 2,
      offset: 127,
      discussionId: opened.discussion_id,
      tailId: tail.discussion_id,
    },
  ]);
  assert.ok(screen.getByText(`/loom/discussion/${opened.discussion_id}`));
});

test('a departure outside the list uses the first visible row and the accepted extent', async (t) => {
  const { calls, respond } = fixture(t);
  const positionRef = createRef<TopicDiscussionBrowserHandle>();
  const recent = row('Above the viewport');
  const visible = row('In the viewport');
  const tail = row('Below the viewport');
  await mount(
    <Viewer
      positionRef={positionRef}
      position={{ discussionId: visible.discussion_id, offset: 130, pages: 5 }}
    />,
  );
  assert.equal(positionRef.current?.captureReturnPosition(), undefined);
  await respond(0, page([recent, visible], 'more'));
  await respond(1, page([tail], 'still-restoring'));
  assert.equal(calls[2]?.url.searchParams.get('cursor'), 'still-restoring');
  const setRowTop = (title: string, top: number) =>
    t.mock.method(
      screen.getByRole('link', { name: title }),
      'getBoundingClientRect',
      () => new dom.window.DOMRect(0, top, 400, 60),
    );
  setRowTop(recent.title!, -20);
  setRowTop(visible.title!, 48);
  setRowTop(tail.title!, window.innerHeight + 20);
  assert.deepEqual(positionRef.current?.captureReturnPosition(), {
    discussionId: visible.discussion_id,
    offset: 48,
    pages: 2,
    tailId: tail.discussion_id,
  });
});

test('a departure with no visible discussion revalidates the extent and returns to the list controls', async (t) => {
  const { calls, respond, scroll } = fixture(t);
  const positionRef = createRef<TopicDiscussionBrowserHandle>();
  const previous = await mount(<Viewer positionRef={positionRef} />);
  await respond(0, page([], 'filtered-first'));
  fireEvent.click(control('Load more discussions'));
  await respond(1, page([], 'filtered-second'));
  const position = positionRef.current?.captureReturnPosition();
  assert.ok(position);
  previous.unmount();

  await mount(<Viewer position={position} />);
  const available = row('Currently readable discussion');
  await respond(2, page([available], 'fresh-continuation'));
  assert.equal(calls[2]?.url.searchParams.get('cursor'), null);
  assert.equal(calls[3]?.url.searchParams.get('cursor'), 'fresh-continuation');
  await respond(3, page([], 'more-current'));
  assert.ok(screen.getByRole('link', { name: available.title! }));
  assert.equal(document.activeElement, control('Show latest discussions'));
  assert.deepEqual(scroll, [{ block: 'start', behavior: 'instant' }]);
});

test('returning uses eight fresh pages, with explicit continuation and one anchor focus', async (t) => {
  const { calls, respond, scroll } = fixture(t);
  const anchor = row('Later discussion');
  const tail = row('Previously loaded tail');
  await mount(
    <Viewer
      position={{
        discussionId: anchor.discussion_id,
        offset: 142,
        pages: 9,
        tailId: tail.discussion_id,
      }}
    />,
  );
  t.mock.method(
    HTMLElement.prototype,
    'getBoundingClientRect',
    () => new dom.window.DOMRect(0, 260, 400, 60),
  );
  for (let index = 0; index < 8; index++) {
    assert.equal(
      calls[index]?.url.searchParams.get('cursor'),
      index === 0 ? null : `current-${index}`,
    );
    await respond(
      index,
      page(index === 1 ? [] : [row(`Current discussion ${index + 1}`)], `current-${index + 1}`),
    );
  }
  assert.equal(calls.length, 8);
  assert.deepEqual(scroll, [{ block: 'start', behavior: 'instant' }]);
  assert.equal(
    document.activeElement,
    screen.getByText('Your previous place hasn’t been fully restored.'),
  );
  fireEvent.click(control('Continue restoring discussions'));
  await respond(8, fail());
  assert.equal(titles().length, 7);
  fireEvent.click(control('Retry restoring discussions'));
  assert.equal(calls[8]?.url.search, calls[9]?.url.search);
  await respond(9, page([anchor, tail]));
  assert.equal(document.activeElement, screen.getByRole('link', { name: anchor.title! }));
  assert.deepEqual(scroll.at(-1), { top: 118, behavior: 'instant' });
  assert.equal(titles().length, 9);
});

test('reader interaction wins over held restoration and extent can be re-established explicitly', async (t) => {
  const { calls, respond, scroll } = fixture(t);
  const opened = row('Remembered anchor'),
    tail = row('Remembered tail');
  await mount(
    <Viewer
      position={{
        discussionId: opened.discussion_id,
        offset: 80,
        pages: 2,
        tailId: tail.discussion_id,
      }}
    />,
  );
  await respond(0, page([opened], 'delayed'));
  const draft = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Draft' });
  fireEvent.pointerDown(draft);
  draft.focus();
  await respond(1, page([row('A current replacement')], 'continue'));
  assert.equal(calls.length, 2);
  assert.equal(document.activeElement, draft);
  assert.deepEqual(scroll, []);
  fireEvent.click(control('Continue restoring discussions'));
  await respond(2, page([tail]));
  assert.equal(document.activeElement, screen.getByRole('link', { name: opened.title! }));
});

test('a vanished anchor leaves an explicit fallback after authorized pages finish', async (t) => {
  const { respond, scroll } = fixture(t);
  await mount(<Viewer position={{ discussionId: randomUUID(), offset: 200, pages: 2 }} />);
  await respond(0, page([row('Currently available')]));
  assert.ok(screen.getByRole('link', { name: 'Currently available' }));
  assert.equal(
    document.activeElement,
    screen.getByText('Your previous discussion is no longer in this list.'),
  );
  assert.deepEqual(scroll, [{ block: 'start', behavior: 'instant' }]);
  assert.equal(screen.queryByRole('button', { name: 'Continue restoring discussions' }), null);
});

test('the early interaction witness fires once and releases all input listeners', () => {
  let interruptions = 0;
  const witness = watchTopicDiscussionInteraction(() => {
    interruptions++;
  });
  assert.equal(witness.interrupted(), false);
  window.dispatchEvent(new Event('wheel'));
  window.dispatchEvent(new Event('keydown'));
  assert.equal(witness.interrupted(), true);
  assert.equal(interruptions, 1);
  const disposed = watchTopicDiscussionInteraction(() => {
    interruptions++;
  });
  disposed.stop();
  window.dispatchEvent(new Event('touchstart'));
  assert.equal(disposed.interrupted(), false);
  assert.equal(interruptions, 1);
});

test('a superseded topic or instance ignores late responses, including StrictMode’s first attempt', async (t) => {
  const { calls, checks, respond } = fixture(t);
  const mounted = await mount(
    <StrictMode>
      <Viewer />
    </StrictMode>,
  );
  assert.equal(checks[0]?.signal.aborted, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(titles(), []);
  await respond(0, page([row('First topic')], 'old-topic'));
  fireEvent.click(control('Load more discussions'));
  mounted.rerender(
    <StrictMode>
      <Viewer area={otherTopic} />
    </StrictMode>,
  );
  assert.equal(calls[1]?.signal.aborted, true);
  await respond(2, page([row('Current topic', otherTopic)], 'old-instance', otherTopic));
  await respond(1, page([row('Late first topic')]));
  assert.equal(titles().length, 1);
  assert.ok(screen.getByRole('link', { name: 'Current topic' }));
  fireEvent.click(control('Load more discussions'));
  mounted.rerender(
    <StrictMode>
      <Viewer area={otherTopic} instance="next" />
    </StrictMode>,
  );
  await respond(4, page([row('Current instance', otherTopic)], null, otherTopic));
  await respond(3, page([row('Late old instance', otherTopic)], null, otherTopic));
  assert.ok(screen.getByRole('link', { name: 'Current instance' }));
  assert.equal(titles().length, 1);
});

test('a same-owner source denial withdraws visible rows and fences an outstanding append', async (t) => {
  const { respond } = fixture(t);
  function IndependentRead() {
    const authority = useAuthorization();
    return (
      <button
        onClick={() => void authority.read(`/api/v1/areas/${otherTopic}/artifacts`).catch(() => {})}
      >
        Check access
      </button>
    );
  }
  await mount(
    <>
      <Viewer />
      <AuthorizationBoundary>
        <IndependentRead />
      </AuthorizationBoundary>
    </>,
  );
  await respond(0, page([row('Previously authorized')], 'delayed'));
  fireEvent.click(control('Load more discussions'));
  fireEvent.click(control('Check access'));
  await respond(2, fail(404, 'unavailable'));
  assert.equal(screen.getAllByText(/protected view was withdrawn/).length, 2);
  assert.deepEqual(titles(), []);
  await respond(1, page([row('Late withdrawn row')]));
  assert.deepEqual(titles(), []);
});

test('identity invalidation fences an outstanding listing', async (t) => {
  const { respond } = fixture(t);
  await mount(<Viewer />);
  await act(async () => invalidateIdentity());
  await respond(0, page([row('Old account row')]));
  assert.ok(screen.getByText(/protected view was withdrawn/));
  assert.deepEqual(titles(), []);
});

function visiblePolling(t: TestContext, hidden = () => false) {
  t.mock.getter(document, 'hidden', hidden);
  let now = performance.now();
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return async (delay = 15000) =>
    act(async () => {
      now += delay;
      t.mock.timers.tick(delay);
    });
}

test('background activity preserves the accepted traversal and an applied list observes from its earlier baseline', async (t) => {
  const tick = visiblePolling(t);
  const { calls, checks, observe, respond, scroll } = fixture(t, true);
  await mount(<Viewer />);
  assert.deepEqual(checks[0]?.body, { action: 'baseline' });
  assert.equal(calls.length, 0);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([row('Accepted first discussion')], 'initial-older'));
  fireEvent.click(control('Load more discussions'));
  await respond(1, page([row('Accepted earlier discussion')], 'initial-remaining'));
  const accepted = titles();
  const draft = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Draft' });
  draft.focus();
  draft.setSelectionRange(3, 8);

  await tick();
  assert.deepEqual(checks[1]?.body, { action: 'check', cursor: 'initial-boundary' });
  await observe(1, freshness('already-detected', 'new_discussions'));
  const updates = screen.getByRole('status', { name: 'Discussion list updates' });
  assert.equal(updates.textContent, 'New discussions available');
  assert.deepEqual(titles(), accepted);
  assert.equal(document.activeElement, draft);
  assert.deepEqual(
    [draft.value, draft.selectionStart, draft.selectionEnd],
    ['Unfinished original thought', 3, 8],
  );
  assert.deepEqual(scroll, []);

  fireEvent.click(control('Show latest discussions'));
  assert.deepEqual(checks[2]?.body, { action: 'baseline' });
  assert.deepEqual(titles(), accepted);
  await observe(2, freshness('failed-application-boundary'));
  await respond(2, fail());
  assert.equal(updates.textContent, 'New discussions available');
  assert.deepEqual(titles(), accepted);

  await tick();
  fireEvent.click(control('Show latest discussions'));
  await observe(4, freshness('successful-application-boundary'));
  await observe(3, freshness('later-than-application-boundary', 'new_discussions'));
  await respond(3, page([row('Accepted latest discussion')], 'latest-older'));
  assert.equal(updates.textContent, '');
  assert.equal(titles().length, 1);
  assert.equal(screen.getByRole('textbox', { name: 'Draft' }), draft);
  fireEvent.click(control('Load more discussions'));
  assert.equal(calls[4]?.url.searchParams.get('cursor'), 'latest-older');
  await respond(4, page([row('Latest traversal continuation')]));

  await tick();
  assert.deepEqual(checks[5]?.body, { action: 'check', cursor: 'successful-application-boundary' });
  await observe(5, freshness('later-than-application-boundary', 'new_discussions'));
  assert.equal(updates.textContent, 'New discussions available');
});

test('invalid observation retains authorized rows, audits through recovery, and fences a held stale page', async (t) => {
  const tick = visiblePolling(t);
  const { calls, checks, observe, respond } = fixture(t, true);
  const formerlyAuthorized = {
    ...row('Previously authorized'),
    discussion_observation_tags: ['a'.repeat(43), 'b'.repeat(43)] as [string, string],
  };
  const newlyTagged = {
    ...formerlyAuthorized,
    discussion_observation_tags: ['c'.repeat(43), 'd'.repeat(43)] as [string, string],
  };
  await mount(<Viewer />);
  await observe(0, freshness('before-recovery'));
  await respond(0, page([formerlyAuthorized], 'old-cursor'));
  const originalRow = titles()[0];

  await tick();
  await observe(1, fail(400, 'invalid_cursor'));
  const updates = screen.getByRole('status', { name: 'Discussion list updates' });
  assert.equal(updates.textContent, 'Discussions updated');
  assert.equal(titles()[0], originalRow);

  await tick();
  assert.deepEqual(checks[2]?.body, { action: 'baseline' });
  await observe(2, freshness('after-recovery'));
  await tick();
  assert.deepEqual(checks[3]?.body, {
    action: 'audit',
    displayed: [
      { resource_id: formerlyAuthorized.resource_id, revision_id: formerlyAuthorized.revision_id },
    ],
  });
  await observe(
    3,
    Response.json({ unavailable: [], tags: [newlyTagged.discussion_observation_tags] }),
  );
  assert.equal(titles()[0], originalRow);
  fireEvent.click(control('Load more discussions'));
  assert.equal(calls[1]?.url.searchParams.get('cursor'), 'old-cursor');

  await tick();
  assert.deepEqual(checks[4]?.body, { action: 'check', cursor: 'after-recovery' });
  await observe(
    4,
    freshness('after-withdrawal', 'none', [newlyTagged.discussion_observation_tags[0]]),
  );
  assert.deepEqual(titles(), []);
  await respond(1, page([newlyTagged, row('Still authorized')]));
  assert.equal(titles().length, 1);
  assert.ok(screen.getByRole('link', { name: 'Still authorized' }));
  assert.equal(updates.textContent, 'Discussions updated');
  assert.ok(screen.getByRole('textbox', { name: 'Draft' }));
});

test('a new page accepts a restored row after a withdrawal during baseline preparation', async (t) => {
  const tick = visiblePolling(t);
  const { calls, checks, observe, respond } = fixture(t, true);
  const restored = row('Restored discussion');
  await mount(<Viewer />);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([restored]));

  await tick();
  fireEvent.click(control('Show latest discussions'));
  assert.deepEqual(checks[2]?.body, { action: 'baseline' });
  assert.equal(calls.length, 1);
  await observe(
    1,
    freshness('after-withdrawal', 'updated', [restored.discussion_observation_tags![0]!]),
  );
  assert.deepEqual(titles(), []);

  await observe(2, freshness('after-restoration'));
  await respond(1, page([restored]));
  assert.ok(screen.getByRole('link', { name: 'Restored discussion' }));
});

test('a complete empty list describes its displayed rows while updates are pending', async (t) => {
  const tick = visiblePolling(t);
  const { observe, respond } = fixture(t, true);
  await mount(<Viewer />);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([]));
  assert.ok(screen.getByText('No discussions yet.'));

  const footer = screen.getByRole('status', { name: '' });
  await tick();
  await observe(1, freshness('after-publication', 'new_discussions'));
  assert.ok(screen.getByText('New discussions available'));
  const afterArrival = footer.textContent;

  const published = row('Newest discussion');
  fireEvent.click(control('Show latest discussions'));
  await observe(2, freshness('applied-boundary'));
  await respond(1, page([published]));
  await tick();
  await observe(
    3,
    freshness('after-withdrawal', 'updated', [published.discussion_observation_tags![0]!]),
  );
  assert.ok(screen.getByText('Discussions updated'));
  assert.deepEqual(titles(), []);
  assert.deepEqual(
    [afterArrival, footer.textContent],
    ['No discussions in this list.', 'No discussions in this list.'],
  );
});

test('a missing baseline leaves the list usable and recovery audits the rows held across the gap', async (t) => {
  const tick = visiblePolling(t);
  const { checks, observe, respond } = fixture(t, true);
  await mount(<Viewer />);
  await observe(0, fail());
  await respond(0, page([row('No longer authorized'), row('Still available')]));
  const retained = screen.getByRole('link', { name: 'Still available' });
  const status = screen.getByRole('status', { name: 'Discussion list updates' });
  assert.match(status.textContent!, /Couldn’t check for updates/);
  assert.equal(titles().length, 2);
  await tick(30000);
  assert.deepEqual(checks[1]?.body, { action: 'baseline' });
  await observe(1, freshness('after-missing-history'));
  assert.equal(status.textContent, 'Discussions updated');
  await tick();
  await observe(
    2,
    Response.json({ unavailable: [0], tags: [null, ['c'.repeat(43), 'd'.repeat(43)]] }),
  );
  assert.deepEqual(titles(), [retained]);
  assert.equal(status.textContent, 'Discussions updated');
});

const throttled = () =>
  Response.json(
    { error: { code: 'rate_limited', message: 'Wait' } },
    { status: 429, headers: { 'Retry-After': '42' } },
  );

test('baseline throttling delays a previously scheduled background check', async (t) => {
  const tick = visiblePolling(t);
  const { checks, observe, respond } = fixture(t, true);
  await mount(<Viewer />);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([row('Accepted rows')]));

  await tick(14000);
  fireEvent.click(control('Show latest discussions'));
  await observe(1, throttled());
  await respond(1, fail());
  await tick(1000);
  assert.equal(checks.length, 2);
  await tick(40000);
  assert.equal(checks.length, 2);
  await tick(1000);
  assert.deepEqual(checks[2]?.body, { action: 'check', cursor: 'initial-boundary' });
});

test('an older successful check retains the newer baseline failure and retry deadline', async (t) => {
  const tick = visiblePolling(t);
  const { checks, observe, respond } = fixture(t, true);
  await mount(<Viewer />);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([row('Accepted rows')]));

  await tick();
  fireEvent.click(control('Show latest discussions'));
  await observe(2, throttled());
  await respond(1, fail());
  await observe(1, freshness('advanced-boundary'));
  const status = screen.getByRole('status', { name: 'Discussion list updates' });
  assert.match(status.textContent!, /Couldn’t check for updates/);
  await tick(41000);
  assert.equal(checks.length, 3);
  await tick(1000);
  assert.deepEqual(checks[3]?.body, { action: 'check', cursor: 'advanced-boundary' });
});

test('accepting a fresh list retains a background failure after its baseline', async (t) => {
  const tick = visiblePolling(t);
  const { observe, respond } = fixture(t, true);
  await mount(<Viewer />);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([row('Accepted rows')]));

  fireEvent.click(control('Show latest discussions'));
  await observe(1, freshness('replacement-boundary'));
  await tick();
  await observe(2, throttled());
  await respond(1, page([row('Replacement row')]));
  const status = screen.getByRole('status', { name: 'Discussion list updates' });
  assert.match(status.textContent!, /Couldn’t check for updates/);
  assert.ok(screen.getByRole('link', { name: 'Replacement row' }));
});

test('a superseded check still advises when to retry in the same view', async (t) => {
  const tick = visiblePolling(t);
  const { checks, observe, respond } = fixture(t, true);
  await mount(<Viewer />);
  await observe(0, freshness('initial-boundary'));
  await respond(0, page([row('Accepted rows')]));

  await tick();
  fireEvent.click(control('Show latest discussions'));
  await observe(2, freshness('replacement-boundary'));
  await respond(1, page([row('Replacement row')]));
  await observe(1, throttled());
  window.dispatchEvent(new Event('focus'));
  await tick(41000);
  assert.equal(checks.length, 3);
  await tick(1000);
  assert.deepEqual(checks[3]?.body, { action: 'check', cursor: 'replacement-boundary' });
});

test('polling pauses, coalesces resume, honors Retry-After, and aborts on departure', async (t) => {
  let hidden = false,
    online = true;
  const tick = visiblePolling(t, () => hidden);
  t.mock.getter(navigator, 'onLine', () => online);
  const { checks, observe, respond } = fixture(t, true);
  const view = await mount(<Viewer />);
  await observe(0, freshness('interval-start'));
  await respond(0, page([row('Accepted rows')]));

  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  await tick(60000);
  assert.equal(checks.length, 1);
  hidden = false;
  online = false;
  document.dispatchEvent(new Event('visibilitychange'));
  await tick(60000);
  assert.equal(checks.length, 1);
  online = true;
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  await tick(0);
  assert.equal(checks.length, 2);
  window.dispatchEvent(new Event('focus'));
  await tick(15000);
  assert.equal(checks.length, 2);

  await observe(1, throttled());
  window.dispatchEvent(new Event('focus'));
  await tick(41000);
  assert.equal(checks.length, 2);
  await tick(1000);
  assert.equal(checks.length, 3);
  view.unmount();
  assert.equal(checks[2]?.signal.aborted, true);
  await observe(2, freshness('departed-response', 'new_discussions'));
  await tick(60000);
  assert.equal(checks.length, 3);
});
