import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import * as C from '../contracts/reservations.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { type Context, useQuery } from './participation-state.js';
import { identityGeneration, isDefinitiveRejection, type Intent } from './participation-client.js';

function useCommands(context: Context) {
  const authority = useAuthorization(),
    live = useRef(true),
    owner = useRef(identityGeneration());
  const [revision, changed] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<C.IntentStatusView>(),
    [receiptRecord, setReceiptRecord] = useState<Intent>();
  const owned = () => live.current && owner.current === identityGeneration();
  useEffect(() => {
    live.current = true;
    const update = () => changed((n) => n + 1);
    window.addEventListener('storage', update);
    window.addEventListener('loom-editing-intent', update);
    return () => {
      live.current = false;
      window.removeEventListener('storage', update);
      window.removeEventListener('loom-editing-intent', update);
    };
  }, []);
  let records: Intent[] = [],
    journalError = '';
  try {
    records = context.store.all().filter((r) => r.kind.startsWith('editing-intent.'));
  } catch (failure) {
    journalError = (failure as Error).message;
  }
  void revision;
  async function execute(record: Intent, status = false, first = false) {
    setBusy(true);
    setError('');
    setReceipt(undefined);
    let dispatched = record;
    try {
      if (!status && !first) dispatched = await context.store.prepareDispatch(record, record.body);
      if (!owned()) return;
      const action = record.kind.slice(15) as C.IntentActionValue;
      const result = await authority.editingIntentCommand(
        status ? { action, idempotency_key: record.key } : dispatched.body,
        status ? 'status' : action,
        context.self,
      );
      if (!owned()) return;
      if (result.operation_state === 'recorded')
        await context.store.settle(dispatched, { state: 'committed' });
      if (owned()) {
        setReceipt(result);
        setReceiptRecord(record);
      }
    } catch (failure) {
      if (owned() && first && isDefinitiveRejection(failure, false)) {
        try {
          await context.store.settle(dispatched, { state: 'rejected' });
        } catch {
          /* Exact uncertain custody remains available. */
        }
      }
      if (owned()) setError((failure as Error).message);
    } finally {
      if (owned()) {
        setBusy(false);
        window.dispatchEvent(new Event('loom-editing-intent'));
      }
    }
  }
  async function send(
    action: C.IntentActionValue,
    body: Record<string, unknown>,
    target: { resource: string; base: string },
  ) {
    setBusy(true);
    setError('');
    try {
      const record = await context.store.prepareEditingIntent(action, body, target, owned);
      if (owned()) await execute(record, false, true);
    } catch (failure) {
      if (owned()) setError((failure as Error).message);
    } finally {
      if (owned()) setBusy(false);
    }
  }
  return {
    records,
    busy,
    error: error || journalError,
    receipt,
    receiptRecord,
    execute,
    send,
    dismiss: async (record: Intent) => {
      try {
        await context.store.remove(record);
        if (owned()) changed((n) => n + 1);
      } catch (failure) {
        if (owned()) setError((failure as Error).message);
      }
    },
  };
}
function Feedback({ commands }: { commands: ReturnType<typeof useCommands> }) {
  const result = commands.receipt;
  return (
    <>
      {commands.error && <p role="alert">{commands.error}</p>}
      {result && (
        <p role="status">
          {result.operation_state === 'not_recorded'
            ? 'No recorded outcome was found. Keep the exact command; it may still commit.'
            : `Original ${result.action} accepted at ${result.outcome.accepted_at}, expiry ${result.outcome.expires_at}. Observed ${result.current.state} at ${result.observed_at}. Refresh notices to inspect current source metadata.`}
        </p>
      )}
    </>
  );
}
function Recovery({
  commands,
  resource,
}: {
  commands: ReturnType<typeof useCommands>;
  resource?: string;
}) {
  const records = commands.records.filter(
    (r) => !resource || r.slot.split(':')[1] === resource.toLowerCase(),
  );
  return (
    <section aria-label="Saved editing intent commands">
      <h3>Saved editing intent commands</h3>
      {records.map((record) => (
        <div
          className="notice"
          key={record.key}
          role="group"
          aria-label={record.kind.slice(15) + ' ' + record.key}
        >
          <strong>
            {record.kind.slice(15)} editing intent · {record.state}
          </strong>
          <p className="destination-id">
            Resource {record.slot.split(':')[1]} · Base {record.slot.split(':')[2]}
          </p>
          <details>
            <summary>Recovery details</summary>
            <p className="destination-id">Command {record.key}</p>
            {!!record.body.notice_id && (
              <p>
                Notice {String(record.body.notice_id)} · Expected version{' '}
                {String(record.body.expected_version)}
              </p>
            )}
          </details>
          {(record.state === 'uncertain' || record.state === 'committed') && (
            <button disabled={commands.busy} onClick={() => void commands.execute(record, true)}>
              Check editing intent outcome
            </button>
          )}
          {record.state === 'uncertain' ? (
            <>
              <button disabled={commands.busy} onClick={() => void commands.execute(record)}>
                Retry exact editing intent command
              </button>
            </>
          ) : (
            <button disabled={commands.busy} onClick={() => void commands.dismiss(record)}>
              Dismiss resolved editing intent command
            </button>
          )}
        </div>
      ))}
      {!records.length && <p>No saved editing intent commands.</p>}
    </section>
  );
}
export function EditingIntentRecovery({ context }: { context: Context }) {
  const commands = useCommands(context);
  return (
    <section>
      <h1>Editing intent recovery</h1>
      <p>
        Private command receipts do not authorize source content. Expiry does not publish or discard
        a draft.
      </p>
      <Feedback commands={commands} />
      <Recovery commands={commands} />
      {commands.receipt?.operation_state === 'recorded' &&
        commands.receipt.current.state !== 'released' && (
          <button
            disabled={commands.busy}
            onClick={() => {
              const result = commands.receipt as C.IntentResultView;
              const record = commands.receiptRecord;
              if (record)
                void commands.send(
                  'release',
                  { notice_id: result.current.notice_id, expected_version: result.current.version },
                  { resource: record.slot.split(':')[1]!, base: record.slot.split(':')[2]! },
                );
            }}
          >
            Release recovered editing intent
          </button>
        )}
    </section>
  );
}
export function EditingIntent({
  context,
  resource,
  base,
  canEdit,
}: {
  context: Context;
  resource: string;
  base: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="editing-intent">
      <h3>Editing intent</h3>
      <p>This notice does not prevent other authorized edits.</p>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Hide editing intent' : 'Inspect editing intent'}
      </button>{' '}
      <Link to="/loom/editing-intent">Recover saved editing intent</Link>
      {open && (
        <IntentControls
          key={resource + base}
          context={context}
          resource={resource}
          base={base}
          canEdit={canEdit}
        />
      )}
    </section>
  );
}
function IntentControls({
  context,
  resource,
  base,
  canEdit,
}: {
  context: Context;
  resource: string;
  base: string;
  canEdit: boolean;
}) {
  const commands = useCommands(context),
    [cursor, setCursor] = useState(''),
    [purpose, setPurpose] = useState(''),
    [description, setDescription] = useState(''),
    [scope, setScope] = useState<'whole' | 'described'>('whole'),
    [duration, setDuration] = useState(30),
    [stale, setStale] = useState(false);
  const query = useQuery<C.IntentPageView>(
    '/api/v1/editing-intent/resources/' +
      resource +
      '?limit=12' +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    C.IntentPage,
  );
  useEffect(() => {
    const changed = () => setStale(true);
    window.addEventListener('focus', changed);
    window.addEventListener('online', changed);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('loom-editing-intent', changed);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener('focus', changed);
      window.removeEventListener('online', changed);
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('loom-editing-intent', changed);
      window.removeEventListener('storage', changed);
    };
  }, []);
  const pending = commands.records.some(
    (r) => r.state === 'uncertain' && r.slot.split(':')[1] === resource.toLowerCase(),
  );
  return (
    <div>
      <button
        onClick={() => {
          setCursor('');
          setStale(false);
          query.refresh();
        }}
      >
        Refresh editing intent
      </button>
      {query.error && (
        <p role="alert">
          Editing intent could not be retrieved: {query.error}. Your publication draft is unchanged.
        </p>
      )}
      {stale && (
        <p role="status">Observation may be stale. Refresh before another editing intent choice.</p>
      )}
      {query.data && (
        <>
          <p>Observed by server at {query.data.observed_at}. Current activity is not guaranteed.</p>
          {query.data.items.map((notice) => (
            <div className="notice" key={notice.notice_id}>
              <p>
                {notice.participant_nickname} plans to revise{' '}
                {notice.scope.kind === 'whole' ? 'the whole resource' : notice.scope.description}.
              </p>
              <p>{notice.purpose}</p>
              <p className="destination-id">
                Base {notice.base_revision_id}
                {notice.older_base ? ' · Based on an older revision' : ''}
              </p>
              <p>
                Expires at {notice.expires_at} · {notice.state} at observation
              </p>
              {!notice.owner_may_edit && (
                <p>Current editing authority is unavailable. This is not a historical release.</p>
              )}
              {notice.participant_id === context.self.participant_id &&
                notice.state !== 'released' && (
                  <>
                    {notice.state === 'active' && notice.owner_may_edit && (
                      <button
                        disabled={commands.busy || pending || stale}
                        onClick={() =>
                          void commands.send(
                            'renew',
                            {
                              notice_id: notice.notice_id,
                              expected_version: notice.version,
                              duration_minutes: duration,
                            },
                            { resource, base: notice.base_revision_id },
                          )
                        }
                      >
                        Renew editing intent
                      </button>
                    )}
                    <button
                      disabled={commands.busy || pending || stale}
                      onClick={() =>
                        void commands.send(
                          'release',
                          { notice_id: notice.notice_id, expected_version: notice.version },
                          { resource, base: notice.base_revision_id },
                        )
                      }
                    >
                      Release editing intent
                    </button>
                  </>
                )}
            </div>
          ))}
          <button
            disabled={!query.data.next_cursor || stale}
            onClick={() => setCursor(query.data!.next_cursor!)}
          >
            Next editing intent page
          </button>
        </>
      )}
      {canEdit && (
        <>
          <label>
            Purpose
            <input value={purpose} maxLength={512} onChange={(e) => setPurpose(e.target.value)} />
          </label>
          <label>
            Scope
            <select
              aria-label="Scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'whole' | 'described')}
            >
              <option value="whole">Whole resource</option>
              <option value="described">Described section or field</option>
            </select>
          </label>
          {scope === 'described' && (
            <label>
              Scope description
              <input
                value={description}
                maxLength={256}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          )}
          <label>
            Duration in minutes
            <input
              type="number"
              min={1}
              max={120}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
          <button
            disabled={
              commands.busy ||
              pending ||
              !purpose.trim() ||
              (scope === 'described' && !description.trim())
            }
            onClick={() =>
              void commands.send(
                'announce',
                {
                  resource_id: resource,
                  base_revision_id: base,
                  purpose,
                  scope: scope === 'whole' ? { kind: 'whole' } : { kind: 'described', description },
                  duration_minutes: duration,
                },
                { resource, base },
              )
            }
          >
            Announce editing intent
          </button>
        </>
      )}
      <Feedback commands={commands} />
      <Recovery commands={commands} resource={resource} />
    </div>
  );
}
