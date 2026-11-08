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
  type ReadingResultView,
} from '../contracts/reading.js';
import { AutomaticReadingQueue } from './reading-coordinator.js';
import type { AuthoredContent } from '../contracts/participation.js';
import type { Context } from './participation-state.js';
import { ApiError, identityGeneration, commandRequest } from './participation-client.js';
import { ReadingRecovery, exportReadingRecovery, type ReadingIntent } from './reading-recovery.js';
import {
  PresentationEpisode,
  observeReadingRegion,
  presentationPolicy,
  viewportPresentation,
} from './reading-presentation.js';
import { AuthoredText } from './AuthoredText.js';

type Authority = ReturnType<typeof useAuthorization>;
type Entry = { target: ReadingTargetView; authorities: Map<Authority, number> };
type State = { item?: ReadingItemView; error?: string };
type Candidate = {
  id: string;
  target: ReadingUpdateInput['targets'][number];
  authority: Authority;
  generation: number;
  intent: number;
  identity: number;
  instance: string;
  participant: string;
  episode: string;
  continuation: boolean;
};
interface Session {
  states: Map<string, State>;
  entries: Map<string, Entry>;
  records: ReadingIntent[];
  enabled: boolean;
  error: string;
  fences: PresentationEpisode;
  episode: string;
  active: () => boolean;
  register: (target: ReadingTargetView, authority: Authority) => () => void;
  observe: (target: ReadingUpdateInput['targets'][number], authority: Authority) => void;
  pendingAutomatic: Set<string>;
  refresh: () => void;
  mark: (targets: ReadingUpdateInput['targets'], basis: 'manual' | 'presentation') => Promise<void>;
  recover: (record: ReadingIntent, retry: boolean) => Promise<void>;
  dismiss: (record: ReadingIntent) => Promise<void>;
  setEnabled: (value: boolean) => Promise<void>;
  exportRecovery: () => void;
}
const ReadingContext = createContext<Session | null>(null);
function readingStorage(): Storage {
  try {
    return window.localStorage;
  } catch {
    const unavailable = () => {
      throw new Error('Reading storage is unavailable. Automatic reading is paused.');
    };
    return {
      getItem: unavailable,
      setItem: unavailable,
      removeItem: unavailable,
      clear: unavailable,
      key: unavailable,
      get length(): number {
        return unavailable();
      },
    };
  }
}
export function useReadingSession() {
  return useContext(ReadingContext);
}
export function ReadingProvider({ context, children }: { context: Context; children: ReactNode }) {
  const [journal] = useState(
    () =>
      new ReadingRecovery(
        context.community.instance_id,
        context.self.participant_id,
        readingStorage(),
      ),
  );
  const [states, setStates] = useState(new Map<string, State>()),
    [records, setRecords] = useState<ReadingIntent[]>([]),
    [enabled, setEnabled] = useState(false),
    [error, setError] = useState(''),
    [, redraw] = useState(0);
  const entries = useRef(new Map<string, Entry>()),
    fences = useRef(new PresentationEpisode()),
    live = useRef(true),
    owner = useRef(identityGeneration()),
    episode = useRef(crypto.randomUUID()),
    lookupPending = useRef(new Map<Authority, Map<string, ReadingTargetView>>()),
    lookupInFlight = useRef(new Map<Authority, Set<string>>()),
    lookupTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    knownRecords = useRef<ReadingIntent[]>([]),
    seenManualIntents = useRef(new Set<string>()),
    preferenceFault = useRef(false),
    disablingPreference = useRef(false),
    intentVersions = useRef(new Map<string, number>()),
    pendingAutomatic = useRef(new Set<string>()),
    dispatchAutomatic = useRef<(batch: Candidate[]) => Promise<Candidate[] | void>>(async () => {}),
    automatic = useRef<AutomaticReadingQueue<Candidate> | undefined>(undefined),
    enabledNow = useRef(false);
  const latestContext = useRef(context);
  latestContext.current = context;
  const knownStates = useRef(states);
  knownStates.current = states;
  const active = useCallback(
    () =>
      live.current &&
      owner.current === identityGeneration() &&
      latestContext.current.community.instance_id === context.community.instance_id &&
      latestContext.current.self.participant_id === context.self.participant_id,
    [context.community.instance_id, context.self.participant_id],
  );
  if (!automatic.current)
    automatic.current = new AutomaticReadingQueue((batch) => dispatchAutomatic.current(batch));
  const flushLookups = useCallback(() => {
    lookupTimer.current = undefined;
    if (!active()) return;
    // Every request stays with its registered text host, never the private provider.
    for (const [authority, pending] of lookupPending.current) {
      if (!authority.active()) {
        lookupPending.current.delete(authority);
        continue;
      }
      const inFlight = lookupInFlight.current.get(authority) ?? new Set<string>();
      const ready = [...pending.values()].filter((target) => !inFlight.has(target.revision_id));
      for (let i = 0; i < ready.length; i += readingLimits.batch) {
        const targets = ready.slice(i, i + readingLimits.batch);
        const generation = authority.capture();
        for (const target of targets) {
          pending.delete(target.revision_id);
          inFlight.add(target.revision_id);
        }
        lookupInFlight.current.set(authority, inFlight);
        void authority
          .read<ReadingPageView>('/api/v1/me/reading/lookup', {
            body: { targets },
            self: latestContext.current.self,
            schema: ReadingPage,
          })
          .then(
            (page) => {
              if (!active() || !authority.current(generation)) return;
              setStates((previous) => {
                const next = new Map(previous);
                for (const item of page.items) {
                  if (!entries.current.get(item.revision_id)?.authorities.has(authority)) continue;
                  const old = next.get(item.revision_id)?.item;
                  if (old && old.version > item.version) continue;
                  next.set(item.revision_id, { item });
                }
                return next;
              });
            },
            (failure) => {
              if (!active() || !authority.current(generation)) return;
              setStates((previous) => {
                const next = new Map(previous);
                for (const target of targets)
                  if (entries.current.get(target.revision_id)?.authorities.has(authority))
                    next.set(target.revision_id, {
                      ...next.get(target.revision_id),
                      error: failure.message,
                    });
                return next;
              });
            },
          )
          .finally(() => {
            for (const target of targets) inFlight.delete(target.revision_id);
            if (active() && lookupPending.current.get(authority)?.size) {
              if (lookupTimer.current) clearTimeout(lookupTimer.current);
              lookupTimer.current = setTimeout(flushLookups, 0);
            }
          });
      }
      if (!pending.size) lookupPending.current.delete(authority);
    }
  }, [active]);
  const requestLookup = useCallback(
    (target: ReadingTargetView, authority: Authority) => {
      if (!entries.current.get(target.revision_id)?.authorities.has(authority)) return;
      const pending = lookupPending.current.get(authority) ?? new Map();
      pending.set(target.revision_id, target);
      lookupPending.current.set(authority, pending);
      if (!lookupTimer.current) lookupTimer.current = setTimeout(flushLookups, 0);
    },
    [flushLookups],
  );
  const refresh = useCallback(() => {
    for (const entry of entries.current.values())
      for (const authority of entry.authorities.keys()) requestLookup(entry.target, authority);
  }, [requestLookup]);
  const register = useCallback(
    (target: ReadingTargetView, authority: Authority) => {
      const old = entries.current.get(target.revision_id);
      const newAuthority = !old?.authorities.has(authority);
      const authorities = old?.authorities ?? new Map<Authority, number>();
      authorities.set(authority, (authorities.get(authority) ?? 0) + 1);
      entries.current.set(target.revision_id, { target, authorities });
      redraw((n) => n + 1);
      if (newAuthority || !knownStates.current.has(target.revision_id))
        requestLookup(target, authority);
      return () => {
        const entry = entries.current.get(target.revision_id);
        const count = entry?.authorities.get(authority) ?? 0;
        if (count > 1) entry!.authorities.set(authority, count - 1);
        else entry?.authorities.delete(authority);
        if (!entry?.authorities.size) {
          entries.current.delete(target.revision_id);
          automatic.current?.cancel(target.revision_id);
          setStates((previous) => {
            const next = new Map(previous);
            next.delete(target.revision_id);
            return next;
          });
        }
        lookupPending.current.get(authority)?.delete(target.revision_id);
      };
    },
    [requestLookup],
  );
  function invalidateAutomatic(id: string) {
    automatic.current?.cancel(id);
    if (
      !intentVersions.current.has(id) &&
      intentVersions.current.size >= presentationPolicy.episodeTargets
    )
      fences.current.paused = true;
    else intentVersions.current.set(id, (intentVersions.current.get(id) ?? 0) + 1);
    if (fences.current.paused) automatic.current?.clear();
  }
  useEffect(() => {
    live.current = true;
    automatic.current?.open();
    const changed = (event?: Event, initial = false) => {
      if (!active()) return;
      try {
        const all = journal.all();
        const observed =
          event instanceof StorageEvent && event.key?.startsWith(journal.prefix + 'intent:')
            ? journal.storedIntent(event.newValue)
            : undefined;
        knownRecords.current = all;
        setRecords(all);
        enabledNow.current =
          journal.enabled() && !preferenceFault.current && !disablingPreference.current;
        setEnabled(enabledNow.current);
        if (!enabledNow.current) automatic.current?.clear();
        // A completed operation can disappear before its storage event arrives.
        // The validated event value still carries the later deliberate intent.
        const manual = new Map(all.map((record) => [record.body.idempotency_key, record]));
        if (observed) manual.set(observed.body.idempotency_key, observed);
        for (const record of manual.values()) {
          const key = record.body.idempotency_key;
          if (record.body.basis !== 'manual' || seenManualIntents.current.has(key)) continue;
          if (seenManualIntents.current.size >= presentationPolicy.episodeTargets) {
            fences.current.paused = true;
            automatic.current?.clear();
            break;
          }
          seenManualIntents.current.add(key);
          if (initial) continue;
          for (const target of record.body.targets) {
            if (target.read) fences.current.attempted(target.revision_id);
            else fences.current.manualUnread(target.revision_id);
            invalidateAutomatic(target.revision_id);
          }
        }
      } catch (failure) {
        setError((failure as Error).message);
        enabledNow.current = false;
        automatic.current?.clear();
        setEnabled(false);
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(journal.prefix)) return;
      const before = knownRecords.current;
      changed(event);
      // Another tab may settle a record between events. Unknown removal needs a
      // full revalidation; known records only refresh their exact registered IDs.
      const removedTargets = journal.storedTargets(event.oldValue);
      if (
        event.key === null ||
        (event.oldValue &&
          !event.newValue &&
          !removedTargets &&
          !before.some((record) => event.key?.endsWith(record.body.idempotency_key)))
      )
        refresh();
      else {
        const ids = new Set(
          before.flatMap((record) => record.body.targets.map((v) => v.revision_id)),
        );
        if (event.key?.startsWith(journal.prefix + 'intent:'))
          for (const target of [
            ...(removedTargets ?? []),
            ...(journal.storedTargets(event.newValue) ?? []),
          ])
            ids.add(target.revision_id);
        for (const record of knownRecords.current)
          for (const target of record.body.targets) ids.add(target.revision_id);
        for (const id of ids) {
          const entry = entries.current.get(id);
          if (entry)
            for (const authority of entry.authorities.keys())
              requestLookup(entry.target, authority);
        }
      }
    };
    changed(undefined, true);
    window.addEventListener('loom-reading', changed);
    window.addEventListener('storage', storage);
    return () => {
      live.current = false;
      automatic.current?.close();
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
      lookupTimer.current = undefined;
      lookupPending.current.clear();
      window.removeEventListener('loom-reading', changed);
      window.removeEventListener('storage', storage);
    };
  }, [journal, active, refresh, requestLookup]);
  function applyPrivateCurrent(items: ReadingItemView[]) {
    if (!active()) return;
    setStates((previous) => {
      const next = new Map(previous);
      for (const item of items) {
        const entry = entries.current.get(item.revision_id);
        if (!entry || entry.target.resource_id !== item.resource_id) continue;
        const old = next.get(item.revision_id)?.item;
        if (!old || old.version > item.version) continue;
        if (![...entry.authorities.keys()].some((authority) => authority.active())) continue;
        // A private receipt never renews a source lease or restores withdrawn text.
        next.set(item.revision_id, {
          item: { ...item, availability: old.availability },
        });
      }
      return next;
    });
  }
  async function send(
    record: ReadingIntent,
    retry: boolean,
  ): Promise<ReadingStatusView | undefined> {
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
        if (result.operation_state === 'version_conflict')
          await journal.recordConflict(record, result);
        else await journal.settleSuccess(record, result.outcome.targets);
        applyPrivateCurrent(result.current);
        if (active()) setError('');
      }
      return result;
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
    }
    return undefined;
  }
  async function mark(targets: ReadingUpdateInput['targets'], basis: 'manual' | 'presentation') {
    if (!active()) return;
    for (const target of targets) {
      if (basis === 'manual') {
        if (target.read) fences.current.attempted(target.revision_id);
        else fences.current.manualUnread(target.revision_id);
        invalidateAutomatic(target.revision_id);
      }
    }
    setError('');
    try {
      const key = crypto.randomUUID();
      if (basis === 'manual') {
        if (seenManualIntents.current.size < presentationPolicy.episodeTargets)
          seenManualIntents.current.add(key);
        else {
          fences.current.paused = true;
          automatic.current?.clear();
        }
      }
      const record = await journal.save(
        {
          idempotency_key: key,
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
  function validCandidate(candidate: Candidate) {
    const current = latestContext.current;
    const item = knownStates.current.get(candidate.id)?.item;
    const entry = entries.current.get(candidate.id);
    return (
      active() &&
      enabledNow.current &&
      candidate.identity === identityGeneration() &&
      candidate.instance === current.community.instance_id &&
      candidate.participant === current.self.participant_id &&
      candidate.episode === episode.current &&
      candidate.intent === (intentVersions.current.get(candidate.id) ?? 0) &&
      entry?.target.resource_id === candidate.target.resource_id &&
      entry.authorities.has(candidate.authority) &&
      candidate.authority.current(candidate.generation) &&
      item?.availability === 'available' &&
      !item.read &&
      item.version === candidate.target.expected_version &&
      (candidate.continuation || !fences.current.excludes(candidate.id))
    );
  }
  function matchesFrozenRefusal(result: ReadingResultView, record: ReadingIntent) {
    if (
      result.operation_state !== 'version_conflict' ||
      result.outcome.basis !== 'presentation' ||
      result.outcome.episode_id !== record.body.episode_id ||
      result.outcome.targets.length !== record.body.targets.length ||
      result.current.length !== record.body.targets.length
    )
      return false;
    const originals = new Map(record.body.targets.map((target) => [target.revision_id, target]));
    return (
      new Set(result.outcome.targets.map((target) => target.revision_id)).size === originals.size &&
      new Set(result.current.map((item) => item.revision_id)).size === originals.size &&
      result.outcome.targets.every((target) => {
        const original = originals.get(target.revision_id);
        return (
          original?.resource_id === target.resource_id &&
          original.read === target.read &&
          original.expected_version === target.expected_version
        );
      }) &&
      result.current.every(
        (item) => item.resource_id === originals.get(item.revision_id)?.resource_id,
      )
    );
  }
  dispatchAutomatic.current = async (batch) => {
    const eligible = batch.filter(validCandidate);
    if (!eligible.length) return;
    for (const candidate of eligible) pendingAutomatic.current.add(candidate.id);
    redraw((n) => n + 1);
    try {
      // The lock callback is the final pre-freeze check. Save reads back the exact
      // body; a later cancellation cannot mutate that frozen operation.
      const record = await journal.savePrepared(() => {
        const frozen = eligible.filter(validCandidate);
        return frozen.length
          ? {
              idempotency_key: crypto.randomUUID(),
              basis: 'presentation',
              episode_id: episode.current,
              targets: frozen.map((candidate) => candidate.target),
            }
          : undefined;
      }, active);
      const frozen = eligible.filter((candidate) =>
        record.body.targets.some((target) => target.revision_id === candidate.id),
      );
      for (const candidate of frozen) fences.current.attempted(candidate.id);
      const result = await send(record, true);
      if (
        result?.operation_state !== 'version_conflict' ||
        !matchesFrozenRefusal(result, record) ||
        !active()
      )
        return;
      // A terminal atomic refusal alone permits one new subset. Retain original
      // expected versions and require each returned current member to be unchanged.
      const continuation: Candidate[] = [];
      for (const candidate of frozen) {
        if (candidate.continuation) continue;
        const current = result.current.find((item) => item.revision_id === candidate.id);
        if (
          current?.resource_id === candidate.target.resource_id &&
          current.availability === 'available' &&
          !current.read &&
          current.version === candidate.target.expected_version &&
          validCandidate({ ...candidate, continuation: true })
        )
          continuation.push({ ...candidate, continuation: true });
      }
      return continuation;
    } catch (failure) {
      if (active() && (failure as Error).name !== 'AbortError') {
        for (const candidate of eligible) fences.current.attempted(candidate.id);
        setError((failure as Error).message);
      }
    } finally {
      for (const candidate of eligible) pendingAutomatic.current.delete(candidate.id);
      if (active()) redraw((n) => n + 1);
    }
  };
  function observe(target: ReadingUpdateInput['targets'][number], authority: Authority) {
    if (!active() || !enabledNow.current || fences.current.excludes(target.revision_id)) return;
    const item = knownStates.current.get(target.revision_id)?.item;
    if (!item || item.read || item.availability !== 'available') return;
    if (
      automatic.current?.has(target.revision_id) ||
      pendingAutomatic.current.has(target.revision_id)
    )
      return;
    try {
      if (
        journal
          .all()
          .some(
            (record) =>
              record.state === 'uncertain' &&
              record.body.targets.some((member) => member.revision_id === target.revision_id),
          )
      )
        return;
    } catch (failure) {
      setError((failure as Error).message);
      return;
    }
    const candidate: Candidate = {
      id: target.revision_id,
      target,
      authority,
      generation: authority.capture(),
      intent: intentVersions.current.get(target.revision_id) ?? 0,
      identity: identityGeneration(),
      instance: latestContext.current.community.instance_id,
      participant: latestContext.current.self.participant_id,
      episode: episode.current,
      continuation: false,
    };
    if (automatic.current?.enqueue(candidate) === 'full')
      setError('Automatic reading buffer is full. Further observations wait for capacity.');
  }
  const value: Session = {
    states,
    entries: entries.current,
    records,
    enabled,
    error,
    fences: fences.current,
    episode: episode.current,
    active,
    register,
    observe,
    pendingAutomatic: pendingAutomatic.current,
    refresh,
    mark,
    recover: async (record, retry) => {
      await send(record, retry);
    },
    dismiss: async (record) => {
      try {
        await journal.finish(record, true);
      } catch (failure) {
        if (active()) setError((failure as Error).message);
      }
    },
    setEnabled: async (value) => {
      if (value) setEnabled(true);
      else {
        disablingPreference.current = true;
        enabledNow.current = false;
        automatic.current?.clear();
        setEnabled(false);
      }
      try {
        await journal.setEnabled(value);
        if (active()) {
          preferenceFault.current = false;
          disablingPreference.current = false;
          enabledNow.current = value;
          setEnabled(value);
          setError((previous) =>
            previous.startsWith('Reading preference') || previous.startsWith('Reading storage')
              ? ''
              : previous,
          );
        }
      } catch (failure) {
        if (active()) {
          preferenceFault.current = true;
          disablingPreference.current = false;
          enabledNow.current = false;
          automatic.current?.clear();
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
  content,
  participants,
}: {
  target: ReadingTargetView;
  content: AuthoredContent;
  participants: { id: string; nickname: string }[];
}) {
  const authority = useAuthorization();
  const session = useContext(ReadingContext),
    node = useRef<HTMLDivElement>(null),
    occurrence = useRef(Symbol('reading text')),
    check = useRef<() => void>(() => {});
  const latest = useRef(session);
  latest.current = session;
  const register = session?.register;
  useEffect(
    () => register?.(target, authority),
    [register, target.resource_id, target.revision_id, authority],
  );
  check.current = () => {
    const current = latest.current;
    const prose = node.current?.querySelector<HTMLElement>('.prose');
    if (!current || !prose) return;
    const view = viewportPresentation(prose);
    current.fences.presence(target.revision_id, occurrence.current, view.present);
    const item = current.states.get(target.revision_id)?.item;
    if (
      view.eligible &&
      current.active() &&
      current.enabled &&
      item?.availability === 'available' &&
      !item.read
    )
      current.observe({ ...target, read: true, expected_version: item.version }, authority);
  };
  useEffect(() => {
    const prose = node.current?.querySelector<HTMLElement>('.prose');
    if (!prose) return;
    const unsubscribe = observeReadingRegion(prose, () => check.current());
    check.current();
    return () => {
      unsubscribe();
      latest.current?.fences.unregister(target.revision_id, occurrence.current);
    };
  }, [target.resource_id, target.revision_id, authority]);
  useEffect(() => check.current(), [session]);
  return (
    <div
      className="reading-text"
      data-reading-target={target.revision_id}
      data-reading-version={session?.states.get(target.revision_id)?.item?.version}
    >
      <div ref={node} data-presented-revision={target.revision_id}>
        <AuthoredText content={content} participants={participants} />
      </div>
      <ReadingActionStatus target={target} />
    </div>
  );
}

export function ReadingMarkUnread({ target }: { target: ReadingTargetView }) {
  const session = useContext(ReadingContext);
  const item = session?.states.get(target.revision_id)?.item;
  if (!session) return null;
  return (
    <button
      className="text-button"
      disabled={!item || item.availability !== 'available'}
      onClick={() =>
        void session.mark([{ ...target, read: false, expected_version: item!.version }], 'manual')
      }
    >
      Mark unread
    </button>
  );
}

export function ReadingActionStatus({ target }: { target: ReadingTargetView }) {
  const session = useContext(ReadingContext);
  if (!session) return null;
  const state = session.states.get(target.revision_id);
  const item = state?.item;
  const pending =
    session.pendingAutomatic.has(target.revision_id) ||
    session.records.some(
      (record) =>
        record.state === 'uncertain' &&
        record.body.targets.some((member) => member.revision_id === target.revision_id),
    );
  const conflicted = session.records.some(
    (record) =>
      record.state === 'conflicted' &&
      !record.superseded_revisions?.includes(target.revision_id) &&
      record.body.targets.some((member) => member.revision_id === target.revision_id),
  );
  if (!pending && !conflicted && !session.error && !state?.error && item?.read) return null;
  return (
    <div className="reading-feedback">
      {pending ? (
        <span className="reading-indicator" role="status">
          Syncing reading…
        </span>
      ) : state?.error || !item || item.availability !== 'available' ? (
        <span className="reading-indicator" role="status">
          {state?.error
            ? 'Reading status unavailable'
            : !item
              ? 'Checking reading…'
              : 'Reading source unavailable'}
        </span>
      ) : !item.read ? (
        <span className="reading-indicator" role="status" aria-label="Unread revision">
          Unread
        </span>
      ) : null}
      {conflicted && (
        <p className="notice" role="alert">
          Reading change conflicted.{' '}
          <Link to="/loom/reading">Review or dismiss the reading conflict</Link>
        </p>
      )}
      {(session.error || state?.error) && (
        <p className="notice" role="alert">
          {session.error || state?.error} <Link to="/loom/reading">Reading recovery</Link>
        </p>
      )}
    </div>
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
        Automatically mark visible text read on this account and browser
      </label>
      <p>
        Content becomes read when its main text appears on screen. Mark unread keeps it unread while
        it remains visible. It becomes read after it leaves the view and appears again.
      </p>
      <p>
        This applies to full openings, comments, artifacts and summaries while this window is
        visible and focused. Excerpts, collapsed branches, notes, references and activity cards do
        not count.
      </p>
      <p>
        Disabling stops new observations. Already dispatched changes can still commit. This
        preference does not control other browsers or direct clients.
      </p>
      <p>
        Automatic marking pauses after 4,096 exact revisions in one view. Manual marking stays
        available.
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
        <article className="card reading-recovery-record" key={record.body.idempotency_key}>
          <p>
            {record.state === 'conflicted'
              ? 'Reading change conflicted'
              : record.state === 'rejected'
                ? 'Rejected before recording'
                : 'Unconfirmed'}{' '}
            · {record.body.targets.length} exact revisions · {record.body.basis}
          </p>
          {record.state === 'conflicted' && (
            <>
              <p>
                No revisions in this change were updated. Open the exact selection to inspect
                current state and make a new choice. Dismissing this notice leaves server reading
                state unchanged.
              </p>
              {!!record.superseded_revisions?.length && (
                <p>
                  {record.superseded_revisions.length === 1
                    ? '1 revision was'
                    : `${record.superseded_revisions.length} revisions were`}{' '}
                  synchronized by later, separate changes. This original conflict remains available
                  for review.
                </p>
              )}
            </>
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
