import { useEffect, useRef, useState } from 'react';
import { useBeforeUnload, useBlocker, useLocation } from 'react-router';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  Onboarding,
  SettingsInput,
  UUID,
  closed,
  type OnboardingView,
} from '../contracts/participation.js';
import {
  ApiError,
  commandRequest,
  identityGeneration,
  isDefinitiveRejection,
  type Intent,
  type Self,
} from './participation-client.js';
import { useQuery, type Context } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import {
  CommunityResource,
  CommunityResourcePicker,
  type CommunityResourceKind,
} from './CommunityResourcePicker.js';
import { ErrorText } from './participation-ui.js';

const settingsPath = '/api/v1/community/settings';
const SettingsReceipt = Type.Object(
  {
    operation_state: Type.Literal('committed'),
    operation_id: UUID,
    version: Type.Integer({ minimum: 1 }),
  },
  closed,
);
type Values = {
  version: number;
  name: string;
  overview: string | null | undefined;
  proposal: string | null | undefined;
};
type Draft = { base: Values; values: Values; restored?: true };
type Problem = { kind: 'conflict' | 'validation' | 'uncertain' | 'local'; message: string };
function valuesFrom(community: OnboardingView): Values {
  const designation = (value: OnboardingView['overview']) =>
    value.resource_id ?? (value.state === 'unavailable' ? undefined : null);
  return {
    version: community.settings_version,
    name: community.community_name,
    overview: designation(community.overview),
    proposal: designation(community.proposal_area),
  };
}
function changed(draft: Draft) {
  return (
    !!draft.restored ||
    draft.values.overview !== draft.base.overview ||
    draft.values.proposal !== draft.base.proposal
  );
}
function retainedDraft(record: Intent | undefined): Draft | undefined {
  if (!record || record.path !== settingsPath || !Value.Check(SettingsInput, record.body))
    return undefined;
  const values = {
    version: record.body.expected_version as number,
    name: record.body.community_name as string,
    overview: record.body.overview_id as string | null,
    proposal: record.body.proposal_area_id as string | null,
  };
  // Custody retains the submitted values/version, not the original accepted choices.
  // Until an explicit reload or confirmed save, there is no local baseline to cancel to.
  return { base: values, values, restored: true };
}

