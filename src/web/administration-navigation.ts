import type { Intent } from './participation-client.js';

export const administrationSections = [
  { path: '/loom/admin', label: 'Overview', icon: 'topic' },
  { path: '/loom/admin/community', label: 'Community', icon: 'discussion' },
  { path: '/loom/admin/participants', label: 'Participants', icon: 'discussion' },
  { path: '/loom/admin/limits', label: 'Limits', icon: 'saved' },
  { path: '/loom/admin/search', label: 'Search indexing', icon: 'search' },
  { path: '/loom/admin/file-processing', label: 'File processing', icon: 'artifact' },
  { path: '/loom/admin/audit', label: 'Identity audit', icon: 'artifact' },
] as const;

/** Unknown operations keep their original recovery URL for explicit review. */
export function administrationIntentPath(record: Intent) {
  switch (record.kind) {
    case 'community.setup':
    case 'community.settings':
      return '/loom/admin/community';
    case 'account.create':
    case 'credential.issue':
      return '/loom/admin/participants';
    case 'participation.rates':
    case 'file.policy':
      return '/loom/admin/limits';
    default:
      return undefined;
  }
}
