import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { act } from 'react';
import type {
  OrganizationPageView,
  OrganizationResourceView,
} from '../../src/contracts/organization.js';
import { contractVersion, guideRevision, limits } from '../../src/contracts/participation.js';
import { IntentStore } from '../../src/web/participation-client.js';
import type { Context } from '../../src/web/participation-state.js';

const locks = navigator.locks;

export function organizationContext(role: Context['self']['role']): Context {
  const participant = randomUUID(),
    instance = randomUUID();
  return {
    self: {
      participant_id: participant,
      credential_id: randomUUID(),
      nickname: role,
      kind: 'human',
      role,
    },
    community: {
      moderation_contract: 'moderation-state-1',
      moderation_url: '/api/v1/admin/moderation/targets',
      instance_id: instance,
      contract_version: contractVersion,
      guide_revision: guideRevision,
      profile: 'synthetic',
      community_name: 'Synthetic community',
      settings_version: 1,
      overview: { state: 'setup_incomplete' },
      proposal_area: { state: 'setup_incomplete' },
      contacts: [],
      contacts_url: '/api/v1/contacts',
      guide_url: '/api/v1/guide',
      openapi_url: '/api/v1/openapi.json',
      limits,
      replay_retention: 'retained_without_automatic_expiry; destructive_restore_unsupported',
      derived_effects: 'search_and_personal_direct_attention; other_projections_disabled',
      notification_contract: 'personal-attention-1',
      notifications_url: '/api/v1/me/notifications/query',
      following_contract: 'following-1',
      following_url: '/api/v1/me/following',
      attention_contract: 'attention-controls-1',
      attention_url: '/api/v1/me/attention/list',
      routine_updates_contract: 'combined-updates-2',
      routine_updates_url: '/api/v1/me/routine-updates/query',
      routine_updates_observation_url: '/api/v1/me/routine-updates/observe',
      reading_contract: 'reading-state-1',
      reading_url: '/api/v1/me/reading/lookup',
      updates_contract: 'combined-updates-1',
      updates_url: '/api/v1/me/updates/query',
      shared_changes_contract: 'shared-changes-1',
      shared_changes_url: '/api/v1/shared-changes/query',
    },
    store: new IntentStore(instance, participant, localStorage, location.origin, locks),
    refreshCommunity: () => {},
  };
}

export function topic(title: string, extra: Partial<OrganizationResourceView> = {}) {
  return {
    resource_id: randomUUID(),
    kind: 'area',
    parent_id: null,
    version: 1,
    hierarchy_version: 1,
    title,
    description: 'Synthetic topic scope',
    metadata_version: 1,
    local_open: true,
    publication_open: true,
    can_organize: false,
    ancestors: [],
    contacts_url: '/api/v1/contacts',
    proposal_route_url: '/api/v1/areas/proposal-route',
    ...extra,
  } satisfies OrganizationResourceView;
}

export function topicPage(
  items: OrganizationResourceView[],
  next: string | null = null,
  extra: Partial<OrganizationPageView> = {},
) {
  const parent = (extra.scope ?? 'children:root').split(':')[1];
  return Response.json({
    observation: {
      parent_id: !parent || parent === 'root' ? null : parent,
      directory_version: 0,
      hierarchy_version: extra.hierarchy_version ?? 1,
      inherited_closure: false,
    },
    items,
    next_cursor: next,
    hierarchy_version: 1,
    scope: 'children:root',
    complete: next === null,
    limit: 12,
    max_response_bytes: 65_536,
    work_budget_reached: items.length === 0 && next !== null,
    ...extra,
  } satisfies OrganizationPageView);
}

export function holdReads(t: TestContext) {
  const calls: { url: URL; signal: AbortSignal; respond: (response: Response) => void }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (path: string, options: RequestInit) =>
      new Promise<Response>((respond) => {
        calls.push({ url: new URL(path, location.origin), signal: options.signal!, respond });
      }),
  );
  function latest(path?: string) {
    const call = path ? calls.findLast(({ url }) => url.pathname === path) : calls.at(-1);
    assert.ok(call, `expected a request for ${path ?? 'the directory'}`);
    return call;
  }
  async function respond(response: Response, call = latest()) {
    await act(async () => call.respond(response));
  }
  return { calls, latest, respond };
}
