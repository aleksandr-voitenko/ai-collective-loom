import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as C from '../contracts/participation.js';
import * as A from '../contracts/attention.js';
import * as F from '../contracts/following.js';
import * as P from '../contracts/private-controls.js';
import * as S from '../contracts/saved-items.js';
import * as R from '../contracts/reading.js';
import * as O from '../contracts/organization.js';
import * as N from '../contracts/notifications.js';
import * as U from '../contracts/updates.js';
import * as V from '../contracts/routine-updates.js';
import * as Ref from '../contracts/references.js';
import * as Sum from '../contracts/summaries.js';
import * as Search from '../contracts/search.js';
import { PromotionProvenance } from '../contracts/files.js';
import * as M from '../contracts/moderation.js';
import * as Notes from '../contracts/notes.js';
import * as Intent from '../contracts/reservations.js';
import { ApiError } from './request-context.js';

type Access = 'public' | 'session' | 'read' | 'private-read' | 'receipt' | 'boundary-receipt';
type Preview = 'follow' | 'follow-page' | 'mute' | 'attention-list' | 'previews';
type ErrorPolicy = {
  session: 'unrelated' | 'discovery' | 'authenticated';
  forbidden: 'retain' | 'withdraw';
  unavailable: 'retain' | 'withdraw';
};
export type ErrorEffects = {
  session: 'retain' | 'anonymous' | 'revoke';
  content: 'retain' | 'withdraw';
};
const unrelatedErrors: ErrorPolicy = {
  session: 'unrelated',
  forbidden: 'retain',
  unavailable: 'retain',
};
const discoveryErrors: ErrorPolicy = {
  session: 'discovery',
  forbidden: 'retain',
  unavailable: 'retain',
};
const identityErrors: ErrorPolicy = {
  session: 'authenticated',
  forbidden: 'withdraw',
  unavailable: 'retain',
};
const sourceErrors: ErrorPolicy = {
  session: 'authenticated',
  forbidden: 'withdraw',
  unavailable: 'withdraw',
};
const privateIntentErrors: ErrorPolicy = {
  session: 'authenticated',
  forbidden: 'retain',
  unavailable: 'retain',
};
// These constructors require only source readability and open publication. Role
// and editor-dependent commands use sourceErrors: refusal can invalidate other
// cached representations guarded by that same capability.
const postingErrors: ErrorPolicy = {
  session: 'authenticated',
  forbidden: 'retain',
  unavailable: 'withdraw',
};
type Rule =
  | { kind: 'affirmed'; reason: string }
  | {
      kind: 'classified';
      schema: TSchema;
      source: readonly string[];
      local: Readonly<Record<string, string>>;
    };
export type ResponseContract = {
  access: Access;
  errors: ErrorPolicy;
  rule: Rule;
  revisionMiss: boolean;
  publicationClosureRefusal?: boolean;
  preview?: Preview;
  publicationClosure?: 'proposal_area.state' | 'state';
  lifecycleReceipt?: boolean;
};
export const responseContracts = new Map<string, ResponseContract>();
const affirmed = (reason: string): Rule => ({ kind: 'affirmed', reason });
const classified = (
  schema: TSchema,
  source: readonly string[],
  local: Record<string, string> = {},
): Rule => ({ kind: 'classified', schema, source, local });
function add(
  routes: readonly string[],
  access: Access,
  errors: ErrorPolicy,
  rule: Rule,
  options: {
    revisionMiss?: boolean;
    publicationClosureRefusal?: boolean;
    preview?: Preview;
    publicationClosure?: 'proposal_area.state' | 'state';
    lifecycleReceipt?: boolean;
  } = {},
) {
  for (const route of routes) {
    if (responseContracts.has(route))
      throw new Error('Duplicate response classification: ' + route);
    responseContracts.set(route, {
      access,
      errors,
      rule,
      revisionMiss: options.revisionMiss ?? false,
      ...options,
    });
  }
}

