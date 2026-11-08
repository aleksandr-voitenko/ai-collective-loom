import type { DiscussionNavigationState } from './discussion-navigation.js';
import { AddPrivateNote } from './PrivateNotes.js';
import { FileBrowser } from './Files.js';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useId,
  createContext,
  useContext,
} from 'react';
import { useLocation, Link } from 'react-router';
import {
  type ResourceView,
  type ContributionContextView,
  ContributionContext,
  type PageView,
  Page,
} from '../contracts/participation.js';
import { type Context, useQuery } from './participation-state.js';
import { ApiError } from './participation-client.js';
import type { AuthorizedValue } from './AuthorizationBoundary.js';
import { OrganizationActions } from './Organization.js';
import { ChangeDetails } from './Changes.js';
import { ReferenceViews } from './References.js';
import { MentionedIn } from './DiscussionBacklinks.js';
import { SaveControl } from './SavedItems.js';
import { FollowControl } from './Following.js';
import { AuthorizationBoundary, useAuthorization } from './AuthorizationBoundary.js';
import { ReadingIndicator, ReadingMarkUnread, ReadingText } from './Reading.js';
import { SuppressLink } from './Moderation.js';
import { SummarySection } from './Summaries.js';
import { Avatar, Collection, ErrorText, Icon } from './participation-ui.js';
import { Composer } from './ParticipationComposer.js';
import { EditingIntent } from './EditingIntent.js';

type BranchNavigation =
  DiscussionNavigationState['branches'] extends Map<string, infer V> ? V : never;
const ParentPreviewContext = createContext<((id: string) => void) | null>(null);
const DiscussionNavigation = createContext<Map<string, BranchNavigation> | null>(null);

export function DiscussionPage({ id, context }: { id: string; context: Context }) {
  return (
    <AuthorizationBoundary scope={'discussion:' + id} sourcePolicy="projections">
      <DiscussionContent key={id} id={id} context={context} />
    </AuthorizationBoundary>
  );
}

