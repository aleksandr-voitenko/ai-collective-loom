import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Type, type Static } from '@sinclair/typebox';
import { SearchHealth, FailedSearchJobs, type SearchHealthView } from '../contracts/search.js';
import { closed } from '../contracts/participation.js';
import { useAuthorization, type AuthorizedValue } from './AuthorizationBoundary.js';
import { ApiError, commandRequest, identityGeneration, type Self } from './participation-client.js';
import { type Context } from './participation-state.js';
import {
  SearchMaintenanceRecovery,
  type SearchMaintenanceRecord,
  type SearchMaintenanceRequest,
} from './search-maintenance-recovery.js';

type Failures = Static<typeof FailedSearchJobs>;
const RetryReceipt = Type.Object({ accepted: Type.Literal(true) }, closed);
const RebuildReceipt = Type.Object({ generation: Type.Integer({ minimum: 2 }) }, closed);
const descriptions: Record<string, string> = {
  processing_failed: 'Processing could not finish',
  lease_expired: 'Worker claim expired',
  unsupported_event: 'Unsupported change type',
  unsupported_source: 'Unsupported source type',
  source_limit: 'Source exceeds processing limits',
};
function state(health: SearchHealthView) {
  if (health.capacity_limited) return 'Capacity limited';
  if (!health.worker_available) return 'Worker unavailable';
  if (health.jobs.failed! > 0) return 'Failures need attention';
  if (
    !health.scan_complete ||
    !health.event_discovery_caught_up ||
    health.jobs.pending! > 0 ||
    health.jobs.running! > 0
  )
    return 'Indexing in progress';
  return 'No queued work observed';
}