// This catalogue is closed by method and endpoint, independently of a caller's
// optional validation schema. The contract test compares it with actual routes
// and requires an explicit meaning for every unavailable field in each response.
add(
  ['GET /health/live', 'GET /health/ready', 'GET /api/v1/runtime', 'GET /api/v1/openapi.json'],
  'public',
  unrelatedErrors,
  affirmed('Operational capability/readiness, not source authorization.'),
);
// Discovery may find no session; ceremonies validate a separate proof. Neither
// absence says that an already anonymous browser has lost current authority.
add(
  ['GET /api/v1/identity/self'],
  'session',
  discoveryErrors,
  affirmed('Discovery establishes the current authenticated session.'),
);
add(
  [
    'POST /api/v1/identity/register/start',
    'POST /api/v1/identity/register/finish',
    'POST /api/v1/identity/signin/start',
    'POST /api/v1/identity/signin/finish',
  ],
  'session',
  unrelatedErrors,
  affirmed('Separate enrollment/sign-in proof, not current-session authority.'),
);
add(
  ['POST /api/v1/identity/logout'],
  'session',
  identityErrors,
  affirmed('Revokes the authenticated current session.'),
);
add(
  ['GET /api/v1/community'],
  'session',
  sourceErrors,
  classified(C.Onboarding, ['overview.state', 'proposal_area.state']),
  { publicationClosure: 'proposal_area.state' },
);
add(
  [
    'POST /api/v1/identity/accounts',
    'POST /api/v1/identity/credentials',
    'POST /api/v1/identity/state',
    'POST /api/v1/identity/rename',
    'POST /api/v1/identity/revoke',
    'POST /api/v1/identity/reconcile',
  ],
  'receipt',
  identityErrors,
  affirmed(
    'Private identity outcome; action refusal and a missing identity record do not revoke the session.',
  ),
);
add(
  [
    'POST /api/v1/discussions',
    'POST /api/v1/replies',
    'POST /api/v1/artifacts',
    'POST /api/v1/attachment-promotions',
    'POST /api/v1/summaries',
    'POST /api/v1/operations/status',
    'POST /api/v1/summaries/status',
    'POST /api/v1/summary-preparations/cleanup',
  ],
  'receipt',
  postingErrors,
  affirmed(
    'Private operation outcome/IDs; ordinary posting closure does not revoke identity or reading permission.',
  ),
);
add(
  ['POST /api/v1/revisions', 'POST /api/v1/summary-revisions'],
  'receipt',
  sourceErrors,
  affirmed(
    'Revision outcome; certified closure preserves reads, while editor refusal withdraws protected content.',
  ),
  { publicationClosureRefusal: true },
);
add(
  [
    'POST /api/v1/community/setup',
    'POST /api/v1/community/settings',
    'POST /api/v1/editors',
    'POST /api/v1/summaries/editors',
    'POST /api/v1/admin/search/retry',
    'POST /api/v1/admin/search/rebuild',
    'POST /api/v1/admin/notifications/retry',
    'POST /api/v1/admin/notifications/reconcile',
  ],
  'receipt',
  sourceErrors,
  affirmed(
    'Private operation outcome; a role/editor refusal withdraws protected content without replacing the journal owner.',
  ),
);
add(
  [
    'GET /api/v1/identity/accounts',
    'GET /api/v1/identity/credentials',
    'GET /api/v1/identity/audit',
  ],
  'read',
  identityErrors,
  affirmed('Current identity administration; unavailable identifies an identity record.'),
);
add(
  [
    'GET /api/v1/guide',
    'GET /api/v1/resources/{id}/editors',
    'GET /api/v1/discussions/{id}',
    'GET /api/v1/areas/{id}',
    'GET /api/v1/organization/children',
    'GET /api/v1/organization/destinations',
    'GET /api/v1/organization/resources/{id}',
    'GET /api/v1/areas/{id}/metadata-history',
    'GET /api/v1/organization/audit',
    'GET /api/v1/search/authors',
    'GET /api/v1/admin/search/health',
    'GET /api/v1/admin/search/failures',
    'GET /api/v1/admin/notifications/health',
    'GET /api/v1/admin/notifications/failures',
    'GET /api/v1/references/target',
    'GET /api/v1/resources/{id}/revisions/{revision}/change-note',
    'GET /api/v1/resources/{id}/revisions/{revision}/change-coverage',
    'GET /api/v1/changes',
    'GET /api/v1/summary-preparations/{id}',
    'GET /api/v1/summary-preparations/{id}/members',
    'GET /api/v1/discussions/{id}/summary-sources',
    'GET /api/v1/summaries/{id}/revisions/{revision}/coverage',
    'GET /api/v1/summaries/{id}/revisions/{revision}/members',
    'GET /api/v1/summaries/{id}/revisions/{revision}/sources',
    'GET /api/v1/summaries/maintenance',
  ],
  'read',
  sourceErrors,
  affirmed(
    'Successful response authorizes its returned representation; omitted or unknown members make no access claim.',
  ),
);
add(
  ['POST /api/v1/summary-preparations'],
  'read',
  sourceErrors,
  affirmed('Prepared source declaration; certified closure alone does not revoke reading.'),
  { publicationClosureRefusal: true },
);
add(
  ['GET /api/v1/resources/{id}', 'GET /api/v1/resources/{id}/revisions/{revision}'],
  'read',
  sourceErrors,
  affirmed(
    'Guarded current/exact revision; only its explicit error hint certifies a revision-only miss.',
  ),
  { revisionMiss: true },
);
add(
  ['GET /api/v1/search/status'],
  'read',
  sourceErrors,
  classified(Search.SearchStatus, [], {
    indexing: 'Worker/index state is not a source access decision.',
  }),
);
add(
  ['GET /api/v1/search'],
  'read',
  sourceErrors,
  classified(Search.SearchPage, [], {
    'indexing.indexing': 'Worker/index state is not a source access decision.',
  }),
);
add(
  ['GET /api/v1/areas/{id}/proposal-route'],
  'read',
  sourceErrors,
  classified(O.ProposalRoute, ['state']),
  { publicationClosure: 'state' },
);
add(
  ['GET /api/v1/discussions/{id}/summary'],
  'read',
  sourceErrors,
  classified(Sum.SummaryLookup, ['state']),
);
add(
  ['GET /api/v1/contributions/{id}/context'],
  'read',
  sourceErrors,
  classified(C.ContributionContext, ['state']),
);
add(
  [
    'GET /api/v1/artifacts',
    'GET /api/v1/areas',
    'GET /api/v1/participants',
    'GET /api/v1/contacts',
    'GET /api/v1/areas/{id}/discussions',
    'GET /api/v1/areas/{id}/artifacts',
    'GET /api/v1/contributions/{id}/children',
    'GET /api/v1/contributions/{id}/ancestors',
    'GET /api/v1/resources/{id}/history',
  ],
  'read',
  sourceErrors,
  classified(C.Page, ['items[].state']),
);
add(
  ['GET /api/v1/references/incoming', 'GET /api/v1/resources/{id}/revisions/{revision}/references'],
  'read',
  sourceErrors,
  classified(Ref.ReferencePage, ['items[].target.state']),
);
add(
  ['GET /api/v1/me/saved-items'],
  'read',
  sourceErrors,
  classified(S.SavedPage, ['items[].source.state']),
);
add(
  ['POST /api/v1/me/saved-items/lookup'],
  'read',
  sourceErrors,
  classified(S.SavedItem, ['source.state']),
);
add(
  ['POST /api/v1/me/saved-items/state', 'POST /api/v1/me/saved-items/status'],
  'boundary-receipt',
  sourceErrors,
  classified(S.SavedStatus, ['current.source.state']),
);
add(
  ['POST /api/v1/me/reading/lookup'],
  'read',
  sourceErrors,
  classified(R.ReadingPage, ['items[].availability']),
);
add(
  ['POST /api/v1/me/reading/state', 'POST /api/v1/me/reading/status'],
  'receipt',
  sourceErrors,
  classified(R.ReadingStatus, ['current[].availability']),
);
add(
  ['POST /api/v1/organization/changes', 'POST /api/v1/organization/status'],
  'boundary-receipt',
  sourceErrors,
  affirmed(
    'Private outcome plus current authorized location; metadata retains a separate content lease.',
  ),
);
add(
  [
    'GET /api/v1/admin/moderation/resources/{id}',
    'GET /api/v1/admin/moderation/targets',
    'GET /api/v1/admin/moderation/audit',
  ],
  'read',
  identityErrors,
  affirmed(
    'Administrator-only lifecycle metadata; ordinary_read_available is a control fact, never content-read authority.',
  ),
);
add(
  ['POST /api/v1/admin/moderation/state', 'POST /api/v1/admin/moderation/status'],
  'boundary-receipt',
  identityErrors,
  classified(M.ModerationStatus, []),
  { lifecycleReceipt: true },
);
add(
  ['GET /api/v1/editing-intent/resources/{id}'],
  'read',
  sourceErrors,
  affirmed(
    'Only currently eligible resource and exact-base metadata is returned. Temporal state is not authority.',
  ),
);
add(
  ['POST /api/v1/editing-intent/announce', 'POST /api/v1/editing-intent/renew'],
  'boundary-receipt',
  sourceErrors,
  classified(Intent.IntentStatus, []),
);
add(
  ['POST /api/v1/editing-intent/release', 'POST /api/v1/editing-intent/status'],
  'boundary-receipt',
  privateIntentErrors,
  classified(Intent.IntentStatus, []),
);

