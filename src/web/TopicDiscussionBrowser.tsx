import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from 'react';
import { Link } from 'react-router';
import { Page, type PageView, type ResourceView } from '../contracts/participation.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration, type Self } from './participation-client.js';
import { Avatar } from './participation-ui.js';
import {
  useTopicDiscussionFreshness,
  watchedTopicDiscussionKey,
} from './useTopicDiscussionFreshness.js';
import {
  TOPIC_DISCUSSION_ORDER,
  isTopicNavigationClick,
  restorationPageBudget,
  watchTopicNavigationInteraction,
  type TopicDiscussionPosition,
} from './topic-navigation.js';

const maxOverlappingWithdrawalTags = 256;
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
type Interaction = ReturnType<typeof watchTopicNavigationInteraction>;
type ListRequest = { controller: AbortController; withdrawn?: Set<string> };

class ListChanged extends Error {}

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
      !item.discussion_observation_tags ||
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

function withdrawRows(traversal: Traversal, tags: ReadonlySet<string>, before = 0) {
  const revoked = (row: DiscussionRow) =>
    row.discussion_observation_tags?.some((tag) => tags.has(tag)) ||
    tags.has(watchedTopicDiscussionKey(row));
  if (!tags.size || !traversal.rows.some(revoked)) return { traversal, removed: 0, before: 0 };
  let removedBefore = 0;
  const rows = traversal.rows.filter((row, index) => {
    if (!revoked(row)) return true;
    if (index < before) removedBefore++;
    return false;
  });
  return {
    traversal: { ...traversal, rows },
    removed: traversal.rows.length - rows.length,
    before: removedBefore,
  };
}

function listStatus(view: List, traversal: Traversal | undefined, updatePending: boolean) {
  if (view.pending === 'latest') return 'Loading the latest discussions…';
  if (view.pending && view.goal) return 'Restoring your place…';
  if (view.pending === 'initial') return 'Loading discussions…';
  if (view.pending === 'append') return 'Loading more discussions…';
  if (!traversal) return null;
  if (traversal.complete) {
    if (traversal.rows.length) return 'End of discussions.';
    return updatePending ? 'No discussions in this list.' : 'No discussions yet.';
  }
  const count = traversal.rows.length;
  if (!count) return 'More discussions may be available.';
  return `${count} ${count === 1 ? 'discussion' : 'discussions'} loaded`;
}

type Props = {
  topicId: string;
  self: Self;
  restoration?: TopicDiscussionPosition | undefined;
  rememberPosition?: ((position: TopicDiscussionPosition) => void) | undefined;
  positionRef?: Ref<TopicDiscussionBrowserHandle> | undefined;
};

export type TopicDiscussionBrowserHandle = {
  captureReturnPosition: () => TopicDiscussionPosition | undefined;
};

export function TopicDiscussionBrowser(props: Props) {
  return <DiscussionList key={props.topicId} {...props} />;
}