export function SearchAdministration({ context }: { context: Context }) {
  const authority = useAuthorization();
  const [custody] = useState(
    () =>
      new SearchMaintenanceRecovery(
        context.community.instance_id,
        context.self.participant_id,
        context.store.storage,
      ),
  );
  const [initial] = useState(() => {
    try {
      return { record: custody.read(), error: '' };
    } catch (error) {
      return { record: undefined, error: (error as Error).message };
    }
  });
  const [record, setRecord] = useState<SearchMaintenanceRecord | undefined>(initial.record),
    [storageError, setStorageError] = useState(initial.error),
    [commandError, setCommandError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmation, setConfirmation] = useState<SearchMaintenanceRequest>();
  const [health, setHealth] = useState<AuthorizedValue<SearchHealthView>>(),
    [failures, setFailures] = useState<AuthorizedValue<Failures>>(),
    [healthLoading, setHealthLoading] = useState(false),
    [failuresLoading, setFailuresLoading] = useState(false),
    [healthError, setHealthError] = useState(''),
    [failuresError, setFailuresError] = useState(''),
    [accessError, setAccessError] = useState(''),
    [after, setAfter] = useState('');
  const live = useRef(false),
    owner = useRef(identityGeneration()),
    pending = useRef(false),
    healthSequence = useRef(0),
    failuresSequence = useRef(0),
    requestedAfter = useRef(''),
    failedHeading = useRef<HTMLHeadingElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    rebuildButton = useRef<HTMLButtonElement>(null);
  const current = () => live.current && owner.current === identityGeneration();
  const withdrawn = authority.getSnapshot().state === 'withdrawn';
  const observed = health && authority.current(health.generation) ? health.value : undefined;
  const page = failures && authority.current(failures.generation) ? failures.value : undefined;
  const canDispatch = () =>
    current() && !withdrawn && !!health && authority.current(health.generation);
  const uncertain = record?.state === 'uncertain';
  const locked = busy || uncertain || !!storageError;

  async function readHealth() {
    if (!current() || authority.getSnapshot().state === 'withdrawn') return;
    const sequence = ++healthSequence.current,
      generation = authority.capture();
    setHealthLoading(true);
    try {
      const result = await authority.readAuthorized<SearchHealthView>(
        '/api/v1/admin/search/health',
        { schema: SearchHealth },
      );
      if (
        !current() ||
        sequence !== healthSequence.current ||
        !authority.current(result.generation)
      )
        return;
      setHealth(result);
      setHealthError('');
    } catch (error) {
      if (current() && sequence === healthSequence.current && authority.current(generation))
        setHealthError((error as Error).message);
    } finally {
      if (current() && sequence === healthSequence.current) setHealthLoading(false);
    }
  }
  async function readFailures(cursor = requestedAfter.current, focus = false) {
    if (!current() || authority.getSnapshot().state === 'withdrawn') return;
    const sequence = ++failuresSequence.current,
      generation = authority.capture();
    requestedAfter.current = cursor;
    setFailuresLoading(true);
    try {
      const result = await authority.readAuthorized<Failures>(
        '/api/v1/admin/search/failures' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''),
        { schema: FailedSearchJobs },
      );
      if (
        !current() ||
        sequence !== failuresSequence.current ||
        !authority.current(result.generation)
      )
        return;
      setFailures(result);
      setAfter(cursor);
      setFailuresError('');
    } catch (error) {
      if (current() && sequence === failuresSequence.current && authority.current(generation))
        setFailuresError((error as Error).message);
    } finally {
      if (current() && sequence === failuresSequence.current) {
        setFailuresLoading(false);
        if (focus) failedHeading.current?.focus();
      }
    }
  }
  function readRecovery() {
    try {
      setRecord(custody.read());
      setStorageError('');
    } catch (error) {
      setStorageError((error as Error).message);
    }
  }
  useEffect(() => {
    live.current = true;
    void readHealth();
    void readFailures();
    const changed = (event: StorageEvent) => {
      if (event.key === custody.key && current() && !pending.current) readRecovery();
    };
    window.addEventListener('storage', changed);
    return () => {
      live.current = false;
      healthSequence.current++;
      failuresSequence.current++;
      window.removeEventListener('storage', changed);
    };
  }, [authority, custody]);
  useEffect(() => {
    if (withdrawn) setConfirmation(undefined);
    if (confirmation && !withdrawn) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation, withdrawn]);
  function cancel() {
    if (!pending.current) {
      setConfirmation(undefined);
      rebuildButton.current?.focus();
    }
  }
  async function refresh() {
    if (!current()) return;
    if (authority.getSnapshot().state === 'withdrawn') {
      const generation = authority.capture();
      try {
        const account = await authority.readAuthorized<Self>('/api/v1/identity/self');
        if (!current() || !authority.current(generation) || !authority.current(account.generation))
          return;
        if (
          account.value.participant_id !== context.self.participant_id ||
          account.value.role !== 'administrator'
        )
          throw new Error(
            'Administrator access is required. The retained request has not changed.',
          );
        authority.region.retry();
        setAccessError('');
      } catch (error) {
        if (current()) setAccessError((error as Error).message);
        return;
      }
    }
    readRecovery();
    await Promise.all([readHealth(), readFailures()]);
  }
  async function dispatch(request: SearchMaintenanceRequest) {
    if (pending.current || !canDispatch() || storageError) return;
    const generation = health!.generation;
    const active = () => current() && authority.current(generation);
    pending.current = true;
    setBusy(true);
    setCommandError('');
    try {
      const result = await custody.attempt(request, record?.sequence ?? 0, active, async () => {
        if (!active()) throw new DOMException('View changed.', 'AbortError');
        if (request.kind === 'rebuild') {
          const receipt = await commandRequest<{ generation: number }>(
            '/api/v1/admin/search/rebuild',
            { self: context.self, body: request.body, schema: RebuildReceipt },
          );
          if (receipt.generation !== request.body.expected_generation + 1)
            throw new Error('The maintenance response could not be confirmed.');
        } else
          await commandRequest('/api/v1/admin/search/retry', {
            self: context.self,
            body: request.body,
            schema: RetryReceipt,
          });
      });
      if (!active()) return;
      setRecord(result.record);
      if (result.error)
        setCommandError(
          result.error instanceof ApiError && result.error.code === 'search_changed'
            ? result.record.state === 'uncertain'
              ? 'The generation changed. The earlier request outcome is still unconfirmed.'
              : 'The generation changed. Refresh status before starting another request.'
            : (result.error as Error).message,
        );
      // Acknowledgement does not establish processing progress. Keep reads separate
      // and fenced to this view; they never change retained command guards.
      if (result.record.state === 'acknowledged') {
        void readHealth();
        void readFailures();
      }
    } catch (error) {
      if (current()) {
        readRecovery();
        if ((error as Error).name !== 'AbortError') setCommandError((error as Error).message);
      }
    } finally {
      pending.current = false;
      if (current()) {
        setBusy(false);
        setConfirmation(undefined);
      }
    }
  }

  return (
    <div className="search-administration">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link to="/loom/admin">Administration</Link>
        <span aria-hidden="true">›</span>
        <span>Search indexing</span>
      </nav>
      <h1>Search indexing</h1>
      <p className="subtitle">
        Shared-text indexing for discussions, comments, artifacts and summaries.
      </p>
      {withdrawn && (
        <div className="notice" role="status">
          <p>
            Operational observations were withdrawn. Retained request recovery does not grant
            access.
          </p>
          <button onClick={() => void refresh()}>Check access</button>
          {accessError && <p role="alert">{accessError}</p>}
        </div>
      )}
      <section className="search-admin-section" aria-labelledby="indexing-status">
        <header>
          <h2 id="indexing-status">Status</h2>
          <button
            disabled={healthLoading || failuresLoading || withdrawn}
            onClick={() => void refresh()}
          >
            Refresh status
          </button>
        </header>
        {healthError && !withdrawn && (
          <p role="alert" className="notice">
            {observed
              ? 'Could not refresh status. Showing an earlier observation.'
              : 'Status unavailable'}{' '}
            <span>{healthError}</span>
          </p>
        )}
        {healthLoading && (
          <p role="status">{observed ? 'Refreshing observations…' : 'Loading status…'}</p>
        )}
        {observed && (
          <>
            <p className="search-admin-state">{state(observed)}</p>
            <dl className="search-admin-observations">
              <div>
                <dt>Worker</dt>
                <dd>{observed.worker_available ? 'Available' : 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Initial scan</dt>
                <dd>{observed.scan_complete ? 'Complete' : 'Incomplete'}</dd>
              </div>
              <div>
                <dt>Change discovery</dt>
                <dd>{observed.event_discovery_caught_up ? 'Caught up' : 'Catching up'}</dd>
              </div>
              <div>
                <dt>Capacity</dt>
                <dd>{observed.capacity_limited ? 'Limited' : 'Within limits'}</dd>
              </div>
            </dl>
            <h3>Jobs in the current index</h3>
            <dl className="search-admin-counts">
              {(['pending', 'running', 'succeeded', 'failed'] as const).map((key) => (
                <div key={key}>
                  <dt>
                    {key === 'succeeded' ? 'Succeeded' : key[0]!.toUpperCase() + key.slice(1)}
                  </dt>
                  <dd>{observed.jobs[key]}</dd>
                </div>
              ))}
            </dl>
            <details className="search-admin-details">
              <summary>Index details</summary>
              <p>Index generation: {observed.generation}</p>
              <p>
                Scan and discovery observations are separate from job completion. These counters do
                not establish full search coverage. File-text processing is managed separately.
              </p>
            </details>
          </>
        )}
      </section>
      <section className="search-admin-section" aria-labelledby="indexing-failures">
        <h2 id="indexing-failures" ref={failedHeading} tabIndex={-1}>
          Failed jobs
        </h2>
        <p className="search-admin-context">Failures across retained index generations.</p>
        {failuresError && !withdrawn && (
          <div role="alert" className="notice">
            <p>
              Could not load the requested failed-job page.{page ? ' Showing an earlier page.' : ''}
            </p>
            <button
              disabled={failuresLoading}
              onClick={() => void readFailures(requestedAfter.current, true)}
            >
              Retry this page
            </button>
          </div>
        )}
        {failuresLoading && <p role="status">Loading failed jobs…</p>}
        {page?.items.map((job, index) => {
          const same = job.generation === observed?.generation;
          const unavailable = !observed
            ? 'Refresh status to check retry eligibility.'
            : !same
              ? job.generation < observed.generation
                ? 'Earlier index generation; this job cannot be retried.'
                : 'Different index generation; refresh status before retrying.'
              : healthError
                ? 'Refresh status before retrying.'
                : '';
          return (
            <article
              className="search-admin-job"
              key={job.id}
              aria-label={'Failed job ' + (index + 1)}
            >
              <div className="search-admin-job-heading">
                <div>
                  <h3>{descriptions[job.failure] ?? 'Indexing failed'}</h3>
                  <p>
                    {job.attempts} attempts
                    {!same && observed && job.generation < observed.generation
                      ? ' · Earlier index'
                      : ''}
                  </p>
                </div>
                <button
                  disabled={
                    locked || !same || !!healthError || !page || failuresLoading || withdrawn
                  }
                  onClick={() =>
                    void dispatch({
                      kind: 'retry',
                      body: { id: job.id, claim_generation: job.claim_generation },
                    })
                  }
                >
                  Retry job
                </button>
              </div>
              {unavailable && <p className="search-admin-context">{unavailable}</p>}
              <details className="search-admin-details">
                <summary>Job details</summary>
                <dl>
                  {Object.entries(job).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replaceAll('_', ' ')}</dt>
                      <dd>{value ?? 'Not supplied'}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </article>
          );
        })}
        {page && page.items.length === 0 && <p>No failed jobs on this page.</p>}
        <div className="actions">
          <button
            disabled={failuresLoading || withdrawn || (!after && !requestedAfter.current)}
            onClick={() => void readFailures('', true)}
          >
            First page
          </button>
          <button
            disabled={failuresLoading || withdrawn || !!failuresError || !page?.next_after}
            onClick={() => void readFailures(page!.next_after!, true)}
          >
            Next page
          </button>
        </div>
      </section>
      <section className="search-admin-section" aria-labelledby="indexing-maintenance">
        <h2 id="indexing-maintenance">Maintenance</h2>
        <p>Rebuild the shared-text index from retained sources.</p>
        <button
          ref={rebuildButton}
          disabled={locked || !observed || !!healthError || withdrawn}
          onClick={() =>
            setConfirmation({
              kind: 'rebuild',
              body: { expected_generation: observed!.generation },
            })
          }
        >
          Rebuild index
        </button>
        {busy && <p role="status">Sending maintenance request…</p>}
        {storageError && <p role="alert">{storageError}</p>}
        {!busy && record && (
          <div className="search-admin-recovery" role="status">
            <h3>
              {record.state === 'uncertain'
                ? 'Outcome not confirmed'
                : record.state === 'rejected'
                  ? 'Request rejected'
                  : record.request.kind === 'rebuild'
                    ? 'Rebuild request acknowledged'
                    : 'Retry request acknowledged'}
            </h3>
            <p>
              {record.state === 'uncertain'
                ? 'The original request is retained. Retry it to seek an acknowledgement.'
                : record.state === 'acknowledged'
                  ? 'Processing continues independently. Check the observations above for progress.'
                  : 'No new maintenance action was accepted by this attempt.'}
            </p>
            {commandError && <p role="alert">{commandError}</p>}
            {record.state === 'uncertain' && (
              <button
                disabled={!observed || withdrawn || !!storageError}
                onClick={() => void dispatch(record.request)}
              >
                Retry same request
              </button>
            )}
            <details className="search-admin-details">
              <summary>Request details</summary>
              <p>
                Action: {record.request.kind === 'rebuild' ? 'Rebuild index' : 'Retry failed job'}
              </p>
              <dl>
                {Object.entries(record.request.body).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replaceAll('_', ' ')}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p>
                Replays use the original generation guards. The API has no per-request status
                lookup; a newer generation or missing job cannot establish this request’s outcome.
              </p>
            </details>
          </div>
        )}
        {!record && commandError && <p role="alert">{commandError}</p>}
      </section>
      <dialog
        ref={dialog}
        className="search-admin-confirm"
        aria-labelledby="rebuild-title"
        onCancel={(event) => {
          event.preventDefault();
          cancel();
        }}
      >
        <h2 id="rebuild-title">Rebuild shared-text index?</h2>
        <p>
          The index will be rebuilt from retained sources. Search coverage may be incomplete while
          processing runs.
        </p>
        <p>Published content and Saved items are not deleted.</p>
        <div className="actions">
          <button autoFocus disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button
            disabled={busy || withdrawn}
            onClick={() => confirmation && void dispatch(confirmation)}
          >
            Rebuild index
          </button>
        </div>
        {busy && <p role="status">Sending maintenance request…</p>}
      </dialog>
    </div>
  );
}
