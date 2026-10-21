import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { type ResourceView, Onboarding } from '../contracts/participation.js';
import { type Context, useQuery } from './participation-state.js';
import {
  OrganizationRecovery,
  TopicDirectory,
  TopicLocation,
  OrganizationActions,
  TopicMetadataHistory,
} from './Organization.js';
import {
  type OrganizationResourceView,
  OrganizationResource,
  type ProposalRouteView,
  ProposalRoute,
} from '../contracts/organization.js';
import { FollowControl } from './Following.js';
import { AuthorizationBoundary } from './AuthorizationBoundary.js';
import { Collection, ErrorText, ResourceRow } from './participation-ui.js';
import { Composer } from './ParticipationComposer.js';
import { ResourceContent } from './ParticipationResource.js';

export function Topics({ context }: { context: Context }) {
  return (
    <>
      <div className="header-line">
        <div>
          <h1>Topics</h1>
          <p className="subtitle">Find a place for your next conversation.</p>
        </div>
      </div>
      {context.community.settings_version === 0 && (
        <div className="notice">
          <p>
            Community setup is incomplete.{' '}
            {context.self.role === 'administrator' ? (
              <Link to="/loom/admin">Set up the community</Link>
            ) : (
              'Ask a community administrator to finish setup.'
            )}
          </p>
        </div>
      )}
      {context.self.role === 'administrator' && (
        <>
          <Link className="button" to="/loom/organize?action=area.create">
            Create root topic
          </Link>
          <OrganizationRecovery context={context} />
        </>
      )}
      <TopicDirectory />
    </>
  );
}

export function AreaPage({ id, context }: { id: string; context: Context }) {
  return (
    <AuthorizationBoundary scope={'area:' + id}>
      <AreaContent id={id} context={context} />
    </AuthorizationBoundary>
  );
}

function AreaContent({ id, context }: { id: string; context: Context }) {
  const query = new URLSearchParams(useLocation().search);
  const [create, setCreate] = useState(query.has('compose')),
    [reload, setReload] = useState(0),
    [tab, setTab] = useState<'discussions' | 'artifacts'>(
      query.get('compose') === 'artifacts' ? 'artifacts' : 'discussions',
    );
  const {
    data: area,
    error,
    refresh,
  } = useQuery<OrganizationResourceView>(
    '/api/v1/organization/resources/' + id,
    OrganizationResource,
  );
  if (error)
    return (
      <>
        <ErrorText error={error} />
        <button onClick={refresh}>Retry topic</button>
      </>
    );
  if (!area) return <p role="status">Opening topic…</p>;
  if (area.kind !== 'area') return <p role="alert">This topic is unavailable.</p>;
  return (
    <>
      <TopicLocation area={area} />
      <div className="header-line">
        <div>
          <h1>{area.title}</h1>
          <p className="subtitle">{area.description}</p>
        </div>
        <button
          className="primary"
          disabled={!area.publication_open}
          onClick={() => setCreate((value) => !value)}
        >
          ＋ {tab === 'discussions' ? 'Start a discussion' : 'New text artifact'}
        </button>
      </div>
      <p className="topic-state">
        {area.publication_open ? 'Open to contributions' : 'Closed to contributions'}
        {!area.publication_open && area.local_open ? ' by an ancestor topic' : ''}
      </p>
      <Link className="button" to={'/loom/search?topic=' + id}>
        Search this topic
      </Link>
      {context.self.role === 'administrator' && (
        <OrganizationActions id={id} kind="area" localOpen={area.local_open} />
      )}
      <FollowControl
        key={'area:' + id}
        context={context}
        target={{ kind: 'area', resource_id: id }}
      />
      <TopicDirectory key={id} parent={id} />
      <div className="topic-tabs" role="group" aria-label="Topic content">
        <button
          aria-pressed={tab === 'discussions'}
          onClick={() => {
            setTab('discussions');
            setCreate(false);
          }}
        >
          Discussions
        </button>
        <button
          aria-pressed={tab === 'artifacts'}
          onClick={() => {
            setTab('artifacts');
            setCreate(false);
          }}
        >
          Artifacts
        </button>
      </div>
      {create && (
        <Composer
          key={tab}
          context={context}
          operation={{
            kind: tab === 'discussions' ? 'discussion.create' : 'artifact.create',
            areaId: id,
          }}
          slot={tab + ':' + id}
          heading={tab === 'discussions' ? 'Start a discussion' : 'New text artifact'}
          onCommitted={() => setReload((n) => n + 1)}
        />
      )}
      <Collection
        key={tab + reload}
        path={'/api/v1/areas/' + id + '/' + tab}
        render={(item) => <ResourceRow resource={item as ResourceView} />}
      />
      <details className="about" open={query.has('proposal')}>
        <summary>About this topic</summary>
        <p>{area?.description}</p>
        <Proposal context={context} areaId={id} />
        <TopicMetadataHistory id={id} />
      </details>
    </>
  );
}

