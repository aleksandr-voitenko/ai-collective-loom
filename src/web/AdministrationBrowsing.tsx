import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdministrationPageView,
  IdentityAuditRecordView,
} from '../contracts/administration.js';
import { useAuthorization, type AuthorizedValue } from './AuthorizationBoundary.js';
import { identityGeneration, type Self } from './participation-client.js';
import { ErrorText } from './participation-ui.js';

/** One mounted page and at most sixteen earlier positions, never accumulated rows. */
export function useAdministrationPage<T>(
  collection: 'accounts' | 'credentials' | 'audit',
  self: Self,
  participantId?: string,
) {
  const authority = useAuthorization();
  const [result, setResult] = useState<AuthorizedValue<AdministrationPageView<T>>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0),
    controller = useRef<AbortController | undefined>(undefined);
  const live = useRef(false);
  const positions = useRef<(string | undefined)[]>([]);
  const displayed = useRef<string | undefined>(undefined);
  const failed = useRef<
    { cursor: string | undefined; direction: 'first' | 'next' | 'previous' } | undefined
  >(undefined);
  const requestGeneration = useRef<number | undefined>(
    authority.getSnapshot().state === 'withdrawn' ? undefined : authority.capture(),
  );
  const load = useCallback(
    async (cursor: string | undefined, direction: 'first' | 'next' | 'previous') => {
      if (!live.current) return;
      const attempt = ++sequence.current,
        owner = identityGeneration();
      controller.current?.abort();
      const signal = new AbortController();
      controller.current = signal;
      setBusy(true);
      setError('');
      try {
        const value = await authority.readAuthorized<AdministrationPageView<T>>(
          '/api/v1/identity/' + collection + '/query',
          {
            signal: signal.signal,
            self,
            body: {
              limit: 25,
              ...(participantId ? { participant_id: participantId } : {}),
              ...(cursor ? { cursor } : {}),
            },
          },
        );
        if (
          attempt !== sequence.current ||
          owner !== identityGeneration() ||
          !authority.current(value.generation)
        )
          return;
        if (direction === 'first') positions.current = [];
        else if (direction === 'next')
          positions.current = [...positions.current.slice(-15), displayed.current];
        else positions.current.pop();
        displayed.current = cursor;
        failed.current = undefined;
        requestGeneration.current = value.generation;
        setResult(value);
      } catch (failure) {
        if (
          attempt === sequence.current &&
          owner === identityGeneration() &&
          !signal.signal.aborted
        ) {
          failed.current = { cursor, direction };
          setError((failure as Error).message);
        }
      } finally {
        if (attempt === sequence.current) setBusy(false);
      }
    },
    [authority, collection, participantId, self],
  );
  useEffect(() => {
    live.current = true;
    if (authority.current(requestGeneration.current)) void load(undefined, 'first');
    return () => {
      live.current = false;
      sequence.current++;
      controller.current?.abort();
    };
  }, [authority, load]);
  const data = result && authority.current(result.generation) ? result.value : undefined;
  const refresh = () => {
    if (!busy) void load(undefined, 'first');
  };
  return {
    data,
    generation: result?.generation,
    busy,
    error,
    refresh,
    refreshIfCurrent: () => {
      if (authority.current(requestGeneration.current)) refresh();
    },
    next: () => {
      if (!busy && data?.next_cursor) void load(data.next_cursor, 'next');
    },
    previous: () => {
      if (!busy && positions.current.length && data)
        void load(positions.current.at(-1), 'previous');
    },
    canPrevious: !!data && positions.current.length > 0,
    retry: () => {
      if (!busy && failed.current) void load(failed.current.cursor, failed.current.direction);
    },
  };
}

export function AdministrationPageControls({
  page,
  name,
}: {
  page: ReturnType<typeof useAdministrationPage<unknown>>;
  name: string;
}) {
  return (
    <>
      <div className="actions" aria-label={name + ' paging'}>
        <button aria-disabled={page.busy} onClick={page.refresh}>
          Refresh {name}
        </button>
        <button aria-disabled={page.busy || !page.canPrevious} onClick={page.previous}>
          Previous {name} page
        </button>
        <button aria-disabled={page.busy || !page.data?.next_cursor} onClick={page.next}>
          Next {name} page
        </button>
        {page.error && (
          <button aria-disabled={page.busy} onClick={page.retry}>
            Retry {name} page
          </button>
        )}
      </div>
      <ErrorText error={page.error} />
      <p role="status">
        {page.busy
          ? 'Loading ' + name + ' page…'
          : page.data?.complete
            ? 'End of ' + name + ' results for this traversal.'
            : page.data
              ? 'More ' + name + ' results available.'
              : 'Refresh to check current access.'}
      </p>
    </>
  );
}

function AuditPage({ self }: { self: Self }) {
  const page = useAdministrationPage<IdentityAuditRecordView>('audit', self);
  return (
    <>
      <AdministrationPageControls page={page} name="audit" />
      {page.data?.items.map((row) => (
        <article className="list-row" key={row.id} data-audit-id={row.id}>
          <div>
            <strong>{row.action}</strong>
            <p>
              {row.recorded_at} · {row.authority}
            </p>
            <p>
              Actor: <code>{row.actor_id ?? 'Deployment authority'}</code> · Credential:{' '}
              <code>{row.actor_credential_id ?? 'None'}</code>
            </p>
            <p>
              Target: <code>{row.target_id}</code> · Operation: <code>{row.operation_id}</code>
            </p>
          </div>
        </article>
      ))}
    </>
  );
}
export function IdentityAuditBrowsing({ self }: { self: Self }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="card admin-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Identity administration audit</summary>
      <p>
        Read-only identity and admission history. Refresh after concurrent changes; this is not an
        export checkpoint.
      </p>
      {open && <AuditPage self={self} />}
    </details>
  );
}
