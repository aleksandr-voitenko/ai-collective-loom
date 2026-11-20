import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api } from '../helpers/change-browser.js';
import { syntheticServer } from '../helpers/participation-server.js';
import { captureTopicDiscussions, topicLayoutReview } from '../helpers/topic-discussion-review.js';

const topicTitle = 'Community gardens';
const firstDiscussion = 'What should we plant this season?';
const longTitle =
  'Volunteer schedules and materials for the neighborhood seed exchange and community garden welcome day';
const description =
  'A place to swap growing advice, plan shared workdays, and welcome new gardeners.';
const longDescription =
  'Plan the neighborhood seed exchange, review the welcome-day schedule, and coordinate supplies with the volunteer teams. Share accessibility requests, questions about borrowing tools, and suggestions for future events with the garden coordinators.';

async function enter(page: Page, origin: string, ticket: string, setup = false) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(origin + '/loom');
  await page.getByText('Set up an admitted account', { exact: true }).click();
  await page.getByLabel('Enrollment ticket', { exact: true }).fill(ticket);
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(
    page.getByRole('heading', { name: setup ? 'Set up your community' : 'Topics', exact: true }),
  ).toBeVisible();
}

async function createTopic(page: Page, parent_id: string, title: string, description: string) {
  const version = (await api(page, '/api/v1/organization/children?limit=1')).hierarchy_version;
  const result = await api(page, '/api/v1/organization/changes', {
    idempotency_key: randomUUID(),
    kind: 'area.create',
    parent_id,
    title,
    description,
    expected_hierarchy_version: version,
  });
  return result.current.resource_id as string;
}

async function publish(page: Page, area_id: string, title: string) {
  await api(page, '/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id,
    title,
    content: {
      format: 'loom-markdown-v1',
      text: 'Share your ideas with the gardeners.',
      mentions: [],
    },
  });
}

async function closeTopic(page: Page, resource_id: string) {
  const area = await api(page, '/api/v1/organization/resources/' + resource_id);
  await api(page, '/api/v1/organization/changes', {
    idempotency_key: randomUUID(),
    kind: 'area.close',
    resource_id,
    expected_version: area.version,
    expected_hierarchy_version: area.hierarchy_version,
  });
}

