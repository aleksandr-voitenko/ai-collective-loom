import { randomUUID } from 'node:crypto';
import type { Locator, Page, Route } from '@playwright/test';
import { expect } from './browser-fixtures.js';
import { api } from './change-browser.js';
import {
  captureTopicDiscussions,
  directoryFreshnessReview,
  enrollReviewAccount,
} from './topic-discussion-review.js';
import type { OrganizationResourceView } from '../../src/contracts/organization.js';

const collection = '/api/v1/organization/children';
const changes = '/api/v1/organization/changes';
type Viewport = 'desktop' | 'mobile';
const top = (row: Locator) => row.evaluate((node) => node.getBoundingClientRect().top);
const reference = (row: Locator) => row.getAttribute('data-topic-id') as Promise<string>;

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function editTopic(admin: Page, id: string, title: string, description?: string) {
  const current = await api(admin, '/api/v1/organization/resources/' + id);
  await api(admin, changes, {
    idempotency_key: randomUUID(),
    kind: 'area.edit',
    resource_id: id,
    title,
    description: description ?? current.description,
    expected_version: current.version,
    expected_hierarchy_version: current.hierarchy_version,
  });
}

async function fixtures(admin: Page) {
  let { hierarchy_version: version } = await api(admin, collection + '?limit=1');
  const create = async (title: string, description: string, parent_id: string | null = null) => {
    const result = await api(admin, changes, {
      idempotency_key: randomUUID(),
      kind: 'area.create',
      parent_id,
      title,
      description,
      expected_hierarchy_version: version,
    });
    const resource: OrganizationResourceView = result.current;
    version = resource.hierarchy_version;
    return resource.resource_id;
  };
  const gardens = await create(
    'Community gardens',
    'Plan workdays, share seeds and welcome new gardeners.',
  );
  const child = await create(
    'Seed library',
    'Coordinate seed donations and spring planting.',
    gardens,
  );
  for (const neighborhood of ['Riverside', 'Hillcrest', 'Brookside', 'Parkside', 'Southbank']) {
    for (const [name, description] of [
      ['gardening', 'Share growing advice and arrange volunteer workdays.'],
      ['bike workshops', 'Trade repair tips and plan the next workshop.'],
      ['book exchange', 'Suggest titles and coordinate the neighborhood book swap.'],
      ['tool library', 'Arrange loans and keep the shared tools in good repair.'],
      ['community kitchen', 'Plan shared meals and exchange favorite recipes.'],
      ['walking group', 'Find accessible routes and arrange meetups.'],
      ['local history', 'Collect photographs, oral histories and neighborhood stories.'],
    ] as const)
      await create(neighborhood + ' ' + name, description);
  }
  return { gardens, child };
}

