import { expect, test, type Locator, type Page } from '@playwright/test';
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
  topicReturnReview,
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

async function openLaterTopic(directory: Locator, noun: string, pages: number, index: number) {
  const links = directory.getByRole('link');
  await expect(links).toHaveCount(12);
  for (let i = 1; i < pages; i++) {
    await directory.getByRole('button', { name: `Load more ${noun}`, exact: true }).click();
    await expect(links.nth(i * 12)).toBeVisible();
  }
  const extent = await links.count();
  const anchor = links.nth(index);
  const title = await anchor.innerText();
  const href = (await anchor.getAttribute('href'))!;
  await anchor.focus();
  const offset = await anchor.evaluate((link) => {
    scrollBy(0, link.getBoundingClientRect().top - innerHeight / 2);
    return link.getBoundingClientRect().top;
  });
  await anchor.press('Enter');
  await expect(directory.page().getByRole('heading', { name: title, exact: true })).toBeVisible();
  return { title, href, extent, offset };
}

async function captureDirectoryReturns(page: Page, admin: Page, origin: string, gardenId: string) {
  const before = topicReturnReview === 'before';
  const root = page.getByRole('region', { name: 'Root topics', exact: true });
  const subtopics = page.getByRole('region', { name: 'Subtopics', exact: true });
  const summary = page.locator('summary').filter({ hasText: /^Subtopics$/ });
  const gardenPath = `/loom/area/${gardenId}`;
  const phase = before ? 'before' : 'after';
  for (const viewport of ['desktop', 'mobile'] as const) {
    await page.setViewportSize(
      viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
    );
    const options = {
      review: 'returns',
      role: 'participant',
      viewport,
      scroll: 'preserve',
    } as const;
    for (const child of [false, true]) {
      const directory = child ? subtopics : root;
      const noun = child ? 'subtopics' : 'topics';
      await page.goto(origin + (child ? gardenPath : '/loom'));
      if (child) await summary.click();
      const visit = await openLaterTopic(directory, noun, 3, child ? 24 : 30);
      const anchor = directory.getByRole('link', { name: visit.title, exact: true });
      await page.goBack();
      const beforeDescription = child
        ? 'Back returned to the parent with Subtopics collapsed.'
        : 'Back returned to the first 12 root topics.';
      if (child) {
        await expect(page.getByText('No discussions yet.', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Follow', exact: true })).toBeEnabled();
      }
      if (before) {
        await expect(anchor).toHaveCount(0);
        if (child) {
          await expect(summary).toBeVisible();
          await expect(summary.locator('..')).not.toHaveAttribute('open', '');
        } else await expect(directory.getByRole('link')).toHaveCount(12);
      } else {
        await expect(directory.getByRole('link')).toHaveCount(visit.extent);
        await expect(anchor).toBeFocused();
        await expect(anchor).toBeInViewport();
        expect(Math.abs((await anchor.boundingBox())!.y - visit.offset)).toBeLessThan(25);
      }
      await captureDirectory(
        page,
        `${phase}-back-to-${noun}`,
        before ? (child ? summary : root) : anchor,
        {
          ...options,
          visibleInViewport: before ? [] : [anchor],
          description: before
            ? `Opened “${visit.title}” from ${visit.extent} loaded ${noun}. ${beforeDescription}`
            : `Back recovered ${visit.extent} ${noun}${child ? ' and reopened Subtopics' : ''}. The activated link “${visit.title}” has focus at ${Math.round((await anchor.boundingBox())!.y)} px from the top, previously ${Math.round(visit.offset)} px.`,
        },
      );
    }
    if (before) continue;

    await page.goto(origin + '/loom');
    await openLaterTopic(root, 'topics', 9, 100);
    await page.goBack();
    const more = root.getByRole('button', { name: 'Continue restoring topics', exact: true });
    await expect(more).toBeInViewport();
    await expect(root.getByRole('link')).toHaveCount(96);
    await captureDirectory(page, 'after-eight-pages', more, {
      ...options,
      visibleInViewport: [more, root.getByRole('status')],
      description:
        'Back accepted eight fresh pages (96 topics) of the previous nine-page extent. The local continuation recovers the remaining page.',
    });
    await more.click();
    await expect(root.getByRole('link')).toHaveCount(108);

    await page.goto(origin + gardenPath);
    await summary.click();
    const visit = await openLaterTopic(subtopics, 'subtopics', 3, 24);
    const resourcePath = '/api/v1/organization/resources/' + visit.href.split('/').at(-1);
    const move = async (parent_id: string | null) => {
      const source = (await api(admin, resourcePath)) as OrganizationResourceView;
      await api(admin, changesPath, {
        kind: 'area.move',
        resource_id: source.resource_id,
        expected_version: source.version,
        expected_hierarchy_version: source.hierarchy_version,
        idempotency_key: randomUUID(),
        parent_id,
      });
    };
    await move(null);
    await page.goBack();
    const status = subtopics.getByRole('status');
    await expect(status).toContainText(/previous place is no longer/i);
    await expect(subtopics.getByRole('link', { name: visit.title, exact: true })).toHaveCount(0);
    await expect(subtopics.getByRole('link')).toHaveCount(visit.extent - 1);
    await captureDirectory(page, 'after-subtopic-moved', status, {
      ...options,
      visibleInViewport: [status],
      description: `An administrator moved “${visit.title}” to the root through the organization API while the participant was away. Back reopened Subtopics and reached the current end with ${visit.extent - 1} entries and a local explanation.`,
    });
    await move(gardenId);
  }
}

test('ordinary topic directory review captures', async ({ browser, page: admin }) => {
  const returns = ['before', 'after'].includes(topicReturnReview ?? '');
  test.skip(
    !returns && !['before', 'after'].includes(topicDirectoryReview ?? ''),
    'Opt-in review capture',
  );
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
    const neighborhoods = [
      'Riverside',
      'Oak Hill',
      'Parkside',
      'East End',
      'Southbank',
      'Brookside',
      'Hillcrest',
    ];
    const roots = await arrangeTopics(
      admin,
      null,
      returns
        ? [
            ...rootTopics,
            ...neighborhoods.flatMap((area) =>
              rootTopics.map(([title, text]) => [`${area} ${title.toLowerCase()}`, text] as const),
            ),
          ]
        : rootTopics,
    );
    const gardens = roots[0]!,
      toolLibrary = roots[1]!;
    await arrangeTopics(
      admin,
      gardens.resource_id,
      returns ? [...childTopics, ...rootTopics] : childTopics,
    );
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
    if (returns) {
      await captureDirectoryReturns(page, admin, server.origin, gardens.resource_id);
      return;
    }

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
