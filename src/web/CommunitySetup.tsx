import { useState } from 'react';
import { useLocation } from 'react-router';
import { type CommittedView } from '../contracts/participation.js';
import { type Intent, commandRequest, isDefinitiveRejection } from './participation-client.js';
import { type Context, useIntent, SeparateDraft } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { ErrorText } from './participation-ui.js';

// Keep an uncertain setup visible even if discovery observes its committed result.
// Settings alone cannot establish which retained command created the community.
export function needsCommunitySetup(context: Pick<Context, 'community' | 'self' | 'store'>) {
  return (
    context.community.settings_version === 0 ||
    (context.self.role === 'administrator' &&
      context.store.all().some((record) => record.slot === 'setup' && record.state === 'uncertain'))
  );
}

export function SetupPending({ context }: { context: Context }) {
  return (
    <section className="setup-waiting card">
      <p className="eyebrow">Welcome to Loom</p>
      <h1>Your community is being set up</h1>
      <p>
        Your account is ready. A community administrator needs to finish setup before you can
        explore.
      </p>
      <button className="primary" onClick={context.refreshCommunity}>
        Check setup progress
      </button>
    </section>
  );
}

export function CommunitySetup({ context }: { context: Context }) {
  const authority = useAuthorization();
  const generation = authority.capture();
  const refreshCommunityIfCurrent = () => {
    if (authority.current(generation) && authority.getSnapshot().state !== 'withdrawn')
      context.refreshCommunity();
  };
  const chosen = new URLSearchParams(useLocation().search).get('intent');
  const [setupIntent, update] = useIntent(
    () =>
      context.store.all().find((r) => r.slot === 'setup' && r.key === chosen) ??
      context.store.all().find((r) => r.slot === 'setup'),
  );
  const [name, setName] = useState(String(setupIntent?.body.community_name ?? 'Research commons')),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const locked =
    busy || (!!setupIntent && (setupIntent.state !== 'draft' || !!setupIntent.blocked_by));
  function setupBody(current = setupIntent) {
    // Hidden fields belong to the saved request. Only a fresh setup receives defaults;
    // editing its name must not replace earlier topic names or authored overview fields.
    return {
      ...(current?.body ?? {
        ordinary_area_name: 'General',
        proposal_area_name: 'Community organization',
        overview: {
          format: 'loom-markdown-v1',
          text: 'Welcome to our shared workspace.\n\nUse General for questions and ongoing work. Propose organizational changes in Community organization.',
          mentions: [],
        },
      }),
      community_name: name,
    };
  }
  async function draft(patch: Record<string, unknown> = {}) {
    try {
      if (setupIntent && setupIntent.state !== 'draft')
        throw new Error('Prepare a correction before editing this request.');
      return await update((current) => {
        const body = { ...setupBody(current), ...patch };
        return context.store.saveDraft(
          current ??
            context.store.create('setup', 'community.setup', '/api/v1/community/setup', body),
          body,
        );
      });
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function setup(check = false) {
    if (busy || setupIntent?.state === 'rejected' || setupIntent?.blocked_by) return;
    let record: Intent | undefined,
      wasUncertain = false;
    setBusy(true);
    try {
      if (!setupIntent) await draft();
      record = await update(async (current) => {
        if (!current) throw new Error('Save the setup draft before sending.');
        wasUncertain = current.state === 'uncertain';
        if (check) return current;
        return context.store.prepareDispatch(current, setupBody(current));
      });
      if (!record || (check && !wasUncertain)) return;
      setError('');
      const result = check
        ? await commandRequest<CommittedView | { operation_state: string }>(
            '/api/v1/operations/status',
            {
              self: context.self,
              body: {
                operation_kind: record.kind,
                idempotency_key: record.key,
              },
            },
          )
        : await commandRequest<CommittedView>(record.path, {
            self: context.self,
            body: record.body,
          });
      if ('publication_state' in result) {
        await update(async () => {
          await context.store.complete(record!);
          return undefined;
        });
        refreshCommunityIfCurrent();
      } else setError('Setup is still unconfirmed. Keep this original intent.');
    } catch (failure) {
      if (record && !check && isDefinitiveRejection(failure, wasUncertain)) {
        const rejected = { ...record, state: 'rejected' as const };
        try {
          await update(() => context.store.settle(record!, rejected));
        } catch (storageFailure) {
          setError((storageFailure as Error).message);
          return;
        }
      }
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function correct() {
    if (!setupIntent) return;
    try {
      await update((current) => context.store.correct(current!));
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <>
      <p className="eyebrow">Welcome to Loom</p>
      <h1>Set up your community</h1>
      <p className="subtitle">Your account is ready. Give your community a name.</p>
      <ol className="setup-progress" aria-label="Setup progress">
        <li>✓ Account ready</li>
        <li aria-current="step">Community details</li>
        <li>Open community</li>
      </ol>
      {authority.getSnapshot().state === 'withdrawn' && (
        <div role="status" className="notice">
          <p>
            Administrator metadata was withdrawn. Your private drafts and exact recovery remain
            available. Refresh the affected section to check access again.
          </p>
          <button onClick={context.refreshCommunity}>Refresh administration</button>
        </div>
      )}
      <ErrorText error={error} />
      <SeparateDraft
        record={setupIntent}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      <form
        className="card admin-card setup-form"
        aria-label="Community details"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void setup();
        }}
      >
        <label>
          Community name
          <input
            value={name}
            disabled={locked}
            onChange={(e) => {
              setName(e.target.value);
              draft({ community_name: e.target.value });
            }}
          />
        </label>
        {setupIntent?.state === 'rejected' ? (
          <div className="notice">
            <p>Setup was rejected. Your draft is preserved.</p>
            <button type="button" onClick={correct}>
              Prepare corrected setup
            </button>
          </div>
        ) : (
          <button type="submit" className="primary" disabled={busy || !!setupIntent?.blocked_by}>
            {setupIntent?.state === 'uncertain' ? 'Retry same setup' : 'Create community'}
          </button>
        )}
        {setupIntent?.state === 'uncertain' && (
          <button type="button" disabled={busy} onClick={() => void setup(true)}>
            Check setup status
          </button>
        )}
      </form>
    </>
  );
}
