import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { Page, type PageView, type ResourceView } from '../contracts/participation.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration } from './participation-client.js';
import { Avatar } from './participation-ui.js';
import {
  TOPIC_DISCUSSION_ORDER,
  type TopicDiscussionPosition,
} from './topic-discussion-navigation.js';

const restorationPageBudget = 8;
type DiscussionRow = ResourceView & { discussion_id: string; discussion_created_at: string };
type Traversal = {
  rows: DiscussionRow[];
  requested: Set<string>;
  complete: boolean;
  next: string | null;
  generation: number | undefined;
};
type Action = 'initial' | 'append' | 'restore' | 'latest';
type List = {
  traversal?: Traversal | undefined;
  pending?: Action | undefined;
  failure?: Action | 'changed' | undefined;
  restartRequired?: boolean | undefined;
  goal?: TopicDiscussionPosition | undefined;
  notice?: 'anchor-missing' | 'extent-changed' | undefined;
};
type Interaction = ReturnType<typeof watchTopicDiscussionInteraction>;

class ListChanged extends Error {}

export function watchTopicDiscussionInteraction(onInterrupt?: () => void) {
  let interrupted = false;
  let frame: number | undefined;
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const stop = () => {
    for (const event of events) window.removeEventListener(event, interrupt, true);
    window.removeEventListener('scroll', interrupt);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
  function interrupt() {
    interrupted = true;
    stop();
    onInterrupt?.();
  }
  for (const event of events)
    window.addEventListener(event, interrupt, { capture: true, passive: true });
  // Browsers may apply their own Back position during the first render. Keep
  // input listeners active, then also detect scrolling through the scrollbar.
  if (window.requestAnimationFrame)
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        window.addEventListener('scroll', interrupt, { passive: true });
      });
    });
  return { interrupted: () => interrupted, stop };
}

function acceptPage(
  previous: Traversal | undefined,
  page: PageView,
  generation: number | undefined,
  topicId: string,
): Traversal {
  const cursor = previous?.next ?? '',
    requested = new Set(previous?.requested).add(cursor);
  if (!page.complete && (!page.next_cursor || requested.has(page.next_cursor)))
    throw new ListChanged();
  const rows = new Map(previous?.rows.map((row) => [row.discussion_id, row]));
  for (const item of page.items) {
    if (
      !('author' in item) ||
      !item.discussion_id ||
      !item.discussion_created_at ||
      item.area_id !== topicId.toLowerCase() ||
      item.parent_id !== null
    )
      throw new Error('This response does not contain topic discussion metadata.');
    // A repeated identity cannot move or replace an earlier accepted row.
    if (!rows.has(item.discussion_id))
      rows.set(item.discussion_id, {
        ...item,
        discussion_id: item.discussion_id,
        discussion_created_at: item.discussion_created_at,
      });
  }
  return {
    rows: [...rows.values()],
    requested,
    complete: page.complete,
    next: page.complete ? null : page.next_cursor,
    generation,
  };
}

function listStatus(view: List, traversal: Traversal | undefined) {
  if (view.pending === 'latest') return 'Loading the latest discussions…';
  if (view.pending && view.goal) return 'Restoring your place…';
  if (view.pending === 'initial') return 'Loading discussions…';
  if (view.pending === 'append') return 'Loading more discussions…';
  if (!traversal) return null;
  if (traversal.complete)
    return traversal.rows.length ? 'End of discussions.' : 'No discussions yet.';
  const count = traversal.rows.length;
  if (!count) return 'More discussions may be available.';
  return `${count} ${count === 1 ? 'discussion' : 'discussions'} loaded`;
}

type Props = {
  topicId: string;
  restoration?: TopicDiscussionPosition | undefined;
  rememberPosition?: ((position: TopicDiscussionPosition) => void) | undefined;
};

export function TopicDiscussionBrowser(props: Props) {
  return <DiscussionList key={props.topicId} {...props} />;
}

