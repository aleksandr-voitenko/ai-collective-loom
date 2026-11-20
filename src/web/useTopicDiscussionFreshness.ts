import { useEffect, useRef, useState } from 'react';
import {
  TopicFreshness,
  TopicFreshnessAudit,
  topicFreshnessLimits,
  type TopicFreshnessAuditView,
  type TopicFreshnessView,
} from '../contracts/topic-discussion-freshness.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { freshnessPolicy } from './DiscussionFreshness.js';
import { ApiError, identityGeneration, type Self } from './participation-client.js';

type Observation = {
  cursor: string | undefined;
  auditAt?: number;
  auditNext?: boolean;
};
type PreparedBaseline = { cursor: string; failureVersion: number };
type Change = TopicFreshnessView['change'];
export type WatchedTopicDiscussion = {
  resource_id: string;
  revision_id: string;
};
export const watchedTopicDiscussionKey = (row: WatchedTopicDiscussion) =>
  `${row.resource_id}:${row.revision_id}`;

export function useTopicDiscussionFreshness(
  topicId: string,
  self: Self,
  view: {
    rows: () => readonly WatchedTopicDiscussion[];
    withdraw: (tags: ReadonlySet<string>, before: number) => { removed: number; before: number };
    retag: (updated: ReadonlyMap<string, string[]>) => void;
    interruptRead: () => void;
  },
) {
  const authority = useAuthorization();
  const path = `/api/v1/areas/${topicId}/discussions/freshness`;
  const activeView = useRef(view);
  activeView.current = view;
  const observation = useRef<Observation>({ cursor: undefined });
  const [ready, setReady] = useState(false);
  const [change, setChange] = useState<Change>('none');
  const [failed, setFailed] = useState(false);
  const retryNotBefore = useRef(0);
  const failureCount = useRef(0);
  const failureVersion = useRef(0);

  function reportFailure(error: unknown) {
    failureVersion.current++;
    const guidance = error instanceof ApiError ? error.retryAfterSeconds : undefined;
    const delay =
      guidance !== undefined
        ? guidance * 1000
        : Math.min(
            freshnessPolicy.maxBackoffMs,
            freshnessPolicy.intervalMs * 2 ** Math.min(3, ++failureCount.current),
          );
    retryNotBefore.current = Math.max(retryNotBefore.current, performance.now() + delay);
    setFailed(true);
  }
  function baseline(signal: AbortSignal) {
    return authority.readAuthorized<TopicFreshnessView>(path, {
      body: { action: 'baseline' },
      schema: TopicFreshness,
      self,
      signal,
    });
  }
  async function prepare(signal: AbortSignal) {
    const version = failureVersion.current;
    try {
      return { cursor: (await baseline(signal)).value.cursor, failureVersion: version };
    } catch (error) {
      if (!signal.aborted && authority.active()) reportFailure(error);
      // The listing can still succeed. Keep the old observation if there is
      // one, or start recovery with a broad indication that history is missing.
      return undefined;
    }
  }
  function accept(prepared: PreparedBaseline | undefined, filtered: boolean) {
    if (prepared) {
      // A successful first page acknowledges only the baseline captured
      // before that page. The replacement cursor still observes later work.
      observation.current = { cursor: prepared.cursor };
      setChange(filtered ? 'updated' : 'none');
      if (prepared.failureVersion === failureVersion.current) setFailed(false);
    } else if (filtered) setChange('updated');
    setReady(true);
  }

  useEffect(() => {
    if (!ready) return;
    const owner = identityGeneration();
    let live = true;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastStarted = -Infinity;
    const current = () => live && owner === identityGeneration() && authority.active();
    const available = () => current() && !document.hidden && navigator.onLine;
    const pause = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (delay: number) => {
      pause();
      if (!available() || request) return;
      timer = setTimeout(
        () => void run(),
        Math.max(delay, retryNotBefore.current - performance.now()),
      );
    };
    async function run() {
      timer = undefined;
      if (!available() || request) return;
      const started = performance.now();
      // A foreground baseline can be throttled after this timer was armed.
      if (started < retryNotBefore.current) {
        schedule(0);
        return;
      }
      const frame = observation.current;
      const version = failureVersion.current;
      const controller = new AbortController();
      request = controller;
      lastStarted = started;
      try {
        if (!frame.cursor) {
          const result = await baseline(controller.signal);
          if (!current() || !authority.current(result.generation) || frame !== observation.current)
            return;
          frame.cursor = result.value.cursor;
          frame.auditAt = 0;
          frame.auditNext = true;
          setChange('updated');
        } else if (frame.auditNext && frame.auditAt !== undefined) {
          const start = frame.auditAt;
          const rows = activeView.current.rows();
          const batch = rows.slice(start, start + topicFreshnessLimits.displayed);
          if (!batch.length) {
            delete frame.auditAt;
          } else {
            const result = await authority.readAuthorized<TopicFreshnessAuditView>(path, {
              body: {
                action: 'audit',
                displayed: batch.map(({ resource_id, revision_id }) => ({
                  resource_id,
                  revision_id,
                })),
              },
              schema: TopicFreshnessAudit,
              self,
              signal: controller.signal,
            });
            if (!current() || !authority.current(result.generation)) return;
            const next = start + batch.length;
            const revoked = new Set(
              result.value.unavailable.flatMap((index) => {
                const row = batch[index];
                return row ? [watchedTopicDiscussionKey(row)] : [];
              }),
            );
            const removed = activeView.current.withdraw(revoked, next);
            if (removed.removed) setChange('updated');
            const remainingAt = next - removed.before;
            if (frame === observation.current) {
              const retagged = new Map<string, string[]>();
              result.value.tags.forEach((tags, index) => {
                const row = batch[index];
                if (row && tags) retagged.set(watchedTopicDiscussionKey(row), tags);
              });
              activeView.current.retag(retagged);
              if (remainingAt < activeView.current.rows().length) frame.auditAt = remainingAt;
              else delete frame.auditAt;
            }
          }
          frame.auditNext = false;
        } else {
          const result = await authority.readAuthorized<TopicFreshnessView>(path, {
            body: { action: 'check', cursor: frame.cursor },
            schema: TopicFreshness,
            self,
            signal: controller.signal,
          });
          if (!current() || !authority.current(result.generation)) return;
          // Even a superseded check can report that an overlapping read
          // carried protected data. Its activity summary and cursor are stale.
          const removed = activeView.current.withdraw(
            new Set(result.value.withdrawn_tags),
            observation.current.auditAt ?? 0,
          );
          if (removed.removed) setChange('updated');
          const latest = observation.current;
          if (latest.auditAt !== undefined) latest.auditAt -= removed.before;
          if (frame !== latest) return;
          frame.cursor = result.value.cursor;
          frame.auditNext = frame.auditAt !== undefined;
          if (result.value.change !== 'none')
            setChange((pending) =>
              !removed.removed && pending === 'new_discussions' ? pending : result.value.change,
            );
        }
        if (frame === observation.current && version === failureVersion.current) {
          failureCount.current = 0;
          retryNotBefore.current = 0;
          setFailed(false);
        }
      } catch (error) {
        if (!current() || (error as Error).name === 'AbortError') return;
        const api = error instanceof ApiError ? error : undefined;
        // Rate admission still applies when Show latest replaces the cursor.
        if (api?.retryAfterSeconds !== undefined) reportFailure(api);
        else if (frame === observation.current) {
          if (api?.code === 'invalid_cursor') {
            activeView.current.interruptRead();
            observation.current = { cursor: undefined };
            setChange('updated');
          } else reportFailure(error);
        }
      } finally {
        request = undefined;
        schedule(freshnessPolicy.intervalMs);
      }
    }
    // Collapse visibility, online and focus notifications for the same resume
    // and let an already running check satisfy them.
    const resume = () => schedule(Math.max(0, lastStarted + 1000 - performance.now()));
    const onVisibility = () => (document.hidden ? pause() : resume());
    schedule(freshnessPolicy.intervalMs);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      pause();
      request?.abort();
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [authority, path, ready, self]);

  return { prepare, accept, change, failed };
}
