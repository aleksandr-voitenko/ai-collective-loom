import { OperationalHealth } from './OperationalHealth.js';
import { FileLimits } from './FileLimits.js';
import { ParticipationRates } from './ParticipationRates.js';
import { Link } from 'react-router';
import { type Context } from './participation-state.js';
import { useAuthorization } from './AuthorizationBoundary.js';
import { FileTextAdministration } from './FileText.js';
import { Admission } from './ParticipationAdmission.js';
import { IdentityAuditBrowsing } from './AdministrationBrowsing.js';

export function Administration({ context }: { context: Context }) {
  const authority = useAuthorization();
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
      <section className="panel">
        <h2>
          <Link to="/loom/admin/community">Community settings</Link>
        </h2>
        <p>Choose the community overview and where proposals are posted.</p>
      </section>
      <OperationalHealth context={context} />
      <ParticipationRates context={context} />
      <FileLimits context={context} />
      <section className="panel">
        <h2>
          <Link to="/loom/admin/search">Search indexing</Link>
        </h2>
        <p>Inspect shared-text indexing, failed jobs and maintenance requests.</p>
      </section>
      <FileTextAdministration context={context} />
      <Admission context={context} />
      <IdentityAuditBrowsing self={context.self} />
    </>
  );
}