function DiscussionContent({ id, context }: { id: string; context: Context }) {
  const location = useLocation(),
    focus = new URLSearchParams(location.search).get('focus');
  const { data, error, refresh } = useQuery<{
    id: string;
    area: { id: string; title: string; description: string };
    opening: ResourceView;
    local_open: boolean;
    publication_open: boolean;
  }>('/api/v1/discussions/' + id);
  const [navigationState] = useState<DiscussionNavigationState>(
    () => context.discussionNavigation ?? { branches: new Map() },
  );
  const navigation = useRef(navigationState.branches);
  const [preview, setPreview] = useState<string>();
  const [returnUnavailable, setReturnUnavailable] = useState(false);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const shouldRestore = useRef(!!navigationState.focus && !focus);
  useEffect(() => {
    const position = navigationState.returnPosition;
    navigationState.focus = focus;
    if (!shouldRestore.current || !position) return;
    let focused: HTMLElement | null = null;
    const restore = () => {
      const target = document.querySelector<HTMLElement>(
        `article[data-resource-id="${position.resource}"]`,
      );
      if (!target) {
        if (
          document.querySelector(`[data-resource-id="${position.resource}"][data-loading="true"]`)
        )
          return;
        const trees = [
          ...main.querySelectorAll<HTMLElement>('.conversation-content .comment-tree'),
        ];
        if (
          trees.length &&
          trees.every((tree) => tree.dataset.ready === 'true' && tree.dataset.restoring !== 'true')
        ) {
          setReturnUnavailable(true);
          stop();
        }
        return;
      }
      if (focused !== target) {
        target.focus({ preventScroll: true });
        focused = target;
      }
      window.scrollBy({
        top: target.getBoundingClientRect().top - position.top,
        behavior: 'instant',
      });
    };
    // Fresh sibling bodies can grow after the anchor mounts. Follow that layout
    // until the user's next input; never fight deliberate scrolling or focus.
    const main = document.getElementById('loom-main') ?? document.body;
    const mutations = new MutationObserver(restore),
      resize = new ResizeObserver(restore);
    let frame = 0;
    let frameCount = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      mutations.disconnect();
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
    mutations.observe(main, {
      childList: true,
      attributes: true,
      subtree: true,
      attributeFilter: ['data-ready', 'data-restoring'],
    });
    resize.observe(main);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
      window.addEventListener(event, stop, { once: true, passive: true });
    restore();
    const correctLayout = () => {
      if (stopped || frameCount++ >= 120) return;
      restore();
      if (!stopped) frame = requestAnimationFrame(correctLayout);
    };
    frame = requestAnimationFrame(correctLayout);
    return () => {
      stop();
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
        window.removeEventListener(event, stop);
    };
  }, [focus]);
  const [reload, setReload] = useState(0),
    [summaryReload, setSummaryReload] = useState(0);
  // Retain only the immutable opening identity as a query seed. Every rendered
  // header, body and traversal response has its own current content lease.
  const opening = useRef<string>(undefined);
  if (data) opening.current = data.opening.resource_id;
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry discussion</button>
      </>
    );
  if (!data && !opening.current) return <p role="status">Opening discussion…</p>;
  // Keep the input's UTF-16 length limit without splitting a supplementary character.
  const summaryTitle = ('Summary: ' + data?.opening.title)
    .slice(0, 160)
    .replace(/[\uD800-\uDBFF]$/, '');
  return (
    <DiscussionNavigation.Provider value={navigation.current}>
      <ParentPreviewContext.Provider
        value={(id) => {
          previewTrigger.current = document.activeElement as HTMLElement;
          setPreview(id);
        }}
      >
        {data ? (
          <>
            <div className="breadcrumb">
              <Link to="/loom">Topics</Link>
              <span>›</span>
              <Link to={'/loom/area/' + data.area.id}>{data.area.title}</Link>
            </div>
            <div className="discussion-heading">
              <h1>{data.opening.title}</h1>
              <div className="discussion-actions">
                <SaveControl
                  context={context}
                  target={{ kind: 'discussion', resource_id: id }}
                  label="discussion"
                />
                <FollowControl
                  key={'discussion:' + id}
                  context={context}
                  target={{ kind: 'discussion', resource_id: id }}
                />
                <details className="discussion-details">
                  <summary>Discussion details</summary>
                  <div className="discussion-details-content">
                    <AddPrivateNote target={{ kind: 'discussion', resource_id: id }} />
                    <Link className="button" to={'/loom/resource/' + data.opening.resource_id}>
                      History & details
                    </Link>
                    <ReferenceViews key={id} target={{ kind: 'discussion', resource_id: id }} />
                    {context.self.role === 'administrator' && (
                      <OrganizationActions id={id} kind="discussion" localOpen={data.local_open} />
                    )}
                    <SuppressLink context={context} id={id} kind="discussion" />
                  </div>
                </details>
              </div>
            </div>
            {!data.publication_open && (
              <p className="notice" role="status">
                {data.local_open
                  ? 'This discussion is locally open, but a topic above it is closed to publication.'
                  : 'This discussion is closed to publication.'}{' '}
                Replies, revisions and summaries are paused. Retained content stays readable.
              </p>
            )}
            {data.opening.affected_area_id && (
              <p>
                Organizational suggestion concerning{' '}
                <Link to={'/loom/area/' + data.opening.affected_area_id}>this topic</Link>.
              </p>
            )}
            <SummarySection key={summaryReload} discussion={id} />
            <MentionedIn key={id} discussion={id} />
            {new URLSearchParams(location.search).get('summary') === 'create' && (
              <Composer
                context={context}
                operation={{ kind: 'summary.create', discussionId: id }}
                slot={'summary.create:' + id}
                initialTitle={summaryTitle}
                heading="Create discussion summary"
                onCommitted={() => setSummaryReload((n) => n + 1)}
              />
            )}
          </>
        ) : (
          <div className="notice">
            <p>
              Earlier discussion details were withdrawn. Available replies are checked separately.
            </p>
            <button onClick={refresh}>Refresh discussion</button>
          </div>
        )}
        {preview && (
          <ParentPreview
            key={preview}
            id={preview}
            discussionId={id}
            close={() => {
              setPreview(undefined);
              if (previewTrigger.current?.isConnected) previewTrigger.current.focus();
            }}
          />
        )}
        <div className="reading-grid">
          <div>
            {focus ? (
              <FocusedBranch key={focus} id={focus} discussionId={id} context={context} />
            ) : (
              <div
                className="conversation-content"
                onClickCapture={(event) => {
                  const target = event.target as Element;
                  if (target.closest('a[href*="?focus="]')) {
                    const article =
                      target.closest('[data-resource-id]') ??
                      target.closest('.comment-branch')?.querySelector('[data-resource-id]');
                    if (article)
                      navigationState.returnPosition = {
                        resource: article.getAttribute('data-resource-id')!,
                        top: article.getBoundingClientRect().top,
                      };
                  }
                }}
              >
                <>
                  {returnUnavailable && (
                    <p className="notice" role="status">
                      The earlier reading position is unavailable. Refresh the conversation or
                      choose another branch.
                    </p>
                  )}
                  <Contribution
                    id={opening.current!}
                    context={context}
                    opening
                    onPosted={() => setReload((n) => n + 1)}
                  />
                  <div className="discussion-controls">
                    <h2>
                      Conversation <span>Comments</span>
                    </h2>
                    <span>Oldest first</span>
                  </div>
                  <Children
                    id={opening.current!}
                    parent={data?.opening}
                    discussionId={id}
                    context={context}
                    depth={0}
                    role="comments"
                    refreshVersion={reload}
                  />
                </>
              </div>
            )}
          </div>
          {data && (
            <aside className="right-rail">
              <h3>About this discussion</h3>
              <p>{data.area.description}</p>
              <Link to={'/loom/area/' + data.area.id}>Browse {data.area.title} →</Link>
              <hr />
              <p>
                Every reply keeps its actual parent. Open a branch to follow a deeper conversation.
              </p>
            </aside>
          )}
        </div>
      </ParentPreviewContext.Provider>
    </DiscussionNavigation.Provider>
  );
}

