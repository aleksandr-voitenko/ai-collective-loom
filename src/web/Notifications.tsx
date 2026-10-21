import { useEffect, useRef, useState } from 'react';
import { DismissControl } from './Attention.js';
import { AuthorizationBoundary, useAuthorization } from './AuthorizationBoundary.js';
import { Link, useSearchParams } from 'react-router';
import { ApiError, identityGeneration } from './participation-client.js';
import type { Context } from './participation-state.js';
import { NotificationRecovery, recoveryToken } from './notification-recovery.js';
import {
  NotificationPage,
  type NotificationOptions,
  type NotificationPageView,
} from '../contracts/notifications.js';

const labels = {
  main_mention: 'Mention in main text',
  direct_reply: 'Direct reply',
  note_mention: 'Mention in revision note',
};
const contextInvalidations = new Set([
  'visibility_replay_required',
  'notification_view_changed',
  'notification_epoch_changed',
  'unauthenticated',
  'unavailable',
  'forbidden',
]);
export function NotificationsPage({ context }: { context: Context }) {
  return (
    <AuthorizationBoundary scope="notifications" retryLabel="Retry notification page">
      <NotificationsContent context={context} />
    </AuthorizationBoundary>
  );
}
function NotificationsContent({ context }: { context: Context }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('reason'),
    reason = selected === 'mention' || selected === 'reply' ? selected : 'all';
  return (
    <NotificationView
      key={`${context.community.instance_id}:${context.self.participant_id}:${reason}`}
      context={context}
      reason={reason}
      choose={(value) => setParams(value === 'all' ? {} : { reason: value })}
    />
  );
}
function NotificationView({
  context,
  reason,
  choose,
}: {
  context: Context;
  reason: 'all' | 'mention' | 'reply';
  choose: (reason: string) => void;
}) {
  const authority = useAuthorization();
  const [page, setPage] = useState<NotificationPageView>(),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<{ code: string; text: string }>();
  const live = useRef(false),
    generation = useRef(identityGeneration()),
    sequence = useRef(0),
    requestSequence = useRef(0),
    attempted = useRef<NotificationOptions>({ reason }),
    heading = useRef<HTMLHeadingElement>(null),
    controller = useRef<AbortController | undefined>(undefined);
  const recoveryNotice = useRef<HTMLDivElement>(null);
  const [recovery] = useState(
    () => new NotificationRecovery(context.community.instance_id, context.self.participant_id),
  );
  const active = () =>
    live.current && generation.current === identityGeneration() && authority.active();
  async function load(options: NotificationOptions, focus = false) {
    if (busy) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const mine = ++requestSequence.current;
    attempted.current = options;
    if (active()) {
      setBusy(true);
      setFailure(undefined);
    }
    try {
      const value = await authority.read<NotificationPageView>('/api/v1/me/notifications/query', {
        body: options,
        self: context.self,
        schema: NotificationPage,
        signal: abort.signal,
      });
      if (!active() || mine !== requestSequence.current) return;
      attempted.current = {
        reason,
        cursor: value.page_cursor,
        limit: value.limit,
        max_response_bytes: value.max_response_bytes,
      };
      // Save a token for replaying this very page before exposing its successor.
      // Reload always reauthorizes; cached source metadata is never rendered.
      const saved = await recovery.save(
        reason,
        value,
        sequence.current,
        () => active() && mine === requestSequence.current,
      );
      if (!active() || mine !== requestSequence.current) return;
      sequence.current = saved.sequence;
      setPage({
        ...value,
        items: [...new Map(value.items.map((item) => [item.delivery_id, item])).values()],
      });
      if (focus) heading.current?.focus();
    } catch (error) {
      if (active() && mine === requestSequence.current && (error as Error).name !== 'AbortError') {
        // Transport/save failures retain context, but an explicit policy or epoch
        // change withdraws the authority to keep displaying cached source rows.
        if (error instanceof ApiError && contextInvalidations.has(error.code)) setPage(undefined);
        setFailure({
          code: error instanceof ApiError ? error.code : 'local_recovery_failed',
          text: error instanceof Error ? error.message : 'Notification retrieval failed.',
        });
      }
    } finally {
      if (active() && mine === requestSequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    live.current = true;
    generation.current = identityGeneration();
    try {
      const saved = recovery.read(reason);
      sequence.current = saved?.sequence ?? 0;
      void load(saved?.request ?? { reason });
    } catch (error) {
      setFailure({ code: 'local_recovery_failed', text: (error as Error).message });
    }
    return () => {
      live.current = false;
      requestSequence.current++;
      controller.current?.abort();
    };
  }, [recovery, reason]);
  useEffect(() => {
    // The old paging control leaves the DOM with the withdrawn source rows.
    // Keep keyboard users at the explanation and its explicit recovery actions.
    if (failure && contextInvalidations.has(failure.code)) recoveryNotice.current?.focus();
  }, [failure]);
  const token = recoveryToken(attempted.current);
  async function restart() {
    if (busy) return;
    try {
      await recovery.restart(reason, active);
      sequence.current = 0;
      await load({ reason, recovery: { action: 'resynchronize' } }, true);
    } catch (error) {
      if (active()) setFailure({ code: 'local_recovery_failed', text: (error as Error).message });
    }
  }
  const recoveryAction =
    failure?.code === 'notification_descriptor_expired'
      ? 'renew'
      : failure?.code === 'visibility_replay_required'
        ? 'replay'
        : failure?.code === 'notification_history_gap'
          ? 'resynchronize'
          : undefined;
  return (
    <section className="notifications" aria-busy={busy}>
      <h1 tabIndex={-1} ref={heading}>
        Mentions/replies
      </h1>
      <p className="muted">
        Direct attention addressed to you. This view covers mentions and replies, independently of
        followed activity.
      </p>
      {context.community.attention_contract && (
        <p>
          All retained personal signals, including dismissed ones.{' '}
          <Link to="/loom/updates?kind=personal">Open remaining routine direct attention</Link>.
        </p>
      )}
      <div className="notification-toolbar">
        <label>
          Attention reasons{' '}
          <select value={reason} onChange={(event) => choose(event.target.value)}>
            <option value="all">Mentions and replies</option>
            <option value="mention">Mentions</option>
            <option value="reply">Replies</option>
          </select>
        </label>
        {page?.interval_complete && (
          <button
            aria-disabled={busy}
            onClick={() => void load({ reason, checkpoint: page.checkpoint! })}
          >
            Check for newer signals
          </button>
        )}
      </div>
      {busy && <p role="status">Loading direct attention…</p>}
      {failure && (
        <div className="notice error" role="alert" tabIndex={-1} ref={recoveryNotice}>
          <p>{failure.text}</p>
          {recoveryAction ? (
            <button
              aria-disabled={busy}
              onClick={() =>
                void load(
                  { reason, recovery: { action: recoveryAction, ...(token ? { token } : {}) } },
                  true,
                )
              }
            >
              {recoveryAction === 'renew'
                ? 'Renew this traversal'
                : recoveryAction === 'replay'
                  ? 'Replay retained history'
                  : 'Resynchronize retained history'}
            </button>
          ) : (
            failure.code !== 'notification_epoch_changed' && (
              <button aria-disabled={busy} onClick={() => void load(attempted.current)}>
                Retry notification page
              </button>
            )
          )}
          {['local_recovery_failed', 'notification_token_invalid'].includes(failure.code) && (
            <button aria-disabled={busy} onClick={() => void restart()}>
              Start a new retained view
            </button>
          )}
        </div>
      )}
      {page && (
        <>
          {page.projection.state === 'incomplete' && (
            <p className="notice" role="status">
              Notification generation is incomplete. More signals may become available after
              processing or repair.
            </p>
          )}
          {page.projection.state === 'unknown' && (
            <p className="notice" role="status">
              Generation coverage is unknown. This page lists currently available signals only.
            </p>
          )}
          {page.recovery === 'visibility_replay' && (
            <p className="notice" role="status">
              Replaying retained history includes earlier signals with their original identities.
            </p>
          )}
          {page.history === 'incomplete' && (
            <p className="notice" role="status">
              Earlier delivery history is unavailable. This retained view cannot reconstruct the
              missing notifications.
            </p>
          )}
          {!page.items.length && !failure && !busy && (
            <p>
              No eligible signals on this page.
              {page.next_cursor ? ' Continue scanning this interval.' : ''}
            </p>
          )}
          <ul className="notification-list">
            {page.items.map((item) => (
              <li key={item.delivery_id}>
                <div className="notification-reasons">
                  {item.reasons.map((r) => (
                    <span key={r.kind}>{labels[r.kind as keyof typeof labels]}</span>
                  ))}
                </div>
                <h2>
                  <Link to={item.browser_url}>{item.source.title ?? item.context_title}</Link>
                </h2>
                <p>
                  <strong>{item.source.publisher.nickname}</strong> · {item.source.area_title}
                  {item.parent?.state === 'available' ? (
                    <> · Reply to {item.parent.author?.nickname}</>
                  ) : item.parent ? (
                    <> · Parent unavailable</>
                  ) : null}
                </p>
                {item.current.main_mention === 'absent' &&
                  item.reasons.some((r) => r.kind === 'main_mention') && (
                    <p className="muted">
                      This mention is in the triggering revision; it is absent from current text.
                    </p>
                  )}
                {item.current.state === 'unavailable' && (
                  <p className="muted">
                    Current revision unavailable. The exact triggering revision is shown separately.
                  </p>
                )}
                <div className="notification-links">
                  <Link to={item.browser_url}>Exact triggering revision</Link>
                  {item.reasons.some((r) => r.kind === 'note_mention') && (
                    <Link to={item.browser_url + '#change-note'}>Triggering change note</Link>
                  )}
                  <Link to={item.context_url}>Current context</Link>
                </div>
                {context.community.attention_contract && (
                  <details>
                    <summary>Attention controls</summary>
                    <DismissControl
                      context={context}
                      inputs={[{ kind: 'personal_delivery', id: item.delivery_id }]}
                    />
                  </details>
                )}
                <details>
                  <summary>Publication and availability</summary>
                  <p>
                    Published{' '}
                    <time dateTime={item.source.created_at}>
                      {new Date(item.source.created_at).toLocaleString()}
                    </time>
                    . Available{' '}
                    <time dateTime={item.available_at}>
                      {new Date(item.available_at).toLocaleString()}
                    </time>
                    .
                  </p>
                  <p>Retrieving this signal does not mark it read or require a response.</p>
                </details>
              </li>
            ))}
          </ul>
          {/* aria-disabled plus load's guard prevents repeat requests without native
          disabled blurring the focused control during a failed page request. */}
          {page.next_cursor && (
            <button
              aria-disabled={busy}
              onClick={() => void load({ reason, cursor: page.next_cursor! }, true)}
            >
              Continue this interval
            </button>
          )}
          {page.interval_complete && !failure && (
            <p className="muted">
              Eligible available signals in this fixed interval have been retrieved.
            </p>
          )}
          <details className="notification-coverage">
            <summary>Retrieval coverage and recovery</summary>
            <p>
              Complete personal direct attention, ordered by availability within fixed bounds. New
              arrivals belong to a subsequent interval. Bodies remain on the exact source routes.
            </p>
            <p>
              Traversal expires {new Date(page.traversal.expires_at).toLocaleString()}; retained
              bounds can be renewed. This browser saves recovery before advancing.
            </p>
            <button
              aria-disabled={busy}
              onClick={() =>
                void load({ reason, recovery: { action: 'replay', token: page.page_cursor } }, true)
              }
            >
              Replay retained history
            </button>
          </details>
        </>
      )}
    </section>
  );
}