function DiscussionList({ topicId, restoration, rememberPosition }: Props) {
  const authority = useAuthorization();
  const [view, setView] = useState<List>({ pending: 'initial', goal: restoration });
  const current = useRef(view);
  const request = useRef<AbortController | undefined>(undefined);
  const interaction = useRef<Interaction | undefined>(undefined);
  const section = useRef<HTMLElement>(null),
    latestAction = useRef<HTMLButtonElement>(null),
    footerAction = useRef<HTMLButtonElement>(null),
    status = useRef<HTMLParagraphElement>(null),
    restorationNotice = useRef<HTMLParagraphElement>(null);
  const positionPlan = useRef<
    | {
        target: TopicDiscussionPosition | 'latest' | 'fallback';
        interaction: Interaction;
        fromFooter: boolean;
      }
    | undefined
  >(undefined);
  const focusStatus = useRef(false);
  const publish = (value: List) => {
    current.current = value;
    setView(value);
  };

  async function load(action: Action, goal?: TopicDiscussionPosition) {
    if (request.current || !authority.active()) return;
    const { traversal: prior, restartRequired } = current.current;
    const fresh = action === 'initial' || action === 'latest';
    let traversal = fresh ? undefined : prior;
    if (!fresh && (restartRequired || !traversal?.next || !authority.current(traversal.generation)))
      return;

    const controller = new AbortController(),
      owner = identityGeneration(),
      generation = authority.capture();
    request.current = controller;
    const live = () =>
      request.current === controller &&
      owner === identityGeneration() &&
      authority.current(generation);
    const tracked = goal || action === 'latest' ? watchTopicDiscussionInteraction() : undefined;
    interaction.current = tracked;
    const hadFooterFocus = document.activeElement === footerAction.current;
    publish({ traversal: prior, pending: action, goal, restartRequired });

    try {
      for (let i = 0; i < (goal ? restorationPageBudget : 1); i++) {
        const cursor = traversal?.next;
        const result = await authority.readAuthorized<PageView>(
          `/api/v1/areas/${topicId}/discussions?` +
            new URLSearchParams({ order: TOPIC_DISCUSSION_ORDER, ...(cursor ? { cursor } : {}) }),
          { schema: Page, signal: controller.signal },
        );
        if (!live() || !authority.current(result.generation)) return;
        traversal = acceptPage(traversal, result.value, result.generation, topicId);
        const anchorFound =
          goal && traversal.rows.some((row) => row.discussion_id === goal.discussionId);
        const extentReached =
          goal &&
          traversal.requested.size >= goal.pages &&
          (!goal.tailId || traversal.rows.some((row) => row.discussion_id === goal.tailId));
        const restored = anchorFound && extentReached;
        const interrupted = tracked?.interrupted();
        if (
          goal &&
          !restored &&
          !traversal.complete &&
          !interrupted &&
          i + 1 < restorationPageBudget
        ) {
          publish({ traversal, pending: action, goal });
          continue;
        }

        const target = action === 'latest' ? 'latest' : anchorFound ? goal : goal && 'fallback';
        const fromFooter = hadFooterFocus && document.activeElement === footerAction.current;
        if (tracked && !interrupted && target)
          positionPlan.current = { target, interaction: tracked, fromFooter };
        focusStatus.current = action !== 'latest' && traversal.complete && fromFooter;
        const departed = goal && traversal.complete && !restored;
        publish({
          traversal,
          goal: restored || traversal.complete ? undefined : goal,
          notice: departed ? (anchorFound ? 'extent-changed' : 'anchor-missing') : undefined,
        });
        break;
      }
    } catch (error) {
      if (!live()) return;
      const changed =
        error instanceof ListChanged ||
        (error instanceof ApiError && error.code === 'invalid_cursor');
      publish({
        traversal: traversal ?? prior,
        failure: changed ? 'changed' : goal && traversal ? 'restore' : action,
        restartRequired: changed || restartRequired,
        goal,
      });
    } finally {
      if (request.current === controller) request.current = undefined;
      if (positionPlan.current?.interaction !== tracked) tracked?.stop();
    }
  }

  // A topic remount starts with current reads. Navigation records contain only
  // a restoration goal and cannot contribute a row or cursor to this request.
  useEffect(() => {
    void load('initial', restoration);
    return () => {
      request.current?.abort();
      request.current = undefined;
      interaction.current?.stop();
      positionPlan.current = undefined;
    };
  }, [authority]);

  useLayoutEffect(() => {
    if (focusStatus.current && document.activeElement === document.body)
      status.current?.focus({ preventScroll: true });
    focusStatus.current = false;
    const plan = positionPlan.current;
    if (!plan) return;
    positionPlan.current = undefined;
    if (!plan.interaction.interrupted() && authority.current(view.traversal?.generation)) {
      if (plan.target === 'latest' || plan.target === 'fallback') {
        if (plan.target === 'fallback') restorationNotice.current?.focus({ preventScroll: true });
        if (
          plan.target === 'latest' &&
          plan.fromFooter &&
          (document.activeElement === document.body ||
            document.activeElement === footerAction.current)
        )
          latestAction.current?.focus({ preventScroll: true });
        section.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      } else {
        const row = section.current?.querySelector<HTMLAnchorElement>(
          `[data-discussion-id="${plan.target.discussionId}"]`,
        );
        if (row) {
          row.focus({ preventScroll: true });
          const top = row.getBoundingClientRect().top - plan.target.offset;
          if (Math.abs(top) > 1) window.scrollBy({ top, behavior: 'instant' });
        }
      }
    }
    plan.interaction.stop();
  }, [authority, view]);

  const traversal = authority.current(view.traversal?.generation) ? view.traversal : undefined;
  const pending = view.pending;
  const failure = view.failure;
  const needsRestore = !!view.goal && !!traversal?.next;
  const showRestoration =
    needsRestore && !view.restartRequired && (!pending || pending === 'restore');
  const footerLabel = view.restartRequired
    ? 'Restart from latest'
    : failure === 'initial' || failure === 'append'
      ? 'Retry'
      : traversal?.next
        ? 'Load more discussions'
        : undefined;
  function footerClick() {
    if (view.restartRequired) void load('latest');
    else if (failure === 'initial') void load('initial', view.goal);
    else void load('append');
  }
  function opening(event: MouseEvent<HTMLAnchorElement>, discussionId: string) {
    if (
      !traversal ||
      !rememberPosition ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const tailId = view.goal?.tailId ?? traversal.rows.at(-1)?.discussion_id;
    rememberPosition({
      discussionId,
      offset: event.currentTarget.getBoundingClientRect().top,
      pages: Math.max(traversal.requested.size, view.goal?.pages ?? 0),
      ...(tailId ? { tailId } : {}),
    });
  }

  return (
    <section ref={section} aria-label="Topic discussions" className="topic-discussion-browser">
      <div className="topic-discussion-toolbar">
        <span>Newest first</span>
        <button
          ref={latestAction}
          type="button"
          className="text-button"
          aria-disabled={!!pending}
          onClick={() => void load('latest')}
        >
          Show latest discussions
        </button>
      </div>
      {failure === 'latest' && (
        <p role="alert" className="notice error">
          The latest discussions could not be loaded. Try Show latest discussions again.
        </p>
      )}
      {showRestoration && (
        <div className="topic-discussion-recovery notice neutral">
          <p ref={restorationNotice} tabIndex={-1} role="status">
            {pending === 'restore'
              ? 'Restoring your place…'
              : failure === 'restore'
                ? 'Earlier discussions could not be restored.'
                : 'Your previous place hasn’t been fully restored.'}
          </p>
          <button
            type="button"
            aria-disabled={!!pending}
            onClick={() => void load('restore', view.goal)}
          >
            {failure === 'restore'
              ? 'Retry restoring discussions'
              : 'Continue restoring discussions'}
          </button>
        </div>
      )}
      {view.notice && (
        <p ref={restorationNotice} tabIndex={-1} role="status" className="notice neutral">
          {view.notice === 'anchor-missing'
            ? 'Your previous discussion is no longer in this list.'
            : 'The earlier end of this list is no longer available.'}
        </p>
      )}
      {traversal?.rows.length ? (
        <ul className="topic-discussion-rows">
          {traversal.rows.map((row) => (
            <DiscussionListRow key={row.discussion_id} row={row} opening={opening} />
          ))}
        </ul>
      ) : null}
      <div className="topic-discussion-footer">
        {(failure === 'initial' || failure === 'append' || failure === 'changed') && (
          <p role="alert" className="notice error">
            {failure === 'changed'
              ? 'This discussion list changed. Show the latest discussions to continue.'
              : failure === 'initial'
                ? 'Discussions could not be loaded.'
                : 'More discussions could not be loaded.'}
          </p>
        )}
        <p ref={status} tabIndex={-1} role="status">
          {listStatus(view, traversal)}
        </p>
        {footerLabel && (
          <button ref={footerAction} type="button" aria-disabled={!!pending} onClick={footerClick}>
            {footerLabel}
          </button>
        )}
      </div>
    </section>
  );
}

function DiscussionListRow({
  row,
  opening,
}: {
  row: DiscussionRow;
  opening: (event: MouseEvent<HTMLAnchorElement>, discussionId: string) => void;
}) {
  const titleId = useId(),
    metadataId = useId();
  const date = new Date(row.discussion_created_at);
  return (
    <li>
      <Link
        className="topic-discussion-row"
        to={`/loom/discussion/${row.discussion_id}`}
        data-discussion-id={row.discussion_id}
        aria-labelledby={titleId}
        aria-describedby={metadataId}
        onClick={(event) => opening(event, row.discussion_id)}
      >
        <span aria-hidden="true">
          <Avatar person={row.author} />
        </span>
        <span className="topic-discussion-text">
          <span id={titleId} className="topic-discussion-title">
            {row.title ?? 'Untitled discussion'}
          </span>
          <span id={metadataId} className="topic-discussion-meta">
            <span className="topic-discussion-author">{row.author.nickname}</span>
            {row.author.kind === 'agent' && <span className="author-badge">Agent</span>}
            <time dateTime={row.discussion_created_at} title={date.toLocaleString()}>
              {date.toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </time>
          </span>
        </span>
      </Link>
    </li>
  );
}