add(
  [
    'GET /api/v1/me/following/private',
    'POST /api/v1/me/following/private/lookup',
    'POST /api/v1/me/attention/private/mutes/lookup',
    'POST /api/v1/me/attention/private/dismissals/lookup',
    'POST /api/v1/me/attention/private/list',
  ],
  'private-read',
  identityErrors,
  affirmed('Owner-private identities/settings; sources are never hydrated.'),
);
add(
  [
    'POST /api/v1/me/following/private/state',
    'POST /api/v1/me/following/private/status',
    'POST /api/v1/me/attention/private/mutes/state',
    'POST /api/v1/me/attention/private/dismissals/state',
    'POST /api/v1/me/attention/private/status',
  ],
  'boundary-receipt',
  sourceErrors,
  affirmed('Owner-private receipt; sources are never hydrated.'),
);
add(
  ['GET /api/v1/me/following'],
  'read',
  sourceErrors,
  classified(F.FollowPage, ['items[].source.state']),
  { preview: 'follow-page' },
);
add(
  ['POST /api/v1/me/following/lookup'],
  'read',
  sourceErrors,
  classified(F.FollowItem, ['source.state']),
  { preview: 'follow' },
);
add(
  ['POST /api/v1/me/following/state', 'POST /api/v1/me/following/status'],
  'boundary-receipt',
  sourceErrors,
  classified(F.FollowStatus, ['current.source.state']),
);
add(
  ['POST /api/v1/me/attention/previews'],
  'read',
  sourceErrors,
  classified(P.PreviewPage, ['items[].source.state']),
  { preview: 'previews' },
);
add(
  ['POST /api/v1/me/attention/mutes/lookup'],
  'read',
  sourceErrors,
  classified(A.MuteItem, ['source.state']),
  { preview: 'mute' },
);
add(
  ['POST /api/v1/me/attention/list'],
  'read',
  sourceErrors,
  classified(A.AttentionList, ['mutes[].source.state', 'dismissals[].availability']),
  { preview: 'attention-list' },
);
add(
  ['POST /api/v1/me/attention/dismissals/lookup'],
  'read',
  sourceErrors,
  classified(A.DismissPage, ['items[].availability']),
);
add(
  ['POST /api/v1/me/routine-updates/selection'],
  'read',
  sourceErrors,
  classified(A.AttentionSelection, ['inputs[].availability']),
);
add(
  [
    'POST /api/v1/me/attention/mutes/state',
    'POST /api/v1/me/attention/dismissals/state',
    'POST /api/v1/me/attention/status',
  ],
  'boundary-receipt',
  sourceErrors,
  classified(A.AttentionStatus, ['current.source.state', 'current[].availability']),
);

