import { useAuthorization } from './AuthorizationBoundary.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import {
  ReadingPage,
  ReadingResult,
  ReadingStatus,
  readingLimits,
  type ReadingItemView,
  type ReadingTargetView,
  type ReadingUpdateInput,
  type ReadingStatusView,
  type ReadingPageView,
} from '../contracts/reading.js';
import type { AuthoredContent } from '../contracts/participation.js';
import type { Context } from './participation-state.js';
import { ApiError, identityGeneration, commandRequest } from './participation-client.js';
import { ReadingRecovery, exportReadingRecovery, type ReadingIntent } from './reading-recovery.js';
import {
  PresentedBands,
  PresentationEpisode,
  presentationPolicy,
  viewportPresentation,
} from './reading-presentation.js';
import { AuthoredText } from './AuthoredText.js';

type Authority = ReturnType<typeof useAuthorization>;
type Entry = { target: ReadingTargetView; label: string; authorities: Map<Authority, number> };
type State = { item?: ReadingItemView; error?: string };
interface Session {
  states: Map<string, State>;
  entries: Map<string, Entry>;
  selected: Set<string>;
  records: ReadingIntent[];
  enabled: boolean;
  error: string;
  fences: PresentationEpisode;
  episode: string;
  active: () => boolean;
  register: (target: ReadingTargetView, label: string, authority: Authority) => () => void;
  refresh: () => void;
  select: (id: string, selected: boolean) => void;
  mark: (targets: ReadingUpdateInput['targets'], basis: 'manual' | 'presentation') => Promise<void>;
  recover: (record: ReadingIntent, retry: boolean) => Promise<void>;
  dismiss: (record: ReadingIntent) => Promise<void>;
  setEnabled: (value: boolean) => Promise<void>;
  exportRecovery: () => void;
}
const ReadingContext = createContext<Session | null>(null);
export function ReadingProvider({ context, children }: { context: Context; children: ReactNode }) {
  const [journal] = useState(
    () => new ReadingRecovery(context.community.instance_id, context.self.participant_id),
  );
  const [states, setStates] = useState(new Map<string, State>()),
    [selected, setSelected] = useState(new Set<string>()),
    [records, setRecords] = useState<ReadingIntent[]>([]),
    [enabled, setEnabled] = useState(false),
    [error, setError] = useState(''),
    [, redraw] = useState(0);
  const entries = useRef(new Map<string, Entry>()),
    fences = useRef(new PresentationEpisode()),
    live = useRef(true),
    owner = useRef(identityGeneration()),
    episode = useRef(crypto.randomUUID()),
    sequence = useRef(0),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = useCallback(() => live.current && owner.current === identityGeneration(), []);
  const latestContext = useRef(context);
  latestContext.current = context;
  const refresh = useCallback(() => {
    const seq = ++sequence.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!active()) return;
      // The provider owns private recovery, but each text host owns its reads.
      // Do not give the persistent provider an independent metadata lease.
      const groups = new Map<Authority, ReadingTargetView[]>();
      for (const entry of entries.current.values())
        for (const authority of entry.authorities.keys())
          groups.set(authority, [...(groups.get(authority) ?? []), entry.target]);
      for (const [authority, list] of groups)
        for (let i = 0; i < list.length; i += readingLimits.batch) {
          const targets = list.slice(i, i + readingLimits.batch);
          void authority
            .read<ReadingPageView>('/api/v1/me/reading/lookup', {
              body: { targets },
              self: latestContext.current.self,
              schema: ReadingPage,
            })
            .then(
              (page) => {
                if (!active() || seq !== sequence.current) return;
                setStates((previous) => {
                  const next = new Map(previous);
                  for (const item of page.items) {
                    if (!entries.current.has(item.revision_id)) continue;
                    const old = next.get(item.revision_id)?.item;
                    if (old && old.version > item.version) continue;
                    fences.current.track(item.revision_id, item.version);
                    next.set(item.revision_id, { item });
                  }
                  return next;
                });
              },
              (failure) => {
                if (!active() || seq !== sequence.current) return;
                setStates((previous) => {
                  const next = new Map(previous);
                  for (const v of targets)
                    if (entries.current.has(v.revision_id))
                      next.set(v.revision_id, { error: failure.message });
                  return next;
                });
              },
            );
        }
    }, 0);
  }, [active]);
  const register = useCallback(
    (target: ReadingTargetView, label: string, authority: Authority) => {
      const old = entries.current.get(target.revision_id);
      const authorities = old?.authorities ?? new Map<Authority, number>();
      authorities.set(authority, (authorities.get(authority) ?? 0) + 1);
      entries.current.set(target.revision_id, { target, label, authorities });
      redraw((n) => n + 1);
      refresh();
      return () => {
        const entry = entries.current.get(target.revision_id);
        const count = entry?.authorities.get(authority) ?? 0;
        if (count > 1) entry!.authorities.set(authority, count - 1);
        else entry?.authorities.delete(authority);
        if (!entry?.authorities.size) {
          entries.current.delete(target.revision_id);
          setStates((previous) => {
            const next = new Map(previous);
            next.delete(target.revision_id);
            return next;
          });
        }
        setSelected((previous) => {
          const next = new Set(previous);
          next.delete(target.revision_id);
          return next;
        });
        refresh();
      };
    },
    [refresh],
  );
  useEffect(() => {
    live.current = true;
    const changed = () => {
      if (!active()) return;
      try {
        const all = journal.all();
        setRecords(all);
        setEnabled(journal.enabled());
        for (const record of all)
          if (record.body.basis === 'manual')
            for (const v of record.body.targets) fences.current.block(v.revision_id);
      } catch (failure) {
        setError((failure as Error).message);
        setEnabled(false);
      }
      refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(journal.prefix)) changed();
    };
    changed();
    window.addEventListener('loom-reading', changed);
    window.addEventListener('storage', storage);
    return () => {
      live.current = false;
      sequence.current++;
      if (timer.current) clearTimeout(timer.current);
      window.removeEventListener('loom-reading', changed);
      window.removeEventListener('storage', storage);
    };
  }, [journal, active, refresh]);
  async function send(record: ReadingIntent, retry: boolean) {
    let dispatched: ReadingIntent | undefined;
    try {
      if (retry) dispatched = await journal.begin(record);
      const result = await commandRequest<ReadingStatusView>(
        '/api/v1/me/reading/' + (retry ? 'state' : 'status'),
        {
          body: retry ? record.body : { idempotency_key: record.body.idempotency_key },
          self: context.self,
          schema: retry ? ReadingResult : ReadingStatus,
        },
      );
      if (result.operation_state === 'not_recorded') {
        if (active())
          setError(
            'This change is not recorded yet. It may still commit; retry the same change to resolve it.',
          );
      } else {
        if (result.operation_state === 'version_conflict') await journal.recordConflict(record);
        else await journal.finish(record);
        if (active()) setError('');
      }
    } catch (failure) {
      if (
        dispatched?.attempts === 1 &&
        failure instanceof ApiError &&
        [
          'reading_limit_reached',
          'invalid_input',
          'invalid_request',
          'unavailable',
          'forbidden',
        ].includes(failure.code) &&
        failure.operationOutcome !== 'unknown'
      )
        await journal.rejectFirst(dispatched).catch(() => {});
      if (active())
        setError(
          (failure as Error).name === 'AbortError'
            ? 'Reading outcome is unconfirmed. Recover the exact change.'
            : (failure as Error).message,
        );
    } finally {
      if (active()) refresh();
    }
  }
  async function mark(targets: ReadingUpdateInput['targets'], basis: 'manual' | 'presentation') {
    if (!active()) return;
    for (const target of targets) fences.current.block(target.revision_id);
    setError('');
    try {
      const record = await journal.save(
        {
          idempotency_key: crypto.randomUUID(),
          basis,
          episode_id: basis === 'presentation' ? episode.current : null,
          targets,
        },
        active,
      );
      await send(record, true);
    } catch (failure) {
      if (active()) setError((failure as Error).message);
    }
  }
  const value: Session = {
    states,
    entries: entries.current,
    selected,
    records,
    enabled,
    error,
    fences: fences.current,
    episode: episode.current,
    active,
    register,
    refresh,
    mark,
    select: (id, on) =>
      setSelected((previous) => {
        const next = new Set(previous);
        if (on && next.size < readingLimits.batch) next.add(id);
        else if (!on) next.delete(id);
        return next;
      }),
    recover: send,
    dismiss: async (record) => {
      try {
        await journal.finish(record, true);
      } catch (failure) {
        if (active()) setError((failure as Error).message);
      }
    },
    setEnabled: async (value) => {
      setEnabled(value);
      try {
        await journal.setEnabled(value);
      } catch (failure) {
        if (active()) {
          setEnabled(false);
          setError((failure as Error).message);
        }
      }
    },
    exportRecovery: () => {
      try {
        exportReadingRecovery(context.community.instance_id, context.self.participant_id);
      } catch (failure) {
        setError((failure as Error).message);
      }
    },
  };
  return (
    <ReadingContext.Provider value={value}>
      {enabled && fences.current.paused && (
        <p className="notice" role="status">
          Automatic reading is paused at this view’s {presentationPolicy.episodeTargets}-revision
          limit. Manual marking remains available. Navigate away and reopen to resume.
        </p>
      )}
      {children}
    </ReadingContext.Provider>
  );
}