function FocusedBranch({
  id,
  discussionId,
  context,
}: {
  id: string;
  discussionId: string;
  context: Context;
}) {
  const { data, generation, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${id}/context`,
    ContributionContext,
  );
  const [reload, setReload] = useState(0);
  const authority = useAuthorization();
  if (error || (data && data.discussion_id !== discussionId))
    return (
      <div className="notice">
        <p>This branch is unavailable in this discussion.</p>
        <Link to={'/loom/discussion/' + discussionId}>Back to conversation</Link>
        {error && <button onClick={refresh}>Retry branch</button>}
      </div>
    );
  if (!data)
    return (
      <>
        <p role="status">Opening branch…</p>
        <button onClick={refresh}>Refresh branch</button>
      </>
    );
  return (
    <>
      <div className="focus-banner">
        <span>Focused branch</span>
        <Link to={'/loom/discussion/' + discussionId}>Back to conversation</Link>
      </div>
      <AncestorContext id={id} />
      <ContributionBody
        id={id}
        data={data}
        context={context}
        onPosted={() => {
          if (authority.current(generation)) setReload((n) => n + 1);
        }}
      />
      <div className="discussion-controls">
        <h2>
          Conversation <span>Direct replies</span>
        </h2>
        <span>Oldest first</span>
      </div>
      <Children
        id={id}
        parent={'state' in data ? undefined : data}
        discussionId={discussionId}
        context={context}
        depth={0}
        role="replies"
        refreshVersion={reload}
      />
    </>
  );
}

function AncestorContext({ id }: { id: string }) {
  return (
    <details className="ancestors" open>
      <summary>Parent context</summary>
      <Collection
        path={'/api/v1/contributions/' + id + '/ancestors'}
        render={(item) =>
          'state' in item ? (
            <p>Parent unavailable</p>
          ) : (
            <Link
              className="ancestor-row"
              to={
                '/loom/resource/' +
                (item as ResourceView).resource_id +
                '/' +
                (item as ResourceView).revision_id
              }
            >
              {(item as ResourceView).author.nickname} · {(item as ResourceView).title ?? 'Reply'} ·
              r{(item as ResourceView).revision_number}
            </Link>
          )
        }
      />
    </details>
  );
}

type ContributionProps = {
  id: string;
  context: Context;
  opening?: boolean;
  parent?: ResourceView | undefined;
  onPosted?: () => void;
};

function Contribution(props: ContributionProps) {
  const { data, generation, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${props.id}/context`,
    ContributionContext,
  );
  const authority = useAuthorization();
  if (error)
    return (
      <div className="notice">
        <ErrorText error={error} />
        <button onClick={refresh}>Retry contribution</button>
      </div>
    );
  if (!data)
    return (
      <p role="status" data-resource-id={props.id} data-loading="true">
        Loading contribution…
      </p>
    );
  return (
    <ContributionBody
      {...props}
      data={data}
      onPosted={() => {
        if (authority.current(generation)) props.onPosted?.();
      }}
    />
  );
}