const currentRevision =
  'The exact source and containment were authorized; this field only describes its distinct current revision (PersonalNotifications.item).';
add(
  ['POST /api/v1/me/notifications/query'],
  'read',
  sourceErrors,
  classified(N.NotificationPage, ['items[].parent.state'], {
    'items[].current.state': currentRevision,
  }),
);
add(
  ['GET /api/v1/me/notifications/{id}'],
  'read',
  sourceErrors,
  classified(N.NotificationItem, ['parent.state'], { 'current.state': currentRevision }),
);
add(
  ['POST /api/v1/shared-changes/query'],
  'read',
  sourceErrors,
  classified(F.SharedPage, ['items[].current.state']),
);
add(
  [
    'POST /api/v1/shared-changes/detail',
    'POST /api/v1/me/updates/reasons',
    'POST /api/v1/me/routine-updates/reasons',
  ],
  'read',
  sourceErrors,
  classified(F.SharedItem, ['current.state']),
);
const memberDenials = ['source.current.state', 'personal.parent.state'];
const memberLocal = { 'personal.current.state': currentRevision };
add(
  ['POST /api/v1/me/updates/members'],
  'read',
  sourceErrors,
  classified(
    U.UpdatesMembersPage,
    memberDenials.map((p) => 'items[].' + p),
    Object.fromEntries(Object.entries(memberLocal).map(([p, r]) => ['items[].' + p, r])),
  ),
);
add(
  ['POST /api/v1/me/routine-updates/members'],
  'read',
  sourceErrors,
  classified(
    V.RoutineMembersPage,
    memberDenials.map((p) => 'items[].' + p),
    Object.fromEntries(Object.entries(memberLocal).map(([p, r]) => ['items[].' + p, r])),
  ),
);
const groupDenials = [
  'items[].current.state',
  ...memberDenials.map((p) => 'items[].direct_sources[].' + p),
];
const groupLocal = Object.fromEntries(
  Object.entries(memberLocal).map(([p, r]) => ['items[].direct_sources[].' + p, r]),
);
add(
  ['POST /api/v1/me/updates/query'],
  'read',
  sourceErrors,
  classified(U.UpdatesPage, groupDenials, groupLocal),
);
add(
  ['POST /api/v1/me/routine-updates/query'],
  'read',
  sourceErrors,
  classified(V.RoutinePage, groupDenials, groupLocal),
);