export function CommunitySettings({ context }: { context: Context }) {
  const authority = useAuthorization(),
    community = useQuery<OnboardingView>('/api/v1/community', Onboarding);
  const selectedRequest = new URLSearchParams(useLocation().search).get('intent');
  const [record, setRecord] = useState(() =>
    context.store
      .all()
      .find(
        (item) =>
          item.kind === 'community.settings' && (!selectedRequest || item.key === selectedRequest),
      ),
  );
  const [draft, setDraft] = useState<Draft | undefined>(() => retainedDraft(record));
  const [observation, setObservation] = useState<{
    version: number;
    generation: number | undefined;
  }>();
  const [picker, setPicker] = useState<CommunityResourceKind>();
  const [comparison, setComparison] = useState<{
    values: Values;
    generation: number | undefined;
  }>();
  const [problem, setProblem] = useState<Problem>();
  const [reloadError, setReloadError] = useState(''),
    [accessError, setAccessError] = useState('');
  const [status, setStatus] = useState(''),
    [operation, setOperation] = useState<'save' | 'reload' | 'check'>(),
    [readErrorVisible, setReadErrorVisible] = useState(true);
  const live = useRef(false),
    owner = useRef(identityGeneration()),
    pending = useRef(false),
    recovery = useRef(record);
  recovery.current = record;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!community.data) return;
    setReloadError('');
    const values = valuesFrom(community.data);
    setObservation({ version: values.version, generation: community.generation });
    // Observations may advance independently; dirty or unresolved edits keep their base.
    setDraft((prior) =>
      !pending.current &&
      !recovery.current &&
      (!prior || (!changed(prior) && values.version >= prior.base.version))
        ? { base: values, values }
        : prior,
    );
  }, [community.data, community.generation]);
  const busy = !!operation;
  const current = () => live.current && owner.current === identityGeneration();
  const authorized = () => current() && !!observation && authority.current(observation.generation);
  const dirty = !!draft && changed(draft),
    uncertain = record?.state === 'uncertain';
  const lossRisk = dirty && !uncertain;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      lossRisk &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Discard unsaved Community settings changes and leave this page?'))
      blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useBeforeUnload((event) => {
    if (lossRisk) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  async function save() {
    if (!draft || pending.current || !authorized() || (!dirty && !uncertain)) return;
    const generation = observation!.generation;
    let sent: Intent | undefined;
    const wasUncertain = !!uncertain;
    pending.current = true;
    setOperation('save');
    setProblem(undefined);
    setComparison(undefined);
    setStatus('');
    try {
      if (!record && context.store.all().some((item) => item.kind === 'community.settings'))
        throw new Error(
          'Another Community settings request is retained. Reopen this page to review it before saving.',
        );
      const body = uncertain
        ? record.body
        : {
            expected_version: draft.base.version,
            community_name: draft.base.name,
            overview_id: draft.values.overview,
            proposal_area_id: draft.values.proposal,
          };
      const candidate =
        record ??
        context.store.create('community.settings', 'community.settings', settingsPath, body);
      if (!Value.Check(SettingsInput, { ...body, idempotency_key: candidate.key }))
        throw new Error('Choose a replacement for each unavailable setting before saving.');
      sent = await context.store.prepareDispatch(candidate, body);
      if (!current()) return;
      setRecord(sent);
      if (!authority.current(generation)) return;
      const result = await commandRequest<{ version: number }>(settingsPath, {
        self: context.self,
        body: sent.body,
        schema: SettingsReceipt,
      });
      if (result.version !== Number(sent.body.expected_version) + 1)
        throw new Error('The save response could not be confirmed.');
      if (!current() || !authority.current(generation)) return;
      await context.store.complete(sent);
      if (!current() || !authority.current(generation)) return;
      const values = { ...draft.values, version: result.version };
      setRecord(undefined);
      setDraft({ base: values, values });
      setStatus('Changes saved.');
      setReadErrorVisible(true);
      community.refreshIfCurrent();
      context.refreshCommunity();
    } catch (failure) {
      if (!current()) return;
      // community.settings serializes the exact attempt and returns any committed
      // audit result before checking the settings version (administration.ts).
      // Its revision_conflict therefore proves noncommit even after response loss.
      // Permission/unavailability refusals can precede that lookup and do not.
      const settingsConflict =
        failure instanceof ApiError &&
        failure.code === 'revision_conflict' &&
        failure.operationOutcome !== 'unknown';
      if (sent && (settingsConflict || isDefinitiveRejection(failure, wasUncertain))) {
        try {
          const rejected = await context.store.settle(sent, { state: 'rejected' });
          if (!current()) return;
          // A concurrent retry can leave the shared record uncertain; never retire it.
          if (rejected.state !== 'rejected') {
            setRecord(rejected);
            setProblem({ kind: 'uncertain', message: (failure as Error).message });
            return;
          }
          setRecord(rejected);
          await context.store.remove(rejected);
          if (!current()) return;
          setRecord(undefined);
          setProblem({
            kind:
              failure instanceof ApiError && failure.code === 'revision_conflict'
                ? 'conflict'
                : 'validation',
            message: (failure as Error).message,
          });
        } catch (storageFailure) {
          if (current()) {
            setProblem({ kind: 'local', message: (storageFailure as Error).message });
          }
        }
      } else
        setProblem({
          kind: sent || wasUncertain ? 'uncertain' : 'local',
          message: (failure as Error).message,
        });
    } finally {
      pending.current = false;
      if (current()) setOperation(undefined);
    }
  }

  async function cancel() {
    if (!draft || draft.restored || pending.current || uncertain) return;
    try {
      if (record) await context.store.remove(record);
      if (!current()) return;
      setRecord(undefined);
      setDraft({ base: draft.base, values: draft.base });
      setProblem(undefined);
      setComparison(undefined);
      setStatus('Changes cancelled.');
    } catch (failure) {
      if (current()) setProblem({ kind: 'local', message: (failure as Error).message });
    }
  }

  async function reloadSaved() {
    if (pending.current || uncertain || !authorized()) return;
    if (
      (dirty || record?.state === 'rejected') &&
      !window.confirm('Discard your unsaved Community settings changes and load saved settings?')
    )
      return;
    const generation = observation!.generation;
    pending.current = true;
    setOperation('reload');
    setStatus('');
    try {
      const result = await authority.readAuthorized<OnboardingView>('/api/v1/community', {
        schema: Onboarding,
      });
      if (!current() || !authority.current(generation) || !authority.current(result.generation))
        return;
      if (record) await context.store.remove(record);
      if (!current() || !authority.current(result.generation)) return;
      const values = valuesFrom(result.value);
      setRecord(undefined);
      setObservation({ version: values.version, generation: result.generation });
      setDraft({ base: values, values });
      setProblem(undefined);
      setComparison(undefined);
      setReloadError('');
      setReadErrorVisible(false);
      setStatus('Saved settings loaded.');
    } catch (failure) {
      if (current()) setReloadError((failure as Error).message);
    } finally {
      pending.current = false;
      if (current()) setOperation(undefined);
    }
  }
  async function checkSaved() {
    if (pending.current || uncertain || !authorized()) return;
    const generation = observation!.generation;
    pending.current = true;
    setOperation('check');
    setComparison(undefined);
    setStatus('');
    try {
      const result = await authority.readAuthorized<OnboardingView>('/api/v1/community', {
        schema: Onboarding,
      });
      if (!current() || !authority.current(generation) || !authority.current(result.generation))
        return;
      const values = valuesFrom(result.value);
      setObservation({ version: values.version, generation: result.generation });
      setComparison({ values, generation: result.generation });
      setReadErrorVisible(false);
      setReloadError('');
      setStatus('Saved choices checked. Your unsaved choices are unchanged.');
    } catch (failure) {
      if (current()) setReloadError((failure as Error).message);
    } finally {
      pending.current = false;
      if (current()) setOperation(undefined);
    }
  }
  async function refresh() {
    if (pending.current) return;
    if (authority.getSnapshot().state === 'withdrawn') {
      const generation = authority.capture();
      pending.current = true;
      setOperation('reload');
      try {
        const account = await authority.readAuthorized<Self>('/api/v1/identity/self');
        if (!current() || !authority.current(generation) || !authority.current(account.generation))
          return;
        if (
          account.value.participant_id !== context.self.participant_id ||
          account.value.role !== 'administrator'
        )
          throw new Error('Administrator access is required. Your choices are retained.');
        // An explicit access check can authorize fresh reads, never an old lease.
        setAccessError('');
        authority.region.retry();
      } catch (failure) {
        if (current()) setAccessError((failure as Error).message);
        return;
      } finally {
        pending.current = false;
        if (current()) setOperation(undefined);
      }
    }
    setReadErrorVisible(true);
    community.refresh();
  }
  function select(id: string) {
    if (!draft || !picker || busy || uncertain || !authorized()) return;
    setDraft({
      ...draft,
      values: { ...draft.values, [picker === 'artifact' ? 'overview' : 'proposal']: id },
    });
    setPicker(undefined);
    setStatus('');
  }
  const unavailable =
    draft && (draft.values.overview === undefined || draft.values.proposal === undefined);
  return (
    <section className="community-settings" aria-labelledby="community-settings-title">
      <h1 id="community-settings-title">Community settings</h1>
      <p className="subtitle">Help people find their way and share proposals.</p>
      <form
        className="community-settings-form"
        aria-label="Community settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ErrorText error={readErrorVisible ? community.error : ''} />
        <ErrorText error={reloadError} />
        <ErrorText error={accessError} />
        {readErrorVisible && community.error && (
          <button type="button" disabled={busy} onClick={refresh}>
            Retry saved settings
          </button>
        )}
        {!draft && !community.error && !record && authority.getSnapshot().state !== 'withdrawn' && (
          <p role="status">Loading community settings…</p>
        )}
        {record && !draft && (
          <ErrorText error="The retained save could not be read. Preserve it in Local drafts before continuing." />
        )}
        {authority.getSnapshot().state === 'withdrawn' && (
          <div className="notice" role="status">
            <p>
              Access changed.{' '}
              {draft
                ? 'Your choices are retained, but resource details and saving are unavailable.'
                : 'Saved settings are unavailable. Check access before editing.'}
            </p>
            <button type="button" disabled={busy} onClick={refresh}>
              Check access
            </button>
          </div>
        )}
        {draft && (
          <>
            {(['overview', 'proposal'] as const).map((field) => (
              <section
                key={field}
                className="community-setting"
                aria-labelledby={'community-' + field + '-label'}
              >
                <header>
                  <h2 id={'community-' + field + '-label'}>
                    {field === 'overview' ? 'Community overview' : 'Proposal topic'}
                  </h2>
                  <button
                    type="button"
                    aria-label={
                      'Change ' + (field === 'overview' ? 'community overview' : 'proposal topic')
                    }
                    disabled={busy || !!record || !authorized()}
                    onClick={() => setPicker(field === 'overview' ? 'artifact' : 'area')}
                  >
                    Change
                  </button>
                </header>
                <p className="community-setting-description">
                  {field === 'overview'
                    ? 'An introduction to your community’s purpose and shared work.'
                    : 'Where people can suggest changes to the community.'}
                </p>
                <div className="community-selection">
                  {!authorized() ? (
                    <p>Selection details are unavailable.</p>
                  ) : draft.values[field] ? (
                    <CommunityResource
                      key={draft.values[field]}
                      id={draft.values[field]}
                      kind={field === 'overview' ? 'artifact' : 'area'}
                    />
                  ) : (
                    <p>
                      {draft.values[field] === undefined
                        ? 'The saved selection is unavailable. Choose a replacement before saving.'
                        : 'No selection yet.'}
                    </p>
                  )}
                </div>
              </section>
            ))}
            {busy && (
              <p role="status">
                {operation === 'save'
                  ? 'Saving changes…'
                  : operation === 'check'
                    ? 'Checking saved choices…'
                    : 'Loading saved settings…'}
              </p>
            )}
            {status && (
              <p role="status" className="community-settings-status">
                {status}
              </p>
            )}
            {dirty && (
              <p className="community-dirty" role="status">
                Unsaved changes
              </p>
            )}
            {record?.state === 'rejected' && (
              <div className="notice" role="alert">
                <p>This save was rejected. The original request is still stored locally.</p>
                <button
                  type="button"
                  disabled={busy || !authorized()}
                  onClick={() => void reloadSaved()}
                >
                  Discard rejected save and load saved settings
                </button>
              </div>
            )}
            {problem?.kind === 'conflict' && (
              <div className="notice" role="alert">
                <p>
                  Community settings changed while you were editing. Your choices are still here.
                </p>
                {authorized() && (
                  <div className="actions">
                    <button type="button" disabled={busy} onClick={() => void checkSaved()}>
                      Check saved settings
                    </button>
                    <button type="button" disabled={busy} onClick={() => void reloadSaved()}>
                      Load saved settings
                    </button>
                  </div>
                )}
              </div>
            )}
            {comparison && authorized() && authority.current(comparison.generation) && (
              <section className="community-saved-choices" aria-labelledby="saved-choices-title">
                <h2 id="saved-choices-title">Saved choices</h2>
                <p>Compare these saved choices with your unsaved choices above.</p>
                <div className="community-saved-grid">
                  {(['overview', 'proposal'] as const).map((field) => (
                    <div key={field}>
                      <p className="community-saved-label">
                        {field === 'overview' ? 'Community overview' : 'Proposal topic'}
                      </p>
                      {comparison.values[field] ? (
                        <CommunityResource
                          key={comparison.values[field]}
                          id={comparison.values[field]}
                          kind={field === 'overview' ? 'artifact' : 'area'}
                        />
                      ) : (
                        <p>
                          {comparison.values[field] === undefined
                            ? 'Saved selection unavailable.'
                            : 'No saved selection.'}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {!busy && (uncertain || problem?.kind === 'uncertain') && (
              <div className="notice" role="alert">
                <p>We couldn’t confirm whether your changes were saved.</p>
                <p>Your original request is retained. Retry the same save when you’re ready.</p>
              </div>
            )}
            {problem && ['validation', 'local'].includes(problem.kind) && (
              <ErrorText error={problem.message} />
            )}
            {observation &&
              authorized() &&
              observation.version > draft.base.version &&
              dirty &&
              problem?.kind !== 'conflict' && (
                <p className="notice">
                  Saved settings have changed. Your choices are retained; saving may report a
                  conflict.
                </p>
              )}
            <footer className="community-settings-actions">
              <button
                type="submit"
                className="primary"
                disabled={busy || !authorized() || !!unavailable || (!dirty && !uncertain)}
              >
                {operation === 'save'
                  ? 'Saving changes…'
                  : uncertain
                    ? 'Retry same save'
                    : 'Save changes'}
              </button>
              <button
                type="button"
                disabled={busy || uncertain || !!draft.restored || !dirty}
                onClick={() => void cancel()}
              >
                Cancel
              </button>
            </footer>
          </>
        )}
      </form>
      {picker && (
        <CommunityResourcePicker kind={picker} choose={select} close={() => setPicker(undefined)} />
      )}
    </section>
  );
}
