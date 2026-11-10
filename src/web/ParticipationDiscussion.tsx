import type { DiscussionNavigationState } from './discussion-navigation.js';
import { AddPrivateNote } from './PrivateNotes.js';
import { FileBrowser } from './Files.js';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useId,
  useCallback,
  createContext,
  useContext,
} from 'react';
import { useLocation, Link } from 'react-router';
import {
  type ResourceView,
  type ContributionContextView,
  ContributionContext,
  type PageView,
  type CommittedView,
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

const ParentPreviewContext = createContext<((id: string) => void) | null>(null);
const DiscussionNavigation = createContext<DiscussionNavigationState | null>(null);

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
  const [openingReply, setOpeningReply] = useState<CommittedView>();
  const [summaryReload, setSummaryReload] = useState(0);
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
    <DiscussionNavigation.Provider value={navigationState}>
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
                    onPosted={setOpeningReply}
                  />
                  <div className="discussion-controls">
                    <h2>Comments</h2>
                    <span>Oldest first</span>
                  </div>
                  <Children
                    id={opening.current!}
                    parent={data?.opening}
                    discussionId={id}
                    context={context}
                    depth={0}
                    role="comments"
                    confirmed={openingReply}
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
  const [confirmed, setConfirmed] = useState<CommittedView>();
  const [collapsed, setCollapsed] = useState(
    () => context.discussionNavigation?.focusedCollapsed?.includes(id) ?? false,
  );
  const authority = useAuthorization();
  const verifiedDiscussion = useRef<string | undefined>(undefined);
  if (data?.discussion_id === discussionId) verifiedDiscussion.current = discussionId;
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
        {verifiedDiscussion.current === discussionId && <AncestorContext id={id} />}
        <button onClick={refresh}>Refresh branch</button>
      </>
    );
  const effectiveCollapsed = collapsed && !('state' in data);
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
        collapsed={effectiveCollapsed}
        onToggleCollapse={(control) => {
          control.focus({ preventScroll: true });
          const next = !collapsed;
          setCollapsed(next);
          const navigation = context.discussionNavigation;
          if (navigation) {
            const saved = new Set(navigation.focusedCollapsed ?? []);
            if (next) saved.add(id);
            else saved.delete(id);
            navigation.focusedCollapsed = [...saved].slice(-64);
          }
        }}
        onPosted={(value) => {
          if (authority.current(generation)) setConfirmed(value);
        }}
      />
      <div className="discussion-controls" hidden={effectiveCollapsed}>
        <h2>Direct replies</h2>
        <span>Oldest first</span>
      </div>
      <Children
        id={id}
        parent={'state' in data ? undefined : data}
        discussionId={discussionId}
        context={context}
        depth={0}
        role="replies"
        confirmed={confirmed}
        hidden={effectiveCollapsed}
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
  onPosted?: (value: CommittedView) => void;
  onReplyOpened?: () => void;
  expectedParentId?: string | undefined;
  discussionId?: string;
  onKnownLoaded?: (id: string, loaded: boolean) => void;
  collapsed?: boolean;
  onToggleCollapse?: (control: HTMLButtonElement) => void;
};