function ContributionBody({
  id,
  data,
  context,
  opening = false,
  parent,
  onPosted,
}: ContributionProps & { data: ContributionContextView }) {
  const onPreview = useContext(ParentPreviewContext);
  const [reply, setReply] = useState(() =>
    context.store
      .all()
      .some((record) => record.slot === 'reply:' + id && record.state !== 'committed'),
  );
  const replyButton = useRef<HTMLButtonElement>(null);
  const [focusComposer, setFocusComposer] = useState(false);
  if ('state' in data)
    return (
      <div className="comment notice" data-resource-id={id}>
        <p>Contribution unavailable</p>
      </div>
    );
  return (
    <article className={opening ? 'post card' : 'comment'} data-resource-id={id} tabIndex={-1}>
      <div className="author-line">
        <Avatar person={data.author} />
        <strong>{data.author.nickname}</strong>
        {data.author.kind === 'agent' && <span className="author-badge">Agent</span>}
        <ReadingIndicator target={{ resource_id: id, revision_id: data.revision_id }} />
        <time>
          {new Date(data.created_at).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      {data.parent_id && (
        <p className="parent-context">
          Replying to{' '}
          <Link to={`/loom/discussion/${data.discussion_id}?focus=${data.parent_id}`}>
            {parent?.resource_id === data.parent_id
              ? '@' + parent.author.nickname
              : 'parent message'}
          </Link>{' '}
          <button className="text-button" onClick={() => onPreview?.(data.parent_id!)}>
            Preview parent
          </button>
        </p>
      )}
      {/* Both siblings reset for a new revision, but their keys must remain distinct. */}
      <ReadingText
        key={'reading:' + data.revision_id}
        target={{ resource_id: id, revision_id: data.revision_id }}
        content={data.content}
        participants={data.mentioned_participants}
      />
      {!!data.attachment_set?.files.length && (
        <FileBrowser
          participant={context.self.participant_id}
          key={'attachments:' + data.revision_id}
          contribution={id}
          revision={data.revision_id}
        />
      )}
      <ChangeDetails revision={data} />
      <div className="post-footer">
        <button
          ref={replyButton}
          className="text-button"
          onClick={() => {
            setFocusComposer(true);
            setReply((value) => !value);
          }}
          disabled={!data.publication_open}
        >
          <Icon name="reply" /> Reply
        </button>
        <SaveControl
          context={context}
          target={{ kind: 'contribution', resource_id: id }}
          label="contribution"
        />
        <details className="message-details">
          <summary>More</summary>
          <div className="message-details-content">
            <ReadingMarkUnread target={{ resource_id: id, revision_id: data.revision_id }} />
            <EditingIntent
              context={context}
              resource={id}
              base={data.revision_id}
              canEdit={data.can_edit}
            />
            <ReferenceViews
              key={'references:' + data.revision_id}
              sourceId={id}
              sourceRevision={data.revision_id}
              target={{ kind: 'contribution', resource_id: id }}
            />
            <Link to={`/loom/resource/${id}/${data.revision_id}`}>
              Revision {data.revision_number}
            </Link>
            {data.can_edit && <Link to={'/loom/resource/' + id + '?edit=1'}>Edit</Link>}
            {!opening && data.parent_id && (
              <SuppressLink context={context} id={id} kind="comment" />
            )}
          </div>
        </details>
      </div>
      {reply && (
        <Composer
          context={context}
          operation={{ kind: 'reply.create', discussionId: data.discussion_id!, parentId: id }}
          slot={'reply:' + id}
          heading={'Reply to ' + data.author.nickname}
          focusOnOpen={focusComposer}
          onClose={() => {
            setReply(false);
            replyButton.current?.focus();
          }}
          onCommitted={() => onPosted?.()}
        />
      )}
    </article>
  );
}

type ChildPage = AuthorizedValue<PageView>;
type ChildItem = Extract<PageView['items'][number], { resource_id: string }>;
type RestorationGoal = { loadedCount: number; tailId?: string };
type ChildrenWindow = {
  pages: ChildPage[];
  requestedCursors: string[];
  continuation: string | null;
  complete: boolean;
  busy: boolean;
  error?: { kind: 'append' | 'refresh'; message: string; cursor?: string | undefined } | undefined;
  goal?: RestorationGoal;
  notice?: string | undefined;
};
const restorationPageBudget = 8;

function uniqueChildren(pages: ChildPage[]) {
  const ids = new Set<string>();
  return pages.flatMap((page) =>
    page.value.items.filter((item): item is ChildItem => {
      if (!('resource_id' in item) || ids.has(item.resource_id)) return false;
      ids.add(item.resource_id);
      return true;
    }),
  );
}

function Children({
  id,
  parent,
  discussionId,
  context,
  depth,
  role,
  refreshVersion = 0,
}: {
  id: string;
  parent?: ResourceView | undefined;
  discussionId: string;
  context: Context;
  depth: number;
  role: 'comments' | 'replies';
  refreshVersion?: number;
}) {
  const authority = useAuthorization();
  const treeId = useId();
  const tree = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const loadButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const readingAnchor = useRef<{ resource: string; top: number } | undefined>(undefined);
  const navigation = useContext(DiscussionNavigation),
    navigationKey = id + ':' + depth;
  const initial = useRef(navigation?.get(navigationKey));
  const [windowState, setWindowState] = useState<ChildrenWindow>({
    pages: [],
    requestedCursors: [],
    continuation: '',
    complete: false,
    busy: false,
  });
  const state = useRef(windowState);
  const request = useRef<AbortController | undefined>(undefined);
  const sequence = useRef(0);
  const [expanded, setExpanded] = useState<string[]>(initial.current?.expanded ?? []),
    [opened, setOpened] = useState<string[]>(initial.current?.opened ?? []),
    [branchVersions, setBranchVersions] = useState<Record<string, number>>({});
  const publish = (next: ChildrenWindow) => {
    state.current = next;
    setWindowState(next);
  };
  const validPages = (pages: ChildPage[]) =>
    pages.every((page) => authority.current(page.generation));
  const withheld = windowState.pages.length > 0 && !validPages(windowState.pages);
  const accepted = withheld ? [] : windowState.pages;
  const items = uniqueChildren(accepted);
  useEffect(() => {
    if (!navigation) return;
    const rows = uniqueChildren(state.current.pages);
    const goal = state.current.goal;
    navigation.set(navigationKey, {
      loadedCount: goal?.loadedCount ?? rows.length,
      ...(goal?.tailId
        ? { tailId: goal.tailId }
        : rows.at(-1)
          ? { tailId: rows.at(-1)!.resource_id }
          : {}),
      expanded,
      opened,
    });
    if (navigation.size > 64) navigation.delete(navigation.keys().next().value!);
  }, [windowState.pages, expanded, opened, navigation, navigationKey]);
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    if (anchor) {
      const target = [
        ...(tree.current?.querySelectorAll<HTMLElement>('article[data-resource-id]') ?? []),
      ].find((node) => node.dataset.resourceId === anchor.resource);
      if (target)
        window.scrollBy({
          top: target.getBoundingClientRect().top - anchor.top,
          behavior: 'instant',
        });
      readingAnchor.current = undefined;
    }
    if (pendingFocus.current) {
      pendingFocus.current = false;
      if (document.activeElement === document.body) summary.current?.focus({ preventScroll: true });
    }
  }, [windowState.pages]);
  const captureReadingAnchor = () => {
    const candidate = [
      ...(tree.current?.querySelectorAll<HTMLElement>('article[data-resource-id]') ?? []),
    ].find(
      (node) =>
        node.getBoundingClientRect().bottom > 0 && node.getBoundingClientRect().top < innerHeight,
    );
    if (candidate)
      readingAnchor.current = {
        resource: candidate.dataset.resourceId!,
        top: candidate.getBoundingClientRect().top,
      };
  };
  const read = (cursor: string, signal: AbortSignal) => {
    const path = `/api/v1/contributions/${id}/children?limit=6${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    return authority.sourcePolicy === 'projections'
      ? authority.readProjection<PageView>(path, { signal, schema: Page })
      : authority.readAuthorized<PageView>(path, { signal, schema: Page });
  };
  const continuation = (page: PageView, requested: string, history: string[]) => {
    if (page.complete) return null;
    if (!page.next_cursor || page.next_cursor === requested || history.includes(page.next_cursor))
      throw new Error(
        `${role === 'comments' ? 'Comments' : 'Replies'} could not continue from this response. Refresh this list to recover.`,
      );
    return page.next_cursor;
  };
  const goalFrom = (snapshot: ChildrenWindow): RestorationGoal => {
    const rows = uniqueChildren(snapshot.pages);
    return (
      snapshot.goal ?? {
        loadedCount: rows.length,
        ...(rows.at(-1) ? { tailId: rows.at(-1)!.resource_id } : {}),
      }
    );
  };
  const rebuild = async (goal: RestorationGoal, resume = false) => {
    request.current?.abort();
    const controller = new AbortController(),
      turn = ++sequence.current;
    request.current = controller;
    const previous = state.current;
    if (!resume && previous.pages.length) captureReadingAnchor();
    publish({ ...previous, busy: true, error: undefined, notice: undefined });
    let pages = resume ? [...previous.pages] : [];
    let history = resume ? [...previous.requestedCursors] : [];
    let cursor = resume ? previous.continuation : '';
    try {
      for (let step = 0; step < restorationPageBudget && cursor !== null; step++) {
        const response = await read(cursor, controller.signal);
        if (turn !== sequence.current || controller.signal.aborted) return;
        if (!validPages([...pages, response]))
          throw new Error('Authorization changed while restoring this list. Retry its refresh.');
        const next = continuation(response.value, cursor, history);
        pages.push(response);
        history.push(cursor);
        cursor = next;
        const rows = uniqueChildren(pages);
        if (!goal.tailId || rows.some((row) => row.resource_id === goal.tailId) || cursor === null)
          break;
      }
      if (turn !== sequence.current) return;
      const rows = uniqueChildren(pages);
      const reached = !goal.tailId || rows.some((row) => row.resource_id === goal.tailId);
      publish({
        pages,
        requestedCursors: history,
        continuation: cursor,
        complete: cursor === null,
        busy: false,
        ...(cursor && !reached ? { goal } : {}),
        ...(!reached && cursor === null
          ? { notice: 'The earlier end of this list is no longer available.' }
          : {}),
      });
      if (reached || cursor === null) {
        const surviving = new Set(rows.map((row) => row.resource_id));
        setOpened((value) => value.filter((key) => surviving.has(key)));
        setExpanded((value) => value.filter((key) => surviving.has(key)));
      }
    } catch (failure) {
      if (turn !== sequence.current || (failure as Error).name === 'AbortError') return;
      if (!previous.pages.length && pages.length) {
        publish({
          pages,
          requestedCursors: history,
          continuation: cursor,
          complete: false,
          busy: false,
          goal,
          error: {
            kind: 'append',
            message: (failure as Error).message,
            cursor: cursor ?? undefined,
          },
        });
      } else
        publish({
          ...previous,
          busy: false,
          error: { kind: 'refresh', message: (failure as Error).message },
        });
      readingAnchor.current = undefined;
    } finally {
      if (turn === sequence.current) request.current = undefined;
    }
  };
  const append = async (retryCursor?: string) => {
    if (request.current) return;
    const previous = state.current;
    const cursor = retryCursor ?? previous.continuation;
    if (!cursor || previous.complete || !validPages(previous.pages)) return;
    const controller = new AbortController(),
      turn = ++sequence.current;
    const activatedLoadButton = document.activeElement === loadButton.current;
    request.current = controller;
    publish({ ...previous, busy: true, error: undefined });
    try {
      const response = await read(cursor, controller.signal);
      if (turn !== sequence.current || controller.signal.aborted) return;
      if (!validPages([...previous.pages, response]))
        throw new Error('Earlier content is no longer authorized. Refresh this list to recover.');
      const next = continuation(response.value, cursor, previous.requestedCursors);
      pendingFocus.current =
        next === null &&
        activatedLoadButton &&
        (document.activeElement === loadButton.current || document.activeElement === document.body);
      publish({
        ...previous,
        pages: [...previous.pages, response],
        requestedCursors: [...previous.requestedCursors, cursor],
        continuation: next,
        complete: next === null,
        busy: false,
        error: undefined,
      });
    } catch (failure) {
      if (turn !== sequence.current || (failure as Error).name === 'AbortError') return;
      if (failure instanceof ApiError && failure.code === 'invalid_cursor') {
        void rebuild(goalFrom(previous));
        return;
      }
      if (!validPages(previous.pages)) {
        void rebuild(goalFrom(previous));
        return;
      }
      publish({
        ...previous,
        busy: false,
        error: { kind: 'append', message: (failure as Error).message, cursor },
      });
    } finally {
      if (turn === sequence.current) request.current = undefined;
    }
  };
  useEffect(() => {
    void rebuild(
      goalFrom(state.current).tailId
        ? goalFrom(state.current)
        : (initial.current ?? { loadedCount: 0 }),
    );
    return () => {
      sequence.current++;
      request.current?.abort();
      request.current = undefined;
    };
  }, [id, refreshVersion]);
  const noun = role === 'comments' ? 'comments' : 'replies';
  const refreshControl = accepted.length > 0 && !windowState.error && (
    <button
      className="text-button"
      disabled={windowState.busy}
      onClick={() => void rebuild(goalFrom(state.current))}
    >
      Refresh {noun}
    </button>
  );
  return (
    <div
      ref={tree}
      className="comment-tree"
      aria-busy={windowState.busy}
      data-ready={accepted.length > 0 || !!windowState.error}
      data-restoring={windowState.busy || !!windowState.goal}
    >
      {accepted.length > 0 && (
        <div className="reply-page-toolbar">
          <p ref={summary} tabIndex={-1} className="reply-page-summary" role="status">
            {items.length} direct{' '}
            {role === 'comments'
              ? items.length === 1
                ? 'comment'
                : 'comments'
              : items.length === 1
                ? 'reply'
                : 'replies'}{' '}
            loaded
          </p>
          {refreshControl}
        </div>
      )}
      {items.map((item) => {
        const resource = item as ResourceView;
        return (
          <div className="comment-branch" key={resource.resource_id}>
            {'state' in item ? (
              <div className="comment notice" data-resource-id={resource.resource_id}>
                <p>Contribution unavailable</p>
              </div>
            ) : (
              <Contribution
                id={resource.resource_id}
                parent={parent}
                context={context}
                onPosted={() => {
                  setExpanded((value) => [...new Set([...value, resource.resource_id])]);
                  setBranchVersions((value) => ({
                    ...value,
                    [resource.resource_id]: (value[resource.resource_id] ?? 0) + 1,
                  }));
                }}
              />
            )}
            {depth >= 1 ? (
              <Link
                className="branch-link"
                to={`/loom/discussion/${discussionId}?focus=${resource.resource_id}`}
              >
                Open reply thread →
              </Link>
            ) : (
              <>
                <button
                  className="text-button branch-link"
                  aria-expanded={expanded.includes(resource.resource_id)}
                  aria-controls={`${treeId}-${resource.resource_id}`}
                  onClick={() => {
                    setOpened((value) => [...new Set([...value, resource.resource_id])]);
                    setExpanded((value) =>
                      value.includes(resource.resource_id)
                        ? value.filter((key) => key !== resource.resource_id)
                        : [...value, resource.resource_id],
                    );
                  }}
                >
                  {expanded.includes(resource.resource_id)
                    ? 'Hide replies'
                    : opened.includes(resource.resource_id)
                      ? 'Show loaded replies'
                      : 'Check replies'}
                </button>
                {/* Hiding retains mounted drafts/cursors; reads still use the current lease. */}
                <div
                  className="comment-children"
                  id={`${treeId}-${resource.resource_id}`}
                  hidden={!expanded.includes(resource.resource_id)}
                >
                  {(opened.includes(resource.resource_id) ||
                    expanded.includes(resource.resource_id)) && (
                    <Children
                      id={resource.resource_id}
                      parent={'state' in item ? undefined : resource}
                      discussionId={discussionId}
                      context={context}
                      depth={depth + 1}
                      role="replies"
                      refreshVersion={branchVersions[resource.resource_id] ?? 0}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
      {windowState.error && (
        <div className="notice continuation-notice" role="alert">
          <p>{windowState.error.message}</p>
          <button
            onClick={() =>
              windowState.error?.kind === 'append'
                ? void append(windowState.error.cursor)
                : void rebuild(goalFrom(state.current))
            }
          >
            Retry {noun}
          </button>
        </div>
      )}
      {withheld && !windowState.busy && !windowState.error && (
        <div className="notice continuation-notice" role="status">
          <p>Earlier {noun} are unavailable until this list is checked again.</p>
          <button onClick={() => void rebuild(goalFrom(state.current))}>Refresh {noun}</button>
        </div>
      )}
      {!accepted.length && !windowState.error && !withheld && <p role="status">Loading {noun}…</p>}
      {accepted.length > 0 && !items.length && windowState.complete && (
        <p className="empty-replies">No {noun} yet.</p>
      )}
      {windowState.notice && (
        <p className="continuation-notice" role="status">
          {windowState.notice}
        </p>
      )}
      {windowState.busy && accepted.length > 0 && (
        <p className="continuation-status" role="status">
          Loading {noun}…
        </p>
      )}
      {!windowState.busy && !windowState.error && windowState.goal && (
        <button
          className="continuation-action"
          onClick={() => void rebuild(windowState.goal!, true)}
        >
          Continue restoring {noun}
        </button>
      )}
      {!windowState.goal &&
        !windowState.error &&
        windowState.continuation &&
        accepted.length > 0 && (
          <button
            className="continuation-action"
            ref={loadButton}
            disabled={windowState.busy}
            onClick={() => void append()}
          >
            Load more {noun}
          </button>
        )}
    </div>
  );
}

function ParentPreview({
  id,
  discussionId,
  close,
}: {
  id: string;
  discussionId: string;
  close: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  const { data, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${id}/context`,
    ContributionContext,
  );
  const available =
    data && !('state' in data) && data.discussion_id === discussionId ? data : undefined;
  return (
    <aside ref={panel} tabIndex={-1} className="parent-preview" aria-label="Parent preview">
      <div className="publication-confirmed">
        <strong>Parent preview</strong>
        <button onClick={close}>Close preview</button>
      </div>
      {error ? (
        <>
          <ErrorText error={error} />
          <button onClick={refresh}>Retry parent preview</button>
        </>
      ) : available ? (
        <>
          <p>
            @{available.author.nickname} · revision {available.revision_number}
          </p>
          <p>{parentExcerpt(available)}</p>
          <Link to={`/loom/discussion/${discussionId}?focus=${id}`}>Open parent message</Link>
        </>
      ) : (
        <p role="status">{data ? 'Parent unavailable.' : 'Loading parent preview…'}</p>
      )}
    </aside>
  );
}

function parentExcerpt(data: Exclude<ContributionContextView, { state: string }>) {
  let text = data.content.text;
  for (const mention of data.content.mentions) {
    const nickname =
      data.mentioned_participants.find((person) => person.id === mention.participant_id)
        ?.nickname ?? 'participant';
    text = text.replaceAll(`[[mention:${mention.token}]]`, '@' + nickname);
  }
  return text.length > 360 ? text.slice(0, 360) + '…' : text;
}
