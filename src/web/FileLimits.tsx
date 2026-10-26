import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Value } from '@sinclair/typebox/value';
import type { Static } from '@sinclair/typebox';
import * as C from '../contracts/file-policy.js';
import {
  commandRequest,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
} from './participation-client.js';
import { useAuthorization, type AuthorizedValue } from './AuthorizationBoundary.js';
import { useIntent, useQuery, SeparateDraft, type Context } from './participation-state.js';
import { ErrorText } from './participation-ui.js';

const path = '/api/v1/admin/file-limits';
const labels = {
  max_file_bytes: 'Maximum newly admitted file size (bytes)',
  max_unfinished_uploads: 'Maximum unfinished uploads per participant',
  participant_reserved_bytes: 'Reserved file bytes per participant',
  community_reserved_bytes: 'Reserved file bytes for the community',
} as const;

export function FileLimits({ context }: { context: Context }) {
  const chosen = new URLSearchParams(useLocation().search).get('intent');
  const [opened, setOpened] = useState(() =>
    context.store.all().some((r) => r.kind === 'file.policy' && (!chosen || r.key === chosen)),
  );
  return (
    <section className="card admin-card">
      <h2>File upload and storage limits</h2>
      <p>
        Shared across each participant’s credentials and sessions. Synthetic preview policy;
        production sizing is unapproved.
      </p>
      {!opened ? (
        <button onClick={() => setOpened(true)}>Inspect file limits</button>
      ) : (
        <FileControls context={context} chosen={chosen} />
      )}
    </section>
  );
}