async function rootJourney(page: Page, admin: Page, origin: string, viewport: Viewport) {
  const root = page.getByRole('region', { name: 'Root topics' });
  const links = root.getByRole('link');
  const more = root.getByRole('button', { name: 'Load more topics', exact: true });
  const apply = root.getByRole('button', { name: 'Show updated topics', exact: true });
  const capture = { review: 'directory-freshness', role: 'participant', viewport } as const;
  await page.goto(origin + '/loom');
  await expect(links).toHaveCount(12);
  for (const count of [24, 36]) {
    await more.click();
    await expect(links).toHaveCount(count);
  }
  if (directoryFreshnessReview === 'before') {
    await captureTopicDiscussions(page, 'before-root-topics', links.first(), {
      ...capture,
      scroll: 'top',
      description:
        'Unchanged main build. Three pages loaded, before automatic directory discovery was added.',
    });
    return;
  }
  // After scrolling down the list, reverse Tab can land on a link within the
  // viewport that is completely covered by the sticky update controls.
  const previous = links.nth(7);
  await links.nth(8).focus();
  await previous.evaluate((node) =>
    window.scrollBy({ top: node.getBoundingClientRect().top - 10, behavior: 'instant' }),
  );
  const linkIsExposed = () =>
    previous.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.contains(
        document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
      );
    });
  expect(Math.abs((await top(previous)) - 10)).toBeLessThanOrEqual(2);
  await page.keyboard.press('Shift+Tab');
  await expect(previous).toBeFocused();
  expect(await linkIsExposed()).toBe(true);
  const original = await links.allTextContents();
  // Change a row well above the reading position. Keeping a narrow viewport
  // offset is meaningful only when the anchor actually moves in the document.
  const earlierIndex = original.findIndex((title) =>
    /^(Riverside|Hillcrest|Brookside|Parkside|Southbank) /.test(title),
  );
  expect(earlierIndex).toBeGreaterThanOrEqual(0);
  expect(earlierIndex).toBeLessThan(20);
  const earlierRow = root.getByRole('listitem').nth(earlierIndex);
  const earlierLink = links.nth(earlierIndex);
  const earlierDescription = earlierRow.locator('p');
  const originalDescription = await earlierDescription.innerText();
  const description =
    viewport === 'mobile'
      ? 'Meet your neighbors.'
      : 'Meet neighbors at the community center on Saturday morning to plan volunteer shifts, share supplies and arrange accessible transport for the next neighborhood event.';
  const originalHeight = await earlierRow.evaluate((node) => node.getBoundingClientRect().height);
  const anchor = links.nth(28);
  const id = await reference(anchor);
  const anchorNode = await anchor.elementHandle();
  await anchor.focus();
  await anchor.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  const anchorTop = await top(anchor);
  const edited =
    original[28]!.replace(/ · Spring$/, '') + (viewport === 'desktop' ? ' · Spring' : ' · Autumn');
  await editTopic(admin, await reference(earlierLink), original[earlierIndex]!, description);
  await editTopic(admin, id, edited);
  await page.clock.fastForward(15_001);
  await expect(root.getByText('Topics updated', { exact: true })).toBeVisible();
  await expect(links).toHaveText(original);
  await expect(earlierDescription).toHaveText(originalDescription);
  await expect(anchor).toBeFocused();
  expect(Math.abs((await top(anchor)) - anchorTop)).toBeLessThanOrEqual(2);
  await captureTopicDiscussions(page, 'root-pending', apply, {
    ...capture,
    scroll: 'top',
    visibleInViewport: [apply, links.first()],
    description:
      'A second authenticated participant edited two loaded topics. The reader retains all three pages while Topics updated offers explicit application.',
  });

  const shownOffset = await top(anchor);
  const shownDocumentTop = shownOffset + (await page.evaluate(() => scrollY));
  const entered = signal(),
    release = signal();
  let pages = 0;
  const rootRead = (url: URL) => url.pathname === collection && !url.searchParams.has('parent_id');
  // Hold the last real authorized page, after its transaction has completed.
  await page.route(rootRead, async (route) => {
    if (++pages !== 3) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    entered.release();
    await release.promise;
    await route.fulfill({ response });
  });
  const raced =
    original[0]!.replace(/ · Revised$/, '') +
    (viewport === 'desktop' ? ' · Revised' : ' · Updated');
  try {
    await apply.click();
    await entered.promise;
    await expect(links).toHaveText(original);
    await editTopic(admin, await reference(links.first()), raced);
    release.release();
    const replaced = original.with(28, edited);
    await expect(links).toHaveText(replaced);
    await expect(earlierDescription).toContainText(description.slice(0, 120));
    expect(await anchor.evaluate((node, prior) => node === prior, anchorNode)).toBe(true);
    const appliedOffset = await top(anchor);
    const appliedDocumentTop = appliedOffset + (await page.evaluate(() => scrollY));
    const heightChange =
      (await earlierRow.evaluate((node) => node.getBoundingClientRect().height)) - originalHeight;
    expect(Math.abs(heightChange)).toBeGreaterThan(15);
    expect(Math.abs(appliedDocumentTop - shownDocumentTop - heightChange)).toBeLessThanOrEqual(2);
    expect(Math.abs(appliedOffset - shownOffset)).toBeLessThanOrEqual(5);
    await expect(root.getByText('Showing the updated list.', { exact: true })).toBeVisible();
    await expect(apply).toBeFocused();
    await captureTopicDiscussions(page, 'multi-page-position-applied', anchor, {
      ...capture,
      scroll: 'preserve',
      visibleInViewport: [anchor],
      description: `After rebuilding 36 topics, row 29 (“${edited}”) is at ${Math.round(appliedOffset)} pixels from the viewport top. Before application it was at ${Math.round(shownOffset)} pixels. The edited description above it moved the row ${Math.round(Math.abs(heightChange))} pixels in the document.`,
      injected: [
        'The third real replacement page was held after its read while the administrator edited a second topic. No response content was altered.',
      ],
    });
    await page.clock.fastForward(15_001);
    await expect(root.getByText('Topics updated', { exact: true })).toBeVisible();
    await expect(links.first()).toHaveText(original[0]!);
    await apply.click();
    await expect(links).toHaveText(replaced.with(0, raced));
  } finally {
    release.release();
    await page.unroute(rootRead);
  }
  await more.click();
  await expect(links.nth(36)).toBeVisible();
  const extent = await links.allTextContents();
  const opened = links.nth(36);
  await opened.focus();
  await opened.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  const offset = await top(opened);
  await opened.press('Enter');
  await expect(page.getByRole('heading', { name: extent[36]!, exact: true })).toBeVisible();
  await page.goBack();
  await expect(links).toHaveText(extent);
  await expect(opened).toBeFocused();
  expect(Math.abs((await top(opened)) - offset)).toBeLessThanOrEqual(24);
}