test('selected topic review captures', async ({ browser, page: admin }) => {
  test.skip(!['before', 'after'].includes(topicLayoutReview ?? ''), 'Opt-in review capture');
  const before = topicLayoutReview === 'before';
  const server = await syntheticServer({ workloadRates: true });
  const participantContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    await enter(admin, server.origin, server.ticket, true);
    await admin.getByRole('button', { name: 'Create community', exact: true }).click();
    await expect(admin.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    const { items } = await api(admin, '/api/v1/areas');
    const general = items.find((item: { title: string }) => item.title === 'General').id;
    const proposals = items.find(
      (item: { title: string }) => item.title === 'Community organization',
    ).id;
    const topic = await createTopic(admin, general, topicTitle, description);
    const longTopic = await createTopic(admin, topic, longTitle, longDescription);
    await publish(admin, longTopic, 'Making the welcome day easier to join');
    const person = await api(admin, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname: 'GardenWorkshopFacilitator',
      kind: 'human',
      role: 'participant',
    });
    const ticket = await api(admin, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: person.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Topic layout review participant',
      replace_credential_id: null,
    });
    const page = await participantContext.newPage();
    await enter(page, server.origin, ticket.secret);
    const participant = { review: 'layout', role: 'participant' } as const;
    expect((await api(page, '/api/v1/identity/self')).role).toBe(participant.role);
    await publish(admin, topic, 'When is the next volunteer workday?');
    await publish(page, topic, 'Share your favorite tools for small spaces');
    await publish(page, topic, firstDiscussion);

    const url = server.origin + '/loom/area/' + topic;
    await page.goto(url, { waitUntil: 'networkidle' });
    const heading = page.getByRole('heading', { name: topicTitle, exact: true });
    const start = page.getByRole('button', { name: 'Start a discussion', exact: true });
    const tabs = page.getByRole('group', { name: 'Topic content' });
    const first = page.getByRole('link', { name: firstDiscussion, exact: true });
    await expect(page.getByRole('button', { name: 'Follow', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Title', { exact: true })).toHaveCount(0);
    await expect(first).toBeVisible();
    await captureTopicDiscussions(
      page,
      before ? 'before-participant' : 'after-participant',
      heading,
      {
        ...participant,
        scroll: 'top',
        visibleInViewport: before ? [heading, start] : [heading, start, tabs, first],
      },
    );
    if (before) return;

    const signOut = await page.getByRole('button', { name: 'Sign out', exact: true }).boundingBox();
    const sidebar = await page.locator('.sidebar').boundingBox();
    expect(signOut!.x + signOut!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);

    await admin.goto(url, { waitUntil: 'networkidle' });
    const administrator = { review: 'layout', role: 'administrator' } as const;
    expect((await api(admin, '/api/v1/identity/self')).role).toBe(administrator.role);
    await admin.getByText('Manage topic', { exact: true }).click();
    const manage = admin.getByRole('link', { name: 'Create subtopic', exact: true });
    await expect(manage).toBeVisible();
    await captureTopicDiscussions(admin, 'after-administrator-manage', manage, {
      ...administrator,
      scroll: 'top',
      viewport: 'desktop',
      visibleInViewport: [manage],
    });

    await start.click();
    await page.getByLabel('Title', { exact: true }).fill('Seed catalog for the welcome day');
    const draft = page.getByLabel('Text', { exact: true });
    const draftBody =
      'I am collecting varieties that grow well in small spaces. What has worked for you?';
    await draft.fill(draftBody);
    await publish(admin, topic, 'Seed donations are ready to collect');
    const notice = page.getByText('New discussions available', { exact: true });
    await expect(notice).toBeVisible({ timeout: 24000 });
    await expect(draft).toHaveValue(draftBody);
    await captureTopicDiscussions(page, 'after-dirty-draft-with-pending-update', notice, {
      ...participant,
      desktopTop: 855,
      viewport: 'desktop',
      visibleInViewport: [draft, notice],
    });

    await page.goto(url);
    await page.getByText('About this topic', { exact: true }).click();
    await page.getByRole('button', { name: /Suggest an organizational change/ }).click();
    const proposalTitle = 'A separate topic for the annual seed exchange';
    await page.getByLabel('Title', { exact: true }).fill(proposalTitle);
    await page
      .getByLabel('Text', { exact: true })
      .fill('Keep planning and updates together for volunteers.');
    const readProposalKey = () =>
      page.evaluate(
        (title) =>
          Object.entries(localStorage)
            .filter(([key]) => key.startsWith('loom.intent.v1:'))
            .map(([, value]) => JSON.parse(value))
            .find((record) => record.body.title === title)?.key as string | undefined,
        proposalTitle,
      );
    await expect.poll(readProposalKey).toBeTruthy();
    const intent = (await readProposalKey())!;
    await closeTopic(admin, proposals);
    await page.goto(url + '?proposal=1&intent=' + intent, { waitUntil: 'networkidle' });
    const recovery = page.getByText(/Keep your draft and contact an administrator/);
    await expect(recovery).toBeVisible();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(proposalTitle);
    await captureTopicDiscussions(page, 'after-about-with-retained-proposal', recovery, {
      ...participant,
      scroll: 'top',
      viewport: 'desktop',
      visibleInViewport: [recovery, page.getByLabel('Title', { exact: true })],
    });

    await closeTopic(admin, topic);
    await page.goto(server.origin + '/loom/area/' + longTopic, { waitUntil: 'networkidle' });
    const child = page.getByRole('heading', { name: longTitle, exact: true });
    await expect(start).toBeDisabled();
    const ancestor = page.getByText(/Closed to contributions.*ancestor/i);
    await expect(ancestor).toBeVisible();
    await captureTopicDiscussions(page, 'after-long-title-with-inherited-closure', child, {
      ...participant,
      scroll: 'top',
      viewport: 'mobile',
      visibleInViewport: [child, ancestor],
    });
    await page.setViewportSize({ width: 320, height: 844 });
    const ancestry = page.getByRole('navigation', { name: 'Topic ancestry' });
    for (const link of await ancestry.getByRole('link').all()) {
      const bounds = await link.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(24);
      expect(bounds?.height).toBeGreaterThanOrEqual(24);
    }
    const readFull = page.getByRole('button', { name: 'Read full description', exact: true });
    await readFull.press('Enter');
    await expect(page.getByText(longDescription, { exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    await participantContext.close();
    await admin.context().close();
    await server.close();
  }
});
