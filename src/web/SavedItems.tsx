import { AuthorizationBoundary, useAuthorization } from './AuthorizationBoundary.js';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Value } from '@sinclair/typebox/value';
import {
  SavedPage,
  SavedUpdate,
  type SavedItemView,
  type SavedPageView,
  type SavedResultView,
  type SavedTargetView,
} from '../contracts/saved-items.js';
import {
  IntentStore,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
  type Self,
} from './participation-client.js';

type Context = { self: Self; store: IntentStore };
const base = '/api/v1/me/saved-items';
function targetKey(target: SavedTargetView) {
  return [
    target.kind,
    target.resource_id,
    target.kind === 'revision' ? target.revision_id : '',
  ].join(':');
}
function pendingRecords(store: IntentStore) {
  return store
    .all()
    .filter((record) => record.kind === 'saved.set')
    .map((record) => {
      if (record.path !== base + '/state' || !Value.Check(SavedUpdate, record.body))
        throw new Error(
          'A Saved items recovery record is incompatible. Export recovery records before continuing.',
        );
      return record;
    });
}
function changed(store: IntentStore) {
  window.dispatchEvent(new CustomEvent('loom-saved-change', { detail: store.prefix }));
}
async function begin(context: Context, current: SavedItemView, saved: boolean) {
  if (!navigator.locks) throw new Error('This browser needs Web Locks to save safely across tabs.');
  // Only one unresolved local command per target. The existing journal still owns
  // quota, identity checks and atomic persistence; no network runs under either lock.
  return navigator.locks.request(
    context.store.prefix + 'saved:' + targetKey(current.target),
    async () => {
      if (
        pendingRecords(context.store).some(
          (record) => record.slot === 'saved:' + targetKey(current.target),
        )
      )
        throw new Error('Resolve the existing Saved items change before choosing another action.');
      const record = context.store.create(
        'saved:' + targetKey(current.target),
        'saved.set',
        base + '/state',
        { target: current.target, saved, expected_version: current.version },
      );
      const retained = await context.store.prepareDispatch(record, record.body);
      changed(context.store);
      return retained;
    },
  );
}
function failureText(error: unknown) {
  return error instanceof Error ? error.message : 'Saved items could not be retrieved.';
}

/** One target's controls own their requests. Server versions additionally stop a
 * late same-target result replacing a newer state observed by this view. */