function Contribution(props: ContributionProps) {
  const { data, generation, error, refresh } = useQuery<ContributionContextView>(
    `/api/v1/contributions/${props.id}/context`,
    ContributionContext,
  );
  const authority = useAuthorization();
  const matches =
    !!data &&
    (!props.expectedParentId ||
      (data.parent_id === props.expectedParentId && data.discussion_id === props.discussionId));
  useEffect(() => {
    if (props.expectedParentId) props.onKnownLoaded?.(props.id, matches);
  }, [props.id, props.expectedParentId, props.onKnownLoaded, matches]);
  if (error)
    return (
      <div className="notice">
        {props.expectedParentId ? (
          <p>Reply posted, but it could not be displayed. Try loading it again.</p>
        ) : (
          <ErrorText error={error} />
        )}
        <button onClick={refresh}>
          {props.expectedParentId ? 'Retry loading reply' : 'Retry contribution'}
        </button>
        {props.expectedParentId && (
          <Link to={`/loom/discussion/${props.discussionId}?focus=${props.id}`}>View reply</Link>
        )}
      </div>
    );
  if (!data)
    return (
      <p role="status" data-resource-id={props.id} data-loading="true">
        Loading contribution…
      </p>
    );
  if (!matches)
    return (
      <div className="notice" data-resource-id={props.id}>
        <p>Reply posted, but it could not be shown in this conversation.</p>
        <button onClick={refresh}>Retry loading reply</button>
        <Link to={`/loom/discussion/${props.discussionId}?focus=${props.id}`}>View reply</Link>
      </div>
    );
  return (
    <ContributionBody
      {...props}
      data={data}
      onPosted={(value) => {
        if (authority.current(generation)) props.onPosted?.(value);
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
  onReplyOpened,
  collapsed = false,
  onToggleCollapse,
}: ContributionProps & { data: ContributionContextView }) {
  const onPreview = useContext(ParentPreviewContext);
  const bodyId = useId();
  const [reply, setReply] = useState(() =>
    context.store
      .all()
      .some(
        (record) =>
          record.slot === 'reply:' + id &&
          (record.state !== 'committed' ||
            new URLSearchParams(window.location.search).get('intent') === record.key),
      ),
  );
  const restoredReply = useRef(reply);
  useEffect(() => {
    if (!restoredReply.current) return;
    restoredReply.current = false;
    onReplyOpened?.();
  }, [onReplyOpened]);
  const [confirmed, setConfirmed] = useState<CommittedView>();
  const seenOperations = useRef(new Set<string>());
  const [preferUnfinishedReply, setPreferUnfinishedReply] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const focusConfirmation = useRef(false);
  const viewReply = useRef<HTMLAnchorElement>(null);
  const replyButton = useRef<HTMLButtonElement>(null);
  const composerHost = useRef<HTMLDivElement>(null);
  const [focusComposer, setFocusComposer] = useState(false);
  useLayoutEffect(() => {
    if (!reply && focusConfirmation.current) {
      focusConfirmation.current = false;
      if (document.activeElement === document.body)
        viewReply.current?.focus({ preventScroll: true });
    }
  }, [reply, confirmed]);
  if ('state' in data)
    return (
      <div className="comment unavailable-summary" data-resource-id={id}>
        <p>Contribution unavailable</p>
      </div>
    );
  return (
    <article className={opening ? 'post card' : 'comment'} data-resource-id={id} tabIndex={-1}>
      <div className="author-line">
        {!opening && onToggleCollapse && (
          <button
            className="comment-collapse-control"
            type="button"
            aria-label={
              collapsed
                ? `Expand comment by ${data.author.nickname}`
                : `Collapse comment by ${data.author.nickname}`
            }
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={(event) => onToggleCollapse(event.currentTarget)}
          >
            <span aria-hidden="true">{collapsed ? '+' : '−'}</span>
          </button>
        )}
        <div className="author-metadata">
          <Avatar person={data.author} />
          <strong className="author-name">{data.author.nickname}</strong>
          {data.author.kind === 'agent' && <span className="author-badge">Agent</span>}
          <time dateTime={data.created_at} title={new Date(data.created_at).toLocaleString()}>
            {new Date(data.created_at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <ReadingIndicator target={{ resource_id: id, revision_id: data.revision_id }} />
        </div>
      </div>
      <div id={bodyId} className="comment-body" hidden={collapsed}>
        {data.parent_id && (!parent || parent.resource_id !== data.parent_id) && (
          <p className="parent-context">
            Replying to{' '}
            <Link to={`/loom/discussion/${data.discussion_id}?focus=${data.parent_id}`}>
              {parent?.resource_id === data.parent_id
                ? '@' + parent.author.nickname
                : 'parent message'}
            </Link>{' '}
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
              const currentEditor = composerHost.current?.querySelector<HTMLElement>('textarea');
              if (reply && currentEditor) return currentEditor.focus();
              setPreferUnfinishedReply(true);
              setComposerKey((value) => value + 1);
              setFocusComposer(true);
              setReply(true);
              onReplyOpened?.();
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
              <div className="message-quick-actions">
                <ReadingMarkUnread target={{ resource_id: id, revision_id: data.revision_id }} />
                {data.parent_id && (
                  <>
                    <button className="text-button" onClick={() => onPreview?.(data.parent_id!)}>
                      Preview parent
                    </button>
                    <Link to={`/loom/discussion/${data.discussion_id}?focus=${data.parent_id}`}>
                      View parent thread
                    </Link>
                  </>
                )}
              </div>
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
          <div ref={composerHost} className="comment-composer">
            <Composer
              key={composerKey}
              context={context}
              operation={{ kind: 'reply.create', discussionId: data.discussion_id!, parentId: id }}
              slot={'reply:' + id}
              heading={'Reply to ' + data.author.nickname}
              focusOnOpen={focusComposer}
              preferUnfinishedReply={preferUnfinishedReply}
              onClose={() => {
                setReply(false);
                replyButton.current?.focus();
              }}
              onCommitted={(value, focusWasInComposer) => {
                if (seenOperations.current.has(value.operation_id)) return;
                seenOperations.current.add(value.operation_id);
                focusConfirmation.current = focusWasInComposer;
                setConfirmed(value);
                setReply(false);
                setPreferUnfinishedReply(true);
                onPosted?.(value);
              }}
            />
          </div>
        )}
        {confirmed && !reply && (
          <div className="reply-confirmation" role="status">
            <strong>Reply posted</strong>{' '}
            <Link
              ref={viewReply}
              to={`/loom/discussion/${data.discussion_id}?focus=${confirmed.resource_id}`}
            >
              View reply
            </Link>{' '}
            <Link to={`/loom/resource/${confirmed.resource_id}/${confirmed.revision_id}`}>
              Inspect exact revision
            </Link>
          </div>
        )}
      </div>
    </article>
  );
}

type ChildPage = AuthorizedValue<PageView>;
type ChildItem = Extract<PageView['items'][number], { resource_id: string }>;
type RestorationGoal = { loadedCount: number; tailId?: string };
type ChildTraversal = {
  pages: ChildPage[];
  requestedCursors: string[];
  continuation: string | null;
  complete: boolean;
};
type ChildrenWindow = ChildTraversal & {
  busy: boolean;
  error?:
    | { kind: 'append' | 'refresh' | 'restore'; message: string; cursor?: string | undefined }
    | undefined;
  goal?: RestorationGoal | undefined;
  staged?: ChildTraversal | undefined;
  notice?: string | undefined;
};
const restorationPageBudget = 8;
const knownReplyLimit = 16;
class ContinuationError extends Error {}

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
  confirmed,
  hidden = false,
}: {
  id: string;
  parent?: ResourceView | undefined;
  discussionId: string;
  context: Context;
  depth: number;
  role: 'comments' | 'replies';
  refreshVersion?: number;
  confirmed?: CommittedView | undefined;
  hidden?: boolean;
}) {
  const authority = useAuthorization();
  const treeId = useId();
  const tree = useRef<HTMLDivElement>(null);
  const completion = useRef<HTMLParagraphElement>(null);
  const recoveryFocus = useRef<HTMLButtonElement>(null);
  const loadButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const readingAnchor = useRef<{ resource: string; top: number; scroll: number } | undefined>(
    undefined,
  );
  const navigationState = useContext(DiscussionNavigation),
    navigation = navigationState?.branches,
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
    [collapsed, setCollapsed] = useState<string[]>(initial.current?.collapsed ?? []),
    [confirmedByParent, setConfirmedByParent] = useState<Record<string, CommittedView>>({}),
    [knownReplyIds, setKnownReplyIds] = useState<string[]>(
      navigationState?.knownReplies?.get(id) ?? [],
    ),
    [knownLoaded, setKnownLoaded] = useState<string[]>([]);
  useEffect(() => {
    if (!confirmed) return;
    setKnownReplyIds((value) =>
      value.includes(confirmed.resource_id)
        ? value
        : [...value, confirmed.resource_id].slice(-knownReplyLimit),
    );
  }, [confirmed]);
  useEffect(() => {
    if (!navigationState || !knownReplyIds.length) return;
    const known = (navigationState.knownReplies ??= new Map());
    known.delete(id);
    known.set(id, knownReplyIds);
    if (known.size > 64) known.delete(known.keys().next().value!);
  }, [id, knownReplyIds, navigationState]);
  const onKnownLoaded = useCallback((resourceId: string, loaded: boolean) => {
    setKnownLoaded((value) =>
      loaded
        ? value.includes(resourceId)
          ? value
          : [...value, resourceId]
        : value.includes(resourceId)
          ? value.filter((id) => id !== resourceId)
          : value,
    );
  }, []);
  const publish = (next: ChildrenWindow) => {
    state.current = next;
    setWindowState(next);
  };
  const validPage = (page: ChildPage) => authority.current(page.generation);
  const validPages = (pages: ChildPage[]) => pages.every(validPage);
  const displayed =
    windowState.pages.length && validPages(windowState.pages)
      ? windowState
      : windowState.staged?.pages.length
        ? windowState.staged
        : windowState;
  const accepted = displayed.pages.filter(validPage);
  const withheld =
    displayed.pages.length > accepted.length ||
    (windowState.pages.length > 0 && displayed !== windowState);
  const items = uniqueChildren(accepted);
  const canonicalIds = new Set(items.map((item) => item.resource_id));
  const separateIds = knownReplyIds.filter((resourceId) => !canonicalIds.has(resourceId));
  const loadedCount =
    items.length + separateIds.filter((resourceId) => knownLoaded.includes(resourceId)).length;
  // One keyed array owns both canonical and separately read rows. Moving a row
  // into an accepted page then preserves its mounted draft and disclosures.
  const entries: (
    | { kind: 'canonical'; item: ChildItem }
    | { kind: 'known'; id: string }
    | { kind: 'gap'; id: string }
  )[] = [
    ...items.map((item) => ({ kind: 'canonical' as const, item })),
    ...separateIds.flatMap((resourceId) => [
      { kind: 'gap' as const, id: resourceId },
      { kind: 'known' as const, id: resourceId },
    ]),
  ];
  useEffect(() => {
    if (!navigation) return;
    const rows = uniqueChildren(state.current.pages);
    // A remount begins empty; retain its saved extent until fresh reads establish another.
    const goal = state.current.goal ?? (state.current.pages.length ? undefined : initial.current);
    navigation.set(navigationKey, {
      loadedCount: goal?.loadedCount ?? rows.length,
      ...(goal?.tailId
        ? { tailId: goal.tailId }
        : rows.at(-1)
          ? { tailId: rows.at(-1)!.resource_id }
          : {}),
      expanded,
      opened,
      collapsed,
    });
    if (navigation.size > 64) navigation.delete(navigation.keys().next().value!);
  }, [windowState.pages, windowState.goal, expanded, opened, collapsed, navigation, navigationKey]);
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    if (anchor) {
      const target = [
        ...(tree.current?.querySelectorAll<HTMLElement>('article[data-resource-id]') ?? []),
      ].find((node) => node.dataset.resourceId === anchor.resource);
      if (target && Math.abs(window.scrollY - anchor.scroll) < 8)
        window.scrollBy({
          top: target.getBoundingClientRect().top - anchor.top,
          behavior: 'instant',
        });
      readingAnchor.current = undefined;
    }
    if (pendingFocus.current) {
      pendingFocus.current = false;
      if (document.activeElement === document.body)
        (completion.current ?? recoveryFocus.current)?.focus({ preventScroll: true });
    }
  }, [windowState.pages]);
  useEffect(() => {
    const cancel = () => {
      readingAnchor.current = undefined;
    };
    for (const event of ['scroll', 'wheel', 'touchstart', 'pointerdown', 'keydown'])
      window.addEventListener(event, cancel, { passive: true });
    return () => {
      for (const event of ['scroll', 'wheel', 'touchstart', 'pointerdown', 'keydown'])
        window.removeEventListener(event, cancel);
    };
  }, []);
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
        scroll: window.scrollY,
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
      throw new ContinuationError(
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
    if (!resume && previous.pages.length && validPages(previous.pages)) captureReadingAnchor();
    const starting: ChildTraversal =
      resume && previous.staged
        ? previous.staged
        : { pages: [], requestedCursors: [], continuation: '', complete: false };
    publish({
      ...previous,
      busy: true,
      error: undefined,
      notice: undefined,
      goal,
      staged: starting,
    });
    const pages = [...starting.pages];
    const history = [...starting.requestedCursors];
    let cursor = starting.continuation;
    try {
      for (let step = 0; step < restorationPageBudget && cursor !== null; step++) {
        const response = await read(cursor, controller.signal);
        if (turn !== sequence.current || controller.signal.aborted) return;
        if (!validPage(response))
          throw new DOMException('View authorization changed.', 'AbortError');
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
      const traversal: ChildTraversal = {
        pages,
        requestedCursors: history,
        continuation: cursor,
        complete: cursor === null,
      };
      if (reached || cursor === null) {
        publish({
          ...traversal,
          busy: false,
          goal: undefined,
          staged: undefined,
          ...(!reached ? { notice: 'The earlier end of this list is no longer available.' } : {}),
        });
        const surviving = new Set([...rows.map((row) => row.resource_id), ...knownReplyIds]);
        setOpened((value) => value.filter((key) => surviving.has(key)));
        setExpanded((value) => value.filter((key) => surviving.has(key)));
        const unavailable = new Set(
          rows.filter((row) => 'state' in row).map((row) => row.resource_id),
        );
        const available = new Set([
          ...rows.filter((row) => !('state' in row)).map((row) => row.resource_id),
          ...knownReplyIds.filter((key) => !unavailable.has(key)),
        ]);
        setCollapsed((value) => value.filter((key) => available.has(key)));
      } else
        publish({
          ...previous,
          busy: false,
          error: undefined,
          notice: undefined,
          goal,
          staged: traversal,
        });
    } catch (failure) {
      if (turn !== sequence.current || controller.signal.aborted) return;
      const staged: ChildTraversal = {
        pages,
        requestedCursors: history,
        continuation: cursor,
        complete: false,
      };
      const restart =
        failure instanceof ContinuationError ||
        (failure instanceof ApiError && failure.code === 'invalid_cursor') ||
        !validPages(pages);
      publish({
        ...previous,
        busy: false,
        goal,
        staged,
        error: {
          kind: restart || !pages.length ? 'refresh' : 'restore',
          message:
            (failure as Error).name === 'AbortError'
              ? 'Authorization changed while restoring this list. Retry its refresh.'
              : (failure as Error).message,
          cursor: cursor ?? undefined,
        },
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
    if (
      !cursor ||
      previous.complete ||
      previous.staged ||
      !authority.current(previous.pages.at(-1)?.generation)
    )
      return;
    const controller = new AbortController(),
      turn = ++sequence.current;
    const activatedLoadButton = document.activeElement === loadButton.current;
    request.current = controller;
    publish({ ...previous, busy: true, error: undefined });
    try {
      const response = await read(cursor, controller.signal);
      if (turn !== sequence.current || controller.signal.aborted) return;
      if (!validPage(response)) throw new DOMException('View authorization changed.', 'AbortError');
      const next = continuation(response.value, cursor, previous.requestedCursors);
      const pages = [...previous.pages, response];
      const rows = uniqueChildren(pages);
      const reached =
        !previous.goal?.tailId || rows.some((row) => row.resource_id === previous.goal?.tailId);
      const restored = !!previous.goal && (reached || next === null);
      pendingFocus.current =
        next === null &&
        activatedLoadButton &&
        (document.activeElement === loadButton.current || document.activeElement === document.body);
      publish({
        ...previous,
        pages,
        requestedCursors: [...previous.requestedCursors, cursor],
        continuation: next,
        complete: next === null,
        busy: false,
        error: undefined,
        ...(restored
          ? {
              goal: undefined,
              notice: reached ? undefined : 'The earlier end of this list is no longer available.',
            }
          : {}),
      });
      if (restored) {
        const surviving = new Set([...rows.map((row) => row.resource_id), ...knownReplyIds]);
        setOpened((value) => value.filter((key) => surviving.has(key)));
        setExpanded((value) => value.filter((key) => surviving.has(key)));
        const unavailable = new Set(
          rows.filter((row) => 'state' in row).map((row) => row.resource_id),
        );
        const available = new Set([
          ...rows.filter((row) => !('state' in row)).map((row) => row.resource_id),
          ...knownReplyIds.filter((key) => !unavailable.has(key)),
        ]);
        setCollapsed((value) => value.filter((key) => available.has(key)));
      }
    } catch (failure) {
      if (turn !== sequence.current || controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.code === 'invalid_cursor') {
        void rebuild(goalFrom(previous));
        return;
      }
      if (!authority.current(previous.pages.at(-1)?.generation)) {
        void rebuild(goalFrom(previous));
        return;
      }
      publish({
        ...previous,
        busy: false,
        error: {
          kind: 'append',
          message:
            (failure as Error).name === 'AbortError'
              ? 'Authorization changed while loading this list. Refresh to recover.'
              : (failure as Error).message,
          cursor,
        },
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
  const refreshControl = accepted.length > 0 &&
    !separateIds.length &&
    !withheld &&
    !windowState.error &&
    (!windowState.complete || !items.length) && (
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
      hidden={hidden}
      aria-busy={windowState.busy}
      data-ready={accepted.length > 0 || !!windowState.error}
      data-restoring={windowState.busy || !!windowState.goal}
    >
      {(accepted.length > 0 || knownReplyIds.length > 0) && (
        <div className="reply-page-toolbar">
          <p className="reply-page-summary" role="status">
            {loadedCount}{' '}
            {role === 'comments'
              ? loadedCount === 1
                ? 'comment'
                : 'comments'
              : loadedCount === 1
                ? 'reply'
                : 'replies'}{' '}
            loaded
          </p>
          {refreshControl}
        </div>
      )}
      {entries.map((entry) => {
        if (entry.kind === 'gap')
          return (
            <div className="continuation-notice reply-gap" key={'gap:' + entry.id}>
              <span>Some {noun} are not loaded.</span>{' '}
              {entry.id === separateIds[0] && !windowState.error && !withheld && (
                <button
                  className="text-button"
                  disabled={windowState.busy}
                  onClick={() => void rebuild(goalFrom(state.current))}
                >
                  Refresh {noun}
                </button>
              )}
            </div>
          );
        const item = entry.kind === 'canonical' ? entry.item : undefined;
        const resourceId = entry.kind === 'canonical' ? entry.item.resource_id : entry.id;
        const resource = item && !('state' in item) ? (item as ResourceView) : undefined;
        const isCollapsed = !(item && 'state' in item) && collapsed.includes(resourceId);
        const branchReady = entry.kind === 'canonical' || knownLoaded.includes(resourceId);
        return (
          <div className="comment-branch" data-collapsed={isCollapsed} key={resourceId}>
            {item && 'state' in item ? (
              <div className="comment unavailable-summary" data-resource-id={resourceId}>
                <p>Contribution unavailable</p>
              </div>
            ) : (
              <Contribution
                id={resourceId}
                parent={parent}
                context={context}
                collapsed={isCollapsed}
                expectedParentId={knownReplyIds.includes(resourceId) ? id : undefined}
                discussionId={discussionId}
                onKnownLoaded={onKnownLoaded}
                onToggleCollapse={(control) => {
                  const active = document.activeElement;
                  if (
                    active instanceof HTMLElement &&
                    control.closest('.comment-branch')?.contains(active)
                  )
                    control.focus({ preventScroll: true });
                  setCollapsed((value) =>
                    value.includes(resourceId)
                      ? value.filter((key) => key !== resourceId)
                      : [...value, resourceId],
                  );
                }}
                onReplyOpened={() => {
                  if (depth >= 1) return;
                  setOpened((value) =>
                    value.includes(resourceId) ? value : [...value, resourceId],
                  );
                  setExpanded((value) =>
                    value.includes(resourceId) ? value : [...value, resourceId],
                  );
                }}
                onPosted={(value) => {
                  setConfirmedByParent((current) =>
                    current[resourceId]?.operation_id === value.operation_id
                      ? current
                      : { ...current, [resourceId]: value },
                  );
                }}
              />
            )}
            {branchReady &&
              (depth >= 1 ? (
                <Link
                  className="branch-link"
                  hidden={isCollapsed}
                  to={`/loom/discussion/${discussionId}?focus=${resourceId}`}
                >
                  Continue this thread →
                </Link>
              ) : (
                <>
                  <button
                    className="text-button branch-link"
                    hidden={isCollapsed}
                    aria-expanded={expanded.includes(resourceId)}
                    aria-controls={`${treeId}-${resourceId}`}
                    onClick={() => {
                      setOpened((value) => [...new Set([...value, resourceId])]);
                      setExpanded((value) =>
                        value.includes(resourceId)
                          ? value.filter((key) => key !== resourceId)
                          : [...value, resourceId],
                      );
                    }}
                  >
                    {expanded.includes(resourceId) ? 'Hide replies' : 'Show replies'}
                  </button>
                  {/* Hiding retains mounted drafts/cursors; reads still use the current lease. */}
                  <div
                    className="comment-children"
                    id={`${treeId}-${resourceId}`}
                    hidden={isCollapsed || !expanded.includes(resourceId)}
                  >
                    {(opened.includes(resourceId) || expanded.includes(resourceId)) && (
                      <Children
                        id={resourceId}
                        parent={resource}
                        discussionId={discussionId}
                        context={context}
                        depth={depth + 1}
                        role="replies"
                        confirmed={confirmedByParent[resourceId]}
                      />
                    )}
                  </div>
                </>
              ))}
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
                : windowState.error?.kind === 'restore'
                  ? void rebuild(goalFrom(state.current), true)
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
          <button ref={recoveryFocus} onClick={() => void rebuild(goalFrom(state.current))}>
            Refresh {noun}
          </button>
        </div>
      )}
      {!accepted.length && !windowState.error && !withheld && <p role="status">Loading {noun}…</p>}
      {accepted.length > 0 && !items.length && !separateIds.length && displayed.complete && (
        <p className="empty-replies">No {noun} yet.</p>
      )}
      {windowState.notice && (
        <p className="continuation-notice" role="status">
          {windowState.notice}
        </p>
      )}
      {windowState.busy && (
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
            aria-disabled={windowState.busy}
            onClick={() => void append()}
          >
            Load more {noun}
          </button>
        )}
      {!windowState.goal &&
        !windowState.error &&
        !withheld &&
        windowState.complete &&
        !separateIds.length &&
        items.length > 0 && (
          <div className="continuation-complete">
            <p ref={completion} tabIndex={-1} className="continuation-status" role="status">
              No more {noun} right now.
            </p>
            <button
              className="text-button"
              aria-disabled={windowState.busy}
              onClick={() => {
                if (!windowState.busy) void rebuild(goalFrom(state.current));
              }}
            >
              Refresh {noun}
            </button>
          </div>
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
