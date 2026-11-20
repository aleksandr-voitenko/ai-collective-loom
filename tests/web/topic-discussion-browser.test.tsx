import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createRef, StrictMode, type Ref } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import type { PageView, ResourceView } from '../../src/contracts/participation.js';
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
afterEach(() => {
  cleanup();
  invalidateIdentity();
});

const topic = randomUUID(),
  otherTopic = randomUUID();
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

function fixture(t: TestContext) {
  const calls: { url: URL; signal: AbortSignal; respond: (response: Response) => void }[] = [];
  const scroll: (ScrollIntoViewOptions | ScrollToOptions | undefined)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (path: string, options: RequestInit) =>
      new Promise<Response>((respond) =>
        calls.push({ url: new URL(path, location.origin), signal: options.signal!, respond }),
      ),
  );
  t.mock.method(window, 'scrollBy', (options: ScrollToOptions) => scroll.push(options));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    value: (options: ScrollIntoViewOptions) => scroll.push(options),
    configurable: true,
  });
  t.after(() => Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'));
  return {
    calls,
    scroll,
    async respond(index: number, response: Response) {
      assert.ok(calls[index], `expected request ${index + 1}`);
      await act(async () => calls[index]!.respond(response));
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
  render(<Viewer />);
  assert.ok(screen.getByText('Loading discussions…'));
  assert.equal(calls[0]?.url.search, '?order=created_desc');
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
  render(<Viewer />);
  await respond(0, page([row('Retained topic row')], 'before-move'));
  const retained = titles()[0];
  fireEvent.click(control('Load more discussions'));
  await respond(1, fail(400, 'invalid_cursor'));
  assert.ok(
    screen.getByText('This discussion list changed. Show the latest discussions to continue.'),
  );
  fireEvent.click(control('Restart from latest'));
  assert.equal(calls[2]?.url.search, '?order=created_desc');
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
  render(<Viewer />);
  await respond(0, page([row('Current row')], 'loop'));
  fireEvent.click(control('Load more discussions'));
  await respond(1, page([row('Ambiguous result')], 'loop'));
  assert.equal(screen.queryByRole('link', { name: 'Ambiguous result' }), null);
  assert.ok(screen.getByRole('link', { name: 'Current row' }));
  assert.ok(control('Restart from latest'));
});

test('ordinary link activation remembers only the loaded extent and the row position', async (t) => {
  const { respond } = fixture(t);
  const remember = t.mock.fn<(position: TopicDiscussionPosition) => void>();
  function CurrentPath() {
    return <output>{useLocation().pathname}</output>;
  }
  render(
    <MemoryRouter>
      <AuthorizationBoundary>
        <TopicDiscussionBrowser topicId={topic} rememberPosition={remember} />
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
  render(
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
  const previous = render(<Viewer positionRef={positionRef} />);
  await respond(0, page([], 'filtered-first'));
  fireEvent.click(control('Load more discussions'));
  await respond(1, page([], 'filtered-second'));
  const position = positionRef.current?.captureReturnPosition();
  assert.ok(position);
  previous.unmount();

  render(<Viewer position={position} />);
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
  render(
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
  render(
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
  render(<Viewer position={{ discussionId: randomUUID(), offset: 200, pages: 2 }} />);
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
  const { calls, respond } = fixture(t);
  const mounted = render(
    <StrictMode>
      <Viewer />
    </StrictMode>,
  );
  assert.equal(calls[0]?.signal.aborted, true);
  await respond(0, page([row('Superseded effect')]));
  assert.deepEqual(titles(), []);
  await respond(1, page([row('First topic')], 'old-topic'));
  fireEvent.click(control('Load more discussions'));
  mounted.rerender(
    <StrictMode>
      <Viewer area={otherTopic} />
    </StrictMode>,
  );
  assert.equal(calls[2]?.signal.aborted, true);
  await respond(4, page([row('Current topic', otherTopic)], 'old-instance', otherTopic));
  await respond(2, page([row('Late first topic')]));
  await respond(3, page([row('Late strict mount', otherTopic)], null, otherTopic));
  assert.equal(titles().length, 1);
  assert.ok(screen.getByRole('link', { name: 'Current topic' }));
  fireEvent.click(control('Load more discussions'));
  mounted.rerender(
    <StrictMode>
      <Viewer area={otherTopic} instance="next" />
    </StrictMode>,
  );
  await respond(7, page([row('Current instance', otherTopic)], null, otherTopic));
  await respond(5, page([row('Late old instance', otherTopic)], null, otherTopic));
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
  render(
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
  render(<Viewer />);
  await act(async () => invalidateIdentity());
  await respond(0, page([row('Old account row')]));
  assert.ok(screen.getByText(/protected view was withdrawn/));
  assert.deepEqual(titles(), []);
});
