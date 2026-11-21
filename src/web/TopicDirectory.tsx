import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  OrganizationPage,
  type OrganizationPageView,
  type OrganizationResourceView,
} from '../contracts/organization.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration } from './participation-client.js';

type Traversal = {
  rows: OrganizationResourceView[];
  version: number;
  next: string | null;
  cursors: Set<string>;
  generation: number | undefined;
};
type Action = 'initial' | 'append' | 'reload';
type DirectoryView = {
  traversal?: Traversal;
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
  return { rows, version: page.hierarchy_version, next, cursors, generation };
}

export function topicDescriptionPreview(description: string | null) {
  const characters = [...(description ?? '')];
  return characters.length > 160
    ? { text: characters.slice(0, 160).join('').trimEnd() + '…', shortened: true }
    : { text: description, shortened: false };
}

export function TopicDirectory({ parent }: { parent?: string }) {
  const parentId = parent?.toLowerCase() ?? null;
  return <Directory key={parentId ?? 'root'} parent={parentId} />;
}

function Directory({ parent }: { parent: string | null }) {
  const authority = useAuthorization();
  const [view, setView] = useState<DirectoryView>({ pending: 'initial' });
  const current = useRef(view);
  const request = useRef<AbortController | undefined>(undefined);
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
    const progress = prior.traversal;
    if (!authority.active() || (progress && !authority.current(progress.generation))) return;
    const cursor = action === 'append' ? progress?.next : null;
    if (action === 'append' && (!cursor || prior.needsReload)) return;
    // Reload may replace an in-flight append, but each traversal advances only
    // from an accepted page. A failed append leaves this cursor available to retry.
    if (request.current && (action !== 'reload' || prior.pending !== 'append')) return;

    const controller = new AbortController();
    const owner = identityGeneration();
    const generation = authority.capture();
    const live = () =>
      request.current === controller &&
      owner === identityGeneration() &&
      authority.current(generation);
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

    request.current?.abort();
    request.current = controller;
    publish({ ...prior, pending: action });
    try {
      const query = new URLSearchParams();
      if (parent) query.set('parent_id', parent);
      if (cursor) query.set('cursor', cursor);
      const result = await authority.readAuthorized<OrganizationPageView>(
        `/api/v1/organization/children${query.size ? '?' + query : ''}`,
        { schema: OrganizationPage, signal: controller.signal },
      );
      if (!live() || !authority.current(result.generation)) return;
      const traversal = acceptPage(
        result.value,
        parent,
        result.generation,
        cursor ? progress : undefined,
      );
      if (!traversal.next) focusWhenRemoved('status');
      // An initial retry can turn into a continuation without replacing its control.
      publish({ traversal });
    } catch (error) {
      if (!live()) return;
      const changed =
        action === 'append' &&
        (error instanceof InconsistentPage ||
          (error instanceof ApiError && error.code === 'invalid_cursor'));
      if (changed) focusWhenRemoved('reload');
      publish({
        ...(progress ? { traversal: progress } : {}),
        failure: changed ? 'changed' : action,
        needsReload: changed || !!prior.needsReload,
      });
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }

  useEffect(() => {
    void load('initial');
    return () => {
      request.current?.abort();
      request.current = undefined;
    };
  }, [authority]);

  useLayoutEffect(() => {
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
  const { pending, failure, needsReload } = view;
  const rows = traversal?.rows ?? [];
  let message = '';
  if (pending) {
    message = {
      initial: `Loading ${noun}…`,
      append: `Loading more ${noun}…`,
      reload: `Reloading ${noun}…`,
    }[pending];
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
      reload: `${label} could not be reloaded.`,
      initial: `${label} could not be loaded.`,
    }[failure];

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
                <Link to={'/loom/area/' + area.resource_id}>{area.title}</Link>
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
          {((traversal?.next && !needsReload) || failure === 'initial') && (
            <button
              ref={footerAction}
              type="button"
              aria-disabled={!!pending}
              onClick={() => {
                if (!pending) void load(traversal ? 'append' : 'initial');
              }}
            >
              {failure === 'initial'
                ? `Retry ${noun}`
                : failure === 'append'
                  ? `Retry loading more ${noun}`
                  : `Load more ${noun}`}
            </button>
          )}
          {traversal && (
            <button
              ref={reloadAction}
              type="button"
              className={needsReload ? undefined : 'text-button'}
              aria-disabled={!!pending && pending !== 'append'}
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
