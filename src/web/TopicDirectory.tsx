import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import {
  OrganizationPage,
  type OrganizationPageView,
  type OrganizationResourceView,
} from '../contracts/organization.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration } from './participation-client.js';
import {
  isTopicNavigationClick,
  restorationPageBudget,
  watchTopicNavigationInteraction,
  type TopicDirectoryPosition,
} from './topic-navigation.js';

type Traversal = {
  rows: OrganizationResourceView[];
  pages: number;
  version: number;
  next: string | null;
  cursors: Set<string>;
  generation: number | undefined;
};
type Action = 'initial' | 'append' | 'reload' | 'restore';
type DirectoryView = {
  traversal?: Traversal | undefined;
  goal?: TopicDirectoryPosition | undefined;
  notice?: 'anchor-missing' | 'extent-changed' | undefined;
  pending?: Action;
  failure?: Action | 'changed';
  needsReload?: boolean;
};

class InconsistentPage extends Error {}

function acceptPage(
  page: OrganizationPageView,
  parent: string | null,
  generation: number | undefined,
  previous?: Traversal,
): Traversal {
  const next = page.next_cursor;
  if (
    page.scope !== `children:${parent ?? 'root'}` ||
    (previous && page.hierarchy_version !== previous.version) ||
    page.items.some(
      (item) =>
        item.kind !== 'area' ||
        item.resource_id === parent ||
        item.parent_id !== parent ||
        item.hierarchy_version !== page.hierarchy_version,
    ) ||
    (page.complete ? next !== null : !next?.trim() || previous?.cursors.has(next))
  ) {
    throw new InconsistentPage();
  }

  const rows = [...(previous?.rows ?? [])];
  const seen = new Set(rows.map((row) => row.resource_id));
  for (const item of page.items) {
    if (seen.has(item.resource_id)) continue;
    seen.add(item.resource_id);
    rows.push(item);
  }
  const cursors = new Set(previous?.cursors);
  if (next) cursors.add(next);
  return {
    rows,
    pages: (previous?.pages ?? 0) + 1,
    version: page.hierarchy_version,
    next,
    cursors,
    generation,
  };
}

export function topicDescriptionPreview(description: string | null) {
  const characters = [...(description ?? '')];
  return characters.length > 160
    ? { text: characters.slice(0, 160).join('').trimEnd() + '…', shortened: true }
    : { text: description, shortened: false };
}

type NavigationProps = {
  restoration?: TopicDirectoryPosition | undefined;
  interrupted?: (() => boolean) | undefined;
  rememberPosition?: ((position: TopicDirectoryPosition) => void) | undefined;
  onReload?: (() => void) | undefined;
};

export function TopicDirectory({ parent, ...navigation }: { parent?: string } & NavigationProps) {
  const parentId = parent?.toLowerCase() ?? null;
  return <Directory key={parentId ?? 'root'} parent={parentId} {...navigation} />;
}

type Interaction = ReturnType<typeof watchTopicNavigationInteraction>;

