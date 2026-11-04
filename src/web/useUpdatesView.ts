import { useEffect, useRef, useState, type RefObject } from 'react';
import * as C from '../contracts/updates.js';
import * as R from '../contracts/routine-updates.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ApiError, identityGeneration } from './participation-client.js';
import type { Context } from './participation-state.js';
import { UpdatesRecovery, displayedRequest, type UpdatesPageRequest } from './updates-recovery.js';

export type ExpansionRetry = { scope: string; request: C.UpdatesMembersOptions };

const withdraw = new Set([
  'updates_visibility_replay_required',
  'updates_view_changed',
  'updates_epoch_changed',
  'updates_state_unavailable',
  'updates_shared_history_gap',
  'updates_personal_history_gap',
  'unauthenticated',
  'invalid_actor',
  'unavailable',
  'forbidden',
]);
// The keyed view owns one coordinator for reads, durable display and authorization fences.
export function useUpdatesView({
  context,
  scope,
  reason,
  routine,
  expansionRetry,
}: {
  context: Context;
  scope: NonNullable<C.UpdatesOptions['scope']>;
  reason: 'all' | 'mention' | 'reply';
  routine: boolean;
  expansionRetry: RefObject<ExpansionRetry | undefined>;
}) {
  const authority = useAuthorization();
  const [page, setPage] = useState<C.UpdatesPageView | R.RoutinePageView>(),
    [expanded, setExpanded] = useState<C.UpdatesMembersPageView | R.RoutineMembersPageView>(),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<{ code: string; text: string }>(),
    [size, setSize] = useState(12),
    [past, setPast] = useState<UpdatesPageRequest[]>([]);
  const [recovery] = useState(
    () =>
      new UpdatesRecovery(
        context.community.instance_id,
        context.self.participant_id,
        localStorage,
        routine,
      ),
  );
  const [attentionChanged, setAttentionChanged] = useState(false),
    attentionChanges = useRef(0);
  const api = routine ? '/api/v1/me/routine-updates' : '/api/v1/me/updates';
  const key = JSON.stringify([scope, reason]),
    live = useRef(false),
    owner = useRef(identityGeneration()),
    sequence = useRef(0),
    requestSequence = useRef(0),
    inflight = useRef(false),
    controller = useRef<AbortController | undefined>(undefined),
    notice = useRef<HTMLDivElement>(null),
    anchor = useRef<HTMLDivElement>(null),
    expansionAnchor = useRef<HTMLElement>(null),
    attempted = useRef<R.RoutineOptions>({ scope, reason }),
    memberAttempt = useRef<C.UpdatesMembersOptions | undefined>(undefined),
    memberFailure = useRef(false),
    lastControl = useRef<HTMLButtonElement | null>(null);
  const active = () => live.current && owner.current === identityGeneration() && authority.active();
  const retryScope = JSON.stringify([
    context.community.instance_id,
    context.self.participant_id,
    scope,
    reason,
    routine,
  ]);
  function cancelRead() {
    requestSequence.current++;
    controller.current?.abort();
    inflight.current = false;
    setBusy(false);
  }
  const report = (error: unknown) => {
    if (error instanceof ApiError && withdraw.has(error.code)) {
      // A child control can learn of withdrawal while an overview/member read
      // is still pending. Fence that read and its queued recovery save as well.
      cancelRead();
      setPage(undefined);
      setExpanded(undefined);
    }
    setFailure({
      code: error instanceof ApiError ? error.code : 'local_recovery_failed',
      text: (error as Error).message,
    });
  };
  const attentionFailure = (error: unknown) => {
    if (!active() || !(error instanceof ApiError)) return;
    if (
      [
        'updates_attention_refresh_required',
        'updates_attention_preparing',
        'updates_descriptor_expired',
      ].includes(error.code)
    ) {
      // The failed selection belongs to the displayed view, not an unseen
      // successor that may already be in flight. Keep its exact recovery bounds.
      cancelRead();
      if (page) attempted.current = displayedRequest(page);
      memberAttempt.current = expanded ? displayedRequest(expanded) : undefined;
      report(error);
    }
  };
  async function load(
    options: R.RoutineOptions,
    history: UpdatesPageRequest[] = past,
    restore?: UpdatesPageRequest,
    focus = false,
  ) {
    if (inflight.current) return;
    inflight.current = true;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const mine = ++requestSequence.current,
      policyAtStart = attentionChanges.current;
    attempted.current = options;
    memberAttempt.current = restore;
    memberFailure.current = false;
    setBusy(true);
    setFailure(undefined);
    expansionRetry.current = restore ? { scope: retryScope, request: restore } : undefined;
    try {
      const value = await authority.read<C.UpdatesPageView | R.RoutinePageView>(api + '/query', {
        body: options,
        self: context.self,
        schema: routine ? R.RoutinePage : C.UpdatesPage,
        signal: abort.signal,
      });
      if (!active() || mine !== requestSequence.current) return;
      attempted.current = displayedRequest(value);
      // A retried expansion may be an unseen successor. Keep its last displayed
      // position until the member response has also been reauthorized and saved.
      const saved = await recovery.save(
        key,
        value,
        sequence.current,
        () => active() && mine === requestSequence.current,
        history,
        restore ? recovery.read(key)?.expansion : undefined,
      );
      if (!active() || mine !== requestSequence.current) return;
      // An older response cannot acknowledge a policy event observed during its
      // read or recovery save, even when that response is otherwise still current.
      sequence.current = saved.sequence;
      setPage(value);
      setAttentionChanged(policyAtStart !== attentionChanges.current);
      setPast(history.slice(-8));
      setExpanded(undefined);
      setSize(value.limit);
      if (focus) anchor.current?.focus();
      if (restore) {
        memberFailure.current = true;
        const detail = await authority.read<C.UpdatesMembersPageView | R.RoutineMembersPageView>(
          api + '/members',
          {
            body: { ...restore, ...(options.recovery?.action === 'renew' ? { renew: true } : {}) },
            self: context.self,
            schema: routine ? R.RoutineMembersPage : C.UpdatesMembersPage,
            signal: abort.signal,
          },
        );
        if (!active() || mine !== requestSequence.current) return;
        const next = await recovery.save(
          key,
          value,
          sequence.current,
          () => active() && mine === requestSequence.current,
          history,
          displayedRequest(detail),
        );
        if (!active() || mine !== requestSequence.current) return;
        sequence.current = next.sequence;
        setExpanded(detail);
        memberAttempt.current = displayedRequest(detail);
      }
    } catch (error) {
      if (active() && mine === requestSequence.current && (error as Error).name !== 'AbortError')
        report(error);
    } finally {
      if (mine === requestSequence.current) {
        inflight.current = false;
        if (active()) setBusy(false);
      }
    }
  }
  async function members(options: C.UpdatesMembersOptions, control?: HTMLButtonElement) {
    if (inflight.current || !page) return;
    inflight.current = true;
    setBusy(true);
    setFailure(undefined);
    memberAttempt.current = options;
    memberFailure.current = true;
    expansionRetry.current = { scope: retryScope, request: options };
    if (control) lastControl.current = control;
    const mine = ++requestSequence.current;
    try {
      const value = await authority.read<C.UpdatesMembersPageView | R.RoutineMembersPageView>(
        api + '/members',
        {
          body: options,
          self: context.self,
          schema: routine ? R.RoutineMembersPage : C.UpdatesMembersPage,
        },
      );
      if (!active() || mine !== requestSequence.current) return;
      memberAttempt.current = displayedRequest(value);
      const saved = await recovery.save(
        key,
        page,
        sequence.current,
        () => active() && mine === requestSequence.current,
        past,
        displayedRequest(value),
      );
      if (!active() || mine !== requestSequence.current) return;
      sequence.current = saved.sequence;
      setExpanded(value);
    } catch (error) {
      if (active() && mine === requestSequence.current) report(error);
    } finally {
      if (mine === requestSequence.current) {
        inflight.current = false;
        if (active()) setBusy(false);
      }
    }
  }
  async function collapse() {
    if (inflight.current || !page) return;
    inflight.current = true;
    setBusy(true);
    const mine = ++requestSequence.current;
    try {
      const saved = await recovery.save(
        key,
        page,
        sequence.current,
        () => active() && mine === requestSequence.current,
        past,
      );
      if (!active() || mine !== requestSequence.current) return;
      sequence.current = saved.sequence;
      setExpanded(undefined);
      memberAttempt.current = undefined;
      memberFailure.current = false;
      expansionRetry.current = undefined;
      (lastControl.current?.isConnected
        ? lastControl.current
        : expanded?.group_id
          ? document.getElementById('updates-group-' + expanded.group_id)
          : anchor.current
      )?.focus();
    } catch (error) {
      if (active() && mine === requestSequence.current) report(error);
    } finally {
      if (mine === requestSequence.current) {
        inflight.current = false;
        if (active()) setBusy(false);
      }
    }
  }
  useEffect(() => {
    live.current = true;
    owner.current = identityGeneration();
    inflight.current = false;
    try {
      const saved = recovery.read(key);
      sequence.current = saved?.sequence ?? 0;
      const pending =
        expansionRetry.current?.scope === retryScope ? expansionRetry.current.request : undefined;
      void load(
        saved?.request ?? { scope, reason },
        saved?.past ?? [],
        pending
          ? {
              cursor: pending.cursor,
              limit: pending.limit ?? 12,
              max_response_bytes: pending.max_response_bytes ?? 131072,
            }
          : saved?.expansion,
      );
    } catch (error) {
      report(error);
    }
    return () => {
      live.current = false;
      requestSequence.current++;
      controller.current?.abort();
    };
  }, [key, recovery]);
  useEffect(() => {
    if (!routine) return;
    const changed = () => {
      if (active()) {
        attentionChanges.current++;
        setAttentionChanged(true);
      }
    };
    const storage = (event: StorageEvent) => {
      if (
        event.key?.startsWith(
          `loom.attention:${location.origin}:${context.community.instance_id}:${context.self.participant_id}:`,
        )
      )
        changed();
    };
    window.addEventListener('loom-attention-policy', changed);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener('loom-attention-policy', changed);
      window.removeEventListener('storage', storage);
    };
  }, [routine]);
  useEffect(() => {
    if (failure && withdraw.has(failure.code)) notice.current?.focus();
  }, [failure]);
  useEffect(() => {
    if (expanded) expansionAnchor.current?.focus();
  }, [expanded]);
  const token =
    attempted.current.cursor ??
    attempted.current.checkpoint ??
    attempted.current.switch?.token ??
    attempted.current.recovery?.token;
  const action =
    failure?.code === 'updates_attention_refresh_required' ||
    failure?.code === 'updates_attention_preparing'
      ? 'attention_refresh'
      : failure?.code === 'updates_descriptor_expired'
        ? 'renew'
        : failure?.code === 'updates_visibility_replay_required'
          ? 'replay'
          : failure?.code.endsWith('_history_gap') || failure?.code === 'updates_state_unavailable'
            ? 'resynchronize'
            : undefined;
  async function clear() {
    if (inflight.current) return;
    try {
      await recovery.clear(active);
      sequence.current = 0;
      await load({ scope, reason }, [], undefined, true);
    } catch (error) {
      if (active()) report(error);
    }
  }
  function recover() {
    if (!action) return;
    void load(
      {
        recovery: { action, ...(token ? { token } : {}) },
        ...(!token ? { scope, reason } : {}),
        limit: attempted.current.limit ?? 12,
        max_response_bytes: attempted.current.max_response_bytes ?? 131072,
      },
      past,
      action === 'renew' && memberAttempt.current
        ? {
            cursor: memberAttempt.current.cursor,
            limit: memberAttempt.current.limit ?? 12,
            max_response_bytes: memberAttempt.current.max_response_bytes ?? 131072,
          }
        : undefined,
      true,
    );
  }
  function retry() {
    if (page && memberFailure.current && memberAttempt.current) void members(memberAttempt.current);
    else
      void load(
        attempted.current,
        past,
        memberAttempt.current
          ? {
              cursor: memberAttempt.current.cursor,
              limit: memberAttempt.current.limit ?? 12,
              max_response_bytes: memberAttempt.current.max_response_bytes ?? 131072,
            }
          : undefined,
      );
  }
  return {
    recover,
    retry,
    page,
    expanded,
    busy,
    failure,
    size,
    setSize,
    past,
    attentionChanged,
    notice,
    anchor,
    expansionAnchor,
    active,
    report,
    attentionFailure,
    load,
    members,
    collapse,
    clear,
    token,
    action,
  };
}
