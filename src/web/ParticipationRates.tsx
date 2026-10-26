import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { Value } from '@sinclair/typebox/value';
import type { Static } from '@sinclair/typebox';
import * as C from '../contracts/rates.js';
import {
  commandRequest,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
} from './participation-client.js';
import { useAuthorization, type AuthorizedValue } from './AuthorizationBoundary.js';
import { useIntent, useQuery, SeparateDraft, type Context } from './participation-state.js';
import { ErrorText } from './participation-ui.js';

const path = '/api/v1/admin/participation-rates';
const labels = {
  ordinary_requests: 'Ordinary requests per minute',
  new_publications: 'New publications per minute',
  recovery_control: 'Recovery and control requests per minute',
} as const;

export function ParticipationRates({ context }: { context: Context }) {
  const chosen = new URLSearchParams(useLocation().search).get('intent');
  const [opened, setOpened] = useState(() =>
    context.store
      .all()
      .some((r) => r.kind === 'participation.rates' && (!chosen || r.key === chosen)),
  );
  return (
    <section className="card admin-card">
      <h2>Participation rate limits</h2>
      <p>
        Shared across each participant’s credentials and sessions. Synthetic preview policy;
        production sizing is unapproved.
      </p>
      {!opened ? (
        <button onClick={() => setOpened(true)}>Inspect participation limits</button>
      ) : (
        <RateControls context={context} chosen={chosen} />
      )}
    </section>
  );
}

function RateControls({ context, chosen }: { context: Context; chosen: string | null }) {
  const policy = useQuery<C.RatePolicyValue>(path, C.RatePolicy),
    authority = useAuthorization();
  const [record, update] = useIntent(
    () =>
      context.store.all().find((r) => r.kind === 'participation.rates' && r.key === chosen) ??
      context.store.all().find((r) => r.kind === 'participation.rates'),
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<C.RateDecisionValue>();
  const [audit, setAudit] = useState<AuthorizedValue<Static<typeof C.RateAudit>>>();
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
    expected_version: policy.data?.version,
    ordinary_requests: policy.data?.ordinary_requests,
    new_publications: policy.data?.new_publications,
    recovery_control: policy.data?.recovery_control,
  });
  async function draft(patch: Record<string, unknown>) {
    try {
      await update((prior) => {
        if (!prior && !policy.data)
          throw new Error('Inspect the current policy before preparing a decision.');
        const body = { ...(prior?.body ?? fields()), ...patch };
        return context.store.saveDraft(
          prior ??
            context.store.create(
              'participation.rates',
              'participation.rates',
              path + '/state',
              body,
            ),
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
        if (!Value.Check(C.RatePolicyInput, prior.body))
          throw new Error('Choose whole-number limits within the displayed ranges.');
        return context.store.prepareDispatch(prior, prior.body);
      });
      if (!sent || !current()) return;
      const result = await commandRequest<Static<typeof C.RateStatus>>(
        check ? path + '/status' : sent.path,
        {
          self: context.self,
          body: check ? { idempotency_key: sent.key } : sent.body,
          schema: C.RateStatus,
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
        context.store.correct(prior!, { ...prior!.body, expected_version: policy.data!.version }),
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
      const result = await authority.readAuthorized<Static<typeof C.RateAudit>>(path + '/audit', {
        self: context.self,
        body: { ...(before ? { before_version: before } : {}), limit: 12 },
        schema: C.RateAudit,
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
        Fixed 60-second windows begin with the first admission. Changes preserve usage until expiry.
        A temporary refusal never authorizes a replacement command.
      </p>
      <button onClick={policy.refresh}>Refresh participation limits</button>
      <ErrorText error={policy.error || error} />
      {policy.data && (
        <p>
          Current policy version {policy.data.version}. New publication requests also use ordinary
          request capacity. Recovery and administrative controls use their separate allowance.
        </p>
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
            const category = field as C.RateCategory,
              bounds = C.rateBounds[category];
            return (
              <label key={field}>
                {label}
                <input
                  type="number"
                  min={bounds.minimum}
                  max={bounds.maximum}
                  step="1"
                  value={Number(
                    record?.body[category] ?? policy.data?.[category] ?? bounds.default,
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
              {record?.state === 'uncertain' ? 'Retry same limits' : 'Save participation limits'}
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
        Inspect rate policy audit
      </button>
      {visibleAudit && (
        <>
          <ol>
            {visibleAudit.items.map((item) => (
              <li key={item.operation_id}>
                Version {item.policy.version}: {item.policy.ordinary_requests} ordinary,{' '}
                {item.policy.new_publications} publications, {item.policy.recovery_control}{' '}
                recovery/control. Administrator {item.actor_id}, credential{' '}
                {item.actor_credential_id}, {item.recorded_at}.
              </li>
            ))}
          </ol>
          {visibleAudit.next_before_version && (
            <button
              aria-disabled={busy}
              onClick={() => void readAudit(visibleAudit.next_before_version!)}
            >
              Earlier rate decisions
            </button>
          )}
        </>
      )}
    </>
  );
}
