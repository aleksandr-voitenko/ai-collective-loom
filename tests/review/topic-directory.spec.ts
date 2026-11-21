import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  OrganizationPageView,
  OrganizationResourceView,
} from '../../src/contracts/organization.js';
import { api } from '../helpers/change-browser.js';
import { syntheticServer } from '../helpers/participation-server.js';
import {
  captureTopicDiscussions as captureDirectory,
  enrollReviewAccount,
  topicDirectoryReview,
} from '../helpers/topic-discussion-review.js';

const rootTopics = [
  ['Community gardens', 'Plan shared workdays, trade growing advice, and welcome new gardeners.'],
  ['Tool library', 'Coordinate tool loans, repairs, and safe storage.'],
  ['Neighborhood events', 'Plan seasonal gatherings, workshops, and open days.'],
  ['Bike workshops', 'Share repair advice and organize monthly maintenance sessions.'],
  ['Community kitchen', 'Plan shared meals and collect favorite recipes.'],
  ['Local history', 'Collect oral histories, photographs, and neighborhood stories.'],
  ['Accessibility', 'Help make neighborhood spaces and events easier to use.'],
  ['Outdoor learning', 'Share activities and resources for learning outside.'],
  ['Rainwater collection', 'Compare notes on water storage and irrigation.'],
  ['Waste reduction', 'Organize swaps and share ideas for reusing materials.'],
  ['Book exchange', 'Suggest reading lists and coordinate the neighborhood book swap.'],
  ['Community safety', 'Share local resources and plan practical training.'],
  ['Public art', 'Discuss mural projects and outdoor installations.'],
  ['Mutual aid', 'Offer practical support and coordinate volunteer schedules.'],
] as const;
const longTitle =
  'Volunteer schedules and supplies for the spring seed exchange and garden welcome day';
const longDescription =
  'Plan the spring seed exchange, coordinate the welcome-day schedule, and arrange supplies for the volunteer teams. Share accessibility requests and questions about borrowing tools. Confirm delivery locations and label the seeds, and tell the coordinators if you have a setup or cleanup request.';
const childTopics = [
  [longTitle, longDescription],
  ['Garden workdays', 'Organize shared work, swap shifts, and post supplies needed.'],
  ['Accessible raised beds', 'Plan bed layouts and make pathways easier to navigate.'],
  ['Seed library', 'Track locally adapted seeds and coordinate donations.'],
  ['New gardeners', 'Ask practical questions and share tips for getting started.'],
  ['Compost', 'Discuss turning schedules, food scraps, and compost health.'],
  ['Pollinators', 'Share ideas for keeping pollinator habitats healthy.'],
  ['Small-space growing', 'Trade tips for balconies, containers, and windowsills.'],
  ['Irrigation', 'Plan watering schedules and compare water-saving methods.'],
  ['Garden tools', 'Coordinate tool maintenance and group purchases.'],
  ['Fruit trees', 'Discuss pruning, seasonal care, and harvests.'],
  ['Garden signage', 'Plan wayfinding and clearly label shared spaces.'],
  ['Harvest sharing', 'Coordinate food donations and neighborhood exchanges.'],
] as const;

const childrenPath = '/api/v1/organization/children';
const changesPath = '/api/v1/organization/changes';

async function createTopic(
  page: Page,
  parent_id: string | null,
  title: string,
  description: string,
) {
  const { hierarchy_version } = await api(page, childrenPath + '?limit=1');
  const { current } = await api(page, changesPath, {
    idempotency_key: randomUUID(),
    kind: 'area.create',
    parent_id,
    title,
    description,
    expected_hierarchy_version: hierarchy_version,
  });
  return current as OrganizationResourceView;
}

async function arrangeTopics(
  page: Page,
  parent: string | null,
  topics: readonly (readonly [string, string])[],
) {
  // Assign the titles in the real server's ID order to make the comparison repeatable.
  const resources = [];
  for (const [title, description] of topics)
    resources.push(await createTopic(page, parent, title, description));
  let version = resources.at(-1)!.hierarchy_version;
  resources.sort((a, b) => a.resource_id.localeCompare(b.resource_id));
  for (const [index, [title, description]] of topics.entries()) {
    const resource = resources[index]!;
    if (resource.title === title) continue;
    const { current } = await api(page, changesPath, {
      idempotency_key: randomUUID(),
      kind: 'area.edit',
      resource_id: resource.resource_id,
      title,
      description,
      expected_version: resource.version,
      expected_hierarchy_version: version,
    });
    resources[index] = current as OrganizationResourceView;
    version = current.hierarchy_version;
  }
  return resources;
}

