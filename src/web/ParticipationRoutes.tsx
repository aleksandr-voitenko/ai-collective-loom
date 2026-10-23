import { PromotionPage } from './AttachmentPromotion.js';
import { useLocation, Link } from 'react-router';
import { type ResourceView } from '../contracts/participation.js';
import { type Context } from './participation-state.js';
import { OrganizationPage } from './Organization.js';
import { SavedItemsPage } from './SavedItems.js';
import { NotificationsPage } from './Notifications.js';
import { FollowingPage } from './Following.js';
import { SharedChangesPage } from './SharedChanges.js';
import { AttentionPage } from './Attention.js';
import { AuthorizationBoundary } from './AuthorizationBoundary.js';
import { UpdatesPage } from './Updates.js';
import { ReadingPageViewComponent } from './Reading.js';
import { ModerationPage } from './Moderation.js';
import { SearchPageViewComponent } from './Search.js';
import { SummaryMaintenance } from './Summaries.js';
import { Collection, ResourceRow } from './participation-ui.js';
import { Administration } from './ParticipationAdministration.js';
import { DiscussionPage } from './ParticipationDiscussion.js';
import { Help } from './ParticipationHelp.js';
import { ResourcePage } from './ParticipationResource.js';
import { AreaPage, Overview, Topics } from './ParticipationTopics.js';

export function ActiveView({ context }: { context: Context }) {
  const location = useLocation(),
    kind = location.pathname.split('/')[2];
  // Attention pages already own their full-view or private-settings boundary.
  // The remaining routes must also provide a protected read capability.
  if (kind === 'admin' || kind === 'moderation' || kind === 'promote')
    return (
      <AuthorizationBoundary
        scope={kind === 'admin' ? 'administration' : kind}
        sourcePolicy="settings"
      >
        <RouteView context={context} />
      </AuthorizationBoundary>
    );
  if (
    [
      'attention',
      'notifications',
      'following',
      'updates',
      'area',
      'discussion',
      'resource',
      'overview',
      'saved',
    ].includes(kind ?? '')
  )
    return <RouteView context={context} />;
  return (
    <AuthorizationBoundary scope={'route:' + location.pathname}>
      <RouteView context={context} />
    </AuthorizationBoundary>
  );
}

function RouteView({ context }: { context: Context }) {
  const location = useLocation(),
    path = location.pathname.split('/').filter(Boolean).slice(1),
    kind = path[0],
    id = path[1];
  if (!kind) return <Topics context={context} />;
  if (kind === 'attention') return <AttentionPage context={context} />;
  if (kind === 'reading') return <ReadingPageViewComponent />;
  if (kind === 'promote') return <PromotionPage key={location.search} context={context} />;
  if (kind === 'moderation') return <ModerationPage key={location.search} context={context} />;
  if (kind === 'organize') return <OrganizationPage context={context} />;
  if (kind === 'saved') return <SavedItemsPage context={context} />;
  if (kind === 'notifications') return <NotificationsPage context={context} />;
  if (kind === 'following') return <FollowingPage context={context} />;
  if (kind === 'updates') return <UpdatesPage context={context} />;
  if (kind === 'changes') return <SharedChangesPage context={context} />;
  if (kind === 'search') return <SearchPageViewComponent context={context} />;
  if (kind === 'summaries') return <SummaryMaintenance context={context} />;
  if (kind === 'area' && id) return <AreaPage id={id} context={context} />;
  if (kind === 'discussion' && id) return <DiscussionPage id={id} context={context} />;
  if (kind === 'resource' && id)
    return <ResourcePage id={id} revision={path[2]} context={context} />;
  if (kind === 'overview') return <Overview context={context} />;
  if (kind === 'artifacts')
    return (
      <>
        <h1>Artifacts</h1>
        <p className="subtitle">Published text, preserved across revisions.</p>
        <Collection
          path="/api/v1/artifacts"
          render={(item) => <ResourceRow resource={item as ResourceView} showLocation />}
        />
      </>
    );
  if (kind === 'admin')
    return context.self.role === 'administrator' ? (
      <Administration context={context} />
    ) : (
      <p role="alert">Administrator access is required.</p>
    );
  if (kind === 'help') return <Help context={context} />;
  return (
    <>
      <h1>Page unavailable</h1>
      <Link to="/loom">Browse topics</Link>
    </>
  );
}
