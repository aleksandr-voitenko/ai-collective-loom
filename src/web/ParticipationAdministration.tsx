import { OperationalHealth } from './OperationalHealth.js';
import { FileLimits } from './FileLimits.js';
import { ParticipationRates } from './ParticipationRates.js';
import { Navigate, Link, useLocation } from 'react-router';
import { type Context } from './participation-state.js';
import { FileTextAdministration } from './FileText.js';
import { Admission } from './ParticipationAdmission.js';
import { IdentityAuditBrowsing } from './AdministrationBrowsing.js';
import { CommunitySettings } from './CommunitySettings.js';
import { SearchAdministration } from './SearchAdministration.js';
import { administrationIntentPath } from './administration-navigation.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { CommunitySetup } from './CommunitySetup.js';

export function Administration({ context }: { context: Context }) {
  const authority = useAuthorization();
  return (
    <>
      {authority.getSnapshot().state === 'withdrawn' && (
        <div role="status" className="notice">
          <p>
            Administrator metadata was withdrawn. Your private drafts and exact recovery remain
            available. Refresh the affected section to check access again.
          </p>
          <button onClick={context.refreshCommunity}>Refresh administration</button>
        </div>
      )}
      <AdministrationPage context={context} />
    </>
  );
}

function AdministrationPage({ context }: { context: Context }) {
  const location = useLocation();
  if (context.self.role !== 'administrator')
    return <p role="alert">Administrator access is required.</p>;
  const path = location.pathname.replace(/\/$/, '');
  const chosen = new URLSearchParams(location.search).get('intent');
  if (path === '/loom/admin' && chosen) {
    const record = context.store.all().find((record) => record.key === chosen);
    const destination = record && administrationIntentPath(record);
    // Preserve the complete search/hash, including parameters unknown to this layout.
    if (destination) return <Navigate replace to={destination + location.search + location.hash} />;
    return (
      <>
        <h1>Recovery unavailable</h1>
        <p>This saved administration attempt could not be matched to a section.</p>
        <Link to="/loom/help">Inspect local drafts</Link>
      </>
    );
  }
  switch (path) {
    case '/loom/admin':
      return (
        <>
          <h1>Overview</h1>
          <OperationalHealth context={context} />
        </>
      );
    case '/loom/admin/community':
      return context.store
        .all()
        .some((record) => record.key === chosen && record.kind === 'community.setup') ? (
        <CommunitySetup context={context} />
      ) : (
        <CommunitySettings context={context} />
      );
    case '/loom/admin/participants':
      return (
        <>
          <h1>Participants</h1>
          <Admission context={context} />
        </>
      );
    case '/loom/admin/limits':
      return (
        <>
          <h1>Limits</h1>
          <ParticipationRates context={context} />
          <FileLimits context={context} />
        </>
      );
    case '/loom/admin/search':
      return <SearchAdministration context={context} />;
    case '/loom/admin/file-processing':
      return (
        <>
          <h1>File processing</h1>
          <FileTextAdministration context={context} />
        </>
      );
    case '/loom/admin/audit':
      return (
        <>
          <h1>Identity audit</h1>
          <IdentityAuditBrowsing self={context.self} />
        </>
      );
    default:
      return (
        <>
          <h1>Administration page unavailable</h1>
          <Link to="/loom/admin">Administration overview</Link>
        </>
      );
  }
}
