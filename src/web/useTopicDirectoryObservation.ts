import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { DirectoryObservation, type DirectoryObservationView } from '../contracts/organization.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { freshnessPolicy } from './DiscussionFreshness.js';
import { ApiError, identityGeneration } from './participation-client.js';

type Findings = {
  directoryVersion: number;
  hierarchyVersion: number;
  changedClosureFor: DirectoryObservationView | undefined;
};

export function useTopicDirectoryObservation(
  parent: string | null,
  section: RefObject<HTMLElement | null>,
  baseline: DirectoryObservationView | undefined,
  hasContinuation: boolean,
) {
  const authority = useAuthorization();
  const accepted = useRef(baseline);
  const [findings, setFindings] = useState<Findings>();
  const [failed, setFailed] = useState(false);
  const ready = !!baseline;
  const retryAt = useRef(0);

  function deferChecks(error: unknown) {
    const guidance = error instanceof ApiError ? error.retryAfterSeconds : undefined;
    if (guidance !== undefined)
      retryAt.current = Math.max(retryAt.current, performance.now() + guidance * 1000);
    return guidance !== undefined;
  }

  useLayoutEffect(() => {
    accepted.current = baseline;
  }, [baseline]);

  // Keep the single request slot and admission deadline across list replacement.
  // Each response's collection evidence still belongs to its own accepted baseline.
  useEffect(() => {
    if (!ready) return;
    const owner = identityGeneration();
    const disclosure = section.current?.closest('details');
    const path =
      '/api/v1/organization/children/observation' +
      (parent === null ? '' : '?' + new URLSearchParams({ parent_id: parent }));
    let live = true;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let lastStarted = -Infinity;
    let resumeRequested = false;
    const current = () =>
      live && section.current?.isConnected && owner === identityGeneration() && authority.active();
    const available = () =>
      current() && (!disclosure || disclosure.open) && !document.hidden && navigator.onLine;
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
      const frame = accepted.current;
      if (!frame || !available() || request) return;
      // Foreground reads share read admission and may defer an already armed timer.
      if (performance.now() < retryAt.current) {
        schedule(0);
        return;
      }
      lastStarted = performance.now();
      request = new AbortController();
      try {
        const result = await authority.readAuthorized<DirectoryObservationView>(path, {
          schema: DirectoryObservation,
          signal: request.signal,
        });
        if (!current() || !authority.current(result.generation) || frame !== accepted.current)
          return;
        const value = result.value;
        if (value.parent_id !== parent) throw new Error('Unexpected directory observation scope.');
        const closureChanged = value.inherited_closure !== frame.inherited_closure;
        if (
          value.directory_version > frame.directory_version ||
          value.hierarchy_version > frame.hierarchy_version ||
          closureChanged
        )
          setFindings((prior) => ({
            directoryVersion: Math.max(prior?.directoryVersion ?? 0, value.directory_version),
            hierarchyVersion: Math.max(prior?.hierarchyVersion ?? 0, value.hierarchy_version),
            changedClosureFor: closureChanged ? frame : prior?.changedClosureFor,
          }));
        failures = 0;
        setFailed(false);
      } catch (error) {
        if (!current() || (error as Error).name === 'AbortError') return;
        const throttled = deferChecks(error);
        if (frame !== accepted.current) return;
        if (!throttled) {
          const delay = Math.min(
            freshnessPolicy.maxBackoffMs,
            freshnessPolicy.intervalMs * 2 ** Math.min(3, ++failures),
          );
          retryAt.current = Math.max(retryAt.current, performance.now() + delay);
        }
        setFailed(true);
      } finally {
        request = undefined;
        // A held check normally satisfies a resume, unless its traversal was
        // replaced and its positive evidence had to be discarded.
        if (resumeRequested && frame !== accepted.current) resume();
        else schedule(freshnessPolicy.intervalMs);
        resumeRequested = false;
      }
    }
    function resume() {
      if (request) resumeRequested = !!available();
      else schedule(Math.max(0, lastStarted + 1000 - performance.now()));
    }
    const visibility = () => (document.hidden ? pause() : resume());
    const toggle = () => (disclosure?.open ? resume() : pause());
    schedule(freshnessPolicy.intervalMs);
    disclosure?.addEventListener('toggle', toggle);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', pause);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      live = false;
      pause();
      request?.abort();
      disclosure?.removeEventListener('toggle', toggle);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', pause);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [authority, parent, ready, section]);

  // A check can finish before a staged replacement whose rows were read earlier.
  // Only revisions covered by the newly accepted rows have been acknowledged.
  const updated =
    !!baseline &&
    !!findings &&
    (findings.directoryVersion > baseline.directory_version ||
      findings.changedClosureFor === baseline);
  const continuationStale =
    hasContinuation &&
    !!baseline &&
    !!findings &&
    findings.hierarchyVersion > baseline.hierarchy_version;
  return {
    pending: updated
      ? ('updated' as const)
      : continuationStale
        ? ('organization' as const)
        : undefined,
    continuationStale,
    failed,
    deferChecks,
  };
}
