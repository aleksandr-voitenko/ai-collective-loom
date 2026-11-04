import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link, useSearchParams } from 'react-router';
import * as C from '../contracts/updates.js';
import * as R from '../contracts/routine-updates.js';
import { MuteControl, DismissControl } from './Attention.js';
import { AuthorizationBoundary, useAuthorization } from './AuthorizationBoundary.js';
import type { FollowTargetView } from '../contracts/following.js';
function groupTarget(group: C.UpdateGroupView): FollowTargetView | undefined {
  if (group.current.state !== 'available') return;
  const match = /^\/loom\/(area|discussion|resource)\/([a-f0-9-]{36})$/.exec(
    group.current.browser_url,
  );
  return match
    ? {
        kind: match[1] === 'area' ? 'area' : match[1] === 'discussion' ? 'discussion' : 'artifact',
        resource_id: match[2]!,
      }
    : undefined;
}
import { eventPreferences } from '../contracts/following.js';
import type { Context } from './participation-state.js';
import { displayedRequest } from './updates-recovery.js';
import { useUpdatesView, type ExpansionRetry } from './useUpdatesView.js';

const reasonLabels = {
  main_mention: 'Mention',
  direct_reply: 'Direct reply',
  note_mention: 'Mention in revision note',
};
function MatchingReasons({
  item,
  cursor,
  context,
  active,
  onError,
}: {
  item: C.UpdateMemberView;
  cursor: string;
  context: Context;
  active: () => boolean;
  onError: (error: unknown) => void;
}) {
  const authority = useAuthorization();
  const [source, setSource] = useState(item.source),
    [busy, setBusy] = useState(false),
    live = useRef(true),
    requestId = useRef(0);
  useEffect(() => {
    live.current = true;
    setSource(item.source);
    return () => {
      live.current = false;
      requestId.current++;
    };
  }, [item.source, cursor]);
  const labels = {
    event_time_area: 'Published in the selected topic',
    direct_target: 'Direct target',
    structural_before_after: 'Structural change touched the selected scope',
    ancestor_impact: 'An ancestor of the selected target changed',
  };
  async function more() {
    if (busy || source.next_reason === null) return;
    setBusy(true);
    const mine = ++requestId.current;
    try {
      const value = await authority.read<typeof source>(source.detail_url, {
        body: { cursor, event_id: source.event_id, reason_offset: source.next_reason },
        self: context.self,
        schema: C.UpdatesReasonsPage,
      });
      if (live.current && active() && mine === requestId.current) setSource(value);
    } catch (error) {
      if (live.current && active() && mine === requestId.current) onError(error);
    } finally {
      if (live.current && mine === requestId.current) setBusy(false);
    }
  }
  return (
    <details>
      <summary>Why this shared change is included</summary>
      <ul>
        {source.reasons.map((reason) => (
          <li key={reason.definition}>
            {labels[reason.relevance as keyof typeof labels]} · {reason.target.kind} ·{' '}
            {reason.preferences.map((p) => p.replaceAll('_', ' ')).join(', ')}
          </li>
        ))}
      </ul>
      {!source.reasons_complete && (
        <button aria-disabled={busy} onClick={() => void more()}>
          More matching reasons
        </button>
      )}
      {source.reasons_complete && <p>Matching reasons complete for this source.</p>}
    </details>
  );
}
export function UpdatesPage({ context }: { context: Context }) {
  // A pending member position contains no source metadata and survives withdrawal
  // alongside the persisted displayed overview; retry must not silently lose it.
  const expansionRetry = useRef<ExpansionRetry | undefined>(undefined);
  return (
    <AuthorizationBoundary scope="updates" retryLabel="Retry Updates">
      <UpdatesContent context={context} expansionRetry={expansionRetry} />
    </AuthorizationBoundary>
  );
}
function UpdatesContent({
  context,
  expansionRetry,
}: {
  context: Context;
  expansionRetry: RefObject<ExpansionRetry | undefined>;
}) {
  const [params, setParams] = useSearchParams(),
    kind = params.get('kind'),
    id = params.get('id'),
    reason = params.get('reason');
  const scope: NonNullable<C.UpdatesOptions['scope']> =
    kind === 'personal'
      ? { kind: 'personal' }
      : (kind === 'area' || kind === 'discussion' || kind === 'artifact') && id
        ? {
            kind: 'explicit',
            definition: {
              target: { kind, resource_id: id },
              include_descendants: kind === 'area' && params.get('descendants') === 'true',
              preferences: eventPreferences.filter(
                (p) => !params.has('events') || params.get('events')!.split(',').includes(p),
              ),
            },
          }
        : { kind: 'following' };
  const routine =
    context.community.routine_updates_contract === R.routineUpdatesContract &&
    params.get('contract') !== 'legacy';
  const chosenReason = reason === 'mention' || reason === 'reply' ? reason : 'all';
  const choose = (field: string, value: string) => {
    const p = new URLSearchParams(params);
    if (value === 'all' || value === 'following') p.delete(field);
    else p.set(field, value);
    setParams(p, { flushSync: true });
  };
  return (
    <section className="updates notifications">
      <h1>Updates</h1>
      <p className="muted">
        Changes in followed discussions and artifacts, together with attention addressed to you.
      </p>
      <div className="notification-toolbar">
        <label>
          Updates scope{' '}
          <select
            value={scope.kind === 'explicit' ? 'explicit' : scope.kind}
            onChange={(e) => choose('kind', e.target.value)}
          >
            <option value="following">Following and direct attention</option>
            <option value="personal">Direct attention only</option>
            {scope.kind === 'explicit' && (
              <option value="explicit">
                Selected {scope.definition.target.kind} and direct attention
              </option>
            )}
          </select>
        </label>
        <label>
          Personal reasons{' '}
          <select value={chosenReason} onChange={(e) => choose('reason', e.target.value)}>
            <option value="all">Mentions and replies</option>
            <option value="mention">Mentions</option>
            <option value="reply">Replies</option>
          </select>
        </label>
      </div>
      <p>
        <Link to="/loom/attention">Attention settings</Link> ·{' '}
        <Link to="/loom/following">Manage Following</Link> ·{' '}
        <Link to="/loom/notifications">Standalone Mentions/replies</Link> ·{' '}
        <Link to="/loom/changes">Chronological Changes</Link>
      </p>
      {routine ? (
        <p>
          <Link
            to={'?' + new URLSearchParams({ ...Object.fromEntries(params), contract: 'legacy' })}
          >
            Open prior saved Updates views
          </Link>
        </p>
      ) : (
        context.community.routine_updates_contract && (
          <p className="notice">
            This prior Updates contract retains its original unfiltered meaning.{' '}
            <Link to={'?' + new URLSearchParams([...params].filter(([key]) => key !== 'contract'))}>
              Open routine Updates with attention controls
            </Link>
          </p>
        )
      )}
      <UpdatesView
        key={
          context.community.instance_id +
          context.self.participant_id +
          JSON.stringify(scope) +
          chosenReason +
          routine
        }
        context={context}
        scope={scope}
        reason={chosenReason}
        routine={routine}
        expansionRetry={expansionRetry}
      />
    </section>
  );
}
function UpdatesView({
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
  const {
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
  } = useUpdatesView({ context, scope, reason, routine, expansionRetry });
  const direct = (item: C.UpdateMemberView) => (
    <>
      <div className="notification-reasons">
        {item.personal?.reasons.map((r) => (
          <span key={r.kind}>{reasonLabels[r.kind as keyof typeof reasonLabels]}</span>
        ))}
      </div>
      <p>
        <strong>{item.source.actor.nickname}</strong> ·{' '}
        <Link to={item.source.exact_url!}>Exact source revision {item.source.revision_number}</Link>
        {item.personal?.reasons.some((r) => r.kind === 'note_mention') && (
          <>
            {' '}
            · <Link to={item.source.exact_url + '#change-note'}>Exact note</Link>
          </>
        )}
      </p>
    </>
  );
  return (
    <div ref={anchor} tabIndex={-1} aria-busy={busy}>
      <div className="notification-toolbar">
        <button
          aria-disabled={busy}
          onClick={() => void load({ scope, reason }, [], undefined, true)}
        >
          Refresh scope from retained history
        </button>
        {page?.checkpoint && (
          <button
            aria-disabled={busy}
            onClick={() =>
              void load({ checkpoint: page.checkpoint!, limit: size }, [], undefined, true)
            }
          >
            Check newer activity
          </button>
        )}
        <label>
          Next page size{' '}
          <select value={size} onChange={(e) => setSize(Number(e.target.value))}>
            <option value={5}>5</option>
            <option value={12}>12</option>
            <option value={25}>25</option>
          </select>
        </label>
      </div>
      {busy && <p role="status">Loading Updates…</p>}
      {failure && (
        <div role="alert" className="notice error" tabIndex={-1} ref={notice}>
          <p>{failure.text}</p>
          {action ? (
            <button aria-disabled={busy} onClick={recover}>
              {action === 'attention_refresh'
                ? 'Refresh attention selection'
                : action === 'renew'
                  ? 'Renew fixed Updates view'
                  : action === 'replay'
                    ? 'Replay both retained streams'
                    : 'Establish an incomplete new baseline'}
            </button>
          ) : (
            failure.code !== 'updates_epoch_changed' && (
              <button aria-disabled={busy} onClick={retry}>
                Retry Updates
              </button>
            )
          )}
          {routine && failure.code === 'updates_attention_refresh_required' && token && (
            <button
              aria-disabled={busy}
              onClick={() =>
                void load(
                  { switch: { token, selection: 'complete' }, limit: size },
                  [],
                  undefined,
                  true,
                )
              }
            >
              Open complete interval despite attention changes
            </button>
          )}
          {failure.code === 'local_recovery_failed' && (
            <button aria-disabled={busy} onClick={() => void clear()}>
              Clear saved Updates views
            </button>
          )}
        </div>
      )}
      {page && (
        <>
          {routine && attentionChanged && (
            <div className="notice">
              <p>
                Attention choices changed. Displayed cards retain their prior selection until
                explicit refresh.
              </p>
              <button
                aria-disabled={busy}
                onClick={() =>
                  void load(
                    {
                      recovery: { action: 'attention_refresh', token: page.page_cursor },
                      limit: page.limit,
                      max_response_bytes: page.max_response_bytes,
                    },
                    [],
                    undefined,
                    false,
                  )
                }
              >
                Refresh attention selection
              </button>
            </div>
          )}
          {'attention' in page && (
            <p className="fineprint">
              {page.attention.selection === 'remaining_routine_inputs'
                ? 'Counts describe remaining routine inputs.'
                : 'Complete retrieval includes all represented authorized inputs, including muted and dismissed ones.'}
            </p>
          )}
          {!page.traversal.settings_current && (
            <p className="notice">
              This interval retains earlier Following settings. Refresh scope to adopt current
              choices.
            </p>
          )}
          {page.projection.state !== 'complete' && (
            <p className="notice">
              Notification generation is {page.projection.state}. More direct signals may become
              available in a later interval.
            </p>
          )}
          {page.traversal.shared.coverage === 'unknown' && (
            <div className="notice">
              <p>
                Historical shared coverage is unknown. No complete combined checkpoint is issued.
              </p>
              {page.stage === 'ready' && (
                <>
                  <p>
                    Start checking newer activity from now with an explicitly incomplete baseline.
                    Missing history will not be reconstructed.
                  </p>
                  <button
                    aria-disabled={busy}
                    onClick={() =>
                      void load(
                        {
                          recovery: { action: 'resynchronize', token: page.page_cursor },
                          limit: page.limit,
                          max_response_bytes: page.max_response_bytes,
                        },
                        [],
                        undefined,
                        true,
                      )
                    }
                  >
                    Establish an incomplete new baseline
                  </button>
                </>
              )}
            </div>
          )}
          {page.recovery === 'visibility_replay' && (
            <p role="status">
              Replaying retained history from both streams with original identities.
            </p>
          )}
          {(page.baseline_established ||
            page.traversal.shared.history === 'incomplete' ||
            page.traversal.personal.history === 'incomplete') && (
            <div className="notice">
              <p>
                {page.baseline_established
                  ? 'This is an incomplete new baseline.'
                  : 'History remains incomplete from an earlier baseline.'}{' '}
                Missing history was not reconstructed.
              </p>
              <p>
                <Link to="/loom">Browse retained topics</Link> ·{' '}
                <Link to="/loom/artifacts">Browse retained artifacts</Link> ·{' '}
                <Link to="/loom/notifications">Open retained personal attention</Link>
              </p>
            </div>
          )}
          {page.stage === 'preparing' ? (
            <p>
              Preparing this fixed interval in bounded steps. Counts and groups will appear when
              both scans finish.
            </p>
          ) : (
            <>
              <div className="notification-toolbar">
                <strong>
                  {page.traversal.selection === 'highlights'
                    ? 'Highlights'
                    : page.traversal.selection === 'direct'
                      ? 'Direct attention groups'
                      : 'All matching groups'}
                </strong>
                {page.traversal.selection !== 'complete' && (
                  <button
                    aria-disabled={busy}
                    onClick={() =>
                      void load(
                        { switch: { token: page.page_cursor, selection: 'complete' }, limit: size },
                        [],
                        undefined,
                        true,
                      )
                    }
                  >
                    Show all matching groups in this interval
                  </button>
                )}
                {page.traversal.selection !== 'direct' && (
                  <button
                    aria-disabled={busy}
                    onClick={() =>
                      void load(
                        { switch: { token: page.page_cursor, selection: 'direct' }, limit: size },
                        [],
                        undefined,
                        true,
                      )
                    }
                  >
                    Show direct attention groups
                  </button>
                )}
              </div>
              {!page.items.length && !busy && !failure && (
                <p>
                  {page.traversal.shared.coverage === 'unknown'
                    ? 'No known eligible activity in this selection; historical shared coverage is incomplete.'
                    : routine && page.traversal.selection !== 'complete'
                      ? 'Nothing in this routine view. Complete / all retained updates remain available.'
                      : 'No eligible activity in this selection.'}
                </p>
              )}
              <ol className="notification-list updates-list">
                {page.items.map((group) => (
                  <li key={group.id}>
                    <h2>
                      <Link to={group.context_url}>
                        {group.current.state === 'available'
                          ? (group.current.title ?? 'Current title unavailable')
                          : 'Current context unavailable'}
                      </Link>
                    </h2>
                    {group.current.state === 'available' && (
                      <p className="muted">
                        Now: {group.current.path.map((p) => p.title).join(' › ')}
                      </p>
                    )}
                    <p className="update-counts">
                      {[
                        [group.counts.reply_publications, 'reply publication'],
                        [group.counts.reply_revisions, 'reply revision'],
                        [group.counts.summary_changes, 'summary change'],
                        [group.counts.artifact_changes, 'artifact change'],
                        [group.counts.opening_changes, 'opening change'],
                        [group.counts.structural_changes, 'structural change'],
                        [group.counts.personal_signals, 'personal signal'],
                      ]
                        .filter(([n]) => Number(n) > 0)
                        .map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`)
                        .join(' · ')}
                    </p>
                    {group.counts.certainty === 'known_sources_only' && (
                      <p>
                        Counts describe known eligible sources only; some historical shared impacts
                        are unknown.
                      </p>
                    )}
                    {group.direct_sources.map((item) => (
                      <div key={item.source.event_id} className="update-direct">
                        {direct(item)}
                      </div>
                    ))}
                    {!group.direct_sources_complete && (
                      <p>
                        More direct sources are available through the bounded direct-attention list.
                      </p>
                    )}
                    {group.explanation && (
                      <p className="update-explanation">
                        <Link to={group.explanation.browser_url}>
                          {group.explanation.form === 'revision_note'
                            ? 'Revision note'
                            : 'Change account'}{' '}
                          by {group.explanation.publisher.nickname}
                        </Link>{' '}
                        — describes {group.explanation.included_revisions.length} named revision
                        {group.explanation.included_revisions.length === 1 ? '' : 's'} in this
                        group. Other changes may be outside its coverage.
                      </p>
                    )}
                    <div className="notification-links">
                      <button
                        id={'updates-group-' + group.id}
                        aria-expanded={expanded?.group_id === group.id}
                        aria-controls="updates-expansion"
                        aria-disabled={busy}
                        onClick={(e) =>
                          void members(
                            { cursor: group.members_cursor, limit: size },
                            e.currentTarget,
                          )
                        }
                      >
                        Inspect changes
                      </button>
                      {group.direct_cursor && (
                        <button
                          aria-disabled={busy}
                          onClick={(e) =>
                            void members(
                              { cursor: group.direct_cursor!, limit: size },
                              e.currentTarget,
                            )
                          }
                        >
                          Inspect direct attention
                        </button>
                      )}
                      <Link to={group.context_url}>Open current context</Link>
                    </div>
                    {routine && (
                      <details>
                        <summary>Attention controls</summary>
                        <DismissControl
                          context={context}
                          cursor={page.page_cursor}
                          groupId={group.id}
                          onSelectionFailure={attentionFailure}
                        />
                        {groupTarget(group) && (
                          <MuteControl context={context} target={groupTarget(group)!} />
                        )}
                      </details>
                    )}
                    <details>
                      <summary>Count and detail coverage</summary>
                      <p>
                        {group.counts.shared_changes} shared changes and{' '}
                        {group.counts.personal_signals} personal signals represent{' '}
                        {group.counts.source_records} distinct source records.{' '}
                        {group.counts.certainty === 'exact'
                          ? 'Counts are exact for eligible bound inputs.'
                          : 'These are known source counts, not complete historical totals.'}{' '}
                        An older personal source need not be a shared change in this interval.
                      </p>
                      <p>
                        Member metadata and full bodies are omitted from this card. Summary coverage
                        was not computed.
                      </p>
                    </details>
                  </li>
                ))}
              </ol>
            </>
          )}
          {expanded && (
            <aside
              id="updates-expansion"
              className="notice neutral update-expansion"
              aria-label="Expanded changes"
              tabIndex={-1}
              ref={expansionAnchor}
            >
              <h2>
                {expanded.direct_only
                  ? 'Direct attention sources'
                  : expanded.group_id
                    ? 'Changes in this group'
                    : 'All source records in this interval'}
              </h2>
              <ol>
                {expanded.items.map((item) => (
                  <li key={item.source.event_id}>
                    {item.personal && direct(item)}
                    <p>
                      {item.source.kind.replaceAll('.', ' ')} · {item.source.actor.nickname} ·{' '}
                      <time dateTime={item.source.occurred_at}>
                        {new Date(item.source.occurred_at).toLocaleString()}
                      </time>
                    </p>
                    <p>
                      {item.source.exact_url && (
                        <Link to={item.source.exact_url}>
                          Exact revision {item.source.revision_number}
                        </Link>
                      )}{' '}
                      · <Link to={item.source.context_url}>Current context</Link>
                    </p>
                    {item.personal?.parent && (
                      <p>
                        {item.personal.parent.state === 'available'
                          ? `Reply to ${item.personal.parent.author?.nickname}`
                          : 'Parent unavailable; actual reply relationship retained.'}
                      </p>
                    )}
                    <p className="muted">
                      {item.shared_in_interval
                        ? 'Included shared change'
                        : routine
                          ? 'No shared input in this selection (outside scope/interval, muted or dismissed)'
                          : 'Personal source from outside the shared interval or scope'}
                      {item.personal ? '; independently available personal signal' : ''}.
                    </p>
                    {routine && (
                      <details>
                        <summary>Dismiss selected source inputs</summary>
                        <DismissControl
                          context={context}
                          onSelectionFailure={attentionFailure}
                          inputs={[
                            ...(item.shared_in_interval
                              ? [{ kind: 'shared_event' as const, id: item.source.event_id }]
                              : []),
                            ...(item.personal
                              ? [
                                  {
                                    kind: 'personal_delivery' as const,
                                    id: item.personal.delivery_id,
                                  },
                                ]
                              : []),
                          ]}
                        />
                      </details>
                    )}
                    {item.shared_in_interval && (
                      <MatchingReasons
                        item={item}
                        cursor={expanded.page_cursor}
                        context={context}
                        active={active}
                        onError={report}
                      />
                    )}
                  </li>
                ))}
              </ol>
              {expanded.next_cursor && (
                <button
                  aria-disabled={busy}
                  onClick={() => void members({ cursor: expanded.next_cursor!, limit: size })}
                >
                  Next sources
                </button>
              )}
              {expanded.complete && (
                <p>Requested member metadata is complete. Full source bodies remain separate.</p>
              )}
              <button aria-disabled={busy} onClick={() => void collapse()}>
                Close changes
              </button>
            </aside>
          )}
          <div className="pagination">
            {past.length > 0 && (
              <button
                aria-disabled={busy}
                onClick={() => void load(past.at(-1)!, past.slice(0, -1), undefined, true)}
              >
                Previous Updates page
              </button>
            )}
            {page.next_cursor && (
              <button
                aria-disabled={busy}
                onClick={() =>
                  void load(
                    { cursor: page.next_cursor!, limit: size },
                    page.stage === 'preparing' ? past : [...past, displayedRequest(page)],
                    undefined,
                    true,
                  )
                }
              >
                {page.stage === 'preparing'
                  ? 'Continue preparing Updates'
                  : 'Continue this interval'}
              </button>
            )}
          </div>
          {page.selection_exhausted && page.traversal.selection !== 'complete' && (
            <p>
              Selected highlights or direct groups are exhausted. Complete retrieval for this
              interval remains available.
            </p>
          )}
          {page.grouped_interval_complete && (
            <p>
              All eligible groups in this fixed interval have been represented. Member details and
              full bodies are separate; nothing was marked read.
            </p>
          )}
          <details className="notification-coverage">
            <summary>Interval, coverage and recovery</summary>
            <p>
              Traversal {page.traversal.id}. Bound {page.traversal.scope} scope,{' '}
              {page.traversal.reason} personal reasons, and two independently fixed stream
              intervals. New publications and delayed deliveries belong to later intervals.
            </p>
            <p>
              Shared scan: {page.traversal.shared.scan_complete ? 'complete' : 'preparing'};
              personal availability scan:{' '}
              {page.traversal.personal.scan_complete ? 'complete' : 'preparing'}. Generation
              coverage is separate. Expires {new Date(page.traversal.expires_at).toLocaleString()}.
            </p>
            <ul>
              {page.traversal.definitions.map((d, i) => (
                <li key={i}>
                  {d.target.kind} {d.target.resource_id} ·{' '}
                  {d.include_descendants ? 'including descendants' : 'direct scope'} ·{' '}
                  {d.preferences.join(', ')}
                </li>
              ))}
            </ul>
            {page.records_cursor && (
              <button
                aria-disabled={busy}
                onClick={(e) =>
                  void members({ cursor: page.records_cursor!, limit: size }, e.currentTarget)
                }
              >
                Inspect all source records
              </button>
            )}
            <button
              aria-disabled={busy}
              onClick={() =>
                void load(
                  { recovery: { action: 'replay', token: page.page_cursor } },
                  [],
                  undefined,
                  true,
                )
              }
            >
              Replay both retained streams
            </button>
            <button aria-disabled={busy} onClick={() => void clear()}>
              Clear saved Updates views
            </button>
          </details>
        </>
      )}
    </div>
  );
}