function FileControls({ context, chosen }: { context: Context; chosen: string | null }) {
  const policy = useQuery<C.AdministrativeFileLimitsValue>(path, C.AdministrativeFileLimits),
    authority = useAuthorization();
  const [record, update] = useIntent(
    () =>
      context.store.all().find((r) => r.kind === 'file.policy' && r.key === chosen) ??
      context.store.all().find((r) => r.kind === 'file.policy'),
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<C.FileDecisionValue>();
  const [audit, setAudit] = useState<AuthorizedValue<Static<typeof C.FileAudit>>>();
  const live = useRef(true),
    owner = useRef(identityGeneration());
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () => live.current && owner.current === identityGeneration();
  const locked = busy || (!!record && (record.state !== 'draft' || !!record.blocked_by));
  const fields = () => ({
    expected_version: policy.data?.policy.version,
    max_file_bytes: policy.data?.policy.max_file_bytes,
    max_unfinished_uploads: policy.data?.policy.max_unfinished_uploads,
    participant_reserved_bytes: policy.data?.policy.participant_reserved_bytes,
    community_reserved_bytes: policy.data?.policy.community_reserved_bytes,
  });
  async function draft(patch: Record<string, unknown>) {
    try {
      await update((prior) => {
        if (!prior && !policy.data)
          throw new Error('Inspect the current policy before preparing a decision.');
        const body = { ...(prior?.body ?? fields()), ...patch };
        return context.store.saveDraft(
          prior ?? context.store.create('file.policy', 'file.policy', path + '/state', body),
          body,
        );
      });
    } catch (failure) {
      if (current()) setError((failure as Error).message);
    }
  }
  async function send(check = false) {
    if (busy || record?.state === 'rejected' || record?.blocked_by) return;
    let sent: Intent | undefined,
      wasUncertain = false;
    setBusy(true);
    setError('');
    try {
      if (!record) await draft({});
      sent = await update(async (prior) => {
        if (!prior) throw new Error('Save the policy draft before sending.');
        wasUncertain = prior.state === 'uncertain';
        if (check) return prior;
        if (!Value.Check(C.FilePolicyInput, prior.body))
          throw new Error('Choose whole-number limits within the displayed ranges.');
        return context.store.prepareDispatch(prior, prior.body);
      });
      if (!sent || !current()) return;
      const result = await commandRequest<Static<typeof C.FileStatus>>(
        check ? path + '/status' : sent.path,
        {
          self: context.self,
          body: check ? { idempotency_key: sent.key } : sent.body,
          schema: C.FileStatus,
        },
      );
      if (!current()) return;
      if (result.operation_state === 'not_recorded') {
        setError('This decision is still unconfirmed. Keep its exact command.');
        return;
      }
      await update(async () => {
        if (!current()) return sent;
        await context.store.complete(sent!);
        return undefined;
      });
      if (current()) {
        setReceipt(result);
        policy.refreshIfCurrent();
      }
    } catch (failure) {
      if (!current()) return;
      if (sent && !check && isDefinitiveRejection(failure, wasUncertain)) {
        try {
          await update(() => context.store.settle(sent!, { state: 'rejected' }));
        } catch (storageFailure) {
          setError((storageFailure as Error).message);
          return;
        }
      }
      setError((failure as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function correct() {
    if (!record || !policy.data) return;
    try {
      await update((prior) =>
        context.store.correct(prior!, {
          ...prior!.body,
          expected_version: policy.data!.policy.version,
        }),
      );
      setError('');
    } catch (failure) {
      if (current()) setError((failure as Error).message);
    }
  }
  async function readAudit(before?: number) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await authority.readAuthorized<Static<typeof C.FileAudit>>(path + '/audit', {
        self: context.self,
        body: { ...(before ? { before_version: before } : {}), limit: 12 },
        schema: C.FileAudit,
      });
      if (current()) setAudit(result);
    } catch (failure) {
      if (current()) setError((failure as Error).message);
    } finally {
      if (current()) setBusy(false);
    }
  }
  const visibleAudit = audit && authority.current(audit.generation) ? audit.value : undefined;
  return (
    <>
      <p>
        New upload identities reserve twice their declared size for staging and final storage. 1 MiB
        = 1,048,576 bytes. Changes preserve admitted files and original expiry. These controls do
        not change fixed transfer, manifest or retained-identity safeguards.
      </p>
      <button onClick={policy.refresh}>Refresh file limits</button>
      <ErrorText error={policy.error || error} />
      {policy.data && (
        <>
          <p>
            Current policy version {policy.data.policy.version}. Observed {policy.data.observed_at}.
            Capacity is rechecked at admission; this snapshot reserves nothing.
          </p>
          <p>
            Community reserved file bytes: {policy.data.community.reserved_bytes} /{' '}
            {policy.data.policy.community_reserved_bytes}.
            {policy.data.community.reserved_bytes_over_limit &&
              ' Over limit. Existing reservations remain charged.'}
          </p>
          <OwnFileUsage value={policy.data} />
        </>
      )}
      <SeparateDraft
        record={record}
        review={() =>
          void update(async (prior) => {
            const { blocked_by: _, ...next } = prior!;
            return context.store.save(next);
          }).catch((f) => setError(f.message))
        }
      />
      {(policy.data || record) && (
        <>
          {Object.entries(labels).map(([field, label]) => {
            const category = field as C.FilePolicyField,
              bounds = C.filePolicyBounds[category];
            return (
              <label key={field}>
                {label}
                <input
                  type="number"
                  min={bounds.minimum}
                  max={bounds.maximum}
                  step="1"
                  value={Number(
                    record?.body[category] ?? policy.data?.policy[category] ?? bounds.default,
                  )}
                  disabled={locked}
                  onChange={(event) => void draft({ [category]: Number(event.target.value) })}
                />
                <span>
                  {bounds.minimum}–{bounds.maximum}; default {bounds.default}.
                </span>
              </label>
            );
          })}
          {record && (
            <p>
              Saved decision based on version {String(record.body.expected_version)}. State:{' '}
              {record.state}.
            </p>
          )}
          {record?.state === 'rejected' ? (
            <button disabled={busy || !policy.data} onClick={() => void correct()}>
              Prepare corrected limits
            </button>
          ) : (
            <button aria-disabled={busy || !!record?.blocked_by} onClick={() => void send()}>
              {record?.state === 'uncertain' ? 'Retry same limits' : 'Save file limits'}
            </button>
          )}
          {record?.state === 'uncertain' && (
            <button aria-disabled={busy} onClick={() => void send(true)}>
              Check limits status
            </button>
          )}
        </>
      )}
      {receipt && (
        <p role="status">
          Recorded policy version {receipt.original.version}; current version at recovery{' '}
          {receipt.current.version}. Earlier settings were not reapplied.
        </p>
      )}
      <button aria-disabled={busy} onClick={() => void readAudit()}>
        Inspect file policy audit
      </button>
      {visibleAudit && (
        <>
          <ol>
            {visibleAudit.items.map((item) => (
              <li key={item.operation_id}>
                Version {item.policy.version}: maximum file {item.policy.max_file_bytes} bytes;{' '}
                {item.policy.max_unfinished_uploads} unfinished; participant{' '}
                {item.policy.participant_reserved_bytes} reserved bytes; community{' '}
                {item.policy.community_reserved_bytes} reserved bytes. Administrator {item.actor_id}
                , credential {item.actor_credential_id}, {item.recorded_at}.
              </li>
            ))}
          </ol>
          {visibleAudit.next_before_version && (
            <button
              aria-disabled={busy}
              onClick={() => void readAudit(visibleAudit.next_before_version!)}
            >
              Earlier file decisions
            </button>
          )}
        </>
      )}
    </>
  );
}

function OwnFileUsage({ value }: { value: C.EffectiveFileLimitsValue }) {
  return (
    <p>
      Your reserved file bytes: {value.own.reserved_bytes} /{' '}
      {value.policy.participant_reserved_bytes}.
      {value.own.reserved_bytes_over_limit && ' Over the byte allowance.'} Your unfinished uploads:{' '}
      {value.own.unfinished_uploads} / {value.policy.max_unfinished_uploads}.
      {value.own.unfinished_uploads_over_limit && ' Over the unfinished allowance.'} Waiting alone
      does not free reserved bytes. Eligible expired, unassociated uploads can use existing cleanup;
      published files are retained.
    </p>
  );
}
export function EffectiveFileLimits() {
  const [opened, setOpened] = useState(false);
  return (
    <section aria-label="Effective file limits">
      {!opened ? (
        <button type="button" onClick={() => setOpened(true)}>
          Inspect my file limits
        </button>
      ) : (
        <OwnLimits />
      )}
    </section>
  );
}
function OwnLimits() {
  const query = useQuery<C.EffectiveFileLimitsValue>('/api/v1/file-limits', C.EffectiveFileLimits);
  return (
    <>
      <button type="button" onClick={query.refresh}>
        Refresh my file limits
      </button>
      <ErrorText error={query.error} />
      {query.data && (
        <>
          <p>
            Maximum new file: {query.data.policy.max_file_bytes} bytes. 1 MiB = 1,048,576 bytes.
            Policy version {query.data.policy.version}, observed {query.data.observed_at}. Admission
            rechecks capacity. Previously admitted retries keep their original declaration and
            expiry.
          </p>
          <OwnFileUsage value={query.data} />
        </>
      )}
    </>
  );
}