test('ordinary topic directory review captures', async ({ browser, page: admin }) => {
  test.skip(!['before', 'after'].includes(topicDirectoryReview ?? ''), 'Opt-in review capture');
  const phase = topicDirectoryReview === 'before' ? 'before' : 'after';
  const server = await syntheticServer({ workloadRates: true });
  const participantContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await enrollReviewAccount(admin, server.origin, server.ticket, true);
    await admin.getByRole('button', { name: 'Create community', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    const roots = await arrangeTopics(admin, null, rootTopics);
    const gardens = roots[0]!,
      toolLibrary = roots[1]!;
    await arrangeTopics(admin, gardens.resource_id, childTopics);
    const closed = (await api(
      admin,
      `/api/v1/organization/resources/${toolLibrary.resource_id}`,
    )) as OrganizationResourceView;
    await api(admin, changesPath, {
      idempotency_key: randomUUID(),
      kind: 'area.close',
      resource_id: closed.resource_id,
      expected_version: closed.version,
      expected_hierarchy_version: closed.hierarchy_version,
    });
    const person = await api(admin, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname: 'GardenVolunteer',
      kind: 'human',
      role: 'participant',
    });
    const ticket = await api(admin, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: person.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Topic directory review participant',
      replace_credential_id: null,
    });
    const page = await participantContext.newPage();
    await enrollReviewAccount(page, server.origin, ticket.secret);
    const options = { review: 'directory', role: 'participant' } as const;
    expect((await api(page, '/api/v1/identity/self')).role).toBe(options.role);

    const topics = page.getByRole('region', { name: 'Root topics', exact: true });
    const title = page.getByRole('heading', { name: 'Topics', exact: true });
    const gardenLink = topics.getByRole('link', { name: gardens.title, exact: true });
    const closedLink = topics.getByRole('link', { name: closed.title, exact: true });
    await expect(closedLink).toBeVisible();
    const first = (await api(page, childrenPath)) as OrganizationPageView;
    expect(first.items).toHaveLength(12);
    expect(first.next_cursor).toBeTruthy();
    await expect(topics.getByRole('link')).toHaveText(first.items.map((item) => item.title));
    await captureDirectory(page, `${phase}-root-topics`, gardenLink, {
      ...options,
      scroll: 'top',
      visibleInViewport: [title, gardenLink, closedLink],
    });

    if (phase === 'after') {
      const next = (await api(
        page,
        `${childrenPath}?cursor=${encodeURIComponent(first.next_cursor!)}`,
      )) as OrganizationPageView;
      expect(next.complete).toBe(true);
      expect(next.items.length).toBeGreaterThan(0);
      const more = topics.getByRole('button', { name: 'Load more topics', exact: true });
      const priorTail = topics.getByRole('link', { name: first.items.at(-1)!.title, exact: true });
      await captureDirectory(page, 'after-root-topics-continuation', more, {
        ...options,
        desktopTop: 850,
        mobileTop: 700,
        visibleInViewport: [priorTail, more],
      });
      await more.click();
      await expect(topics.getByRole('link')).toHaveText(
        [...first.items, ...next.items].map((item) => item.title),
      );
      const end = topics.getByText('All topics loaded.', { exact: true });
      await expect(end).toBeVisible();
      await captureDirectory(page, 'after-root-topics-completed', end, {
        ...options,
        desktopTop: 850,
        mobileTop: 700,
        visibleInViewport: [
          priorTail,
          topics.getByRole('link', { name: next.items[0]!.title, exact: true }),
          end,
        ],
      });
    }

    await page.goto(`${server.origin}/loom/area/${gardens.resource_id}`);
    const selected = page.getByRole('heading', { name: gardens.title, exact: true });
    const summary = page.locator('summary').filter({ hasText: /^Subtopics$/ });
    const subtopics = page.getByRole('region', { name: 'Subtopics', exact: true });
    const longLink = subtopics.getByRole('link', { name: longTitle, exact: true });
    await expect(longLink).toBeHidden();
    await summary.click();
    await expect(longLink).toBeVisible();
    await captureDirectory(page, `${phase}-expanded-subtopics`, longLink, {
      ...options,
      scroll: 'top',
      visibleInViewport: [selected, summary, longLink],
    });
    if (phase === 'before') return;

    await createTopic(admin, null, 'Neighborhood repair day', 'Plan its date and volunteers.');
    const more = subtopics.getByRole('button', { name: 'Load more subtopics', exact: true });
    await more.click();
    const alert = subtopics.getByRole('alert');
    const reload = subtopics.getByRole('button', { name: 'Reload subtopics', exact: true });
    const priorTail = subtopics.getByRole('link', { name: childTopics[11][0], exact: true });
    await expect(alert).toContainText(/needs refreshing/i);
    await expect(subtopics.getByRole('link')).toHaveText(
      childTopics.slice(0, 12).map(([name]) => name),
    );
    await captureDirectory(page, 'after-subtopics-invalid-continuation', alert, {
      ...options,
      desktopTop: 785,
      mobileTop: 650,
      visibleInViewport: [priorTail, reload, alert],
    });
    await reload.click();
    await more.click();
    await expect(subtopics.getByRole('link')).toHaveText(childTopics.map(([name]) => name));

    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    // Check the mirrored layout after capturing the application's default direction.
    expect(
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
        return document.documentElement.scrollWidth;
      }),
    ).toBe(320);
  } finally {
    await participantContext.close();
    await admin.context().close();
    await server.close();
  }
});