add(
  [
    'POST /api/v1/file-uploads',
    'POST /api/v1/file-uploads/{id}/bytes',
    'POST /api/v1/file-uploads/{id}/finalize',
  ],
  'receipt',
  sourceErrors,
  affirmed('Owner-private upload custody; it never authorizes source content.'),
  { publicationClosureRefusal: true },
);
add(
  ['POST /api/v1/file-uploads/status', 'POST /api/v1/file-uploads/cleanup'],
  'receipt',
  identityErrors,
  affirmed('Owner-private status and cleanup; sources are never hydrated.'),
);
add(
  ['GET /api/v1/file-uploads/{id}'],
  'private-read',
  identityErrors,
  affirmed('Owner-private upload custody with no source metadata.'),
);
add(
  [
    'GET /api/v1/artifacts/{id}/revisions/{revision}/files',
    'GET /api/v1/artifacts/{id}/revisions/{revision}/files/{file}/download',
  ],
  'read',
  sourceErrors,
  affirmed('Exact contextual files under current resource and revision authority.'),
);

add(
  [
    'GET /api/v1/contributions/{id}/revisions/{revision}/attachments',
    'GET /api/v1/contributions/{id}/revisions/{revision}/attachments/{file}',
    'GET /api/v1/contributions/{id}/revisions/{revision}/attachments/{file}/download',
  ],
  'read',
  sourceErrors,
  affirmed(
    'Exact contribution-owned attachment metadata and passive native bytes require current contextual authorization.',
  ),
);
add(
  ['GET /api/v1/artifacts/{id}/revisions/{revision}/provenance'],
  'read',
  sourceErrors,
  classified(PromotionProvenance, ['source.state']),
);

add(
  [
    'GET /api/v1/search/files',
    'GET /api/v1/search/files/status',
    'GET /api/v1/admin/file-text/health',
    'GET /api/v1/artifacts/{id}/revisions/{revision}/files/{file}/text',
    'GET /api/v1/artifacts/{id}/revisions/{revision}/files/{file}/text/status',
    'GET /api/v1/contributions/{id}/revisions/{revision}/attachments/{file}/text',
    'GET /api/v1/contributions/{id}/revisions/{revision}/attachments/{file}/text/status',
  ],
  'read',
  sourceErrors,
  affirmed(
    'Current exact file authority precedes all derivative metadata and text; processing health never denotes source authority.',
  ),
);
add(
  ['POST /api/v1/admin/file-text/retry', 'POST /api/v1/admin/file-text/rebuild'],
  'receipt',
  sourceErrors,
  affirmed('Administrator derived-work maintenance never authorizes source content.'),
);

