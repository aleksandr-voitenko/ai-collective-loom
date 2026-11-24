import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import {
  OrganizationPage,
  type DirectoryObservationView,
  type OrganizationPageView,
  type OrganizationResourceView,
} from '../contracts/organization.js';
import { useTopicDirectoryObservation } from './useTopicDirectoryObservation.js';
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
  observation: DirectoryObservationView;
  pages: number;
  version: number;
  next: string | null;
  cursors: Set<string>;
  generation: number | undefined;
};
type Action = 'initial' | 'append' | 'reload' | 'restore';
type ReadingAnchor = { topicId: string; offset: number };
type UpdateGoal = {
  pages: number;
  tailId?: string | undefined;
  anchorId?: string | undefined;
  returnId?: string | undefined;
};
type Replacement = {
  goal: UpdateGoal;
  progress?: Traversal | undefined;
  state: 'preparing' | 'continue' | 'retry' | 'restart';
};
type DirectoryView = {
  replacement?: Replacement;
  applied?: 'updated' | 'anchor-missing';
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
  const observation = previous?.observation ?? page.observation;
  if (
    !observation ||
    observation.parent_id !== parent ||
    observation.hierarchy_version !== page.hierarchy_version ||
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
    observation,
    pages: (previous?.pages ?? 0) + 1,
    version: page.hierarchy_version,
    next,
    cursors,
    generation,
  };
}