export function ReadingText({
  target,
  number,
  content,
  participants,
  selectable = false,
}: {
  target: ReadingTargetView;
  number: string;
  content: AuthoredContent;
  participants: { id: string; nickname: string }[];
  selectable?: boolean;
}) {
  const authority = useAuthorization();
  const session = useContext(ReadingContext),
    node = useRef<HTMLDivElement>(null),
    observed = useRef<{ version: number; bands: PresentedBands } | undefined>(undefined);
  const latest = useRef(session);
  latest.current = session;
  const register = session?.register;
  useEffect(
    () => register?.(target, 'Revision ' + number, authority),
    [register, target.resource_id, target.revision_id, number, authority],
  );
  const state = session?.states.get(target.revision_id),
    item = state?.item;
  useEffect(() => {
    const tick = () => {
      const current = latest.current,
        state = current?.states.get(target.revision_id)?.item;
      if (
        !current?.active() ||
        !current.enabled ||
        current.fences.excludes(target.revision_id) ||
        !state ||
        state.availability !== 'available' ||
        state.read
      ) {
        observed.current?.bands.pause();
        return;
      }
      observed.current ??= { version: state.version, bands: new PresentedBands() };
      if (observed.current.version !== state.version) {
        current.fences.block(target.revision_id);
        return;
      }
      const prose = node.current?.querySelector<HTMLElement>('.prose');
      if (!prose) return;
      const view = viewportPresentation(prose);
      if (observed.current.bands.sample(view.height, view.visible, performance.now()))
        void current.mark(
          [{ ...target, read: true, expected_version: observed.current.version }],
          'presentation',
        );
    };
    const pause = () => observed.current?.bands.pause();
    const timer = setInterval(tick, presentationPolicy.sampleMs);
    document.addEventListener('visibilitychange', pause);
    window.addEventListener('blur', pause);
    return () => {
      clearInterval(timer);
      pause();
      document.removeEventListener('visibilitychange', pause);
      window.removeEventListener('blur', pause);
    };
  }, [target.resource_id, target.revision_id]);
  const pending = session?.records.some(
    (r) =>
      r.state === 'uncertain' && r.body.targets.some((v) => v.revision_id === target.revision_id),
  );
  const conflicted = session?.records.some(
    (r) =>
      r.state === 'conflicted' && r.body.targets.some((v) => v.revision_id === target.revision_id),
  );
  return (
    <div
      className="reading-text"
      data-reading-target={target.revision_id}
      data-reading-version={item?.version}
    >
      <div ref={node} data-presented-revision={target.revision_id}>
        <AuthoredText content={content} participants={participants} />
      </div>
      {session && (
        <div className="reading-controls">
          <span role="status">
            {pending
              ? 'Pending reading change'
              : state?.error
                ? 'Reading status unavailable'
                : !item
                  ? 'Checking reading status…'
                  : item.availability === 'unavailable'
                    ? 'Reading source unavailable'
                    : item.read
                      ? 'Read'
                      : item.version
                        ? 'Marked unread'
                        : 'Unmarked / unread'}{' '}
            · private · revision {number}
          </span>
          <button
            className="text-button"
            disabled={!item || item.availability !== 'available'}
            onClick={() =>
              void session.mark(
                [{ ...target, read: true, expected_version: item!.version }],
                'manual',
              )
            }
          >
            Mark read
          </button>
          <button
            className="text-button"
            disabled={!item}
            onClick={() =>
              void session.mark(
                [{ ...target, read: false, expected_version: item!.version }],
                'manual',
              )
            }
          >
            Mark unread
          </button>
          <button className="text-button" onClick={session.refresh}>
            Refresh reading status
          </button>
          {selectable && (
            <label>
              <input
                type="checkbox"
                checked={session.selected.has(target.revision_id)}
                disabled={
                  !session.selected.has(target.revision_id) &&
                  session.selected.size >= readingLimits.batch
                }
                onChange={(e) => session.select(target.revision_id, e.target.checked)}
              />
              Select revision {number} for bulk marking
            </label>
          )}
          {conflicted && (
            <p className="notice" role="alert">
              Reading change conflicted for this revision. Review its current state before making
              another choice. <Link to="/loom/reading">Review or dismiss the reading conflict</Link>
            </p>
          )}
          {(session.error || state?.error) && (
            <p className="notice" role="alert">
              {session.error || state?.error} <Link to="/loom/reading">Reading recovery</Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
export function ReadingSelection() {
  const session = useContext(ReadingContext);
  if (!session) return null;
  const entries = [...session.selected].flatMap((id) => {
    const entry = session.entries.get(id);
    return entry ? [entry] : [];
  });
  const ready =
    entries.length > 0 &&
    entries.every(
      (e) => session.states.get(e.target.revision_id)?.item?.availability === 'available',
    );
  const mark = (read: boolean) => {
    const frozen = entries.map((e) => ({
      ...e.target,
      read,
      expected_version: session.states.get(e.target.revision_id)!.item!.version,
    }));
    void session.mark(frozen, 'manual');
  };
  return (
    <details className="reading-selection">
      <summary>
        Mark selected discussion revisions ({entries.length}/{readingLimits.batch})
      </summary>
      <p>
        Select individual displayed openings or comments below. This is a manual declaration for
        these exact revisions, including selected text you have not opened.
      </p>
      <ul>
        {entries.map((e) => (
          <li key={e.target.revision_id}>
            {e.label} · <code>{e.target.revision_id}</code>
          </li>
        ))}
      </ul>
      <button disabled={!ready} onClick={() => mark(true)}>
        Mark {entries.length} selected read
      </button>{' '}
      <button disabled={!ready} onClick={() => mark(false)}>
        Mark {entries.length} selected unread
      </button>
    </details>
  );
}
export function ReadingPageViewComponent() {
  const session = useContext(ReadingContext);
  if (!session) return null;
  return (
    <section>
      <h1>Private reading progress</h1>
      <p>
        Read and unread describe exact text revisions. Fetch checkpoints, Saved items, Following,
        notification delivery and summary coverage remain separate.
      </p>
      <label>
        <input
          type="checkbox"
          checked={session.enabled}
          onChange={(e) => void session.setEnabled(e.target.checked)}
        />
        Automatically mark presented text read — prototype, this account on this browser
      </label>
      <p>
        Off by default. While this window is focused and visible, each 160-pixel band of the full
        text must be visible for one continuous second. Scroll through every band of long text.
        Horizontally overflowing code needs manual marking. This approximates presentation, not
        comprehension or review.
      </p>
      <p>
        Supported: full opening posts, comments, artifacts and summaries. Excerpts, collapsed
        branches, notes, references and activity cards do not qualify. Mark unread keeps this
        opening episode unread; navigate away and reopen (or reload) to allow another observation.
        Refreshing status or switching tabs does not rearm it.
      </p>
      <p>
        Disabling stops new observations. Already dispatched changes can still commit. This
        preference does not control other browsers or direct clients.
      </p>
      <p>
        Automatic marking pauses after 4,096 exact revisions in one view. Manual marking stays
        available; navigate away and reopen to resume.
      </p>
      {session.error && (
        <p role="alert" className="notice">
          {session.error}
        </p>
      )}
      <h2>Reading recovery</h2>
      <p>
        Unconfirmed changes may have committed. Exact retry preserves their original decision; a
        conflict needs a new deliberate choice.
      </p>
      <button onClick={session.exportRecovery}>Export reading recovery</button>
      {!session.records.length && <p>No pending reading changes.</p>}
      {session.records.map((record) => (
        <article className="card" key={record.body.idempotency_key}>
          <p>
            {record.state === 'conflicted'
              ? 'Reading change conflicted'
              : record.state === 'rejected'
                ? 'Rejected before recording'
                : 'Unconfirmed'}{' '}
            · {record.body.targets.length} exact revisions · {record.body.basis}
          </p>
          {record.state === 'conflicted' && (
            <p>
              No revisions in this change were updated. Open the exact selection to inspect current
              state and make a new choice. Dismissing this notice leaves server reading state
              unchanged.
            </p>
          )}
          <details>
            <summary>Exact selection</summary>
            <ul>
              {record.body.targets.map((v) => (
                <li key={v.revision_id}>
                  <Link to={`/loom/resource/${v.resource_id}/${v.revision_id}`}>
                    {v.revision_id}
                  </Link>{' '}
                  → {v.read ? 'read' : 'unread'} at version {v.expected_version}
                </li>
              ))}
            </ul>
          </details>
          {record.state !== 'uncertain' ? (
            <button onClick={() => void session.dismiss(record)}>
              {record.state === 'conflicted'
                ? 'Dismiss reading conflict'
                : 'Dismiss rejected reading change'}
            </button>
          ) : (
            <>
              <button onClick={() => void session.recover(record, false)}>
                Check reading outcome
              </button>{' '}
              <button onClick={() => void session.recover(record, true)}>
                Retry same reading change
              </button>
            </>
          )}
        </article>
      ))}
    </section>
  );
}