async function readDirectoryPositions(page: Page, row: Locator, editor: Locator) {
  const original = page.viewportSize()!;
  const scroll = await page.evaluate(() => scrollY);
  const results = [];
  try {
    // At 768px the sidebar occupies space that belongs to the list on narrower screens.
    for (const width of [320, 768]) {
      await page.setViewportSize({ width, height: original.height });
      const positions = await Promise.all(
        [row, editor].map((item) =>
          item.evaluate((node) => node.getBoundingClientRect().top + scrollY),
        ),
      );
      results.push({ width, row: positions[0], editor: positions[1] });
    }
  } finally {
    await page.setViewportSize(original);
    await page.evaluate((y) => window.scrollTo(0, y), scroll);
  }
  return results;
}

async function childJourney(
  page: Page,
  admin: Page,
  origin: string,
  gardens: string,
  child: string,
  viewport: Viewport,
) {
  await page.goto(origin + '/loom/area/' + gardens);
  const summary = (name: string) =>
    page.locator('summary').filter({ hasText: new RegExp('^' + name + '$') });
  const subtopics = summary('Subtopics');
  const directory = page.getByRole('region', { name: 'Subtopics', exact: true });
  const row = directory.getByRole('link');
  const apply = directory.getByRole('button', { name: 'Show updated subtopics' });
  const retry = directory.getByRole('button', { name: 'Retry updating subtopics' });
  await subtopics.press('Enter');
  await expect(row).toHaveCount(1);
  const previous = await row.innerText();
  const capture = { review: 'directory-freshness', role: 'participant', viewport } as const;
  const editorRegion = page.getByRole('region', { name: 'Start a discussion', exact: true });
  const editor = editorRegion.getByLabel('Text', { exact: true });
  const title = editorRegion.getByLabel('Title', { exact: true });
  const settings = [
    ['Follow settings', 'Include subtopics'],
    ['Routine attention', 'Mute descendant topics'],
  ] as const;
  for (const [section, label] of settings) {
    await summary(section).click();
    await page.getByRole('checkbox', { name: label, exact: true }).check();
    await summary(section).click();
  }
  const about = summary('About this topic');
  await about.press('Enter');
  await page
    .getByRole('button', { name: 'Suggest an organizational change →', exact: true })
    .click();
  const proposal = page
    .getByRole('region', { name: 'Suggest an organizational change' })
    .getByLabel('Text', { exact: true });
  const proposed = 'Could we add seed collection times to this topic’s description?';
  await proposal.fill(proposed);
  const proposalNode = await proposal.elementHandle();
  await about.click();
  await page.getByRole('button', { name: 'Start a discussion', exact: true }).click();
  const draft = 'I can bring envelopes and labels for the seed exchange. What else do we need?';
  await title.fill('Planning the next seed swap');
  await editor.fill(draft);
  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 21));
  const editorNode = await editor.elementHandle();
  const quiet = await readDirectoryPositions(page, row, editor);
  const editorTop = await top(editor);
  const showDraft = async (
    state: string,
    target: Locator,
    description: string,
    injected?: string[],
  ) =>
    captureTopicDiscussions(page, state, subtopics, {
      ...capture,
      desktopTop: 115,
      mobileTop: 60,
      visibleInViewport: [target, editor],
      description,
      ...(injected ? { injected } : {}),
    });
  if (directoryFreshnessReview === 'before') {
    await showDraft(
      'before-subtopics',
      subtopics,
      'Unchanged main build. A reader has expanded Subtopics and started a discussion draft.',
    );
    return;
  }
  const renamed = viewport === 'desktop' ? 'Spring seed library' : 'Autumn seed library';
  const checks: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === collection + '/observation' &&
      url.searchParams.get('parent_id') === gardens
    )
      checks.push(url.href);
  });
  const discussionNotice = page
    .getByRole('region', { name: 'Topic discussions' })
    .getByText('New discussions available', { exact: true });
  await api(admin, '/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: gardens,
    title: 'Garden workday · ' + viewport,
    content: {
      format: 'loom-markdown-v1',
      text: 'Please bring a trowel to the garden workday.',
      mentions: [],
    },
  });
  await editTopic(admin, child, renamed);
  await page.clock.fastForward(15_001);
  await expect(directory.getByText('Subtopics updated', { exact: true })).toBeVisible();
  await expect(row).toHaveText(previous);
  await expect(discussionNotice).toBeVisible();
  await expect(editor).toBeFocused();
  expect(Math.abs((await top(editor)) - editorTop)).toBeLessThanOrEqual(2);
  const selection = () =>
    editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]);
  expect(await selection()).toEqual([6, 21]);
  await showDraft(
    'subtopics-pending-draft',
    apply,
    'A directory update is pending. The original subtopic and nearby unsent discussion remain visible.',
  );
  await subtopics.click();
  await expect(directory).toBeHidden();
  const checksBeforePause = checks.length;
  await page.clock.fastForward(30_001);
  expect(checks.length).toBe(checksBeforePause);
  expect(checksBeforePause).toBeGreaterThan(0);
  await subtopics.press('Space');
  await expect.poll(() => checks.length).toBe(checksBeforePause + 1);
  await expect(directory.getByText('Subtopics updated', { exact: true })).toBeVisible();
  const childRead = (url: URL) =>
    url.pathname === collection && url.searchParams.get('parent_id') === gardens;
  const failRead = (route: Route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'temporarily_unavailable',
          request_id: randomUUID(),
          message: 'Temporary service interruption',
          recovery: { action: 'retry_same_request' },
        },
      },
    });
  await page.route(childRead, failRead, { times: 1 });
  await apply.click();
  await expect(retry).toBeVisible();
  await expect(row).toHaveText(previous);
  await expect(editor).toHaveValue(draft);
  await showDraft(
    'subtopics-failed-retry',
    retry,
    'The update attempt failed. The accepted subtopic, retry action and draft are retained.',
    [
      'The first explicit directory replacement returned one synthetic HTTP 503. The retry reached the real authorized API.',
    ],
  );
  await page.route(
    (url) =>
      url.pathname === collection + '/observation' && url.searchParams.get('parent_id') === gardens,
    failRead,
    { times: 1 },
  );
  await page.clock.fastForward(15_001);
  await expect(
    directory.getByText('Couldn’t check for updates. Retrying…', { exact: true }),
  ).toBeVisible();
  await expect(retry).toBeVisible();
  expect(await readDirectoryPositions(page, row, editor)).toEqual(quiet);
  const entered = signal(),
    release = signal();
  await page.route(
    childRead,
    async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      entered.release();
      await release.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  try {
    await retry.click();
    await entered.promise;
    await editor.focus();
    const offset = await top(editor);
    release.release();
    await expect(row).toHaveText(renamed);
    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node, prior) => node === prior, editorNode)).toBe(true);
    expect(await selection()).toEqual([6, 21]);
    expect(Math.abs((await top(editor)) - offset)).toBeLessThanOrEqual(2);
    await expect(editor).toHaveValue(draft);
    await expect(discussionNotice).toBeVisible();
    await expect(about.locator('..')).not.toHaveAttribute('open', '');
    await about.press('Enter');
    await expect(proposal).toHaveValue(proposed);
    expect(await proposal.evaluate((node, prior) => node === prior, proposalNode)).toBe(true);
    for (const [section, label] of settings) {
      await expect(summary(section).locator('..')).not.toHaveAttribute('open', '');
      await summary(section).click();
      await expect(page.getByRole('checkbox', { name: label, exact: true })).toBeChecked();
    }
    await expect(page.getByRole('button', { name: 'Discussions', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  } finally {
    release.release();
  }
}

export async function checkDirectoryDiscovery(admin: Page, page: Page, origin: string) {
  const { gardens, child } = await fixtures(admin);
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
    label: 'Directory reader',
    replace_credential_id: null,
  });
  await enrollReviewAccount(page, origin, ticket.secret);
  expect((await api(page, '/api/v1/identity/self')).role).toBe('participant');
  await page.clock.install();
  const viewports: Viewport[] = directoryFreshnessReview ? ['desktop', 'mobile'] : ['desktop'];
  for (const viewport of viewports) {
    await page.setViewportSize(
      viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 },
    );
    await rootJourney(page, admin, origin, viewport);
    await childJourney(page, admin, origin, gardens, child, viewport);
  }
}