function nearestSurvivor(
  previous: OrganizationResourceView[],
  current: OrganizationResourceView[],
  ids: Set<string>,
  anchor: ReadingAnchor,
): ReadingAnchor | undefined {
  const index = previous.findIndex((row) => row.resource_id === anchor.topicId);
  for (let distance = 1; distance < previous.length; distance++) {
    const neighbor = [previous[index + distance], previous[index - distance]].find(
      (row) => row && ids.has(row.resource_id),
    );
    if (neighbor) return { ...anchor, topicId: neighbor.resource_id };
  }
  const row = current[Math.min(Math.max(0, index), current.length - 1)];
  return row && { ...anchor, topicId: row.resource_id };
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
    anchor?: ReadingAnchor;
    update?: boolean;
    focusFallback?: boolean;
    interaction: Interaction;
    automatic: boolean;
  }>(undefined);
  const section = useRef<HTMLElement>(null);
  const footerAction = useRef<HTMLButtonElement>(null);
  const reloadAction = useRef<HTMLButtonElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const updateAction = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const focusAfterRemoval = useRef<'status' | 'reload' | undefined>(undefined);
  const noun = parent ? 'subtopics' : 'topics';
  const label = parent ? 'Subtopics' : 'Topics';

  const traversal = authority.current(view.traversal?.generation) ? view.traversal : undefined;
  const observation = useTopicDirectoryObservation(
    parent,
    section,
    traversal?.observation,
    !!traversal?.next,
  );

  async function readPage(controller: AbortController, previous?: Traversal) {
    const query = new URLSearchParams();
    if (parent) query.set('parent_id', parent);
    if (previous?.next) query.set('cursor', previous.next);
    else query.set('observe', '1');
    return authority.readAuthorized<OrganizationPageView>(
      '/api/v1/organization/children?' + query,
      { schema: OrganizationPage, signal: controller.signal },
    );
  }
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
    if (action !== 'reload' && prior.replacement) return;
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

    publish({ traversal: prior.traversal, pending: action, goal });
    try {
      const budget = goal ? restorationPageBudget : 1;
      for (let read = 1; read <= budget; read++) {
        const result = await readPage(controller, progress);
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
      if (owner === identityGeneration() && authority.active()) observation.deferChecks(error);
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

  function visibleAnchor(): ReadingAnchor | undefined {
    const links = section.current?.querySelectorAll<HTMLAnchorElement>('a[data-topic-id]');
    if (!links) return;
    const visibleTop = Math.max(0, toolbar.current?.getBoundingClientRect().bottom ?? 0);
    const visible = ({ top, bottom }: DOMRect) =>
      bottom > visibleTop && top < window.innerHeight && bottom > top;
    const focused = section.current?.querySelector<HTMLAnchorElement>('a[data-topic-id]:focus');
    if (focused) {
      const rect = focused.getBoundingClientRect();
      if (visible(rect)) return { topicId: focused.dataset.topicId!, offset: rect.top };
    }
    for (const link of links) {
      const rect = link.getBoundingClientRect();
      // A title can already be behind the sticky controls while its description
      // is still the first thing the reader sees.
      if (
        visible(rect) ||
        (link.parentElement && visible(link.parentElement.getBoundingClientRect()))
      )
        return { topicId: link.dataset.topicId!, offset: rect.top };
    }
  }

  async function applyUpdate() {
    const prior = current.current;
    const retained = prior.traversal;
    if (!retained || request.current || !authority.current(retained.generation)) return;
    const anchor = visibleAnchor();
    const goal = prior.replacement?.goal ?? {
      pages: Math.max(retained.pages, prior.goal?.pages ?? 0),
      tailId: prior.goal?.tailId ?? retained.rows.at(-1)?.resource_id,
      anchorId: anchor?.topicId,
      returnId: prior.goal?.topicId,
    };
    let progress = prior.replacement?.progress;
    const controller = new AbortController();
    const interaction = watchTopicNavigationInteraction(undefined, 'update');
    const active = { controller, interaction };
    request.current = active;
    const owner = identityGeneration();
    const live = () =>
      request.current === active &&
      section.current?.isConnected &&
      owner === identityGeneration() &&
      authority.current(retained.generation);
    publish({ ...prior, replacement: { goal, progress, state: 'preparing' } });
    try {
      for (let read = 0; read < restorationPageBudget; read++) {
        const result = await readPage(controller, progress);
        if (!live() || !authority.current(result.generation)) return;
        progress = acceptPage(result.value, parent, result.generation, progress);
        const ids = new Set(progress.rows.map((row) => row.resource_id));
        const reached =
          progress.pages >= goal.pages &&
          [goal.tailId, goal.anchorId, goal.returnId].every((id) => !id || ids.has(id));
        if (!progress.next || reached) {
          const missingAnchor = !!anchor && !ids.has(anchor.topicId);
          const target = missingAnchor
            ? nearestSurvivor(retained.rows, progress.rows, ids, anchor)
            : anchor;
          if (anchor && !interaction.interrupted()) {
            positionPlan.current = {
              interaction,
              automatic: false,
              update: true,
              focusFallback:
                missingAnchor &&
                document.activeElement instanceof HTMLElement &&
                document.activeElement.dataset.topicId === anchor.topicId,
              ...(target ? { anchor: target } : {}),
            };
          }
          // Commit the first page's boundary together with the fully prepared traversal.
          publish({
            traversal: progress,
            applied:
              missingAnchor || (goal.anchorId && !ids.has(goal.anchorId))
                ? 'anchor-missing'
                : 'updated',
          });
          return;
        }
      }
      publish({ ...prior, replacement: { goal, progress, state: 'continue' } });
    } catch (error) {
      if (owner === identityGeneration() && authority.active()) observation.deferChecks(error);
      if (!live()) return;
      const changed =
        error instanceof InconsistentPage ||
        (error instanceof ApiError && error.code === 'invalid_cursor');
      // A temporary failure retries the failed cursor. An incompatible prefix must
      // be discarded, and restarting it always requires another explicit action.
      publish({
        ...prior,
        replacement: changed ? { goal, state: 'restart' } : { goal, progress, state: 'retry' },
      });
    } finally {
      if (request.current === active) request.current = undefined;
      if (positionPlan.current?.interaction !== interaction) interaction.stop();
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
          if (!plan.update || plan.focusFallback) link.focus({ preventScroll: true });
          const top = link.getBoundingClientRect().top - plan.anchor.offset;
          if (Math.abs(top) > 1) window.scrollBy({ top, behavior: 'instant' });
        }
      } else if (mayPosition && plan.update) {
        // All rows moved away. Keep the directory's empty state within reach.
        if (plan.focusFallback) updateAction.current?.focus({ preventScroll: true });
        section.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      } else if (mayPosition && !plan.update) {
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

  const { pending, failure, goal, needsReload } = view;
  const rows = traversal?.rows ?? [];
  const countedNoun = rows.length === 1 ? (parent ? 'subtopic' : 'topic') : noun;
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
      message = rows.length
        ? `${rows.length} ${countedNoun} loaded`
        : `More ${noun} may be available.`;
    } else if (observation.pending) {
      message = rows.length ? `${rows.length} ${countedNoun} shown` : `No ${noun} in this view.`;
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

  const replacement = view.replacement?.state;
  const showUpdated = `Show updated ${noun}`;
  const operations = {
    preparing: { action: showUpdated, status: `Updating ${noun}…` },
    continue: {
      action: `Continue updating ${noun}`,
      status: 'Continue to rebuild the rest of this list.',
    },
    retry: {
      action: `Retry updating ${noun}`,
      status: `Couldn’t update ${noun}. Your list is still here.`,
    },
    restart: {
      action: 'Restart update',
      status: 'Organization changed again. Restart this update.',
    },
  };
  const operation = replacement && operations[replacement];
  const updateLabel = operation?.action ?? showUpdated;
  let updateNotice = '';
  if (operation) updateNotice = operation.status;
  else if (observation.pending === 'updated') updateNotice = `${label} updated`;
  else if (observation.pending === 'organization')
    updateNotice = 'Topic organization changed. Update this list to continue.';
  else if (view.applied === 'anchor-missing')
    updateNotice = 'Your previous place is no longer in this list.';
  else if (view.applied) updateNotice = 'Showing the updated list.';
  const updateBusy = !!pending || replacement === 'preparing';
  return (
    <section
      ref={section}
      className="topic-browser"
      aria-label={parent ? 'Subtopics' : 'Root topics'}
    >
      {traversal && (
        <div ref={toolbar} className="topic-directory-updates" aria-label={`${label} updates`}>
          <button
            ref={updateAction}
            type="button"
            className="text-button"
            aria-disabled={updateBusy}
            onClick={() => {
              if (!updateBusy) void applyUpdate();
            }}
          >
            {updateLabel}
          </button>
          <div aria-live="polite" aria-atomic="true" className="topic-directory-update-status">
            {updateNotice && <strong>{updateNotice}</strong>}
            {observation.failed && <span>Couldn’t check for updates. Retrying…</span>}
          </div>
        </div>
      )}
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
              aria-disabled={!!pending || !!replacement || observation.continuationStale}
              onClick={() => {
                if (!pending && !replacement && !observation.continuationStale)
                  void load(goal ? 'restore' : traversal ? 'append' : 'initial');
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
