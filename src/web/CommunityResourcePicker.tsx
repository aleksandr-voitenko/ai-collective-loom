import { useEffect, useRef, useState } from 'react';
import {
  OrganizationResource,
  OrganizationPage,
  type OrganizationResourceView,
  type OrganizationPageView,
} from '../contracts/organization.js';
import { Page, type PageView } from '../contracts/participation.js';
import { useQuery } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ErrorText } from './participation-ui.js';

export type CommunityResourceKind = 'artifact' | 'area';

function location(resource: OrganizationResourceView) {
  const parts = resource.ancestors.map((part) => part.title);
  if (resource.kind === 'area') parts.push(resource.title);
  return parts.join(' › ') || 'Top level';
}

function Identity({ resource }: { resource: OrganizationResourceView }) {
  return (
    <div className="community-resource-identity">
      <h3>{resource.title}</h3>
      <p>{location(resource)}</p>
    </div>
  );
}

// Resolve only the selected resource or one row of the bounded picker page.
// A failed lookup never changes the retained designation.
export function CommunityResource({
  id,
  kind,
  choose,
}: {
  id: string;
  kind: CommunityResourceKind;
  choose?: (id: string) => void;
}) {
  const authority = useAuthorization();
  const result = useQuery<OrganizationResourceView>(
    '/api/v1/organization/resources/' + id,
    OrganizationResource,
  );
  const resource = result.data?.kind === kind ? result.data : undefined;
  if (authority.getSnapshot().state === 'withdrawn')
    return <p>Resource details are unavailable.</p>;
  return (
    <>
      {resource ? (
        <>
          <Identity resource={resource} />
          {choose && (
            <button
              type="button"
              disabled={kind === 'area' && !resource.publication_open}
              aria-label={'Choose ' + resource.title + ' in ' + location(resource)}
              onClick={() => choose(id)}
            >
              Choose
            </button>
          )}
        </>
      ) : (
        <div>
          <p>
            {result.error || result.data ? 'Could not load this selection.' : 'Loading selection…'}
          </p>
          {(result.error || result.data) && (
            <button type="button" onClick={result.refresh}>
              Retry resource lookup
            </button>
          )}
        </div>
      )}
    </>
  );
}

export function CommunityResourcePicker({
  kind,
  choose,
  close,
}: {
  kind: CommunityResourceKind;
  choose: (id: string) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    opener = useRef(document.activeElement);
  const heading = useRef<HTMLHeadingElement>(null);
  const authority = useAuthorization();
  const [cursor, setCursor] = useState(''),
    [previous, setPrevious] = useState<string[]>([]);
  const query = new URLSearchParams({ limit: '12', ...(cursor ? { cursor } : {}) });
  const result = useQuery<PageView | OrganizationPageView>(
    (kind === 'area' ? '/api/v1/organization/destinations?' : '/api/v1/artifacts?') + query,
    kind === 'area' ? OrganizationPage : Page,
  );
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (opener.current instanceof HTMLElement && opener.current.isConnected)
        opener.current.focus();
    };
  }, []);
  useEffect(() => {
    if (result.data) heading.current?.focus();
  }, [result.data]);
  return (
    <dialog
      ref={dialog}
      className="community-picker"
      aria-labelledby="community-picker-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        const first = buttons[0],
          last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last && first) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h2 id="community-picker-title" ref={heading} tabIndex={-1}>
            {kind === 'area' ? 'Choose a proposal topic' : 'Choose an overview artifact'}
          </h2>
          <p>
            {kind === 'area'
              ? 'Choose where community proposals should be posted.'
              : 'Choose the artifact that introduces your community.'}
          </p>
        </div>
        <button type="button" onClick={close} aria-label="Close resource picker">
          Close
        </button>
      </header>
      <ErrorText error={result.error} />
      {authority.getSnapshot().state === 'withdrawn' ? (
        <p role="alert">Access changed. Close this picker and check access again.</p>
      ) : (
        <>
          {!result.data && !result.error && <p role="status">Loading choices…</p>}
          {result.error && (
            <button type="button" onClick={result.refresh}>
              Retry choices
            </button>
          )}
          <div className="community-picker-list" aria-busy={!result.data && !result.error}>
            {result.data?.items.map((item) => {
              if (!('resource_id' in item)) return null;
              if ('ancestors' in item)
                return (
                  <div className="community-picker-row" key={item.resource_id}>
                    <Identity resource={item} />
                    {!item.publication_open && <span>Closed to proposals</span>}
                    <button
                      type="button"
                      disabled={!item.publication_open}
                      aria-label={'Choose ' + item.title + ' in ' + location(item)}
                      onClick={() => choose(item.resource_id)}
                    >
                      Choose
                    </button>
                  </div>
                );
              return (
                <div className="community-picker-row" key={item.resource_id}>
                  {'state' in item ? (
                    <p>Artifact unavailable</p>
                  ) : (
                    <CommunityResource id={item.resource_id} kind="artifact" choose={choose} />
                  )}
                </div>
              );
            })}
            {result.data && !result.data.items.length && (
              <p>
                {result.data.complete
                  ? 'No choices available.'
                  : 'More choices are available on the next page.'}
              </p>
            )}
          </div>
          <footer>
            <button
              type="button"
              disabled={!cursor && !result.error}
              onClick={() => {
                setCursor('');
                setPrevious([]);
                if (!cursor) result.refresh();
              }}
            >
              First choices
            </button>
            <button
              type="button"
              disabled={!previous.length || !result.data}
              onClick={() => {
                setCursor(previous.at(-1)!);
                setPrevious((pages) => pages.slice(0, -1));
              }}
            >
              Previous choices
            </button>
            <button
              type="button"
              disabled={!result.data?.next_cursor}
              onClick={() => {
                setPrevious((pages) => [...pages, cursor].slice(-16));
                setCursor(result.data!.next_cursor!);
              }}
            >
              Next choices
            </button>
          </footer>
        </>
      )}
    </dialog>
  );
}