add(
  ['GET /api/v1/me/notes/{id}', 'POST /api/v1/me/notes/query'],
  'private-read',
  privateIntentErrors,
  affirmed('Current independently owned private note content; no shared source projection.'),
);
add(
  ['POST /api/v1/me/notes/create', 'POST /api/v1/me/notes/update'],
  'receipt',
  sourceErrors,
  affirmed('Content-free private note outcome; new links require current source authority.'),
);
add(
  ['POST /api/v1/me/notes/delete', 'POST /api/v1/me/notes/status'],
  'receipt',
  privateIntentErrors,
  affirmed('Content-free owner-only note outcome, independent of linked sources.'),
);
add(
  ['GET /api/v1/me/notes/{id}/sources'],
  'read',
  privateIntentErrors,
  classified(Notes.NoteSources, ['items[].source.state']),
);

const matchers = [...responseContracts].map(([route, contract]) => ({
  route,
  contract,
  pattern: new RegExp(
    '^' +
      route
        .split(/(\{\w+\})/)
        .map((part) =>
          /^\{\w+\}$/.test(part) ? '[^/?#]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('') +
      '$',
  ),
}));
export function responseContract(path: string, method: 'GET' | 'POST') {
  // Match only a same-origin relative endpoint. Do not normalize URL or command bytes.
  const route = method + ' ' + path.split('?')[0];
  const match = matchers.find((entry) => entry.pattern.test(route));
  if (!match)
    throw new Error('This endpoint has no authorization boundary response classification.');
  return match.contract;
}
export function classifyError(contract: ResponseContract, error: ApiError): ErrorEffects {
  const policy = contract.errors;
  // Session identity, content authority and journal settlement are independent.
  // Proof/input/action failures cannot replace the private journal owner.
  if (['unauthenticated', 'invalid_actor'].includes(error.code)) {
    switch (policy.session) {
      case 'unrelated':
        return { session: 'retain', content: 'retain' };
      case 'discovery':
        return { session: 'anonymous', content: 'retain' };
      case 'authenticated':
        return { session: 'revoke', content: 'withdraw' };
    }
  }
  if (
    contract.publicationClosureRefusal &&
    error.code === 'forbidden' &&
    error.forbiddenReason === 'publication_closed'
  )
    return { session: 'retain', content: 'retain' };
  const content =
    error.code === 'forbidden'
      ? policy.forbidden
      : error.code === 'unavailable' &&
          !(contract.revisionMiss && error.unavailableScope === 'revision')
        ? policy.unavailable
        : 'retain';
  return { session: 'retain', content };
}

function values(value: unknown, path: string): unknown[] {
  let current: unknown[] = [value];
  for (const part of path.split('.')) {
    const many = part.endsWith('[]'),
      key = many ? part.slice(0, -2) : part;
    current = current.flatMap((item) => {
      const child =
        item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined;
      return many ? (Array.isArray(child) ? child : []) : [child];
    });
  }
  return current;
}
export function classifyResponse(contract: ResponseContract, value: unknown) {
  const rule = contract.rule;
  if (rule.kind === 'classified' && !Value.Check(rule.schema, value))
    throw new ApiError(
      'unsupported_contract',
      'This response does not match its endpoint contract.',
    );
  const denied =
    !!(
      contract.lifecycleReceipt &&
      value &&
      typeof value === 'object' &&
      'operation_state' in value &&
      value.operation_state === 'recorded'
    ) ||
    (rule.kind === 'classified' &&
      rule.source.some(
        (path) =>
          values(value, path).includes('unavailable') &&
          // The server supplies this hint only after checking source ownership/read
          // access. Missing hints retain the conservative legacy interpretation.
          !(
            path === contract.publicationClosure &&
            values(value, path.replace(/state$/, 'unavailable_reason')).includes(
              'publication_closed',
            )
          ),
      ));
  let previews: P.PreviewItemView[] = [];
  const preview = (
    item: F.FollowItemView | A.MuteItemView | P.PreviewItemView,
  ): P.PreviewItemView => ({
    target: item.target,
    source: item.source,
    other_current_scope_mutes:
      'other_current_scope_mutes' in item ? item.other_current_scope_mutes : [],
  });
  switch (contract.preview) {
    case 'follow':
      previews = [preview(value as F.FollowItemView)];
      break;
    case 'mute':
      previews = [preview(value as A.MuteItemView)];
      break;
    case 'follow-page':
      previews = (value as F.FollowPageView).items.map(preview);
      break;
    case 'attention-list':
      previews = (value as A.AttentionListView).mutes.map(preview);
      break;
    case 'previews':
      previews = (value as P.PreviewPageView).items;
      break;
    case undefined:
      break;
  }
  return { denied, previews };
}