function Proposal({ context, areaId }: { context: Context; areaId?: string }) {
  const chosen = new URLSearchParams(useLocation().search);
  const existing = context.store
    .all()
    .find(
      (r) =>
        r.kind === 'discussion.create' &&
        (chosen.has('intent')
          ? r.key === chosen.get('intent') && !!r.body.proposal_context
          : r.slot === 'proposal:' + (areaId ?? 'community')),
    );
  const [open, setOpen] = useState(chosen.has('proposal')),
    [destination, setDestination] = useState(existing?.body.area_id as string | undefined),
    [version, setVersion] = useState(
      (existing?.body.proposal_context as { expected_settings_version: number } | undefined)
        ?.expected_settings_version,
    );
  const affected = areaId ?? context.community.proposal_area.resource_id;
  const route = useQuery<ProposalRouteView>(
    affected ? `/api/v1/areas/${affected}/proposal-route` : '/api/v1/community',
    affected ? ProposalRoute : Onboarding,
  );
  const ready = affected && route.data?.state === 'ready';
  const contacts = route.data?.contacts ?? context.community.contacts;
  // A retained proposal supplies its original destination/settings even while
  // current routing is unavailable. This is a caller type boundary, not a rewrite
  // of the saved request or a fresh authority claim.
  const proposalArea = (destination ?? existing?.body.area_id) as string | undefined;
  const proposalVersion =
    version ??
    (existing?.body.proposal_context as { expected_settings_version: number } | undefined)
      ?.expected_settings_version;
  return (
    <>
      <p>
        For organization help, contact{' '}
        {contacts.map((p) => p.nickname).join(', ') || 'an administrator'}.{' '}
        <a href="/api/v1/contacts">Administrator contacts</a>
      </p>
      {route.error && <p role="alert">{route.error}</p>}
      {!ready && (
        <p role="status">
          Organizational proposals are currently unavailable or not configured. Keep your draft and
          contact an administrator.
        </p>
      )}
      <button
        className="text-button"
        disabled={!ready && !existing}
        onClick={() => {
          if (!open) {
            setDestination(
              (existing?.body.area_id as string) ?? route.data?.destination?.resource_id,
            );
            setVersion(
              (existing?.body.proposal_context as { expected_settings_version: number } | undefined)
                ?.expected_settings_version ?? route.data?.settings_version,
            );
          }
          setOpen((value) => !value);
        }}
      >
        Suggest an organizational change →
      </button>
      <button className="text-button" onClick={route.refresh}>
        Refresh proposal route
      </button>
      {/* A retained attempt keeps its original target even when fresh routing is unavailable. */}
      {open && (existing || ready) && proposalArea && (
        <Composer
          context={context}
          slot={'proposal:' + (areaId ?? 'community')}
          operation={{
            kind: 'discussion.create',
            areaId: proposalArea,
            proposal: {
              ...(areaId ? { affected_area_id: areaId } : {}),
              expected_settings_version: proposalVersion,
            },
          }}
          initialText={
            areaId
              ? `Proposal concerning [this topic](${location.origin}/loom/area/${areaId})\n\n`
              : ''
          }
          heading="Suggest an organizational change"
        />
      )}
    </>
  );
}

export function Overview({ context }: { context: Context }) {
  // The overview embeds a full artifact and its proposal form; both belong to
  // the same authorization lifetime, including uses outside the resource route.
  return (
    <AuthorizationBoundary scope="overview">
      <OverviewContent context={context} />
    </AuthorizationBoundary>
  );
}

function OverviewContent({ context }: { context: Context }) {
  const target = context.community.overview;
  if (target.state !== 'ready')
    return (
      <>
        <h1>Community overview</h1>
        <div className="notice">
          {target.state === 'setup_incomplete'
            ? 'The Community overview has not been configured.'
            : 'The Community overview is currently unavailable.'}
        </div>
        <Link to="/loom">Browse topics</Link>
        <Proposal context={context} />
      </>
    );
  return (
    <>
      <ResourceContent id={target.resource_id!} revision={undefined} context={context} />
      <section className="section">
        <Proposal context={context} />
      </section>
    </>
  );
}
