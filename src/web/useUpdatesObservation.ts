import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  RoutineObservation,
  type RoutineObservationView,
  type RoutinePageView,
} from '../contracts/routine-updates.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { freshnessPolicy } from './DiscussionFreshness.js';
import { ApiError, identityGeneration, type Self } from './participation-client.js';

type Status = {
  pending: boolean;
  failed: boolean;
  unknown: boolean;
  catchingUp: boolean;
  settingsChanged: boolean;
  problem?: ApiError;
};
const quiet: Status = {
  pending: false,
  failed: false,
  unknown: false,
  catchingUp: false,
  settingsChanged: false,
};

export function useUpdatesObservation(
  self: Self,
  page: RoutinePageView | undefined,
  attentionChanged: boolean,
  policyGeneration: () => number,
  bindingFailure: (error: ApiError) => boolean,
) {
  const authority = useAuthorization();
  // Paging the same fixed interval issues new page tokens. Keep observing from
  // the original overview until the browser accepts a different binding.
  const frame = useMemo(
    () => ({ view: page?.page_cursor, cursor: undefined as string | undefined }),
    [
      page?.traversal.id,
      page?.traversal.selection,
      page?.traversal.expires_at,
      page?.attention.policy_version,
    ],
  );
  const [observed, setObserved] = useState<{ frame: typeof frame; status: Status }>();
  const retryAt = useRef(0);
  const paused = attentionChanged && page?.traversal.selection !== 'complete';
  const handlers = useRef({ policyGeneration, bindingFailure, paused });
  const resumeObserver = useRef<() => void>(undefined);
  useLayoutEffect(() => {
    handlers.current = { policyGeneration, bindingFailure, paused };
  });
  useLayoutEffect(() => {
    if (!frame.view) return;
    const owner = identityGeneration();
    let live = true;
    let stopped = false;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastStarted = -Infinity;
    let failures = 0;
    const current = () => live && owner === identityGeneration() && authority.active();
    const available = () =>
      current() && !handlers.current.paused && !stopped && !document.hidden && navigator.onLine;
    function update(change: (prior: Status) => Status) {
      setObserved((prior) => ({
        frame,
        status: change(prior?.frame === frame ? prior.status : quiet),
      }));
    }
    function pause() {
      clearTimeout(timer);
      timer = undefined;
    }
    function schedule(delay: number) {
      pause();
      if (available() && !request)
        timer = setTimeout(run, Math.max(delay, retryAt.current - performance.now()));
    }
    async function run() {
      timer = undefined;
      if (!available() || request) return;
      if (performance.now() < retryAt.current) {
        schedule(0);
        return;
      }
      request = new AbortController();
      const policy = handlers.current.policyGeneration();
      lastStarted = performance.now();
      try {
        const result = await authority.readAuthorized<RoutineObservationView>(
          '/api/v1/me/routine-updates/observe',
          {
            body: { view: frame.view, ...(frame.cursor ? { cursor: frame.cursor } : {}) },
            self,
            schema: RoutineObservation,
            signal: request.signal,
          },
        );
        if (
          !current() ||
          !authority.current(result.generation) ||
          policy !== handlers.current.policyGeneration()
        )
          return;
        const value = result.value;
        frame.cursor = value.cursor;
        failures = 0;
        update((prior) => ({
          pending: prior.pending || value.new_activity,
          unknown: prior.unknown || value.coverage === 'unknown',
          settingsChanged: !value.settings_current,
          catchingUp: !value.scan_complete,
          failed: false,
        }));
      } catch (error) {
        const guidance = error instanceof ApiError ? error.retryAfterSeconds : undefined;
        // Admission applies to the owner even if the response arrives after a
        // replacement view installed its timer. Only the view feedback is stale.
        if (guidance !== undefined && owner === identityGeneration() && authority.active())
          retryAt.current = Math.max(retryAt.current, performance.now() + guidance * 1000);
        if (!current() || (error as Error).name === 'AbortError') return;
        if (error instanceof ApiError) {
          if (handlers.current.bindingFailure(error)) {
            stopped = true;
            return;
          }
          if (
            [
              'updates_descriptor_expired',
              'updates_token_invalid',
              'unsupported_contract',
            ].includes(error.code)
          ) {
            stopped = true;
            update((prior) => ({ ...prior, failed: false, problem: error }));
            return;
          }
        }
        if (guidance === undefined) {
          const delay = Math.min(
            freshnessPolicy.maxBackoffMs,
            freshnessPolicy.intervalMs * 2 ** Math.min(3, ++failures),
          );
          retryAt.current = Math.max(retryAt.current, performance.now() + delay);
        }
        update((prior) => ({ ...prior, failed: true }));
      } finally {
        request = undefined;
        schedule(freshnessPolicy.intervalMs);
      }
    }
    const resume = () => schedule(Math.max(0, lastStarted + 1000 - performance.now()));
    const visibility = () => (document.hidden ? pause() : resume());
    resumeObserver.current = resume;
    schedule(freshnessPolicy.intervalMs);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      live = false;
      resumeObserver.current = undefined;
      pause();
      request?.abort();
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [frame, authority, self]);
  const wasPaused = useRef(paused);
  useLayoutEffect(() => {
    // Pause further checks, but allow a held same-view request to report
    // withdrawal. Its positive result is fenced by the policy generation.
    if (wasPaused.current && !paused) resumeObserver.current?.();
    wasPaused.current = paused;
  }, [paused]);
  return observed?.frame === frame ? observed.status : quiet;
}
