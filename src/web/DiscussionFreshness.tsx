import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as F from '../contracts/discussion-freshness.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration, type Self } from './participation-client.js';
import type { DiscussionNavigationState } from './discussion-navigation.js';

export const freshnessPolicy = Object.freeze({
  intervalMs: 15000,
  maxBackoffMs: 120000,
  maxPending: 128,
});
type Watch = { id: string; revision?: string; visible: boolean; priority?: boolean };
export function selectFreshnessWatches(matches: Watch[], limit: number, round: number) {
  const priority = matches.filter((value) => value.priority);
  const visible = matches.filter((value) => value.visible && !value.priority);
  const hidden = matches.filter((value) => !value.visible && !value.priority);
  const rotate = (items: Watch[], count: number) => {
    if (!items.length || !count) return [];
    const start = round % items.length;
    return Array.from(
      { length: Math.min(items.length, count) },
      (_, i) => items[(start + i) % items.length]!,
    );
  };
  // A mounted collapsed subtree is lower priority, but it must eventually
  // receive a watch slot even when the visible set exceeds one batch.
  const chosenPriority = rotate(priority, limit);
  const remaining = limit - chosenPriority.length;
  const hiddenSlots = hidden.length && visible.length >= remaining ? Math.min(2, remaining) : 0;
  return [
    ...chosenPriority,
    ...rotate(visible, remaining - hiddenSlots),
    ...rotate(hidden, Math.max(hiddenSlots, remaining - visible.length)),
  ].slice(0, limit);
}
type Context = {
  events: F.FreshnessView['events'];
  broad: boolean;
  catchingUp: boolean;
  error: string;
  latest: ReadonlyMap<string, string>;
  watch: (kind: 'parent' | 'body', value: Watch) => () => void;
  represented: (ids: string[]) => void;
  representedRevision: (id: string, revision: string) => void;
  reconciledDiscussion: (through: string) => void;
  checkNow: () => void;
};
const FreshnessContext = createContext<Context | null>(null);
export function useDiscussionFreshness() {
  return useContext(FreshnessContext);
}