function Directory({
  parent,
  restoration,
  interrupted,
  rememberPosition,
  onReload,
}: { parent: string | null } & NavigationProps) {
  const authority = useAuthorization();
  const [view, setView] = useState<DirectoryView>({ pending: 'initial', goal: restoration });
  const current = useRef(view);
  const initialInteraction = useRef<Interaction>(undefined);
  const request = useRef<{ controller: AbortController; interaction?: Interaction | undefined }>(
    undefined,
  );
  const positionPlan = useRef<{
    anchor?: TopicDirectoryPosition;
    interaction: Interaction;
    automatic: boolean;
  }>(undefined);
  const section = useRef<HTMLElement>(null);
  const footerAction = useRef<HTMLButtonElement>(null);
  const reloadAction = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const focusAfterRemoval = useRef<'status' | 'reload' | undefined>(undefined);
  const noun = parent ? 'subtopics' : 'topics';
  const label = parent ? 'Subtopics' : 'Topics';

  function publish(next: DirectoryView) {
    current.current = next;
    setView(next);
  }

  async function load(action: Action) {
    const prior = current.current;
    const goal = action === 'reload' ? undefined : prior.goal;
    if (!authority.active() || (prior.traversal && !authority.current(prior.traversal.generation)))
      return;
    if (request.current && (action !== 'reload' || prior.pending === 'reload')) return;
    let progress = action === 'append' || action === 'restore' ? prior.traversal : undefined;
    if ((action === 'append' && !progress?.next) || (progress && prior.needsReload)) return;
    if (action === 'reload') onReload?.();

    request.current?.controller.abort();
    request.current?.interaction?.stop();
    positionPlan.current?.interaction.stop();
    positionPlan.current = undefined;
    const controller = new AbortController();
    const owner = identityGeneration();
    const generation = authority.capture();
    const interaction =
      action === 'initial'
        ? initialInteraction.current
        : goal
          ? watchTopicNavigationInteraction()
          : undefined;
    const active = { controller, interaction };
    request.current = active;
    const live = () =>
      request.current === active &&
      section.current?.isConnected &&
      owner === identityGeneration() &&
      authority.current(generation);
    // The automatic batch inherits input during the parent's metadata read. A
    // focused Continue or Retry starts a new batch with its own interaction witness.
    const paused = () =>
      interaction?.interrupted() ||
      (action === 'initial' && interrupted?.()) ||
      section.current?.closest('details:not([open])');
    const initiatingControl =
      document.activeElement === footerAction.current && footerAction.current;
    function focusWhenRemoved(target: 'status' | 'reload') {
      if (
        initiatingControl &&
        document.activeElement === initiatingControl &&
        !section.current?.closest('details:not([open])')
      ) {
        focusAfterRemoval.current = target;
      }
    }

    publish({ ...prior, pending: action, goal });
    try {
      const budget = goal ? restorationPageBudget : 1;
      for (let read = 1; read <= budget; read++) {
        const query = new URLSearchParams();
        if (parent) query.set('parent_id', parent);
        if (progress?.next) query.set('cursor', progress.next);
        const result = await authority.readAuthorized<OrganizationPageView>(
          `/api/v1/organization/children${query.size ? '?' + query : ''}`,
          { schema: OrganizationPage, signal: controller.signal },
        );
        if (!live() || !authority.current(result.generation)) return;
        progress = acceptPage(result.value, parent, result.generation, progress);
        if (!progress.next) focusWhenRemoved('status');
        if (!goal) {
          publish({ traversal: progress });
          return;
        }
        const hasAnchor = progress.rows.some((row) => row.resource_id === goal.topicId);
        const extentReached =
          progress.pages >= goal.pages &&
          (!goal.tailId || progress.rows.some((row) => row.resource_id === goal.tailId));
        const restored = hasAnchor && extentReached;
        if (!restored && progress.next && read < budget && !paused()) {
          publish({ traversal: progress, pending: action, goal });
          continue;
        }
        const automatic = action === 'initial';
        if (
          interaction &&
          !paused() &&
          (automatic || (initiatingControl && document.activeElement === initiatingControl))
        )
          positionPlan.current = { interaction, automatic, ...(hasAnchor ? { anchor: goal } : {}) };
        publish({
          traversal: progress,
          goal: restored || !progress.next ? undefined : goal,
          notice:
            !restored && !progress.next
              ? hasAnchor
                ? 'extent-changed'
                : 'anchor-missing'
              : undefined,
        });
        return;
      }
    } catch (error) {
      if (!live()) return;
      const changed =
        (action === 'append' || !!goal) &&
        (error instanceof InconsistentPage ||
          (error instanceof ApiError && error.code === 'invalid_cursor'));
      if (changed) focusWhenRemoved('reload');
      publish({
        traversal: current.current.traversal,
        goal,
        failure: changed ? 'changed' : goal ? 'restore' : action,
        needsReload: changed || !!prior.needsReload,
      });
    } finally {
      if (request.current === active) request.current = undefined;
      if (positionPlan.current?.interaction !== interaction) interaction?.stop();
    }
  }

  // Observe input from the directory's first commit, including the interval
  // before the passive effect dispatches the first page.
  useLayoutEffect(() => {
    if (!restoration) return;
    const witness = watchTopicNavigationInteraction();
    initialInteraction.current = witness;
    return witness.stop;
  }, [authority]);
  useEffect(() => {
    void load('initial');
    return () => {
      request.current?.controller.abort();
      request.current?.interaction?.stop();
      request.current = undefined;
      positionPlan.current?.interaction.stop();
      positionPlan.current = undefined;
    };
  }, [authority]);

  useLayoutEffect(() => {
    const plan = positionPlan.current;
    positionPlan.current = undefined;
    if (plan) {
      const mayPosition =
        !plan.interaction.interrupted() &&
        !(plan.automatic && interrupted?.()) &&
        authority.current(view.traversal?.generation) &&
        !section.current?.closest('details:not([open])');
      plan.interaction.stop();
      if (mayPosition && plan.anchor) {
        const link = section.current?.querySelector<HTMLAnchorElement>(
          `[data-topic-id="${plan.anchor.topicId}"]`,
        );
        if (link) {
          link.focus({ preventScroll: true });
          const top = link.getBoundingClientRect().top - plan.anchor.offset;
          if (Math.abs(top) > 1) window.scrollBy({ top, behavior: 'instant' });
        }
      } else if (mayPosition) {
        status.current?.focus({ preventScroll: true });
        status.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
      }
    }
    const target = focusAfterRemoval.current;
    focusAfterRemoval.current = undefined;
    if (
      target &&
      document.activeElement === document.body &&
      section.current?.isConnected &&
      !section.current.closest('details:not([open])')
    ) {
      (target === 'status' ? status : reloadAction).current?.focus({ preventScroll: true });
    }
  });

  const traversal = authority.current(view.traversal?.generation) ? view.traversal : undefined;
  const { pending, failure, goal, needsReload } = view;
  const rows = traversal?.rows ?? [];
  let message = '';
  if (pending && goal) {
    message = 'Restoring your place…';
  } else if (pending) {
    message = {
      initial: `Loading ${noun}…`,
      append: `Loading more ${noun}…`,
      reload: `Reloading ${noun}…`,
      restore: 'Restoring your place…',
    }[pending];
  } else if (view.notice === 'anchor-missing') {
    message = 'Your previous place is no longer in this list.';
  } else if (view.notice === 'extent-changed') {
    message = 'The list changed while you were away.';
  } else if (goal && !needsReload && !failure) {
    message = 'Your previous place hasn’t been fully restored.';
  } else if (traversal) {
    if (traversal.next) {
      message = rows.length ? `${rows.length} ${noun} loaded` : `More ${noun} may be available.`;
    } else {
      message = rows.length
        ? `All ${noun} loaded.`
        : parent
          ? 'No subtopics yet.'
          : 'No topics here yet.';
    }
  }
  const error =
    !pending &&
    failure &&
    {
      changed: `This list needs refreshing before more ${noun} can be loaded.`,
      append: `More ${noun} could not be loaded.`,
      restore: `Your place in ${noun} could not be restored.`,
      reload: `${label} could not be reloaded.`,
      initial: `${label} could not be loaded.`,
    }[failure];

  function opening(event: MouseEvent<HTMLAnchorElement>, topicId: string) {
    if (!traversal || !authority.current(traversal.generation) || !isTopicNavigationClick(event))
      return;
    // Reload retains readable rows until the new first page succeeds. A reader
    // can still open one, but its old traversal is no longer the return extent.
    const latest = current.current;
    const retainedByReload = latest.pending === 'reload' || latest.failure === 'reload';
    const tailId = retainedByReload
      ? undefined
      : (latest.goal?.tailId ?? traversal.rows.at(-1)?.resource_id);
    rememberPosition?.({
      pages: retainedByReload ? 1 : Math.max(latest.goal?.pages ?? 0, traversal.pages),
      ...(tailId ? { tailId } : {}),
      topicId,
      offset: event.currentTarget.getBoundingClientRect().top,
    });
  }

  let footerLabel: string | undefined;
  if (goal && !needsReload && (!pending || pending === 'restore'))
    footerLabel = failure === 'restore' ? `Retry restoring ${noun}` : `Continue restoring ${noun}`;
  else if (!goal && failure === 'initial') footerLabel = `Retry ${noun}`;
  else if (!goal && traversal?.next && !needsReload)
    footerLabel = failure === 'append' ? `Retry loading more ${noun}` : `Load more ${noun}`;

  return (
    <section
      ref={section}
      className="topic-browser"
      aria-label={parent ? 'Subtopics' : 'Root topics'}
    >
      {rows.length > 0 && (
        <ul className="topic-browser-rows" role="list">
          {rows.map((area) => {
            const { text } = topicDescriptionPreview(area.description);
            return (
              <li key={area.resource_id}>
                <Link
                  to={'/loom/area/' + area.resource_id}
                  data-topic-id={area.resource_id}
                  onClick={(event) => opening(event, area.resource_id)}
                >
                  {area.title}
                </Link>
                {text && <p>{text}</p>}
                {!area.publication_open && <small>Closed to contributions</small>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="topic-browser-footer">
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <p ref={status} tabIndex={-1} role="status">
          {message}
        </p>
        <div className="topic-browser-actions">
          {footerLabel && (
            <button
              ref={footerAction}
              type="button"
              aria-disabled={!!pending}
              onClick={() => {
                if (!pending) void load(goal ? 'restore' : traversal ? 'append' : 'initial');
              }}
            >
              {footerLabel}
            </button>
          )}
          {(traversal || goal || pending === 'reload' || failure === 'reload') && (
            <button
              ref={reloadAction}
              type="button"
              className={needsReload ? undefined : 'text-button'}
              aria-disabled={pending === 'reload'}
              onClick={() => void load('reload')}
            >
              {failure === 'reload' ? `Retry reloading ${noun}` : `Reload ${noun}`}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
