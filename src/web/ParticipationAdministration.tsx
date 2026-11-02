import { OperationalHealth } from './OperationalHealth.js';
import { FileLimits } from './FileLimits.js';
import { ParticipationRates } from './ParticipationRates.js';
import { useEffect, useRef, useState } from 'react';
import { Type } from '@sinclair/typebox';
import { type OnboardingView, Onboarding, UUID, closed } from '../contracts/participation.js';
import { commandRequest, identityGeneration } from './participation-client.js';
import { type Context, useQuery } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { SearchAdministration } from './Search.js';
import { FileTextAdministration } from './FileText.js';
import { ErrorText } from './participation-ui.js';
import { Admission } from './ParticipationAdmission.js';
import { IdentityAuditBrowsing } from './AdministrationBrowsing.js';

export function Administration({ context }: { context: Context }) {
  const authority = useAuthorization(),
    generation = authority.capture();
  const refreshCommunityIfCurrent = () => {
    if (authority.current(generation) && authority.getSnapshot().state !== 'withdrawn')
      context.refreshCommunity();
  };
  return (
    <>
      <h1>Administration</h1>
      <p className="subtitle">Manage your community and admit participants.</p>
      {authority.getSnapshot().state === 'withdrawn' && (
        <div role="status" className="notice">
          <p>
            Administrator metadata was withdrawn. Your private drafts and exact recovery remain
            available. Refresh the affected section to check access again.
          </p>
          <button onClick={context.refreshCommunity}>Refresh administration</button>
        </div>
      )}
      <OperationalHealth context={context} />
      <ParticipationRates context={context} />
      <FileLimits context={context} />
      <SearchAdministration context={context} />
      <FileTextAdministration context={context} />
      <Settings context={{ ...context, refreshCommunity: refreshCommunityIfCurrent }} />
      <Admission context={context} />
      <IdentityAuditBrowsing self={context.self} />
    </>
  );
}

function Settings({ context }: { context: Context }) {
  return (
    <Configuration
      key={context.community.instance_id + ':' + context.self.participant_id}
      context={context}
    />
  );
}

const SettingsReceipt = Type.Object(
  {
    operation_state: Type.Literal('committed'),
    operation_id: UUID,
    version: Type.Integer({ minimum: 1 }),
  },
  closed,
);
type ConfigurationValues = {
  version: number;
  name: string;
  overview: string;
  proposal: string;
};
type ConfigurationDraft = { base: ConfigurationValues; values: ConfigurationValues };
function configurationValues(community: OnboardingView): ConfigurationValues {
  return {
    version: community.settings_version,
    name: community.community_name,
    overview: community.overview.resource_id ?? '',
    proposal: community.proposal_area.resource_id ?? '',
  };
}
function hasConfigurationChanges(draft: ConfigurationDraft) {
  return (
    draft.values.overview !== draft.base.overview || draft.values.proposal !== draft.base.proposal
  );
}

