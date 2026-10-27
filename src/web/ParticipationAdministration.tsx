import { OperationalHealth } from './OperationalHealth.js';
import { FileLimits } from './FileLimits.js';
import { ParticipationRates } from './ParticipationRates.js';
import { useState } from 'react';
import { type OnboardingView, Onboarding } from '../contracts/participation.js';
import { commandRequest } from './participation-client.js';
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
  const community = useQuery<OnboardingView>('/api/v1/community', Onboarding);
  return (
    <>
      <button onClick={community.refresh}>Refresh configuration</button>
      <ErrorText error={community.error} />
      {community.data && (
        <Configuration
          key={community.generation}
          context={{ ...context, community: community.data }}
          onSaved={() => {
            community.refreshIfCurrent();
            context.refreshCommunity();
          }}
        />
      )}
    </>
  );
}

function Configuration({ context, onSaved }: { context: Context; onSaved: () => void }) {
  const [overview, setOverview] = useState(context.community.overview.resource_id ?? ''),
    [proposal, setProposal] = useState(context.community.proposal_area.resource_id ?? ''),
    [error, setError] = useState('');
  async function save() {
    try {
      await commandRequest('/api/v1/community/settings', {
        self: context.self,
        body: {
          idempotency_key: crypto.randomUUID(),
          expected_version: context.community.settings_version,
          community_name: context.community.community_name,
          overview_id: overview || null,
          proposal_area_id: proposal || null,
        },
      });
      onSaved();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  return (
    <details className="card admin-card">
      <summary>Community configuration</summary>
      <ErrorText error={error} />
      <label>
        Overview artifact ID
        <input value={overview} onChange={(e) => setOverview(e.target.value)} />
      </label>
      <label>
        Proposal area ID
        <input value={proposal} onChange={(e) => setProposal(e.target.value)} />
      </label>
      <button onClick={() => void save()}>Save configuration</button>
    </details>
  );
}
