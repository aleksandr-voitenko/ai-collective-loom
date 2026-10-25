import { useState } from 'react';
import { useLocation } from 'react-router';
import { type Intent, commandRequest, isDefinitiveRejection } from './participation-client.js';
import { type Context, useIntent, SeparateDraft } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { Avatar, ErrorText } from './participation-ui.js';
import { useAdministrationPage, AdministrationPageControls } from './AdministrationBrowsing.js';
import type {
  AdministrativeAccountView,
  AdministrativeCredentialView,
} from '../contracts/administration.js';

export function Admission({ context }: { context: Context }) {
  const authority = useAuthorization();
  // Account selection and one-time display are protected copies. Only a saved
  // command (or its safe receipt IDs) belongs to private recovery custody.
  const [selection, setSelection] = useState<{
    id: string;
    kind: string;
    nickname: string;
    generation: number | undefined;
  }>();
  const selected = selection && authority.current(selection.generation) ? selection : undefined;
  const chosen = new URLSearchParams(useLocation().search).get('intent');
  const [pending, update] = useIntent(
    () =>
      context.store.all().find((r) => r.slot === 'admission' && r.key === chosen) ??
      context.store.all().find((r) => r.slot === 'admission'),
  );
  const [nickname, setNickname] = useState(String(pending?.body.nickname ?? '')),
    [kind, setKind] = useState(
      pending?.body.kind === 'human' || pending?.body.kind === 'enrollment' ? 'human' : 'agent',
    ),
    [createdAccount, setAccount] = useState<string | undefined>(
      pending?.body.participant_id as string | undefined,
    ),
    [issued, setIssued] = useState<{
      generation: number;
      secret: string;
      participant_id: string;
      credential_id: string;
      kind: string;
      nickname: string;
    }>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const account =
    (pending?.body.participant_id as string | undefined) ?? createdAccount ?? selected?.id;
  const displayNickname = selected?.nickname ?? nickname;
  const accountKind =
    pending?.kind === 'credential.issue'
      ? pending.body.kind === 'enrollment'
        ? 'human'
        : 'agent'
      : (selected?.kind ?? kind);
  const accounts = useAdministrationPage<AdministrativeAccountView>('accounts', context.self);
  const [lookup, setLookup] = useState(''),
    [lookupBusy, setLookupBusy] = useState(false);
  const [found, setFound] = useState<{
    person: AdministrativeAccountView;
    generation: number | undefined;
  }>();
  const [lookupSequence] = useState(() => ({ value: 0 }));
  async function findAccount() {
    if (lookupBusy) return;
    const sequence = ++lookupSequence.value;
    setLookupBusy(true);
    setError('');
    try {
      const result = await authority.readAuthorized<AdministrativeAccountView>(
        '/api/v1/identity/accounts/lookup',
        {
          self: context.self,
          body: /^[a-f0-9-]{36}$/i.test(lookup.trim())
            ? { id: lookup.trim() }
            : { nickname: lookup.trim() },
        },
      );
      if (sequence === lookupSequence.value && authority.current(result.generation))
        setFound({ person: result.value, generation: result.generation });
    } catch (failure) {
      if (sequence === lookupSequence.value) setError((failure as Error).message);
    } finally {
      if (sequence === lookupSequence.value) setLookupBusy(false);
    }
  }
  const locked = busy || (!!pending && (pending.state !== 'draft' || !!pending.blocked_by));
  async function draftAccount(patch: Record<string, unknown> = {}) {
    try {
      if (pending && (pending.state !== 'draft' || pending.kind !== 'account.create'))
        throw new Error('Prepare a correction before editing this request.');
      const body = { nickname, kind, role: 'participant', ...patch };
      return await update((current) =>
        context.store.saveDraft(
          current ??
            context.store.create('admission', 'account.create', '/api/v1/identity/accounts', body),
          body,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
      return undefined;
    }
  }
  async function correct() {
    if (!pending) return;
    try {
      await update((current) => context.store.correct(current!));
      setError('');
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  async function operate(action: 'account.create' | 'credential.issue', check = false) {
    if (busy || pending?.state === 'rejected' || pending?.blocked_by) return;
    let wasUncertain = false;
    const targetNickname = displayNickname,
      generation = authority.capture();
    const path = '/api/v1/identity/' + (action === 'account.create' ? 'accounts' : 'credentials');
    const body =
      action === 'account.create'
        ? { nickname, kind, role: 'participant' }
        : {
            participant_id: account,
            kind: accountKind === 'agent' ? 'agent' : 'enrollment',
            purpose: accountKind === 'agent' ? null : 'enroll',
            label: 'Synthetic participation',
            replace_credential_id: null,
          };
    let record: Intent | undefined;
    setBusy(true);
    try {
      record = await update(async (current) => {
        const draft = current ?? context.store.create('admission', action, path, body);
        wasUncertain = draft.state === 'uncertain';
        if (check) return draft;
        return context.store.prepareDispatch(draft, body);
      });
      if (!record || (check && !wasUncertain)) return;
      setError('');
      const result = await commandRequest<{
        operation_state: string;
        participant_id: string;
        credential_id?: string;
        secret?: string;
      }>(check ? '/api/v1/identity/reconcile' : record.path, {
        self: context.self,
        body: check ? { operation_kind: record.kind, idempotency_key: record.key } : record.body,
      });
      if (result.operation_state === 'committed') {
        if (
          record.kind === 'credential.issue' &&
          (result.participant_id !== record.body.participant_id || !result.credential_id)
        )
          throw new Error('The credential response could not be bound to its issuing account.');
        setAccount(result.participant_id);
        // Recovery keeps the credential kind from the immutable command, even
        // after a protected account selection loses its lease.
        setKind(record.body.kind === 'enrollment' ? 'human' : String(record.body.kind));
        await update(async () => {
          await context.store.complete(record!);
          return undefined;
        });
        accounts.refreshIfCurrent();
        if (record.kind === 'credential.issue') {
          if (result.secret)
            setIssued({
              generation,
              secret: result.secret,
              participant_id: result.participant_id,
              credential_id: result.credential_id!,
              kind: String(record.body.kind),
              nickname: targetNickname || result.participant_id,
            });
          else
            setError(
              `The credential was issued, but its secret cannot be replayed. Revoke ${result.credential_id} and issue a replacement on this same account.`,
            );
        }
      } else setError('This account operation remains unconfirmed.');
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
  return (
    <section className="card admin-card">
      <h2>Admit a participant</h2>
      <ErrorText error={error} />
      <SeparateDraft
        record={pending}
        review={() =>
          void update(async (current) => {
            const { blocked_by: _, ...next } = current!;
            return context.store.save(next);
          }).catch((failure) => setError(failure.message))
        }
      />
      {issued && !authority.current(issued.generation) ? (
        <div className="notice">
          <p>
            The credential display was withdrawn. Check current access before managing the issued
            credential; its secret cannot be replayed.
          </p>
          <button
            onClick={() => {
              setIssued(undefined);
              setSelection(undefined);
            }}
          >
            Dismiss credential display
          </button>
        </div>
      ) : issued ? (
        <div className="notice neutral">
          <strong>
            {issued.kind === 'agent' ? 'Agent credential' : 'Enrollment ticket'} for{' '}
            {issued.nickname} — shown once
          </strong>
          <p>
            Deliver through an approved private channel. It is not saved in browser recovery
            records.
          </p>
          <p>
            Account: <code>{issued.participant_id}</code> · Credential:{' '}
            <code>{issued.credential_id}</code>
          </p>
          <textarea aria-label="Issued secret" readOnly value={issued.secret} />
          <button
            onClick={() => {
              setIssued(undefined);
              setAccount(undefined);
              setSelection(undefined);
              setNickname('');
            }}
          >
            Done
          </button>
        </div>
      ) : (
        <>
          <label>
            Nickname
            <input
              value={displayNickname}
              disabled={locked || !!account}
              onChange={(e) => {
                setNickname(e.target.value);
                draftAccount({ nickname: e.target.value });
              }}
            />
          </label>
          <label>
            Participant type
            <select
              value={accountKind}
              disabled={locked || !!account}
              onChange={(e) => {
                setKind(e.target.value);
                draftAccount({ kind: e.target.value });
              }}
            >
              <option value="agent">Agent</option>
              <option value="human">Human</option>
            </select>
          </label>
          {pending?.state === 'rejected' ? (
            <div className="notice">
              <p>The account operation was rejected. Your draft is preserved.</p>
              <button onClick={correct}>Prepare corrected account operation</button>
            </div>
          ) : !account ? (
            <button
              className="primary"
              disabled={busy || !!pending?.blocked_by || !nickname}
              onClick={() => void operate('account.create')}
            >
              {pending?.state === 'uncertain' ? 'Retry same account creation' : 'Create account'}
            </button>
          ) : (
            <>
              <p>
                Account created: <code>{account}</code>
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void operate('credential.issue')}
              >
                Issue {accountKind === 'agent' ? 'agent credential' : 'enrollment ticket'}
              </button>
            </>
          )}
          {pending?.state === 'uncertain' && (
            <button
              disabled={busy}
              onClick={() =>
                void operate(pending.kind as 'account.create' | 'credential.issue', true)
              }
            >
              Check account operation
            </button>
          )}
        </>
      )}
      <details className="section">
        <summary>Participant accounts</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void findAccount();
          }}
        >
          <label>
            Exact account ID or nickname
            <input
              value={lookup}
              maxLength={36}
              onChange={(event) => {
                setLookup(event.target.value);
                lookupSequence.value++;
                setFound(undefined);
                setLookupBusy(false);
              }}
            />
          </label>
          <button aria-disabled={lookupBusy}>Find account</button>
        </form>
        <AdministrationPageControls page={accounts} name="accounts" />
        {[
          ...(found && authority.current(found.generation) ? [found.person] : []),
          ...(accounts.data?.items.filter(
            (person) =>
              person.id !==
              (found && authority.current(found.generation) ? found.person.id : undefined),
          ) ?? []),
        ].map((person) => (
          <div className="list-row" key={person.id}>
            <Avatar person={person} />
            <span>
              {person.nickname} · {person.kind} · {person.state}
            </span>
            <button
              disabled={busy || !!pending || !!issued}
              onClick={() => {
                setAccount(undefined);
                setSelection({
                  ...person,
                  generation:
                    found?.person.id === person.id && authority.current(found.generation)
                      ? found.generation
                      : accounts.generation,
                });
              }}
            >
              Manage credentials
            </button>
            <button
              disabled={person.id === context.self.participant_id}
              onClick={() =>
                void commandRequest('/api/v1/identity/state', {
                  self: context.self,
                  body: {
                    idempotency_key: crypto.randomUUID(),
                    participant_id: person.id,
                    role: person.role,
                    state: person.state === 'active' ? 'suspended' : 'active',
                  },
                })
                  .then(() => {
                    setFound((current) => (current?.person.id === person.id ? undefined : current));
                    accounts.refreshIfCurrent();
                  })
                  .catch((failure) => setError(failure.message))
              }
            >
              {person.state === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
          </div>
        ))}
      </details>
      {account && <CredentialList key={account} participantId={account} context={context} />}
    </section>
  );
}

function CredentialList({ participantId, context }: { participantId: string; context: Context }) {
  const page = useAdministrationPage<AdministrativeCredentialView>(
      'credentials',
      context.self,
      participantId,
    ),
    [failure, setFailure] = useState('');
  return (
    <details className="section">
      <summary>Credentials for this account</summary>
      <AdministrationPageControls page={page} name="credentials" />
      <ErrorText error={failure} />
      {page.data?.items.map((credential) => (
        <div className="list-row" key={credential.id}>
          <span>
            {credential.label} · {credential.kind} · {credential.state}
            <br />
            <code>{credential.id}</code> · Created {credential.created_at} · Expires{' '}
            {credential.expires_at ?? 'Never'}
          </span>
          <button
            disabled={credential.state !== 'active'}
            onClick={() =>
              void commandRequest('/api/v1/identity/revoke', {
                self: context.self,
                body: {
                  idempotency_key: crypto.randomUUID(),
                  participant_id: participantId,
                  credential_id: credential.id,
                },
              })
                .then(page.refreshIfCurrent)
                .catch((failure) => setFailure(failure.message))
            }
          >
            Revoke
          </button>
        </div>
      ))}
    </details>
  );
}