function DiscussionList({ topicId, self, restoration, rememberPosition, positionRef }: Props) {
  const authority = useAuthorization();
  const [view, setView] = useState<List>({ pending: 'initial', goal: restoration });
  const current = useRef(view);
  const request = useRef<ListRequest | undefined>(undefined);
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
  function interruptRead() {
    if (!request.current) return;
    const active = request.current;
    request.current = undefined;
    active.controller.abort();
    interaction.current?.stop();
    const { pending, goal, traversal } = current.current;
    publish({
      ...current.current,
      pending: undefined,
      failure: goal && traversal ? 'restore' : pending,
    });
  }
  const freshness = useTopicDiscussionFreshness(topicId, self, {
    rows: () => current.current.traversal?.rows ?? [],
    interruptRead,
    retag(updated) {
      const traversal = current.current.traversal;
      if (!traversal || !updated.size) return;
      const rows = traversal.rows.map((row) => {
        const tags = updated.get(watchedTopicDiscussionKey(row));
        if (!tags || tags.every((tag, index) => tag === row.discussion_observation_tags?.[index]))
          return row;
        return { ...row, discussion_observation_tags: tags };
      });
      if (rows.some((row, index) => row !== traversal.rows[index]))
        publish({ ...current.current, traversal: { ...traversal, rows } });
    },
    withdraw(tags, before) {
      const withdrawn = request.current?.withdrawn;
      if (withdrawn) {
        // A held page may contain a source that has just lost authority. Keep
        // bounded negative evidence until that read settles, including Back.
        for (const tag of tags) {
          withdrawn.add(tag);
          if (withdrawn.size > maxOverlappingWithdrawalTags) {
            interruptRead();
            break;
          }
        }
      }
      const traversal = current.current.traversal;
      if (!traversal) return { removed: 0, before: 0 };
      const result = withdrawRows(traversal, tags, before);
      if (result.removed) publish({ ...current.current, traversal: result.traversal });
      return result;
    },
  });

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
    const active: ListRequest = { controller };
    request.current = active;
    const live = () =>
      request.current === active && owner === identityGeneration() && authority.current(generation);
    const tracked = goal || action === 'latest' ? watchTopicNavigationInteraction() : undefined;
    interaction.current = tracked;
    const hadFooterFocus = document.activeElement === footerAction.current;
    publish({ traversal: prior, pending: action, goal, restartRequired });

    try {
      const baseline = fresh ? await freshness.prepare(controller.signal) : undefined;
      if (!live()) return;
      for (let i = 0; i < (goal ? restorationPageBudget : 1); i++) {
        const cursor = traversal?.next;
        // A newly dispatched page rechecks authority, including restorations.
        const withdrawn = (active.withdrawn = new Set());
        const result = await authority.readAuthorized<PageView>(
          `/api/v1/areas/${topicId}/discussions?` +
            new URLSearchParams({
              order: TOPIC_DISCUSSION_ORDER,
              observe: '1',
              ...(cursor ? { cursor } : {}),
            }),
          { schema: Page, signal: controller.signal },
        );
        if (!live() || !authority.current(result.generation)) return;
        const authorized = withdrawRows(
          acceptPage(
            cursor ? current.current.traversal : undefined,
            result.value,
            result.generation,
            topicId,
          ),
          withdrawn,
        );
        traversal = authorized.traversal;
        if (fresh && i === 0) freshness.accept(baseline, authorized.removed > 0);
        const anchorFound =
          goal &&
          (!goal.discussionId ||
            traversal.rows.some((row) => row.discussion_id === goal.discussionId));
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
        traversal: current.current.traversal,
        failure: changed ? 'changed' : goal && traversal ? 'restore' : action,
        restartRequired: changed || restartRequired,
        goal,
      });
    } finally {
      if (request.current === active) request.current = undefined;
      if (positionPlan.current?.interaction !== tracked) tracked?.stop();
    }
  }

  // A topic remount starts with current reads. Navigation records contain only
  // a restoration goal and cannot contribute a row or cursor to this request.
  useEffect(() => {
    void load('initial', restoration);
    return () => {
      request.current?.controller.abort();
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
      } else if (plan.target.discussionId) {
        const row = section.current?.querySelector<HTMLAnchorElement>(
          `[data-discussion-id="${plan.target.discussionId}"]`,
        );
        if (row) {
          row.focus({ preventScroll: true });
          const top = row.getBoundingClientRect().top - plan.target.offset;
          if (Math.abs(top) > 1) window.scrollBy({ top, behavior: 'instant' });
        }
      } else {
        latestAction.current?.focus({ preventScroll: true });
        section.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    }
    plan.interaction.stop();
  }, [authority, view]);

  const traversal = authority.current(view.traversal?.generation) ? view.traversal : undefined;
  useImperativeHandle(positionRef, () => ({ captureReturnPosition: () => capturePosition() }));
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
  function capturePosition(clickedRow?: HTMLAnchorElement): TopicDiscussionPosition | undefined {
    if (!traversal || !authority.current(traversal.generation)) return;
    const goal = clickedRow ? view.goal : undefined;
    const tailId = goal?.tailId ?? traversal.rows.at(-1)?.discussion_id;
    const extent = {
      pages: Math.max(traversal.requested.size, goal?.pages ?? 0),
      ...(tailId ? { tailId } : {}),
    };
    const rows = clickedRow
      ? [clickedRow]
      : (section.current?.querySelectorAll<HTMLAnchorElement>('[data-discussion-id]') ?? []);
    for (const row of rows) {
      const { top, bottom } = row.getBoundingClientRect();
      const discussionId = row.dataset.discussionId;
      if (discussionId && (clickedRow || (top >= 0 && top < window.innerHeight && bottom > top)))
        return { ...extent, discussionId, offset: top };
    }
    return extent;
  }
  function opening(event: MouseEvent<HTMLAnchorElement>) {
    if (!isTopicNavigationClick(event)) return;
    const position = capturePosition(event.currentTarget);
    if (position) rememberPosition?.(position);
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
        <p
          className="topic-discussion-freshness"
          role="status"
          aria-label="Discussion list updates"
        >
          {freshness.change === 'new_discussions' && <strong>New discussions available</strong>}
          {freshness.change === 'updated' && <strong>Discussions updated</strong>}
          {freshness.failed && (
            <>
              {' '}
              <span>Couldn’t check for updates. Retrying…</span>
            </>
          )}
        </p>
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
          {listStatus(view, traversal, freshness.change !== 'none')}
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
  opening: (event: MouseEvent<HTMLAnchorElement>) => void;
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
        onClick={opening}
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