export function DiscussionFreshnessProvider({
  discussion,
  self,
  navigation,
  children,
}: {
  discussion: string;
  self: Self;
  navigation: DiscussionNavigationState;
  children: ReactNode;
}) {
  const authority = useAuthorization();
  const owner = useRef(identityGeneration());
  const saved = navigation.freshness;
  const cursor = useRef(saved?.cursor);
  const pending = useRef(new Map((saved?.events ?? []).map((event) => [event.position, event])));
  const broad = useRef(saved?.broad ?? false);
  const watched = useRef(new Map<string, Watch>());
  const latest = useRef(new Map<string, string>());
  const round = useRef(0);
  const inFlight = useRef(false);
  const failureCount = useRef(0);
  const retryNotBefore = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  const [ready, setReady] = useState(!!cursor.current);
  const [version, setVersion] = useState(0);
  const [catchingUp, setCatchingUp] = useState(false);
  const [error, setError] = useState('');
  const emit = useCallback(() => {
    navigation.freshness = {
      cursor: cursor.current!,
      events: [...pending.current.values()],
      broad: broad.current,
    };
    setVersion((n) => n + 1);
  }, [navigation]);
  const select = (kind: 'parent' | 'body', limit: number) => {
    const matches = [...watched.current.entries()]
      .filter(([key]) => key.startsWith(kind + ':'))
      .map(([, value]) => value);
    return selectFreshnessWatches(matches, limit, round.current);
  };
  const check = useCallback(async () => {
    if (
      !live.current ||
      inFlight.current ||
      !cursor.current ||
      document.hidden ||
      !navigator.onLine ||
      owner.current !== identityGeneration() ||
      !authority.active()
    )
      return;
    if (performance.now() < retryNotBefore.current)
      return retryNotBefore.current - performance.now();
    inFlight.current = true;
    const parents = select('parent', F.freshnessLimits.parents).map((value) => value.id);
    const displayed = select('body', F.freshnessLimits.displayed)
      .filter((value): value is Watch & { revision: string } => !!value.revision)
      .map((value) => ({ resource_id: value.id, revision_id: value.revision }));
    // Step by one so sets whose size divides the batch limit still rotate.
    round.current++;
    try {
      const result = await authority.readProjection<F.FreshnessView>(
        `/api/v1/discussions/${discussion}/freshness`,
        {
          body: { action: 'check', cursor: cursor.current, parents, displayed },
          self,
          schema: F.Freshness,
        },
      );
      if (
        !live.current ||
        owner.current !== identityGeneration() ||
        !authority.current(result.generation)
      )
        return;
      const response = result.value;
      cursor.current = response.cursor;
      let changed = false;
      for (const item of response.displayed) {
        if (item.current_revision_id && item.current_revision_id !== item.revision_id) {
          if (latest.current.get(item.resource_id) !== item.current_revision_id) changed = true;
          latest.current.set(item.resource_id, item.current_revision_id);
        } else if (latest.current.delete(item.resource_id)) changed = true;
      }
      for (const event of response.events) {
        if (event.own && event.kind !== 'revision') continue;
        if (!pending.current.has(event.position)) {
          pending.current.set(event.position, event);
          changed = true;
        }
      }
      while (pending.current.size > freshnessPolicy.maxPending) {
        pending.current.delete(pending.current.keys().next().value!);
        broad.current = true;
        changed = true;
      }
      if (catchingUp !== !response.complete) setCatchingUp(!response.complete);
      if (error) setError('');
      failureCount.current = 0;
      retryNotBefore.current = 0;
      navigation.freshness = {
        cursor: cursor.current,
        events: [...pending.current.values()],
        broad: broad.current,
      };
      if (changed) emit();
    } catch (failure) {
      if (!live.current || owner.current !== identityGeneration()) return;
      if ((failure as Error).name === 'AbortError') return;
      failureCount.current++;
      setError('Couldn’t check for updates. Retrying…');
      const guidance = failure instanceof ApiError ? failure.retryAfterSeconds : undefined;
      const delay = guidance
        ? guidance * 1000
        : Math.min(
            freshnessPolicy.maxBackoffMs,
            freshnessPolicy.intervalMs * 2 ** Math.min(3, failureCount.current),
          );
      retryNotBefore.current = performance.now() + delay;
      return delay;
    } finally {
      inFlight.current = false;
    }
  }, [authority, discussion, self, catchingUp, error, emit, navigation]);
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    live.current = true;
    if (cursor.current)
      return () => {
        live.current = false;
      };
    let busy = false;
    let failures = 0;
    const pause = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
    };
    const schedule = (delay: number) => {
      pause();
      if (document.hidden || !navigator.onLine) return;
      timer.current = setTimeout(run, Math.max(delay, retryNotBefore.current - performance.now()));
    };
    const run = async () => {
      timer.current = undefined;
      if (
        busy ||
        cursor.current ||
        !live.current ||
        document.hidden ||
        !navigator.onLine ||
        owner.current !== identityGeneration() ||
        !authority.active()
      )
        return;
      busy = true;
      try {
        const result = await authority.readProjection<F.FreshnessView>(
          `/api/v1/discussions/${discussion}/freshness`,
          { body: { action: 'baseline' }, self, schema: F.Freshness },
        );
        if (
          !live.current ||
          owner.current !== identityGeneration() ||
          !authority.current(result.generation)
        )
          return;
        cursor.current = result.value.cursor;
        navigation.freshness = { cursor: cursor.current, events: [], broad: false };
        retryNotBefore.current = 0;
        setError('');
        setReady(true);
      } catch (failure) {
        if (
          !live.current ||
          owner.current !== identityGeneration() ||
          (failure as Error).name === 'AbortError'
        )
          return;
        failures++;
        setError('Couldn’t check for updates. Retrying…');
        const guidance = failure instanceof ApiError ? failure.retryAfterSeconds : undefined;
        const delay = guidance
          ? guidance * 1000
          : Math.min(
              freshnessPolicy.maxBackoffMs,
              freshnessPolicy.intervalMs * 2 ** Math.min(3, failures),
            );
        retryNotBefore.current = performance.now() + delay;
        schedule(delay);
      } finally {
        busy = false;
      }
    };
    const resume = () => schedule(0);
    const onVisibility = () => (document.hidden ? pause() : resume());
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', onVisibility);
    schedule(0);
    return () => {
      live.current = false;
      pause();
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authority, discussion, navigation, self, ready]);
  useEffect(() => {
    if (!ready) return;
    const schedule = (delay: number) => {
      if (timer.current) clearTimeout(timer.current);
      if (document.hidden || !navigator.onLine) return;
      timer.current = setTimeout(
        async () => {
          timer.current = undefined;
          const retryDelay = await checkRef.current();
          if (live.current && !timer.current) schedule(retryDelay ?? freshnessPolicy.intervalMs);
        },
        Math.max(delay, retryNotBefore.current - performance.now()),
      );
    };
    const resume = () => schedule(0);
    const pause = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
    };
    const onVisibility = () => (document.hidden ? pause() : resume());
    schedule(freshnessPolicy.intervalMs);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      pause();
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ready]);
  const watch = useCallback((kind: 'parent' | 'body', value: Watch) => {
    const key = `${kind}:${value.id}`;
    watched.current.set(key, value);
    return () => {
      if (watched.current.get(key) === value) watched.current.delete(key);
    };
  }, []);
  const represented = useCallback(
    (ids: string[]) => {
      const known = new Set(ids);
      let changed = false;
      for (const [position, event] of pending.current)
        if (
          (event.kind === 'new_root' || event.kind === 'new_reply') &&
          event.resource_id &&
          known.has(event.resource_id)
        ) {
          pending.current.delete(position);
          changed = true;
        }
      if (changed) emit();
    },
    [emit],
  );
  const representedRevision = useCallback(
    (id: string, revision: string) => {
      let changed = false;
      for (const [position, event] of pending.current)
        if (
          event.kind === 'revision' &&
          event.resource_id === id &&
          event.revision_id === revision
        ) {
          pending.current.delete(position);
          changed = true;
        }
      if (changed) emit();
    },
    [emit],
  );
  const reconciledDiscussion = useCallback(
    (through: string) => {
      let changed = false;
      for (const [position, event] of pending.current)
        if (event.kind === 'discussion' && BigInt(position) <= BigInt(through)) {
          pending.current.delete(position);
          changed = true;
        }
      // The overflow flag covers events whose IDs were discarded. A metadata read
      // cannot prove that those older comments or revisions were reconciled.
      if (changed) emit();
    },
    [emit],
  );
  const value = useMemo<Context>(
    () => ({
      events: [...pending.current.values()],
      broad: broad.current,
      catchingUp,
      error,
      latest: new Map(latest.current),
      watch,
      represented,
      representedRevision,
      reconciledDiscussion,
      checkNow: () => void checkRef.current(),
    }),
    [version, catchingUp, error, watch, represented, representedRevision, reconciledDiscussion],
  );
  return (
    <FreshnessContext.Provider value={value}>
      {ready ? children : <p role="status">Opening discussion…</p>}
      {!ready && error && <p className="discussion-freshness-status">{error}</p>}
    </FreshnessContext.Provider>
  );
}