function Configuration({ context }: { context: Context }) {
  const community = useQuery<OnboardingView>('/api/v1/community', Onboarding);
  const authority = useAuthorization();
  const [draft, setDraft] = useState<ConfigurationDraft>(),
    [observation, setObservation] = useState<{ version: number; generation: number | undefined }>(),
    [refreshErrorVisible, setRefreshErrorVisible] = useState(true),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false);
  const live = useRef(false),
    owner = useRef(identityGeneration()),
    pending = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!community.data) return;
    const values = configurationValues(community.data);
    setObservation({ version: values.version, generation: community.generation });
    // A read can update a pristine form, but never an unsaved edit's base.
    // Keep this state mounted while useQuery clears or withdraws its result.
    setDraft((current) =>
      !pending.current &&
      (!current || (!hasConfigurationChanges(current) && values.version >= current.base.version))
        ? { base: values, values }
        : current,
    );
  }, [community.data, community.generation]);
  const current = () => live.current && owner.current === identityGeneration();
  const authorized = () => current() && !!observation && authority.current(observation.generation);
  const dirty = !!draft && hasConfigurationChanges(draft);

  async function save() {
    if (!draft || pending.current || !authorized()) return;
    const generation = observation!.generation,
      submitted = draft.values;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await commandRequest<{ version: number }>('/api/v1/community/settings', {
        self: context.self,
        schema: SettingsReceipt,
        body: {
          idempotency_key: crypto.randomUUID(),
          expected_version: draft.base.version,
          community_name: draft.base.name,
          overview_id: submitted.overview || null,
          proposal_area_id: submitted.proposal || null,
        },
      });
      if (result.version !== draft.base.version + 1)
        throw new Error(
          'Saving was not confirmed at the expected version. Your draft is retained.',
        );
      if (!current() || !authority.current(generation)) return;
      const values = { ...submitted, version: result.version };
      setDraft({ base: values, values });
      setStatus(`Configuration saved at version ${result.version}.`);
      setRefreshErrorVisible(true);
      community.refreshIfCurrent();
      context.refreshCommunity();
    } catch (failure) {
      if (current()) setError((failure as Error).message);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  async function discard() {
    if (pending.current || !authorized()) return;
    if (
      dirty &&
      !window.confirm('Discard your unsaved configuration changes and load saved settings?')
    )
      return;
    const generation = observation!.generation;
    pending.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await authority.readAuthorized<OnboardingView>('/api/v1/community', {
        schema: Onboarding,
      });
      if (!current() || !authority.current(generation) || !authority.current(result.generation))
        return;
      const values = configurationValues(result.value);
      setObservation({ version: values.version, generation: result.generation });
      setDraft({ base: values, values });
      // This successful read supersedes any earlier query refresh failure.
      setRefreshErrorVisible(false);
      setStatus('Saved configuration loaded.');
    } catch (failure) {
      if (current()) setError((failure as Error).message);
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }

  return (
    <>
      <button
        disabled={busy}
        onClick={() => {
          setRefreshErrorVisible(true);
          community.refresh();
        }}
      >
        Refresh configuration
      </button>
      <ErrorText error={refreshErrorVisible ? community.error : ''} />
      <details className="card admin-card">
        <summary>Community configuration</summary>
        <ErrorText error={error} />
        {draft && (authorized() || dirty) && (
          <>
            <p role="status">
              {dirty ? 'Unsaved changes. ' : ''}Editing settings version {draft.base.version}.
              {status && ' ' + status}
            </p>
            <p>
              Refresh checks saved settings and keeps unsaved changes and their original version.
            </p>
            {authorized() && observation!.version > draft.base.version && (
              <p className="notice">
                Saved settings have changed to version {observation!.version}. Your draft still uses
                version {draft.base.version}; saving may conflict. Discard and reload to use saved
                settings.
              </p>
            )}
            {!authorized() && (
              <p>Your draft is retained. Refresh configuration to check access again.</p>
            )}
            <label>
              Overview artifact ID
              <input
                disabled={busy}
                value={draft.values.overview}
                onChange={(e) => {
                  setDraft({ ...draft, values: { ...draft.values, overview: e.target.value } });
                  setStatus('');
                }}
              />
            </label>
            <label>
              Proposal area ID
              <input
                disabled={busy}
                value={draft.values.proposal}
                onChange={(e) => {
                  setDraft({ ...draft, values: { ...draft.values, proposal: e.target.value } });
                  setStatus('');
                }}
              />
            </label>
            {authorized() && (
              <div className="actions">
                <button disabled={busy} onClick={() => void save()}>
                  Save configuration
                </button>
                <button disabled={busy} onClick={() => void discard()}>
                  {dirty ? 'Discard changes and reload saved settings' : 'Reload saved settings'}
                </button>
              </div>
            )}
          </>
        )}
      </details>
    </>
  );
}