export function SaveControl({
  target,
  context,
  initial,
  label,
}: {
  target: SavedTargetView;
  context: Context;
  initial?: SavedItemView;
  label?: string;
}) {
  const authority = useAuthorization();
  const [current, setCurrent] = useState(initial),
    [pending, setPending] = useState<Intent>(),
    [sourceGeneration, setSourceGeneration] = useState<number | undefined>(() =>
      initial ? authority.capture() : undefined,
    ),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!initial),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const live = useRef(true),
    owner = useRef(identityGeneration()),
    query = useRef(0),
    version = useRef(initial?.version ?? -1);
  const key = targetKey(target),
    prefix = context.store.prefix;
  const active = () => live.current && owner.current === identityGeneration();
  function accept(item: SavedItemView) {
    if (active() && item.version >= version.current) {
      version.current = item.version;
      setCurrent(item);
    }
  }
  function syncPending() {
    if (active())
      setPending(pendingRecords(context.store).find((record) => record.slot === 'saved:' + key));
  }
  async function refresh() {
    const mine = ++query.current;
    if (active()) {
      setLoading(true);
      setError('');
    }
    try {
      syncPending();
      const { value: item, generation } = await authority.savedLookup(target, context.self);
      if (mine === query.current) {
        accept(item);
        if (active()) setSourceGeneration(generation);
      }
    } catch (failure) {
      if (active() && mine === query.current) setError(failureText(failure));
    } finally {
      if (active() && mine === query.current) setLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    // A list already supplies the initial state. Rehydrating every row on mount
    // would repeatedly invalidate that same fresh mixed page.
    if (!initial) void refresh();
    else syncPending();
    const update = () => {
      void refresh();
    };
    const local = (event: Event) => {
      if ((event as CustomEvent).detail === prefix) update();
    };
    const storage = (event: StorageEvent) => {
      if (event.key?.startsWith(prefix)) update();
    };
    window.addEventListener('loom-saved-change', local);
    window.addEventListener('storage', storage);
    window.addEventListener('focus', update);
    return () => {
      live.current = false;
      query.current++;
      window.removeEventListener('loom-saved-change', local);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', update);
    };
  }, [key, prefix]);
  async function finish(record: Intent, result: SavedResultView) {
    // Even off-route completion may retire a known result, but a different account
    // or already retired key cannot be repopulated by a late response.
    await context.store.complete(record);
    changed(context.store);
    if (!active()) return;
    accept(result.current);
    setPending(undefined);
    setMessage(
      result.operation_state === 'version_conflict'
        ? 'Your change was not applied because another client changed this item. Review its current state before choosing again.'
        : result.outcome.saved !== result.current.saved
          ? `The earlier ${result.outcome.saved ? 'Save' : 'Unsave'} completed. This item is now ${result.current.saved ? 'saved' : 'unsaved'}.`
          : result.current.saved
            ? 'Saved privately.'
            : 'Removed from Saved items.',
    );
  }
  async function mutate(retry?: Intent) {
    if (busy || (!retry && (!current || loading))) return;
    setBusy(true);
    setError('');
    setMessage('');
    let retained: Intent | undefined;
    try {
      retained = retry
        ? await context.store.prepareDispatch(retry, retry.body)
        : await begin(context, current!, !current!.saved);
      if (active()) setPending(retained);
      const result = await authority.savedCommand(retained.body, 'state', context.self);
      if (result.operation_state !== 'not_recorded') await finish(retained, result);
    } catch (failure) {
      if (retained && isDefinitiveRejection(failure, !!retry)) {
        try {
          await context.store.settle(retained, { state: 'rejected' });
          changed(context.store);
        } catch {
          /* Preserve the newer journal record. */
        }
      }
      if (active()) {
        setError(failureText(failure));
        try {
          syncPending();
        } catch (failure) {
          setError(failureText(failure));
        }
      }
    } finally {
      if (active()) setBusy(false);
    }
  }
  async function status() {
    if (!pending || busy) return;
    const record = pending;
    setBusy(true);
    setError('');
    try {
      const result = await authority.savedCommand(
        { idempotency_key: record.key },
        'status',
        context.self,
      );
      if (result.operation_state === 'not_recorded') {
        if (active())
          setMessage(
            'No outcome is recorded yet. The original request may still complete; keep this intent or retry it unchanged.',
          );
      } else await finish(record, result);
    } catch (failure) {
      if (active()) setError(failureText(failure));
    } finally {
      if (active()) setBusy(false);
    }
  }
  const action = current?.saved
    ? 'Unsave'
    : target.kind === 'revision'
      ? 'Save this revision'
      : 'Save';
  return (
    <div className="saved-control" data-saved-target={key}>
      {!pending && (
        <button
          aria-label={label ? `${action} ${label}` : action}
          aria-pressed={current?.saved ?? false}
          disabled={
            busy ||
            loading ||
            !current ||
            (!current.saved &&
              (current.source.state === 'unavailable' || !authority.current(sourceGeneration))) ||
            !!error
          }
          onClick={() => void mutate()}
        >
          {busy ? 'Saving…' : loading && !current ? 'Checking saved state…' : action}
        </button>
      )}
      {pending && (
        <div className="saved-recovery notice">
          <strong>
            {busy
              ? 'Waiting for confirmation…'
              : pending.state === 'rejected'
                ? 'This change was rejected.'
                : 'We couldn’t confirm whether this saved-item change completed.'}
          </strong>
          <p>
            {pending.body.saved ? 'Save' : 'Unsave'} ·{' '}
            {target.kind === 'revision' ? 'Exact revision' : target.kind}. Only your private
            collection is affected.
          </p>
          {pending.state === 'rejected' ? (
            <button
              disabled={busy}
              onClick={() => {
                void context.store
                  .remove(pending)
                  .then(() => {
                    changed(context.store);
                    if (active()) {
                      setPending(undefined);
                      void refresh();
                    }
                  })
                  .catch((failure) => {
                    if (active()) setError(failureText(failure));
                  });
              }}
            >
              Dismiss rejected change
            </button>
          ) : (
            <>
              <button disabled={busy} onClick={() => void status()}>
                Check saved status
              </button>
              <button disabled={busy} onClick={() => void mutate(pending)}>
                Retry same change
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button disabled={busy} onClick={() => void refresh()}>
            Refresh saved state
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="fineprint">
          {message}
        </p>
      )}
    </div>
  );
}

export function SavedItemsPage({ context }: { context: Context }) {
  return (
    <AuthorizationBoundary scope="saved" sourcePolicy="settings">
      <SavedItemsContent context={context} />
    </AuthorizationBoundary>
  );
}
function SavedItemsContent({ context }: { context: Context }) {
  const authority = useAuthorization();
  const [generation, setGeneration] = useState<number>();
  const [page, setPage] = useState<SavedPageView>(),
    [cursor, setCursor] = useState<string>(),
    [history, setHistory] = useState<(string | undefined)[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState<Intent[]>([]),
    [changedElsewhere, setChangedElsewhere] = useState(false);
  const live = useRef(true),
    owner = useRef(identityGeneration()),
    requestId = useRef(0),
    heading = useRef<HTMLHeadingElement>(null);
  const attemptedPage = useRef<{ cursor?: string; history: (string | undefined)[] }>({
    history: [],
  });
  const active = () => live.current && owner.current === identityGeneration();
  const prefix = context.store.prefix;
  function syncPending() {
    if (active()) setPending(pendingRecords(context.store));
  }
  async function load(next?: string, previous: (string | undefined)[] = [], focus = false) {
    attemptedPage.current = { ...(next ? { cursor: next } : {}), history: previous };
    const mine = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      syncPending();
      const { value: data, generation: lease } = await authority.readProjection<SavedPageView>(
        base + '?limit=12' + (next ? '&cursor=' + encodeURIComponent(next) : ''),
        { schema: SavedPage },
      );
      if (active() && mine === requestId.current) {
        setPage(data);
        setGeneration(lease);
        setCursor(next);
        setHistory(previous);
        setChangedElsewhere(false);
        if (focus) heading.current?.focus();
      }
    } catch (failure) {
      if (active() && mine === requestId.current) setError(failureText(failure));
    } finally {
      if (active() && mine === requestId.current) setLoading(false);
    }
  }
  useEffect(() => {
    live.current = true;
    void load();
    const change = () => {
      try {
        syncPending();
        if (active()) {
          // A list fetched before this journal change is no longer evidence of
          // current membership, even if its response arrives after the change.
          requestId.current++;
          setLoading(false);
          setChangedElsewhere(true);
        }
      } catch (failure) {
        if (active()) setError(failureText(failure));
      }
    };
    const local = (event: Event) => {
      if ((event as CustomEvent).detail === prefix) change();
    };
    const storage = (event: StorageEvent) => {
      if (event.key?.startsWith(prefix)) change();
    };
    window.addEventListener('loom-saved-change', local);
    window.addEventListener('storage', storage);
    return () => {
      live.current = false;
      requestId.current++;
      window.removeEventListener('loom-saved-change', local);
      window.removeEventListener('storage', storage);
    };
  }, [prefix]);
  return (
    <>
      <div className="header-line">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            Saved items
          </h1>
          <p className="subtitle">
            Your private references, across sessions and devices. Saving is separate from following
            or reading.
          </p>
        </div>
        <button disabled={loading} onClick={() => void load(undefined, [], true)}>
          Refresh collection
        </button>
      </div>
      {pending.length > 0 && (
        <section className="section" aria-label="Saved items recovery">
          <h2>Unconfirmed changes</h2>
          {pending.map((record) => (
            <div className="saved-pending" key={record.key}>
              <span>
                {record.body.saved ? 'Save' : 'Unsave'} ·{' '}
                {(record.body.target as SavedTargetView).kind}
              </span>
              <SaveControl context={context} target={record.body.target as SavedTargetView} />
            </div>
          ))}
        </section>
      )}
      {changedElsewhere && (
        <p role="status" className="notice neutral">
          Saved items may have changed. Refresh the collection for its current membership.
        </p>
      )}
      {error && (
        <div role="alert" className="notice error">
          <p>{error} The collection has not been shown as complete.</p>
          <button
            disabled={loading}
            onClick={() =>
              void load(attemptedPage.current.cursor, attemptedPage.current.history, true)
            }
          >
            Retry collection
          </button>
        </div>
      )}
      {loading && <p role="status">Loading Saved items…</p>}
      {page && (
        <>
          <div
            className="collection saved-collection"
            aria-label="Saved references"
            aria-busy={loading}
          >
            {!page.items.length && !error && !changedElsewhere && (
              <div className="empty-state">
                <h2>No saved items yet</h2>
                <p>
                  Use Save on a discussion, contribution, or artifact, or Save this revision to keep
                  an exact reference.
                </p>
              </div>
            )}
            {page.items.map((item) => {
              const source =
                authority.current(generation) && item.source.state === 'available'
                  ? item.source.resource
                  : undefined;
              const exact = item.target.kind === 'revision';
              const url =
                item.target.kind === 'revision'
                  ? `/loom/resource/${item.target.resource_id}/${item.target.revision_id}`
                  : item.target.kind === 'discussion'
                    ? '/loom/discussion/' + item.target.resource_id
                    : '/loom/resource/' + item.target.resource_id;
              return (
                <div className="list-row saved-row" key={targetKey(item.target)}>
                  <div>
                    <small>
                      {exact
                        ? 'Exact revision'
                        : item.target.kind === 'discussion'
                          ? 'Discussion'
                          : item.target.kind === 'artifact'
                            ? 'Artifact'
                            : 'Contribution'}
                    </small>
                    <h2>
                      {source ? (
                        <Link to={url}>
                          {source.title ?? 'Contribution by ' + source.author.nickname}
                        </Link>
                      ) : (
                        'Saved target unavailable'
                      )}
                    </h2>
                    {source ? (
                      <>
                        <p>
                          {source.area_title} · Revision {source.revision_number} ·{' '}
                          {source.publisher.nickname}
                        </p>
                        {exact ? (
                          <Link to={'/loom/resource/' + item.target.resource_id}>
                            View current resource
                          </Link>
                        ) : (
                          item.source.state === 'available' &&
                          item.source.observed_revision_id && (
                            <Link
                              to={`/loom/resource/${source.resource_id}/${item.source.observed_revision_id}`}
                            >
                              Revision current when saved
                            </Link>
                          )
                        )}
                      </>
                    ) : (
                      <p>
                        This reference is retained privately. Its source metadata is unavailable;
                        you can still unsave it.
                      </p>
                    )}
                  </div>
                  <SaveControl
                    context={context}
                    target={item.target}
                    initial={
                      authority.current(generation)
                        ? item
                        : { ...item, source: { state: 'unavailable' } }
                    }
                  />
                </div>
              );
            })}
          </div>
          <div className="pagination">
            <span>{page.items.length} references on this page · stable order</span>
            <div>
              <button
                disabled={loading || !history.length}
                onClick={() => void load(history.at(-1), history.slice(0, -1), true)}
              >
                Previous page
              </button>
              <button
                disabled={loading || !!error || !page.next_cursor}
                onClick={() => void load(page.next_cursor!, [...history, cursor], true)}
              >
                Next page
              </button>
            </div>
          </div>
          {!loading && !error && !changedElsewhere && page.complete && (
            <p className="fineprint">
              End of this Saved items collection. This does not mark anything read.
            </p>
          )}
        </>
      )}
    </>
  );
}
