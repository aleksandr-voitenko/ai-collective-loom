import { type Page, type BrowserContext, type CDPSession, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import type { syntheticServer } from '../helpers/participation-server.js';
import { test, expect } from '../helpers/browser-fixtures.js';
import { httpClient } from '../helpers/participation-http.js';
import { admissionReview } from '../helpers/admission-review.js';
import { adminNavigationReview } from '../helpers/admin-navigation-review.js';
import { uxHighReview } from '../helpers/ux-high-review.js';
import { captureMessaging } from '../helpers/messaging-review.js';
import { captureMentionSelection } from '../helpers/mention-selection-review.js';
import { captureContinuousDiscussion } from '../helpers/continuous-discussion-review.js';
import { captureConfirmedReply } from '../helpers/confirmed-reply-review.js';
import { publicationJournalBytes } from '../helpers/publication-journal-snapshot.js';

const authenticators = new WeakMap<Page, { cdp: CDPSession; id: string }>();
async function authenticator(page: Page, context: BrowserContext) {
  const previous = authenticators.get(page);
  if (previous)
    await previous.cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: previous.id,
    });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const result = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  authenticators.set(page, { cdp, id: result.authenticatorId });
  return cdp;
}
async function enter(
  page: Page,
  context: BrowserContext,
  origin: string,
  ticket: string,
  initialSetup = false,
) {
  await authenticator(page, context);
  await page.goto(origin + '/loom');
  await page.getByText('Set up an admitted account', { exact: true }).click();
  await page.getByLabel('Enrollment ticket', { exact: true }).fill(ticket);
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(
    page.getByRole('heading', {
      name: initialSetup ? 'Set up your community' : 'Topics',
      exact: true,
    }),
  ).toBeVisible();
}
async function setup(page: Page) {
  await page.getByRole('button', { name: 'Create community', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Community', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Participants', exact: true }).click();
}
async function backToLoom(page: Page) {
  const back = page.getByRole('link', { name: /Back to Loom/ });
  if (await back.isVisible()) await back.click();
}
async function createDiscussion(
  page: Page,
  title = 'Reading the actual context',
  reviewMessaging = false,
) {
  await backToLoom(page);
  await page.getByRole('link', { name: 'Topics', exact: true }).first().click();
  await page.getByRole('link').filter({ hasText: 'General' }).first().click();
  await page.getByRole('button', { name: 'Start a discussion' }).click();
  if (reviewMessaging) await expect(page.getByLabel('Title', { exact: true })).toBeFocused();
  const another = page.getByRole('button', {
    name: 'Write another',
    exact: true,
  });
  if (await another.isVisible()) await another.click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page
    .getByLabel('Text', { exact: true })
    .fill('A **shared question** with `<script>` as ordinary text.');
  if (reviewMessaging) {
    const input = page.getByLabel('Text', { exact: true });
    await input.fill(
      'A **shared question** with `<script>` as ordinary text.\n\n> A quoted ending',
    );
    await input.press('ControlOrMeta+End');
    await page.getByRole('button', { name: 'Mention a participant', exact: true }).click();
    await page.getByRole('button', { name: '@lyra', exact: true }).click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(/> A quoted ending\n\n@lyra/);
    const withMention = await input.inputValue();
    await input.press('ControlOrMeta+z');
    await expect(input).not.toHaveValue(/@lyra/);
    await input.press('ControlOrMeta+Shift+z');
    await expect(input).toHaveValue(withMention);
    await input.press('ControlOrMeta+End');
    await input.press('Backspace');
    await expect(
      page.getByRole('button', { name: 'Remove mention @lyra', exact: true }),
    ).toHaveCount(0);
    await input.press('ControlOrMeta+z');
    await expect(input).toHaveValue(withMention);
    await expect(
      page.getByRole('button', { name: 'Remove mention @lyra', exact: true }),
    ).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(page.url()).origin,
    });
    await input.press('ControlOrMeta+a');
    await input.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(withMention);
    await input.press('ArrowRight');
    await page.evaluate(() => navigator.clipboard.writeText(' \r\n@lyra'));
    await input.press('ControlOrMeta+v');
    await expect(input).toHaveValue(withMention + ' \n@lyra');
    await expect(
      page.getByRole('button', { name: 'Remove mention @lyra', exact: true }),
    ).toHaveCount(1);
    await input.press('ControlOrMeta+z');
    await expect(input).toHaveValue(withMention);
    await page.getByText('Formatting help', { exact: true }).click();
    await expect(
      page.getByText('Plain @names do not notify anyone.', { exact: false }),
    ).toBeVisible();
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await input.scrollIntoViewIfNeeded();
      await captureMessaging(page, 'formatting-help');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByText('Formatting help', { exact: true }).click();
    await page.getByText('Preview', { exact: true }).click();
    await expect(page.locator('.composer .mention')).toHaveText('@lyra');
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('.composer').scrollIntoViewIfNeeded();
      await input.focus();
      await expect(input).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeInViewport({
        ratio: 1,
      });
      await captureMessaging(page, 'composer');
      const attachments = page
        .locator('.composer-options')
        .filter({ has: page.locator('summary', { hasText: /^Attachments/ }) });
      await attachments.locator('summary').click();
      await expect(
        page.getByRole('button', { name: 'Inspect my file limits', exact: true }),
      ).toBeVisible();
      await attachments.scrollIntoViewIfNeeded();
      await captureMessaging(page, 'attachments');
      await attachments.locator('summary').click();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('loom.intent.v1:')) {
          Storage.prototype.setItem = original;
          throw new Error('Synthetic draft save failure');
        }
        return original.call(this, key, value);
      };
    });
    await page.getByRole('button', { name: 'Close composer', exact: true }).click();
    const failure = page.getByRole('alert').filter({ hasText: 'Synthetic draft save failure' });
    await expect(failure).toBeVisible();
    await expect(input).toHaveValue(/@lyra/);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await failure.scrollIntoViewIfNeeded();
      await expect(failure).toBeInViewport({ ratio: 1 });
      await captureMessaging(page, 'close-save-failure', [
        'One local draft Storage.setItem deliberately throws before dismissal; editor and saved request remain present.',
      ]);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Your publication is saved.', { exact: true })).toBeVisible();
  if (reviewMessaging) {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.locator('.composer-confirmed').scrollIntoViewIfNeeded();
      await captureMessaging(page, 'publication-confirmed');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.getByRole('link', { name: 'Inspect exact revision' }).click();
  const path = new URL(page.url()).pathname.split('/');
  const resource = path[3]!,
    revision = path[4]!;
  await page.getByRole('link', { name: 'Conversation', exact: true }).click();
  return {
    resource,
    revision,
    discussion: new URL(page.url()).pathname.split('/')[3]!,
  };
}
async function api(page: Page, path: string, body?: unknown) {
  const self = await (
    await page.request.get(new URL('/api/v1/identity/self', page.url()).href)
  ).json();
  return body === undefined
    ? page.request.get(new URL(path, page.url()).href)
    : page.request.post(new URL(path, page.url()).href, {
        data: body,
        headers: {
          origin: new URL(page.url()).origin,
          'x-loom-csrf': self.csrf,
        },
      });
}
async function agent(
  page: Page,
  server: Awaited<ReturnType<typeof syntheticServer>>,
  nickname = 'external_agent',
) {
  const account = await (
    await api(page, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname,
      kind: 'agent',
      role: 'participant',
    })
  ).json();
  const issued = await (
    await api(page, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: 'agent',
      purpose: null,
      label: 'Direct HTTP browser test',
      replace_credential_id: null,
    })
  ).json();
  return {
    id: account.participant_id,
    client: httpClient(
      server.origin,
      await readFile(server.directory + '/cert.pem', 'utf8'),
      issued.secret,
    ),
  };
}
const text = (value: string) => ({
  format: 'loom-markdown-v1',
  text: value,
  mentions: [],
});

test('browser-owned TLS preconnection closes before server teardown', async ({
  context,
  server,
}) => {
  // Hold a real TLS connection without sending HTTP, with the browser context's
  // lifetime. This deterministically models a speculative browser connection;
  // Node's HTTP idle-connection cleanup does not close this socket.
  const connection = connectTls({
    host: '127.0.0.1',
    port: Number(new URL(server.origin).port),
    servername: 'localhost',
    ca: await readFile(server.directory + '/cert.pem', 'utf8'),
  });
  context.once('close', () => connection.destroy());
  await once(connection, 'secureConnect');
  expect(connection.authorized).toBe(true);
  // Successful fixture teardown is the assertion: server-first cleanup deadlocks
  // until this context closes.
});

test('administrator setup/admission, human discussion, direct HTTP agent, nesting, revisions and responsive reading', async ({
  page,
  context,
  server,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let anonymousProbes = 0;
  const observed = (response: import('@playwright/test').Response) => {
    if (new URL(response.url()).pathname === '/api/v1/identity/self' && response.status() === 401)
      anonymousProbes++;
  };
  page.on('response', observed);
  for (const [index, path] of ['/loom', '/loom/saved'].entries()) {
    await page.goto(server.origin + path);
    await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(anonymousProbes).toBe(index + 1);
  }
  page.off('response', observed);
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const uxReview = uxHighReview();
  await backToLoom(page);
  await page.getByRole('link', { name: 'Topics', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.sidebar').hover();
  await page.mouse.wheel(0, 1200);
  await uxReview.capture(page, 'navigation-short-window');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport({
    ratio: 1,
  });
  const navigation = page
    .getByRole('navigation', { name: 'Community navigation' })
    .getByRole('link');
  await navigation.first().focus();
  for (let index = 0; index < (await navigation.count()); index++) {
    await expect(navigation.nth(index)).toBeFocused();
    // Native focus scrolls in whole pixels; Linux font metrics can leave a
    // subpixel edge outside the scrollport (observed 0.27px on a 42px link).
    await expect(navigation.nth(index)).toBeInViewport({ ratio: 0.99 });
    await page.keyboard.press('Tab');
  }
  await expect(page.getByRole('link', { name: 'Participation guide', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await uxReview.capture(page, 'navigation-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
  await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Community menu', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.hover();
  await page.mouse.wheel(0, 1200);
  await expect(drawer.getByRole('button', { name: 'Sign out', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await uxReview.capture(page, 'navigation-mobile');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  await page.getByRole('link', { name: 'Participants', exact: true }).click();
  await page.getByLabel('Nickname', { exact: true }).fill('lyra');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByRole('button', { name: 'Issue agent credential', exact: true }).click();
  const secret = await page.getByLabel('Issued secret').inputValue();
  expect(secret).toBeTruthy();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const human = await (
    await api(page, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname: 'maya',
      kind: 'human',
      role: 'participant',
    })
  ).json();
  const ticket = await (
    await api(page, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: human.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Human browser',
      replace_credential_id: null,
    })
  ).json();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
  await enter(page, context, server.origin, ticket.secret);
  const discussion = await createDiscussion(page, undefined, true),
    client = httpClient(
      server.origin,
      await readFile(server.directory + '/cert.pem', 'utf8'),
      secret,
    );
  const actual = await client.call('/api/v1/resources/' + discussion.resource);
  expect(actual.body.content.text).toContain('shared question');
  const reply = await client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: actual.body.resource_id,
    content: text('I retrieved the actual opening revision before answering.'),
  });
  expect(reply.status).toBe(201);
  await page.reload();
  await expect(
    page.getByText('I retrieved the actual opening revision before answering.'),
  ).toBeVisible();
  const agentPost = page.locator(`[data-resource-id="${reply.body.resource_id}"]`);
  await expect(agentPost.getByText('Replying to', { exact: false })).toHaveCount(0);
  const agentBranch = agentPost.locator('..');
  await expect(
    agentBranch.getByRole('button', { name: 'Show replies', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await agentPost.locator('.message-details > summary').click();
  await agentPost.getByRole('button', { name: 'Preview parent', exact: true }).click();
  const parentPreview = page.getByRole('complementary', { name: 'Parent preview' });
  await expect(parentPreview).toBeFocused();
  await expect(parentPreview).toContainText('@maya');
  await expect(parentPreview).toContainText('shared question');
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await parentPreview.scrollIntoViewIfNeeded();
    await captureMessaging(page, 'parent-preview');
  }
  await parentPreview.getByRole('button', { name: 'Close preview' }).click();
  await expect(
    agentPost.getByRole('button', { name: 'Preview parent', exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await agentPost.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(agentPost.getByLabel('Your reply', { exact: true })).toBeFocused();
  await agentPost
    .getByLabel('Your reply', { exact: true })
    .fill('A draft kept when the composer closes.');
  await agentPost.getByRole('button', { name: 'Close composer', exact: true }).click();
  await expect(agentPost.getByRole('button', { name: 'Reply', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Drafts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Drafts', exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await captureMessaging(page, 'drafts');
  }
  await page.getByRole('link', { name: /Resume draft · Reply/ }).click();
  await expect(page.getByLabel('Your reply', { exact: true })).toHaveValue(
    'A draft kept when the composer closes.',
  );
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await agentPost.getByRole('button', { name: 'Close composer', exact: true }).click();

  await agentPost.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(agentPost.getByLabel('Your reply', { exact: true })).toHaveValue(
    'A draft kept when the composer closes.',
  );
  await agentPost.getByLabel('Your reply', { exact: true }).fill('This reply belongs under Lyra.');
  await agentPost.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(agentPost.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(
    page
      .locator('.comment-tree .prose')
      .getByText('This reply belongs under Lyra.', { exact: true }),
  ).toBeVisible();
  const children = await client.call(`/api/v1/contributions/${reply.body.resource_id}/children`);
  expect(children.body.items).toHaveLength(1);
  expect(children.body.items[0].parent_id).toBe(reply.body.resource_id);
  const nestedReplies = agentBranch.locator(':scope > .comment-children');
  await expect(nestedReplies.getByText('1 reply loaded', { exact: true })).toBeVisible();
  await expect(nestedReplies.getByText('Replying to', { exact: false })).toHaveCount(0);
  await agentPost.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/loom/discussion/${discussion.discussion}$`));
  await agentPost
    .getByLabel('Your reply', { exact: true })
    .fill('A second reply in the already open branch.');
  await agentPost.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(
    page
      .locator('.comment-tree .prose')
      .getByText('A second reply in the already open branch.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('2 replies loaded', { exact: true })).toBeVisible();
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  await agentBranch.getByRole('button', { name: 'Show replies', exact: true }).click();
  await expect(nestedReplies.getByText('2 replies loaded', { exact: true })).toBeVisible();
  const nestedPost = nestedReplies.locator('article.comment').first();
  await nestedPost.getByRole('button', { name: 'Reply', exact: true }).click();
  await nestedPost
    .getByLabel('Your reply', { exact: true })
    .fill('A nested draft survives hiding the branch.');
  await agentBranch.getByRole('button', { name: 'Hide replies', exact: true }).click();
  await expect(nestedReplies).toBeHidden();
  await agentBranch.getByRole('button', { name: 'Show replies', exact: true }).click();
  await expect(nestedReplies.getByText('2 replies loaded', { exact: true })).toBeVisible();
  await expect(nestedPost.getByLabel('Your reply', { exact: true })).toHaveValue(
    'A nested draft survives hiding the branch.',
  );
  const refreshedRoot = page.waitForResponse(
    (response) =>
      response.url().includes(`/contributions/${discussion.resource}/children?limit=6`) &&
      response.status() === 200,
  );
  await page
    .locator('.conversation-content > .comment-tree')
    .getByRole('button', { name: 'Refresh comments', exact: true })
    .click();
  await refreshedRoot;
  await expect(page.locator('.conversation-content > .comment-tree')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(nestedPost.getByLabel('Your reply', { exact: true })).toHaveValue(
    'A nested draft survives hiding the branch.',
  );
  const threadLink = nestedPost
    .locator('..')
    .getByRole('link', { name: 'Continue this thread →', exact: true });
  await threadLink.scrollIntoViewIfNeeded();
  const beforeTop = await nestedPost.evaluate((node) => node.getBoundingClientRect().top);
  await threadLink.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation', exact: true }).click();
  await expect(nestedPost.getByLabel('Your reply', { exact: true })).toHaveValue(
    'A nested draft survives hiding the branch.',
  );
  await expect(nestedPost).toBeFocused();
  await expect
    .poll(async () =>
      Math.abs((await nestedPost.evaluate((node) => node.getBoundingClientRect().top)) - beforeTop),
    )
    .toBeLessThan(3);
  await nestedPost.getByRole('button', { name: 'Close composer', exact: true }).click();
  await expect(agentPost.locator('.composer')).toHaveCount(0);
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await agentPost.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await captureMessaging(page, 'conversation');
    await captureMessaging(page, 'reply-context');
    await nestedReplies.evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await captureMessaging(page, 'reply-thread');
    const more = agentPost.locator('.post-footer > .message-details');
    await more.locator('summary').click();
    await expect(more.getByText('Inspect editing intent', { exact: true })).toBeVisible();
    await more.scrollIntoViewIfNeeded();
    await captureMessaging(page, 'message-details');
    await more.locator('summary').click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: testInfo.outputPath('discussion-desktop.png'),
    fullPage: true,
  });
  await testInfo.attach('discussion desktop', {
    path: testInfo.outputPath('discussion-desktop.png'),
    contentType: 'image/png',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('discussion-mobile.png'),
    fullPage: true,
  });
  await testInfo.attach('discussion mobile', {
    path: testInfo.outputPath('discussion-mobile.png'),
    contentType: 'image/png',
  });
  let releaseNames!: () => void, namesReached!: () => void;
  const heldNames = new Promise<void>((resolve) => {
    releaseNames = resolve;
  });
  const reachedNames = new Promise<void>((resolve) => {
    namesReached = resolve;
  });
  const namesRoute = async (route: import('@playwright/test').Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    namesReached();
    await heldNames;
    await route.fulfill({ response });
  };
  await page.route('**/api/v1/participants', namesRoute);
  await page.goto(
    server.origin + `/loom/resource/${discussion.resource}/${discussion.revision}?edit=1`,
  );
  const conflictInput = page.getByLabel('Text', { exact: true });
  try {
    await reachedNames;
    await expect(conflictInput).toHaveValue(/@participant/);
    // Defer selection notification, not the selection itself. This exercises the
    // valid interval between native replacement selection and React's observer.
    await conflictInput.evaluate((node) => {
      const input = node as HTMLTextAreaElement;
      const hold = (event: Event) => event.stopImmediatePropagation();
      document.addEventListener('selectionchange', hold, true);
      (window as unknown as { releaseMentionSelection: () => void }).releaseMentionSelection =
        () => {
          document.removeEventListener('selectionchange', hold, true);
          document.dispatchEvent(new Event('selectionchange'));
        };
      input.setSelectionRange(0, input.value.length);
      input.focus();
    });
    releaseNames();
    await expect(conflictInput).toHaveValue(/@lyra/);
    const resolvedLength = (await conflictInput.inputValue()).length;
    await expect
      .poll(() =>
        conflictInput.evaluate((node) => {
          const input = node as HTMLTextAreaElement;
          return [input.selectionStart, input.selectionEnd, input.value.length];
        }),
      )
      .toEqual([0, resolvedLength, resolvedLength]);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await conflictInput.scrollIntoViewIfNeeded();
      await captureMentionSelection(page, 'resolved-full-selection');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  } finally {
    releaseNames();
    await page.unroute('**/api/v1/participants', namesRoute);
    await page.evaluate(() => {
      const windowWithRelease = window as unknown as { releaseMentionSelection?: () => void };
      windowWithRelease.releaseMentionSelection?.();
      delete windowWithRelease.releaseMentionSelection;
    });
  }
  await page.keyboard.insertText('My retained conflicting edit.');
  await expect(conflictInput).toHaveValue('My retained conflicting edit.');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(conflictInput).toHaveValue(/@lyra/);
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find((record) => record.slot === 'edit:' + discussion.resource)
          ?.body.content,
    )
    .toEqual(actual.body.content);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(conflictInput).toHaveValue('My retained conflicting edit.');
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find((record) => record.slot === 'edit:' + discussion.resource)
          ?.body.content,
    )
    .toEqual(text('My retained conflicting edit.'));
  const competing = await api(page, '/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: discussion.resource,
    expected_revision_id: discussion.revision,
    title: 'Reading the actual context',
    content: text('A competing revision.'),
  });
  expect(competing.status()).toBe(201);
  const exactConflictDraft = (await savedIntents(page)).find(
    (record) => record.slot === 'edit:' + discussion.resource,
  )!;
  const submittedConflict = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/v1/revisions' && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  expect((await submittedConflict).postData()).toBe(JSON.stringify(exactConflictDraft.body));
  await expect(page.getByText('Your draft is preserved.')).toBeVisible();
  await expect
    .poll(async () =>
      JSON.stringify(
        (await savedIntents(page)).find((record) => record.key === exactConflictDraft.key)?.body,
      ),
    )
    .toBe(JSON.stringify(exactConflictDraft.body));
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
    'My retained conflicting edit.',
  );
  await expect(page.getByText('A competing revision.', { exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await conflictInput.scrollIntoViewIfNeeded();
    await captureMentionSelection(page, 'retained-conflicting-edit');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Prepare corrected submission' }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Your publication is saved.', { exact: true })).toBeVisible();
  const old = await client.call(
    `/api/v1/resources/${discussion.resource}/revisions/${discussion.revision}`,
  );
  expect(old.body.content.text).toContain('shared question');
  // A bounded loaded count is not a whole-thread total. Refresh also rechecks
  // an observed empty branch.
  for (let index = 0; index < 6; index++) {
    const extra = await client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: discussion.resource,
      content: text(`Another direct reply ${index + 1}.`),
    });
    expect(extra.status).toBe(201);
  }
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  await expect(page.getByText('6 comments loaded', { exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .locator('.discussion-controls')
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await captureMessaging(page, 'reply-page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: 'Load more comments', exact: true }).click();
  await expect(page.getByText('7 comments loaded', { exact: true })).toBeVisible();
  await expect(page.getByText('Another direct reply 1.', { exact: true })).toBeVisible();
  const leaf = children.body.items[0].resource_id;
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}?focus=${leaf}`);
  await expect(page.getByText('No replies yet.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close composer', exact: true }).click();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .locator('.discussion-controls')
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await captureMessaging(page, 'reply-empty');
  }
  const childrenRoute = `**/api/v1/contributions/${leaf}/children?limit=6`;
  await page.route(childrenRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'service_unavailable', message: 'Replies temporarily unavailable' },
      }),
    }),
  );
  await page.getByRole('button', { name: 'Refresh replies', exact: true }).click();
  await expect(page.getByText('Replies temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No replies yet.', { exact: true })).toBeVisible();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Retry replies', exact: true }).scrollIntoViewIfNeeded();
    await captureMessaging(
      page,
      'reply-error',
      [
        'One explicit children refresh returns service_unavailable503; the earlier empty observation remains qualified.',
      ],
      [
        'GET /api/v1/contributions/{leaf}/children?limit=6 returns service_unavailable503 during the explicit refresh.',
      ],
    );
  }
  await page.unroute(childrenRoute);
  await page.getByRole('button', { name: 'Retry replies', exact: true }).click();
  await expect(page.getByText('Replies temporarily unavailable', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No replies yet.', { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('a late committed publication cannot repopulate another identity or route after sign-out', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const d = await createDiscussion(page);
  const account = await (
    await api(page, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname: 'new_owner',
      kind: 'human',
      role: 'participant',
    })
  ).json();
  const ticket = await (
    await api(page, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Second identity',
      replace_credential_id: null,
    })
  ).json();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let key = '';
  await page.route('**/api/v1/replies', async (route) => {
    key = route.request().postDataJSON().idempotency_key;
    const records = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([name]) => name.startsWith('loom.intent.'))
        .map(([, value]) => JSON.parse(value)),
    );
    expect(records.some((record) => record.key === key && record.state === 'uncertain')).toBe(true);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    started();
    await held;
    await route.fulfill({ response });
  });
  const opening = page.locator(`[data-resource-id="${d.resource}"]`);
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply').fill('Late original-owner publication.');
  await opening.getByRole('button', { name: 'Post reply' }).click();
  await ready;
  await page.getByRole('link', { name: 'Artifacts', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Artifacts', exact: true })).toBeVisible();
  await expect(page.getByText('Reply posted', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Clear local drafts and sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
  await enter(page, context, server.origin, ticket.secret);
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.locator('.sidebar .account strong')).toHaveText('new_owner');
  await expect(page.getByText('Reply posted', { exact: true })).not.toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('loom.intent.')),
    ),
  ).toEqual([]);
  expect(
    (
      await server.observer.query(
        'SELECT count(*) FROM loom.idempotency_records WHERE idempotency_key=$1',
        [key],
      )
    ).rows[0].count,
  ).toBe('1');
});

test('lost committed response survives actual browser process restart and exact retry without duplication', async ({
  server,
  diagnostics,
}, testInfo) => {
  const uxReview = uxHighReview();
  const directory = await mkdtemp(join(tmpdir(), 'loom-browser-restart-'));
  let context = await diagnostics.launchPersistentContext(directory, {
    ignoreHTTPSErrors: true,
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  try {
    let page = await context.newPage();
    await enter(page, context, server.origin, server.ticket, true);
    await setup(page);
    const d = await createDiscussion(page);
    const opening = page.locator(`[data-resource-id="${d.resource}"]`);
    await opening.getByRole('button', { name: 'Reply', exact: true }).click();
    await opening.getByLabel('Your reply').fill('Recover this exact reply after a crash.');
    let posted: Record<string, unknown> | undefined, completed!: () => void;
    const aborted = new Promise<void>((resolve) => {
      completed = resolve;
    });
    await page.route('**/api/v1/replies', async (route) => {
      posted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('connectionfailed');
      completed();
    });
    await opening.getByRole('button', { name: 'Post reply' }).click();
    await expect(
      page.getByText('We couldn’t confirm whether your reply was posted.'),
    ).toBeVisible();
    await aborted;
    await uxReview.capture(page, 'recovery-desktop', [
      'Real reply POST committed; browser response aborted before receipt.',
    ]);
    await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeInViewport({
      ratio: 1,
    });
    const recovery = page.getByRole('group', { name: 'Submission recovery', exact: true });
    await expect(recovery).toBeFocused();
    await expect(recovery).toBeInViewport({ ratio: 1 });
    await expect(
      recovery.getByRole('button', { name: 'Check status', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Tab');
    await expect(recovery.getByRole('button', { name: 'Check status', exact: true })).toBeFocused();
    await uxReview.capture(page, 'recovery-desktop-keyboard', [
      'Real committed reply response was dropped; Tab enters Check status from the focused recovery group.',
    ]);
    const original = posted!;
    expect(original.idempotency_key).toBeTruthy();
    await context.close();
    context = await diagnostics.launchPersistentContext(directory, {
      ignoreHTTPSErrors: true,
      headless: true,
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    await page.goto(server.origin + '/loom/discussion/' + d.discussion);
    await expect(
      page.getByText('We couldn’t confirm whether your reply was posted.'),
    ).toBeVisible();
    await expect(page.getByLabel('Your reply')).toHaveValue(
      'Recover this exact reply after a crash.',
    );
    let retry: unknown;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/replies')) retry = request.postDataJSON();
    });
    await page.getByRole('button', { name: 'Retry same reply' }).click();
    await expect(page.getByText('Reply posted', { exact: true })).toBeVisible();
    expect(retry).toEqual(original);
    const count = await server.observer.query(
      'SELECT count(*) FROM loom.idempotency_records WHERE operation_kind=$1 AND idempotency_key=$2',
      ['reply.create', original.idempotency_key],
    );
    expect(count.rows[0].count).toBe('1');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileOpening = page.locator(`[data-resource-id="${d.resource}"]`);
    await mobileOpening.getByRole('button', { name: 'Reply', exact: true }).click();
    await mobileOpening
      .getByLabel('Your reply', { exact: true })
      .fill('Recover an unreceived mobile reply without changing its request.');
    const mobileAttempts: unknown[] = [];
    await page.route('**/api/v1/replies', async (route) => {
      mobileAttempts.push(route.request().postDataJSON());
      if (mobileAttempts.length === 1) await route.abort('connectionfailed');
      else await route.continue();
    });
    await mobileOpening.getByRole('button', { name: 'Post reply', exact: true }).click();
    await expect(
      page.getByText('We couldn’t confirm whether your reply was posted.', { exact: true }),
    ).toBeVisible();
    await uxReview.capture(page, 'recovery-mobile', [
      'Reply POST deliberately aborted before reaching the server.',
    ]);
    const mobileRecovery = page.getByRole('group', { name: 'Submission recovery', exact: true });
    await expect(mobileRecovery).toBeFocused();
    await expect(mobileRecovery).toBeInViewport({ ratio: 1 });
    await expect(
      mobileRecovery.getByRole('button', { name: 'Check status', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Tab');
    await expect(
      mobileRecovery.getByRole('button', { name: 'Check status', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Confirmation is still unavailable. The original request may still commit.'),
    ).toBeVisible();
    await expect(mobileRecovery).toBeFocused();
    await expect(mobileRecovery).toBeInViewport({ ratio: 1 });
    await uxReview.capture(page, 'recovery-mobile-unrecorded', [
      'Reply POST never reached the server; explicit status read returned not_recorded without changing the saved request.',
    ]);
    expect(mobileAttempts).toHaveLength(1);
    await mobileRecovery.getByRole('button', { name: 'Retry same reply', exact: true }).click();
    await expect(page.getByText('Reply posted', { exact: true })).toBeVisible();
    expect(mobileAttempts).toHaveLength(2);
    expect(mobileAttempts[1]).toEqual(mobileAttempts[0]);
    const mobileKey = (mobileAttempts[0] as { idempotency_key: string }).idempotency_key;
    expect(
      (
        await server.observer.query(
          'SELECT count(*) FROM loom.idempotency_records WHERE operation_kind=$1 AND idempotency_key=$2',
          ['reply.create', mobileKey],
        )
      ).rows[0].count,
    ).toBe('1');
    await uxReview.capture(page, 'recovery-mobile-confirmed');
    await page.screenshot({
      path: testInfo.outputPath('recovered-reply.png'),
      fullPage: true,
    });
    await testInfo.attach('recovered reply', {
      path: testInfo.outputPath('recovered-reply.png'),
      contentType: 'image/png',
    });
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('late reads preserve navigation/account ownership; older-page failure and revoked rights preserve draft', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const d = await createDiscussion(page),
    external = await agent(page, server);
  for (let i = 1; i <= 8; i++)
    expect(
      (
        await external.client.call('/api/v1/replies', {
          idempotency_key: randomUUID(),
          discussion_id: d.discussion,
          parent_id: d.resource,
          content: text('Bounded reply ' + i),
        })
      ).status,
    ).toBe(201);
  await page.reload();
  await expect(page.getByText('Bounded reply 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Bounded reply 7', { exact: true })).not.toBeVisible();
  let failPage = true;
  await page.route('**/api/v1/contributions/*/children?*', async (route) => {
    if (failPage && new URL(route.request().url()).searchParams.has('cursor')) {
      failPage = false;
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Load more comments' }).click();
  await expect(page.getByRole('button', { name: 'Retry comments' })).toBeVisible();
  await expect(page.getByText('Bounded reply 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry comments' }).click();
  await expect(page.getByText('Bounded reply 7', { exact: true })).toBeVisible();
  await expect(page.getByText('Bounded reply 1', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/resources/' + d.resource, async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await page.goto(server.origin + '/loom/resource/' + d.resource);
  await ready;
  await page.getByRole('link', { name: 'Artifacts', exact: true }).first().click();
  release();
  await expect(page.getByRole('heading', { name: 'Artifacts', exact: true })).toBeVisible();
  await expect(page.getByText('A shared question', { exact: false })).not.toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  // A normal admitted human is enrolled with real browser WebAuthn, not a role header.
  const account = await (
    await api(page, '/api/v1/identity/accounts', {
      idempotency_key: randomUUID(),
      nickname: 'second_human',
      kind: 'human',
      role: 'participant',
    })
  ).json();
  const ticket = await (
    await api(page, '/api/v1/identity/credentials', {
      idempotency_key: randomUUID(),
      participant_id: account.participant_id,
      kind: 'enrollment',
      purpose: 'enroll',
      label: 'Second browser',
      replace_credential_id: null,
    })
  ).json();
  let releaseOld!: () => void;
  const holdOld = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldReady!: () => void;
  const oldStarted = new Promise<void>((resolve) => {
    oldReady = resolve;
  });
  await page.route('**/api/v1/resources/' + d.resource, async (route) => {
    const response = await route.fetch();
    oldReady();
    await holdOld;
    await route.fulfill({ response });
  });
  await page.goto(server.origin + '/loom/resource/' + d.resource);
  await oldStarted;
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  if (await page.getByRole('button', { name: 'Clear local drafts and sign out' }).isVisible())
    await page.getByRole('button', { name: 'Clear local drafts and sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
  releaseOld();
  await page.unrouteAll({ behavior: 'wait' });
  // A fresh virtual authenticator ensures the browser selects the second identity.
  await enter(page, context, server.origin, ticket.secret);
  await expect(page.locator('.sidebar .account strong')).toHaveText('second_human');
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  const opening = page.locator(`[data-resource-id="${d.resource}"]`);
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply').fill('Preserve this draft when permission changes.');
  await server.observer.query('UPDATE loom.resources SET publication_open=false WHERE id=$1', [
    d.discussion,
  ]);
  await opening.getByRole('button', { name: 'Post reply' }).click();
  await expect(page.getByText('Your draft is preserved.')).toBeVisible();
  await expect(page.getByLabel('Your reply')).toHaveValue(
    'Preserve this draft when permission changes.',
  );
  const denied = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: d.discussion,
    parent_id: d.resource,
    content: text('same denial'),
  });
  expect(denied.status).toBe(403);
  await expect(page.locator('.sidebar .account strong')).toHaveText('second_human');
});

test('a confirmed reply appears in its parent branch and Reply starts a fresh operation', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const opening = page.locator('.conversation-content > article.post');
  const comments = page.locator('.conversation-content > .comment-tree');
  await expect(comments.getByText('No comments yet.')).toBeVisible();
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply', { exact: true }).fill('First posted comment');
  await captureConfirmedReply(
    page,
    'before-post',
    opening.getByLabel('Your reply', { exact: true }),
  );
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(opening.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(opening.getByLabel('Your reply', { exact: true })).toHaveCount(0);
  await expect(opening.getByRole('link', { name: 'View reply' })).toBeFocused();
  await expect(comments.getByText('First posted comment', { exact: true })).toBeVisible();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toBeVisible();
  await expect(comments.locator(':scope > .comment-branch')).toHaveCount(1);
  await captureConfirmedReply(
    page,
    'ordinary-confirmed',
    comments.locator(':scope > .comment-branch').first(),
  );
  const firstId = (await opening
    .getByRole('link', { name: 'View reply' })
    .getAttribute('href'))!.split('focus=')[1]!;
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(opening.getByLabel('Your reply', { exact: true })).toHaveValue('');
  await captureConfirmedReply(
    page,
    'next-fresh-editor',
    opening.getByLabel('Your reply', { exact: true }),
  );
  await opening.getByLabel('Your reply', { exact: true }).fill('Second posted comment');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(comments.getByText('Second posted comment', { exact: true })).toBeVisible();
  const ownRecords = (await savedIntents(page)).filter(
    (record) => record.kind === 'reply.create' && record.state === 'committed',
  );
  expect(new Set(ownRecords.map((record) => record.key)).size).toBe(2);
  const firstRow = comments.locator(
    `:scope > .comment-branch:has(article[data-resource-id="${firstId}"])`,
  );
  await firstRow.getByRole('button', { name: 'Reply', exact: true }).click();
  await firstRow.getByLabel('Your reply', { exact: true }).fill('Nested under the first comment');
  await firstRow.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(firstRow.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(firstRow.getByText('Nested under the first comment', { exact: true })).toBeVisible();
  await firstRow.getByRole('link', { name: 'View reply' }).click();
  await page.locator('.reading-grid > div > article.comment .message-details > summary').click();
  await page
    .locator('.reading-grid > div > article.comment')
    .getByRole('link', { name: 'View parent thread' })
    .click();
  await expect(page).toHaveURL(new RegExp(`focus=${firstId}`));
  const focusedReplies = page.locator('.reading-grid > div > .comment-tree');
  await expect(
    focusedReplies.getByText('Nested under the first comment', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(firstRow.getByText('Nested under the first comment', { exact: true })).toBeVisible();
});

test('an older uncertain reply confirms after a newer reply in canonical order', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const opening = page.locator('.conversation-content > article.post');
  const comments = page.locator('.conversation-content > .comment-tree');
  const rows = comments.locator(':scope > .comment-branch');
  let published = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/replies' && request.method() === 'POST')
      published++;
  });
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply', { exact: true }).fill('Older reply awaiting status');
  let originalRequest: Record<string, unknown> | undefined;
  await page.route('**/api/v1/replies', async (route) => {
    originalRequest = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort('connectionfailed');
  });
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(page.getByText('We couldn’t confirm whether your reply was posted.')).toBeVisible();
  const older = (await savedIntents(page)).find(
    (record) => record.slot === 'reply:' + discussion.resource && record.state === 'uncertain',
  )!;
  await page.unrouteAll({ behavior: 'wait' });
  await opening.getByRole('button', { name: 'Close composer' }).click();
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(opening.getByLabel('Your reply', { exact: true })).toHaveValue('');
  await opening.getByLabel('Your reply', { exact: true }).fill('Newer confirmed reply');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(opening.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(comments.getByText('Newer confirmed reply', { exact: true })).toBeVisible();
  const newer = (await savedIntents(page)).find(
    (record) => record.slot === 'reply:' + discussion.resource && record.state === 'committed',
  )!;
  expect(newer.key).not.toBe(older.key);
  expect(published).toBe(2);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}?intent=${older.key}`);
  await expect(page.getByText('We couldn’t confirm whether your reply was posted.')).toBeVisible();
  await opening.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(opening.getByText('Reply posted', { exact: true })).toBeVisible();
  expect(published).toBe(2);
  const recovered = (await savedIntents(page)).find((record) => record.key === older.key)!;
  expect(recovered.state).toBe('committed');
  await expect(rows).toHaveCount(2);
  await expect(comments.getByText('Older reply awaiting status', { exact: true })).toHaveCount(1);
  await expect(comments.getByText('Newer confirmed reply', { exact: true })).toHaveCount(1);
  await expect
    .poll(() =>
      rows.evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector('article')?.getAttribute('data-resource-id')),
      ),
    )
    .toEqual([recovered.result!.resource_id, newer.result!.resource_id]);
  const replay = await api(page, '/api/v1/replies', originalRequest);
  expect(replay.ok()).toBe(true);
  expect((await replay.json()).resource_id).toBe(recovered.result!.resource_id);
  await expect(rows).toHaveCount(2);
  const unrelated = rows.first().getByRole('button', { name: 'Reply', exact: true });
  await unrelated.click();
  const unrelatedEditor = rows.first().getByLabel('Your reply', { exact: true });
  const unrelatedHandle = await unrelatedEditor.elementHandle();
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  const freshEditor = opening.getByLabel('Your reply', { exact: true });
  const freshHandle = await freshEditor.elementHandle();
  await freshEditor.pressSequentially('F');
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find(
          (record) =>
            record.slot === 'reply:' + discussion.resource &&
            record.state === 'draft' &&
            record.body.content.text === 'F',
        )?.key,
    )
    .toBeTruthy();
  const firstDraft = (await savedIntents(page)).find(
    (record) =>
      record.slot === 'reply:' + discussion.resource &&
      record.state === 'draft' &&
      record.body.content.text === 'F',
  )!;
  await expect.poll(() => new URL(page.url()).searchParams.get('intent')).toBe(firstDraft.key);
  expect(await freshHandle!.evaluate((node) => node.isConnected)).toBe(true);
  expect(await unrelatedHandle!.evaluate((node) => node.isConnected)).toBe(true);
  expect(
    await freshHandle!.evaluate(
      (original, current) => original === current,
      await freshEditor.elementHandle(),
    ),
  ).toBe(true);
  expect(
    await unrelatedHandle!.evaluate(
      (original, current) => original === current,
      await unrelatedEditor.elementHandle(),
    ),
  ).toBe(true);
  await expect(freshEditor).toBeFocused();
  expect(
    await freshEditor.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual([1, 1]);
  await freshEditor.pressSequentially('resh draft after recovery');
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find(
          (record) =>
            record.slot === 'reply:' + discussion.resource &&
            record.state === 'draft' &&
            record.body.content.text === 'Fresh draft after recovery',
        )?.key,
    )
    .toBeTruthy();
  const fresh = (await savedIntents(page)).find(
    (record) => record.slot === 'reply:' + discussion.resource && record.state === 'draft',
  )!;
  expect(fresh.key).not.toBe(older.key);
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return [url.pathname, url.searchParams.get('focus'), url.searchParams.get('intent')];
    })
    .toEqual([`/loom/discussion/${discussion.discussion}`, null, fresh.key]);
  await expect(opening.getByLabel('Your reply', { exact: true })).toHaveValue(
    'Fresh draft after recovery',
  );
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}?intent=${older.key}`);
  await expect(opening.getByText('Publication confirmed.', { exact: true })).toBeVisible();
});

test('a separately confirmed reply collapses through refresh, return, and reconciliation', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const external = await agent(page, server);
  const create = async (parentId: string, body: string) => {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: parentId,
      content: text(body),
    });
    expect(result.status).toBe(201);
    return result.body.resource_id as string;
  };
  for (let index = 1; index <= 13; index++)
    await create(discussion.resource, `Earlier comment ${index}`);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const opening = page.locator('.conversation-content > article.post');
  const comments = page.locator('.conversation-content > .comment-tree');
  await expect(comments.locator(':scope > .comment-branch')).toHaveCount(6);
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply', { exact: true }).fill('Own comment after gap');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  const ownId = (await opening
    .getByRole('link', { name: 'View reply' })
    .getAttribute('href'))!.split('focus=')[1]!;
  const ownRow = comments.locator(
    `:scope > .comment-branch:has(article[data-resource-id="${ownId}"])`,
  );
  await expect(ownRow.getByText('Own comment after gap', { exact: true })).toBeVisible();
  await create(ownId, 'Child beneath own comment');
  await ownRow.getByRole('button', { name: 'Show replies' }).click();
  await expect(ownRow.getByText('Child beneath own comment', { exact: true })).toBeVisible();
  await ownRow
    .locator(':scope > article.comment')
    .getByRole('button', { name: /Collapse comment by/ })
    .click();
  await expect(ownRow).toHaveAttribute('data-collapsed', 'true');
  await expect(ownRow.getByText('Own comment after gap', { exact: true })).toBeHidden();
  await expect(ownRow.getByText('Child beneath own comment', { exact: true })).toBeHidden();
  await captureConfirmedReply(page, 'known-reply-collapsed', ownRow);
  await opening.getByRole('link', { name: 'View reply' }).click();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(ownRow).toHaveAttribute('data-collapsed', 'true');
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/v1/contributions/${discussion.resource}/children`,
  );
  await comments.getByRole('button', { name: 'Refresh comments' }).click();
  await refreshed;
  await expect(comments.getByRole('button', { name: 'Refresh comments' })).toBeEnabled();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toBeVisible();
  await expect(ownRow).toHaveAttribute('data-collapsed', 'true');
  for (let index = 0; index < 2; index++)
    await comments.getByRole('button', { name: 'Load more comments' }).click();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toHaveCount(0);
  await expect(ownRow).toHaveAttribute('data-collapsed', 'true');
  await expect(ownRow.getByText('Child beneath own comment', { exact: true })).toBeHidden();
  await ownRow
    .locator(':scope > article.comment')
    .getByRole('button', { name: /Expand comment by/ })
    .click();
  await expect(ownRow.getByText('Own comment after gap', { exact: true })).toBeVisible();
  await expect(ownRow.getByText('Child beneath own comment', { exact: true })).toBeVisible();
});

test('a restored inline reply draft displays its confirmed child without another opening', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const external = await agent(page, server);
  const seeded = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: discussion.resource,
    content: text('Parent with a draft'),
  });
  expect(seeded.status).toBe(201);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const parent = page.locator('.conversation-content > .comment-tree > .comment-branch').first();
  await parent.getByRole('button', { name: 'Reply', exact: true }).click();
  await parent.getByLabel('Your reply', { exact: true }).fill('Posted after draft restoration');
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find(
          (record) =>
            record.slot === `reply:${seeded.body.resource_id}` &&
            record.body.content.text === 'Posted after draft restoration',
        )?.state,
    )
    .toBe('draft');
  await page.reload();
  await expect(parent.getByLabel('Your reply', { exact: true })).toHaveValue(
    'Posted after draft restoration',
  );
  await parent.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(parent.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(parent.getByText('Posted after draft restoration', { exact: true })).toBeVisible();
  await captureConfirmedReply(
    page,
    'restored-draft-confirmed',
    parent.getByText('Posted after draft restoration', { exact: true }),
  );
});

test('separately confirmed replies keep honest gaps and join canonical order without remounting', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const external = await agent(page, server);
  const originalRevisions = new Map<string, string>();
  const externalReply = async (body: string) => {
    const response = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: discussion.resource,
      content: text(body),
    });
    expect(response.status).toBe(201);
    originalRevisions.set(response.body.resource_id as string, response.body.revision_id as string);
    return response.body.resource_id as string;
  };
  const ordered: string[] = [];
  for (let index = 1; index <= 20; index++)
    ordered.push(await externalReply(`Gap comment ${index}`));
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const opening = page.locator('.conversation-content > article.post');
  const comments = page.locator('.conversation-content > .comment-tree');
  const rows = comments.locator(':scope > .comment-branch');
  await expect(rows).toHaveCount(6);
  await comments.getByRole('button', { name: 'Load more comments' }).click();
  await expect(rows).toHaveCount(12);
  const firstArticle = rows.first().locator('article');
  const firstHandle = await firstArticle.elementHandle();
  await firstArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const dirty = firstArticle.getByLabel('Your reply', { exact: true });
  await dirty.fill('Unrelated draft stays here');
  await dirty.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 9));
  const dirtyHandle = await dirty.elementHandle();
  let childReads = 0;
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    childReads++;
    await route.continue();
  });
  ordered.push(await externalReply('Gap comment 21 after the last complete read'));
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply', { exact: true }).fill('First own gap comment');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(comments.getByText('First own gap comment', { exact: true })).toBeVisible();
  const firstOwn = (await opening
    .getByRole('link', { name: 'View reply' })
    .getAttribute('href'))!.split('focus=')[1]!;
  ordered.push(firstOwn);
  await expect(comments.getByText('13 comments loaded', { exact: true })).toBeVisible();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toHaveCount(1);
  expect(childReads).toBe(0);
  await expect(dirty).toHaveValue('Unrelated draft stays here');
  await captureConfirmedReply(page, 'dirty-draft-with-known-reply', dirty);
  expect(
    await dirty.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
  ).toEqual([2, 9]);
  expect(
    await firstHandle!.evaluate(
      (original, current) => original === current,
      await firstArticle.elementHandle(),
    ),
  ).toBe(true);
  ordered.push(await externalReply('Gap comment between own posts'));
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply', { exact: true }).fill('Second own gap comment');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(comments.getByText('Second own gap comment', { exact: true })).toBeVisible();
  const secondOwn = (await opening
    .getByRole('link', { name: 'View reply' })
    .getAttribute('href'))!.split('focus=')[1]!;
  ordered.push(secondOwn);
  await expect(comments.getByText('14 comments loaded', { exact: true })).toBeVisible();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toHaveCount(2);
  await captureConfirmedReply(
    page,
    'confirmed-beyond-gap',
    comments.getByText('Second own gap comment', { exact: true }),
  );
  expect(childReads).toBe(0);
  const firstOwnRow = comments.locator(
    `:scope > .comment-branch:has(article[data-resource-id="${firstOwn}"])`,
  );
  await firstOwnRow.getByRole('button', { name: 'Reply', exact: true }).click();
  const ownDraft = firstOwnRow.getByLabel('Your reply', { exact: true });
  await ownDraft.fill('Draft on a provisional row');
  await ownDraft.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 8));
  const ownHandle = await ownDraft.elementHandle();
  await comments.getByRole('button', { name: 'Load more comments' }).click();
  await expect(comments.getByText('20 comments loaded', { exact: true })).toBeVisible();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toHaveCount(2);
  await comments.getByRole('button', { name: 'Load more comments' }).click();
  await expect(comments.getByText('24 comments loaded', { exact: true })).toBeVisible();
  await expect(comments.getByText('Some comments are not loaded.', { exact: true })).toHaveCount(0);
  await captureConfirmedReply(
    page,
    'gap-filled-deduplicated',
    comments.getByText('Second own gap comment', { exact: true }),
  );
  await expect(rows.locator(':scope > article.comment')).toHaveCount(24);
  expect(
    await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('article')?.getAttribute('data-resource-id')),
    ),
  ).toEqual(ordered);
  expect(
    await ownHandle!.evaluate(
      (original, current) => original === current,
      await ownDraft.elementHandle(),
    ),
  ).toBe(true);
  await expect(ownDraft).toHaveValue('Draft on a provisional row');
  expect(
    await ownDraft.evaluate((node: HTMLTextAreaElement) => [
      node.selectionStart,
      node.selectionEnd,
    ]),
  ).toEqual([3, 8]);
  expect(
    await dirtyHandle!.evaluate(
      (original, current) => original === current,
      await dirty.elementHandle(),
    ),
  ).toBe(true);
  await expect(dirty).toHaveValue('Unrelated draft stays here');
  const revisedOlder = await external.client.call('/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: ordered[0]!,
    expected_revision_id: originalRevisions.get(ordered[0]!),
    title: null,
    content: text('Gap comment 1 edited after later posts'),
  });
  expect(revisedOlder.status).toBe(201);
  await page.reload();
  for (let pageIndex = 1; pageIndex < 4; pageIndex++) {
    await comments.getByRole('button', { name: 'Load more comments' }).click();
    await expect(rows).toHaveCount(Math.min(6 * (pageIndex + 1), 24));
  }
  await expect(
    comments.getByText('Gap comment 1 edited after later posts', { exact: true }),
  ).toBeVisible();
  await expect(rows.locator(':scope > article.comment')).toHaveCount(24);
  expect(
    await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector('article')?.getAttribute('data-resource-id')),
    ),
  ).toEqual(ordered);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a confirmed reply with a failed content read retries display without another publication', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const opening = page.locator('.conversation-content > article.post');
  const comments = page.locator('.conversation-content > .comment-tree');
  await expect(comments.getByText('No comments yet.')).toBeVisible();
  let postedId = '';
  let posts = 0;
  let displayReads = 0;
  await page.route('**/api/v1/replies', async (route) => {
    posts++;
    const response = await route.fetch();
    postedId = (await response.json()).resource_id;
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/contributions/*/context', async (route) => {
    if (!postedId || !route.request().url().includes(`/contributions/${postedId}/context`))
      return route.continue();
    displayReads++;
    if (displayReads === 1) return route.abort('connectionfailed');
    return route.continue();
  });
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening
    .getByLabel('Your reply', { exact: true })
    .fill('Confirmed but initially unavailable');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(opening.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(comments.getByText('Reply posted, but it could not be displayed.')).toBeVisible();
  await expect(comments.getByRole('button', { name: 'Show replies' })).toHaveCount(0);
  await captureConfirmedReply(
    page,
    'confirmed-display-failed',
    comments.getByText('Reply posted, but it could not be displayed.'),
    ['The first authorized contribution-context read was deliberately aborted.'],
  );
  await expect(
    comments.getByText('Confirmed but initially unavailable', { exact: true }),
  ).toHaveCount(0);
  await comments.getByRole('button', { name: 'Retry loading reply' }).click();
  await expect(
    comments.getByText('Confirmed but initially unavailable', { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(displayReads).toBe(2);
  await page.unrouteAll({ behavior: 'wait' });
});

test('a depth-limit reply confirms under its actual parent and opens its focused destination', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const external = await agent(page, server);
  const create = async (parentId: string, body: string) => {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: parentId,
      content: text(body),
    });
    expect(result.status).toBe(201);
    return result.body.resource_id as string;
  };
  const parent = await create(discussion.resource, 'Depth parent');
  const nested = await create(parent, 'Depth nested parent');
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const parentBranch = page
    .locator('.conversation-content > .comment-tree > .comment-branch')
    .first();
  await parentBranch.getByRole('button', { name: 'Show replies' }).click();
  const nestedBranch = parentBranch
    .locator(':scope > .comment-children > .comment-tree > .comment-branch')
    .first();
  const nestedPost = nestedBranch.locator(`article[data-resource-id="${nested}"]`);
  await expect(nestedPost.getByText('Depth nested parent', { exact: true })).toBeVisible();
  await nestedPost.getByRole('button', { name: 'Reply', exact: true }).click();
  await nestedPost.getByLabel('Your reply', { exact: true }).fill('Beyond inline depth');
  await nestedPost.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(nestedPost.getByText('Reply posted', { exact: true })).toBeVisible();
  await captureConfirmedReply(
    page,
    'depth-limit-confirmed',
    nestedPost.getByText('Reply posted', { exact: true }),
  );
  await expect(nestedPost.getByLabel('Your reply', { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/loom/discussion/${discussion.discussion}$`));
  const link = nestedPost.getByRole('link', { name: 'View reply' });
  await expect(link).toHaveAttribute(
    'href',
    new RegExp(`^/loom/discussion/${discussion.discussion}\\?focus=`),
  );
  await expect(nestedBranch.locator(':scope > .comment-children')).toHaveCount(0);
  await link.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await expect(
    page
      .locator('.reading-grid > div > article.comment')
      .getByText('Beyond inline depth', { exact: true }),
  ).toBeVisible();
  await captureConfirmedReply(
    page,
    'depth-limit-focused',
    page.locator('.reading-grid > div > article.comment'),
  );
});

test('late confirmation keeps a deliberately hidden branch and moved keyboard focus', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const external = await agent(page, server);
  const seed = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: discussion.resource,
    content: text('Pending parent'),
  });
  expect(seed.status).toBe(201);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const parent = page.locator('.conversation-content > .comment-tree > .comment-branch').first();
  await parent.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(parent.getByRole('button', { name: 'Hide replies' })).toBeVisible();
  await parent.getByLabel('Your reply', { exact: true }).fill('Late confirmed child');
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/replies', async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  await parent.getByRole('button', { name: 'Post reply', exact: true }).click();
  await ready;
  await parent.getByRole('button', { name: 'Hide replies' }).click();
  const details = page.locator('.discussion-details > summary');
  await details.focus();
  release();
  await expect(parent.getByText('Reply posted', { exact: true })).toBeVisible();
  await expect(parent.locator(':scope > .comment-children')).toBeHidden();
  await expect(details).toBeFocused();
  await parent.getByRole('button', { name: 'Show replies' }).click();
  await expect(parent.getByText('Late confirmed child', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
});

test('continuous comments and replies retain earlier rows, editors, focus and recovery', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const discussion = await createDiscussion(page);
  const external = await agent(page, server);
  const roots: string[] = [];
  for (let index = 1; index <= 14; index++) {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: discussion.resource,
      content: text(`Continuous comment ${index}`),
    });
    expect(result.status).toBe(201);
    roots.push(result.body.resource_id);
  }
  const direct: string[] = [];
  for (let index = 1; index <= 8; index++) {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: roots[0],
      content: text(`Direct reply ${index}`),
    });
    expect(result.status).toBe(201);
    direct.push(result.body.resource_id);
  }
  const lateReply = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: roots[12],
    content: text('Reply beneath later comment'),
  });
  expect(lateReply.status).toBe(201);
  await page.goto(server.origin + `/loom/discussion/${discussion.discussion}`);
  const capture = async (
    state: string,
    target: ReturnType<Page['locator']>,
    failures: string[] = [],
  ) => {
    if (process.env.LOOM_CONTINUOUS_REVIEW !== '1') return;
    if (state === 'focused-thread')
      await expect(page.locator('.ancestors .ancestor-row')).toHaveCount(2);
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      if (
        state === 'thread-presentation' ||
        state === 'focused-thread' ||
        state === 'page-two-unavailable'
      )
        await target.evaluate((node) => node.scrollIntoView({ block: 'start' }));
      else await target.scrollIntoViewIfNeeded();
      await captureContinuousDiscussion(page, state, failures);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  const root = page.locator('.conversation-content > .comment-tree');
  const rootRows = root.locator(':scope > .comment-branch');
  await expect(root.getByText('6 comments loaded', { exact: true })).toBeVisible();
  await expect(rootRows).toHaveCount(6);
  await capture('before-append', root.getByText('6 comments loaded', { exact: true }));
  const first = rootRows.first();
  await first.getByRole('button', { name: 'Show replies' }).click();
  const replies = first.locator(':scope > .comment-children > .comment-tree');
  await expect(replies.getByText('6 replies loaded', { exact: true })).toBeVisible();
  const overviewSibling = rootRows.nth(2);
  await overviewSibling.getByRole('button', { name: /Collapse comment by/ }).click();
  await capture('thread-overview', first.locator('article').first());
  let failedCursor = '';
  let retryCursor = '';
  await page.route(`**/api/v1/contributions/${roots[0]}/children?*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) return route.continue();
    if (!failedCursor) {
      failedCursor = cursor;
      await route.abort('connectionfailed');
    } else {
      retryCursor = cursor;
      await route.continue();
    }
  });
  await replies.getByRole('button', { name: 'Load more replies' }).click();
  await expect(replies.getByRole('button', { name: 'Retry replies' })).toBeVisible();
  await expect(replies.getByText('Direct reply 1', { exact: true })).toBeVisible();
  await expect(replies.locator(':scope > .comment-branch')).toHaveCount(6);
  await capture('continuation-failure', replies.getByRole('button', { name: 'Retry replies' }), [
    'One direct-reply continuation request was deliberately aborted.',
  ]);
  await replies.getByRole('button', { name: 'Retry replies' }).click();
  await expect(replies.getByText('8 replies loaded', { exact: true })).toBeVisible();
  expect(retryCursor).toBe(failedCursor);
  await capture('reply-complete', replies.getByText('8 replies loaded', { exact: true }));
  expect(
    await replies
      .locator(':scope > .comment-branch')
      .evaluateAll((nodes) =>
        nodes.map((node) =>
          node.querySelector('[data-resource-id]')?.getAttribute('data-resource-id'),
        ),
      ),
  ).toEqual(direct);
  await page.unrouteAll({ behavior: 'wait' });
  let readsOnReopen = 0;
  await page.route(`**/api/v1/contributions/${roots[0]}/children?*`, async (route) => {
    readsOnReopen++;
    await route.continue();
  });
  const firstArticle = first.locator('article').first();
  const articleHandle = await firstArticle.elementHandle();
  await firstArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const editor = firstArticle.getByLabel('Your reply', { exact: true });
  await editor.fill('A retained draft');
  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 7));
  const editorHandle = await editor.elementHandle();
  const collapse = firstArticle.getByRole('button', { name: /Collapse comment by/ });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  const controlled = await collapse.getAttribute('aria-controls');
  expect(controlled).toBeTruthy();
  await expect(firstArticle.locator(`[id="${controlled}"]`)).toBeVisible();
  await editor.focus();
  await collapse.evaluate((button: HTMLButtonElement) => button.click());
  const expand = firstArticle.getByRole('button', { name: /Expand comment by/ });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(expand).toBeFocused();
  await expect(firstArticle.getByText('Continuous comment 1', { exact: true })).toBeHidden();
  await expect(first.locator(':scope > .comment-children')).toBeHidden();
  await expect(rootRows.nth(1).getByText('Continuous comment 2')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  await expand.focus();
  await expand.press('Enter');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.press('Space');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.press('Enter');
  await expect(first.locator(':scope > .comment-children')).toBeVisible();
  await expect(editor).toHaveValue('A retained draft');
  expect(
    await editorHandle!.evaluate(
      (original, current) => original === current,
      await editor.elementHandle(),
    ),
  ).toBe(true);
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
  ).toEqual([2, 7]);
  await expect(replies.getByText('8 replies loaded', { exact: true })).toBeVisible();
  expect(readsOnReopen).toBe(0);
  await capture('dirty-reply-restored', editor);
  await page.unrouteAll({ behavior: 'wait' });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let rootAppendRequests = 0;
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue();
    rootAppendRequests++;
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  const pendingLoad = root.getByRole('button', { name: 'Load more comments' });
  await pendingLoad.focus();
  await pendingLoad.press('Enter');
  await ready;
  await expect(pendingLoad).toBeFocused();
  await expect(pendingLoad).toHaveAttribute('aria-disabled', 'true');
  await pendingLoad.evaluate((button: HTMLButtonElement) => button.click());
  expect(rootAppendRequests).toBe(1);
  await editor.focus();
  await editor.fill('A retained draft while loading');
  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 11));
  await capture('pending-continuation', editor);
  await capture('pending-boundary', root.getByText('Loading comments…', { exact: true }));
  const more = firstArticle.locator('.message-details > summary');
  await more.click();
  await firstArticle.getByRole('button', { name: 'Mark unread' }).click();
  await expect(firstArticle.getByRole('status', { name: 'Unread revision' })).toBeVisible();
  await capture('more-open', more);
  await more.click();
  await editor.focus();
  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 11));
  const beforeTop = await firstArticle.evaluate((node) => node.getBoundingClientRect().top);
  release();
  await expect(root.getByText('12 comments loaded', { exact: true })).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('A retained draft while loading');
  await expect(firstArticle.getByRole('status', { name: 'Unread revision' })).toBeVisible();
  expect(
    await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]),
  ).toEqual([2, 11]);
  expect(
    await page.evaluate(
      (node) =>
        node ===
        document.querySelector('.conversation-content > .comment-tree > .comment-branch article'),
      articleHandle,
    ),
  ).toBe(true);
  expect(
    Math.abs((await firstArticle.evaluate((node) => node.getBoundingClientRect().top)) - beforeTop),
  ).toBeLessThan(28);
  expect(await replies.locator(':scope > .comment-branch').count()).toBe(8);
  await capture('accumulated-with-draft', root.getByText('12 comments loaded', { exact: true }));
  await page.unrouteAll({ behavior: 'wait' });
  const load = root.getByRole('button', { name: 'Load more comments' });
  await load.focus();
  await load.press('Enter');
  const completed = root.getByText('No more comments right now.', { exact: true });
  await expect(completed).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(root.getByRole('button', { name: 'Refresh comments' })).toBeFocused();
  await expect(rootRows).toHaveCount(14);
  await expect(root.getByText('Continuous comment 14', { exact: true })).toBeVisible();
  expect(
    await rootRows.evaluateAll((nodes) =>
      nodes.map((node) =>
        node.querySelector('[data-resource-id]')?.getAttribute('data-resource-id'),
      ),
    ),
  ).toEqual(roots);
  await expect(load).toHaveCount(0);
  await expect(editor).toHaveValue('A retained draft while loading');
  await capture('completed-continuation', root.getByText('14 comments loaded', { exact: true }));
  await capture('completed-tail', rootRows.last());
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(root.getByText('14 comments loaded', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('A retained draft while loading');
  await expect(replies.getByText('8 replies loaded', { exact: true })).toBeVisible();
  const later = rootRows.nth(12);
  await later.getByRole('button', { name: 'Show replies' }).click();
  const laterChild = later.locator('.comment-children .comment-branch').first();
  await expect(laterChild.getByText('Reply beneath later comment')).toBeVisible();
  const thread = laterChild.getByRole('link', { name: 'Continue this thread →' });
  await thread.scrollIntoViewIfNeeded();
  const anchorTop = await laterChild
    .locator('[data-resource-id]')
    .first()
    .evaluate((node) => node.getBoundingClientRect().top);
  await thread.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await capture('focused-thread', page.locator('.focus-banner'));
  const focusArticle = page.locator('.reading-grid > div > article.comment');
  await focusArticle.getByRole('button', { name: /Collapse comment by/ }).click();
  await expect(focusArticle.locator('.prose')).toBeHidden();
  await expect(page.locator('.reading-grid > div > .comment-tree')).toBeHidden();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(root.getByText('14 comments loaded', { exact: true })).toBeVisible();
  await expect(laterChild.getByText('Reply beneath later comment')).toBeVisible();
  await expect(editor).toHaveValue('A retained draft while loading');
  await expect(laterChild.locator('[data-resource-id]').first()).toBeFocused();
  await expect
    .poll(async () =>
      Math.abs(
        (await laterChild
          .locator('[data-resource-id]')
          .first()
          .evaluate((node) => node.getBoundingClientRect().top)) - anchorTop,
      ),
    )
    .toBeLessThan(8);
  await capture('restored-later-page', laterChild);
  await thread.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await expect(focusArticle.getByRole('button', { name: /Expand comment by/ })).toBeVisible();
  await focusArticle.getByRole('button', { name: /Expand comment by/ }).click();
  await expect(focusArticle.locator('.prose')).toBeVisible();
  let failedReturnCursor = '';
  let retriedReturnCursor = '';
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) return route.continue();
    if (!failedReturnCursor) {
      failedReturnCursor = cursor;
      return route.abort('connectionfailed');
    }
    if (!retriedReturnCursor) retriedReturnCursor = cursor;
    return route.continue();
  });
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(root.getByText('6 comments loaded', { exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Retry comments' })).toBeVisible();
  await expect(root.getByText('Continuous comment 1', { exact: true })).toBeVisible();
  await expect(root.getByText('Continuous comment 13', { exact: true })).toHaveCount(0);
  await root.getByRole('button', { name: 'Retry comments' }).click();
  await expect(root.getByText('14 comments loaded', { exact: true })).toBeVisible();
  expect(retriedReturnCursor).toBe(failedReturnCursor);
  await expect(laterChild.getByText('Reply beneath later comment', { exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  await thread.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await page.route(`**/api/v1/contributions/${roots[12]}/children?*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      body: JSON.stringify({ ...body, items: [], complete: true, next_cursor: null }),
    });
  });
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(root.getByText('14 comments loaded', { exact: true })).toBeVisible();
  await expect(later.getByText('No replies yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('The earlier reading position is unavailable.')).toBeVisible();
  await expect(page.getByText('Reply beneath later comment', { exact: true })).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' });

  const otherArticle = rootRows.nth(1).locator('article').first();
  await otherArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const otherEditor = otherArticle.getByLabel('Your reply', { exact: true });
  await otherEditor.fill('Another private draft remains here');
  await firstArticle.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(replies.getByText('9 replies loaded', { exact: true })).toBeVisible();
  await expect(otherEditor).toHaveValue('Another private draft remains here');
  await expect(root.getByText('14 comments loaded', { exact: true })).toBeVisible();
  const opening = page.locator('.conversation-content > article.post');
  await opening.getByRole('button', { name: 'Reply', exact: true }).click();
  await opening.getByLabel('Your reply', { exact: true }).fill('New opening comment');
  await opening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(root.getByText('15 comments loaded', { exact: true })).toBeVisible();
  await expect(otherEditor).toHaveValue('Another private draft remains here');
  await replies
    .locator(':scope > .comment-branch')
    .first()
    .locator('.message-details > summary')
    .click();
  await replies
    .locator(':scope > .comment-branch')
    .first()
    .getByRole('link', { name: 'View parent thread' })
    .click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  const focusedReplies = page.locator('.reading-grid > div > .comment-tree');
  await expect(focusedReplies.getByText('7 replies loaded', { exact: true })).toBeVisible();
  await focusedReplies.getByRole('button', { name: 'Load more replies' }).click();
  await expect(focusedReplies.getByText('9 replies loaded', { exact: true })).toBeVisible();
  const focusedParent = page.locator('.reading-grid > div > article.comment');
  await focusedParent.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(focusedParent.getByLabel('Your reply', { exact: true })).toHaveValue('');
  await focusedParent.getByLabel('Your reply', { exact: true }).fill('Focused reply after loading');
  await focusedParent.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(focusedReplies.getByText('10 replies loaded', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(root.getByText('15 comments loaded', { exact: true })).toBeVisible();
  await expect(replies.getByText('10 replies loaded', { exact: true })).toBeVisible();
  await expect(otherEditor).toHaveValue('Another private draft remains here');
  for (let index = 16; index <= 28; index++) {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: discussion.resource,
      content: text(`Continuous comment ${index}`),
    });
    expect(result.status).toBe(201);
    roots.push(result.body.resource_id);
  }
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(root.getByText('18 comments loaded', { exact: true })).toBeVisible();
  let firstPageRequests = 0;
  let mode: 'invalidate' | 'rebuilding' | 'nonprogress' | 'empty' | 'normal' = 'invalidate';
  let invalidCursor = '';
  let recoveredCursor = '';
  let retriedCursor = '';
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) {
      firstPageRequests++;
      return route.continue();
    }
    if (mode === 'invalidate') {
      mode = 'rebuilding';
      invalidCursor = cursor;
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'invalid_cursor', message: 'Cursor invalid', recovery: 'replay_view' },
        }),
      });
    }
    if (mode === 'nonprogress') {
      mode = 'empty';
      recoveredCursor = cursor;
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({
        response,
        body: JSON.stringify({ ...body, items: [], complete: false, next_cursor: cursor }),
      });
    }
    if (mode === 'empty') {
      mode = 'normal';
      retriedCursor = cursor;
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({
        response,
        body: JSON.stringify({ ...body, items: [], complete: false }),
      });
    }
    return route.continue();
  });
  await root.getByRole('button', { name: 'Load more comments' }).click();
  await expect.poll(() => firstPageRequests).toBeGreaterThan(0);
  await expect(root).toHaveAttribute('aria-busy', 'false');
  await expect(root.getByRole('button', { name: 'Load more comments' })).toBeVisible();
  expect(invalidCursor).toBeTruthy();
  mode = 'nonprogress';
  await root.getByRole('button', { name: 'Load more comments' }).click();
  await expect(root.getByRole('button', { name: 'Retry comments' })).toBeVisible();
  await expect(root.getByText('18 comments loaded', { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Retry comments' }).click();
  await expect(root.getByRole('button', { name: 'Load more comments' })).toBeVisible();
  expect(retriedCursor).toBe(recoveredCursor);
  expect(recoveredCursor).not.toBe(invalidCursor);
  await expect(root.getByText('18 comments loaded', { exact: true })).toBeVisible();
  await expect(root.getByText('No comments yet.', { exact: true })).toHaveCount(0);
  await root.getByRole('button', { name: 'Load more comments' }).click();
  await expect(root.getByText('22 comments loaded', { exact: true })).toBeVisible();
  await expect(root.getByText('Continuous comment 28', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });

  // A ninth accepted page must remain mounted while the bounded refresh stages
  // its first eight pages, including the editor and branch on the loaded tail.
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(root.getByText('28 comments loaded', { exact: true })).toBeVisible();
  for (let index = 29; index <= 54; index++) {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion.discussion,
      parent_id: discussion.resource,
      content: text(`Continuous comment ${index}`),
    });
    expect(result.status).toBe(201);
    roots.push(result.body.resource_id);
  }
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(root.getByText('28 comments loaded', { exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('aria-busy', 'false');
  while ((await rootRows.count()) < 54) {
    const before = await rootRows.count();
    await root.getByRole('button', { name: 'Load more comments' }).click();
    await expect.poll(() => rootRows.count()).toBeGreaterThan(before);
    await expect(root).toHaveAttribute('aria-busy', 'false');
  }
  await expect(root.getByText('54 comments loaded', { exact: true })).toBeVisible();
  const collapsedSibling = rootRows.nth(1);
  await collapsedSibling.getByRole('button', { name: /Collapse comment by/ }).click();
  await expect(collapsedSibling.getByRole('button', { name: /Expand comment by/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const laterBranch = rootRows.nth(42);
  await expect(laterBranch.getByText('Continuous comment 43', { exact: true })).toBeVisible();
  const laterBranchReply = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: roots[41],
    content: text('Reply beneath comment 43'),
  });
  expect(laterBranchReply.status).toBe(201);
  await laterBranch.getByRole('button', { name: 'Show replies' }).click();
  await expect(laterBranch.getByText('Reply beneath comment 43', { exact: true })).toBeVisible();
  const laterBranchThread = laterBranch.getByRole('link', { name: 'Continue this thread →' });
  await laterBranchThread.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(rootRows).toHaveCount(48);
  await expect(collapsedSibling.getByRole('button', { name: /Expand comment by/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(collapsedSibling.getByText('Continuous comment 2', { exact: true })).toBeHidden();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await expect(laterBranch.getByText('Reply beneath comment 43', { exact: true })).toBeVisible();
  await capture(
    'partial-return-first',
    root.getByRole('button', { name: 'Continue restoring comments' }),
  );
  await laterBranchThread.scrollIntoViewIfNeeded();
  const laterReplyArticle = laterBranch.locator('article[data-resource-id]').last();
  const secondReturnTop = await laterReplyArticle.evaluate(
    (node) => node.getBoundingClientRect().top,
  );
  await laterBranchThread.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(rootRows).toHaveCount(48);
  await expect(collapsedSibling.getByRole('button', { name: /Expand comment by/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(collapsedSibling.getByText('Continuous comment 2', { exact: true })).toBeHidden();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await expect(laterBranch.getByText('Reply beneath comment 43', { exact: true })).toBeVisible();
  await expect(laterReplyArticle).toBeFocused();
  await expect
    .poll(async () =>
      Math.abs(
        (await laterReplyArticle.evaluate((node) => node.getBoundingClientRect().top)) -
          secondReturnTop,
      ),
    )
    .toBeLessThan(8);
  await expect(otherEditor).toHaveValue('Another private draft remains here');
  await capture(
    'partial-return-second',
    root.getByRole('button', { name: 'Continue restoring comments' }),
  );
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  await expect(rootRows).toHaveCount(54);
  await expect(collapsedSibling.getByRole('button', { name: /Expand comment by/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(collapsedSibling.getByText('Continuous comment 2', { exact: true })).toBeHidden();
  await expect(root.getByText('Continuous comment 54', { exact: true })).toBeVisible();
  const tail = rootRows.last();
  await tail.getByRole('button', { name: 'Show replies' }).click();
  await expect(tail.getByText('No replies yet.', { exact: true })).toBeVisible();
  const tailArticle = tail.locator('article').first();
  const tailHandle = await tailArticle.elementHandle();
  await tailArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const tailEditor = tailArticle.getByLabel('Your reply', { exact: true });
  await tailEditor.fill('A draft on the ninth page');
  await tailEditor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 9));
  await rootRows.nth(25).scrollIntoViewIfNeeded();
  let releaseRefresh!: () => void;
  let refreshStarted!: () => void;
  const heldRefresh = new Promise<void>((resolve) => (releaseRefresh = resolve));
  const refreshReady = new Promise<void>((resolve) => (refreshStarted = resolve));
  let holdFirst = true;
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    if (!holdFirst || new URL(route.request().url()).searchParams.has('cursor'))
      return route.continue();
    holdFirst = false;
    const response = await route.fetch();
    refreshStarted();
    await heldRefresh;
    await route.fulfill({ response });
  });
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await refreshReady;
  await expect(rootRows).toHaveCount(54);
  await capture('pending-refresh-long-window', rootRows.nth(25));
  await rootRows.nth(25).scrollIntoViewIfNeeded();
  const startingScroll = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(startingScroll + 400);
  const readerScroll = await page.evaluate(() => scrollY);
  releaseRefresh();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await expect(rootRows).toHaveCount(54);
  await expect(tailEditor).toHaveValue('A draft on the ninth page');
  await expect(tail.getByText('No replies yet.', { exact: true })).toBeVisible();
  expect(await page.evaluate((node) => node?.isConnected, tailHandle)).toBe(true);
  expect(Math.abs((await page.evaluate(() => scrollY)) - readerScroll)).toBeLessThan(40);
  await capture(
    'bounded-refresh-long-window',
    root.getByRole('button', { name: 'Continue restoring comments' }),
  );
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  await expect(root.getByText('54 comments loaded', { exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toHaveCount(0);
  await expect(tailEditor).toHaveValue('A draft on the ninth page');
  expect(await page.evaluate((node) => node?.isConnected, tailHandle)).toBe(true);
  await page.unrouteAll({ behavior: 'wait' });

  // A separately known publication must not turn the saved 54-row tail into a
  // 55-row automatic restoration goal after a focused round trip.
  const longOpening = page.locator('.conversation-content > article.post');
  await longOpening.getByRole('button', { name: 'Reply', exact: true }).click();
  await longOpening.getByLabel('Your reply', { exact: true }).fill('Known beyond the long window');
  await longOpening.getByRole('button', { name: 'Post reply', exact: true }).click();
  await expect(root.getByText('Known beyond the long window', { exact: true })).toBeVisible();
  await expect(root.getByText('55 comments loaded', { exact: true })).toBeVisible();
  await expect(root.getByText('Some comments are not loaded.', { exact: true })).toBeVisible();
  let knownReturnReads = 0;
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    knownReturnReads++;
    await route.continue();
  });
  await laterBranchThread.click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(rootRows).toHaveCount(49);
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  expect(knownReturnReads).toBeLessThanOrEqual(8);
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  await expect(rootRows).toHaveCount(55);
  await expect(root.getByText('Known beyond the long window', { exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });

  // A partial negative projection on page two withdraws older leases, while
  // its own structural entry and later readable siblings still progress.
  const eligibleDescendant = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: roots[6],
    content: text('Eligible descendant of unavailable comment'),
  });
  expect(eligibleDescendant.status).toBe(201);
  const withdrawing = rootRows.nth(6);
  await withdrawing.getByRole('button', { name: /Collapse comment by/ }).click();
  await expect(withdrawing.getByText('Continuous comment 7', { exact: true })).toBeHidden();
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
    roots[6],
  ]);
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  await expect(root.getByText('Continuous comment 8', { exact: true })).toBeVisible();
  await expect(root.getByText('Continuous comment 1', { exact: true })).toHaveCount(0);
  const unavailable = root.locator('.comment-branch').filter({
    has: page.locator(`[data-resource-id="${roots[6]}"]`),
  });
  await expect(unavailable.getByText('Contribution unavailable', { exact: true })).toBeVisible();
  await expect(unavailable.locator('article')).toHaveCount(0);
  await expect(unavailable.getByText('Continuous comment 7', { exact: true })).toHaveCount(0);
  await unavailable.getByRole('button', { name: 'Show replies' }).click();
  await expect(unavailable.getByText('Eligible descendant of unavailable comment')).toBeVisible();
  const descendantThread = unavailable.getByRole('link', { name: 'Continue this thread →' });
  await descendantThread.click();
  await page.getByRole('button', { name: 'Refresh branch' }).click();
  await expect(page.getByText('Focused branch', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  await expect(unavailable.getByText('Eligible descendant of unavailable comment')).toBeVisible();
  await expect(root.getByText('Continuous comment 54', { exact: true })).toBeVisible();
  await expect(root.getByText('Continuous comment 1', { exact: true })).toHaveCount(0);
  const afterUnavailable = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: discussion.discussion,
    parent_id: discussion.resource,
    content: text('After unavailable page'),
  });
  expect(afterUnavailable.status).toBe(201);
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  let markStaleReady!: () => void;
  let releaseStale!: () => void;
  const staleReady = new Promise<void>((resolve) => (markStaleReady = resolve));
  const heldStaleResponse = new Promise<void>((resolve) => (releaseStale = resolve));
  let heldStale = false;
  await page.route(`**/api/v1/contributions/${discussion.resource}/children?*`, async (route) => {
    if (heldStale || !new URL(route.request().url()).searchParams.has('cursor'))
      return route.continue();
    heldStale = true;
    const response = await route.fetch();
    markStaleReady();
    await heldStaleResponse;
    await route.fulfill({ response });
  });
  await root.getByRole('button', { name: 'Load more comments' }).click();
  await staleReady;
  await unavailable.locator('.message-details > summary').click();
  await unavailable.getByRole('button', { name: 'Preview parent' }).click();
  await expect(page.getByText('Parent unavailable.', { exact: true })).toBeVisible();
  releaseStale();
  await expect(root).toHaveAttribute('aria-busy', 'false');
  await expect(root.getByRole('button', { name: 'Continue restoring comments' })).toBeVisible();
  await expect(root.getByText('Continuous comment 1', { exact: true })).toHaveCount(0);
  await root.getByRole('button', { name: 'Continue restoring comments' }).click();
  await expect(root.getByRole('button', { name: 'Load more comments' })).toBeVisible();
  const finalLoad = root.getByRole('button', { name: 'Load more comments' });
  await finalLoad.focus();
  await finalLoad.press('Enter');
  await expect(root.getByText('After unavailable page', { exact: true })).toBeVisible();
  await expect(root.getByText('Continuous comment 8', { exact: true })).toBeVisible();
  await expect(root.getByRole('button', { name: 'Refresh comments' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.unrouteAll({ behavior: 'wait' });

  // Reproduce the original six-row failure directly: page two contains an
  // unavailable child, followed by an eligible sibling and descendant.
  const pageTwo = await createDiscussion(page, 'Unavailable second page');
  const pageTwoIds: string[] = [];
  for (let index = 1; index <= 8; index++) {
    const result = await external.client.call('/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: pageTwo.discussion,
      parent_id: pageTwo.resource,
      content: text(`Second-page comment ${index}`),
    });
    expect(result.status).toBe(201);
    pageTwoIds.push(result.body.resource_id);
  }
  const pageTwoChild = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: pageTwo.discussion,
    parent_id: pageTwoIds[6],
    content: text('Second-page eligible descendant'),
  });
  expect(pageTwoChild.status).toBe(201);
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
    pageTwoIds[6],
  ]);
  await page.goto(server.origin + `/loom/discussion/${pageTwo.discussion}`);
  await expect(root.getByText('6 comments loaded', { exact: true })).toBeVisible();
  await root.getByRole('button', { name: 'Load more comments' }).click();
  await expect(root.getByText('Second-page comment 8', { exact: true })).toBeVisible();
  await expect(root.getByText('Second-page comment 1', { exact: true })).toHaveCount(0);
  const unavailableOnPageTwo = root.locator(':scope > .comment-branch').filter({
    has: page.locator(`[data-resource-id="${pageTwoIds[6]}"]`),
  });
  await expect(
    unavailableOnPageTwo.getByText('Contribution unavailable', { exact: true }),
  ).toBeVisible();
  await unavailableOnPageTwo.getByRole('button', { name: 'Show replies' }).click();
  await expect(unavailableOnPageTwo.getByText('Second-page eligible descendant')).toBeVisible();
  await capture('page-two-unavailable', unavailableOnPageTwo, [
    'Synthetic comment 7 was deliberately suppressed before the second-page request.',
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  const visual = await createDiscussion(page, 'A conversation with human and agent replies');
  const longName = 'research_agent_with_long_name_01';
  const namedAgent = await agent(page, server, longName);
  const human = await api(page, '/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: visual.discussion,
    parent_id: visual.resource,
    content: text('A human thought: let us compare the evidence together.'),
  });
  expect(human.status()).toBe(201);
  const agentRoot = await namedAgent.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: visual.discussion,
    parent_id: visual.resource,
    content: text('The agent adds a concise observation.'),
  });
  expect(agentRoot.status).toBe(201);
  const sibling = await external.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: visual.discussion,
    parent_id: visual.resource,
    content: text('A separate sibling comment.'),
  });
  expect(sibling.status).toBe(201);
  const child = await namedAgent.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: visual.discussion,
    parent_id: agentRoot.body.resource_id,
    content: text('A direct reply with a deeper route.'),
  });
  expect(child.status).toBe(201);
  await page.goto(server.origin + `/loom/discussion/${visual.discussion}`);
  await expect(rootRows).toHaveCount(3);
  const visualAgent = rootRows.nth(1);
  await visualAgent.getByRole('button', { name: 'Show replies' }).click();
  await expect(visualAgent.getByText('A direct reply with a deeper route.')).toBeVisible();
  await rootRows
    .nth(2)
    .getByRole('button', { name: /Collapse comment by/ })
    .click();
  await capture('thread-presentation', rootRows.first().locator('article'));
  await page.setViewportSize({ width: 390, height: 844 });
  const longNameArticle = visualAgent.locator(':scope > article.comment');
  const nestedLongNameArticle = visualAgent.locator('.comment-children article.comment').first();
  const assertHeaderClearance = async (article: Locator) => {
    const clearance = await article.evaluate((node) => {
      const control = node.querySelector('.comment-collapse-control')!.getBoundingClientRect();
      const badge = node.querySelector('.author-badge')!.getBoundingClientRect();
      const unread = node.querySelector('.reading-indicator')!.getBoundingClientRect();
      return { controlRight: control.right, badgeLeft: badge.left, unreadLeft: unread.left };
    });
    expect(clearance.badgeLeft).toBeGreaterThanOrEqual(clearance.controlRight + 2);
    expect(clearance.unreadLeft).toBeGreaterThanOrEqual(clearance.controlRight + 2);
  };
  for (const article of [longNameArticle, nestedLongNameArticle]) {
    await article.locator('.message-details > summary').click();
    await article.getByRole('button', { name: 'Mark unread' }).click();
    await expect(article.getByRole('status', { name: 'Unread revision' })).toBeVisible();
    await assertHeaderClearance(article);
  }
  const longContent =
    'Paragraph one remains readable.\n\n' +
    'https://example.org/research/' +
    'very-long-segment-'.repeat(18) +
    '\n\n```ts\nconst evidence = "' +
    'wide-code-'.repeat(20) +
    '";\n```';
  const lengthy = await namedAgent.client.call('/api/v1/replies', {
    idempotency_key: randomUUID(),
    discussion_id: visual.discussion,
    parent_id: visual.resource,
    content: text(longContent),
  });
  expect(lengthy.status).toBe(201);
  await root.getByRole('button', { name: 'Refresh comments' }).click();
  const lengthyArticle = root.locator(`article[data-resource-id="${lengthy.body.resource_id}"]`);
  await expect(lengthyArticle.locator('pre')).toBeVisible();
  await lengthyArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  await lengthyArticle
    .getByLabel('Your reply', { exact: true })
    .fill('A draft beside long content.');
  await lengthyArticle.locator('.message-details > summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await lengthyArticle.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await capture('responsive-content', lengthyArticle);
});

test('overview uses ordinary artifact history/editors; text-artifact drafts survive navigation', async ({
  page,
  context,
  server,
}, testInfo) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  await backToLoom(page);
  await page
    .getByRole('link', { name: /Research commons — Community overview/ })
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: 'Community overview', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Welcome to our shared workspace.', { exact: true })).toBeVisible();
  await page.getByText('Editors', { exact: true }).click();
  await page.getByRole('button', { name: 'Manage editors' }).click();
  await expect(page.getByRole('checkbox', { name: 'synthetic_admin' })).toBeChecked();
  await page.getByRole('button', { name: 'Save editor list' }).click();
  await page.getByRole('button', { name: 'Revision history' }).click();
  await expect(page.getByRole('link').filter({ hasText: 'Revision 1' })).toBeVisible();
  await backToLoom(page);
  await page.getByRole('link', { name: 'Topics', exact: true }).first().click();
  await page.getByRole('link').filter({ hasText: 'General' }).first().click();
  await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
  await page.getByRole('button', { name: 'New text artifact' }).click();
  await page.getByLabel('Title', { exact: true }).fill('A retained working note');
  await page.getByLabel('Text', { exact: true }).fill('Keep this unsent draft through navigation.');
  await page.getByRole('link', { name: 'Participation guide', exact: true }).first().click();
  await page.getByRole('link').filter({ hasText: 'artifact.create · draft' }).click();
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
    'Keep this unsent draft through navigation.',
  );
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Your publication is saved.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Artifacts', exact: true }).first().click();
  await expect(page.getByRole('link').filter({ hasText: 'A retained working note' })).toContainText(
    'General',
  );
  await page.screenshot({
    path: testInfo.outputPath('artifacts-desktop.png'),
    fullPage: true,
  });
  await testInfo.attach('artifacts desktop', {
    path: testInfo.outputPath('artifacts-desktop.png'),
    contentType: 'image/png',
  });
  await backToLoom(page);
  await page.getByRole('link', { name: 'Topics', exact: true }).first().click();
  await page.getByRole('link').filter({ hasText: 'General' }).first().click();
  await page.getByText('About this topic', { exact: true }).click();
  await page.getByRole('button', { name: 'Suggest an organizational change' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Propose a reading topic');
  await page
    .getByLabel('Text', { exact: true })
    .fill('Preserve this proposal with its configured destination.');
  await page.getByRole('link', { name: 'Participation guide', exact: true }).first().click();
  await page.getByRole('link').filter({ hasText: 'discussion.create · draft' }).click();
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
    'Preserve this proposal with its configured destination.',
  );
});

async function savedIntents(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith('loom.intent.v1:'))
      .map((key) => JSON.parse(localStorage.getItem(key)!)),
  );
}

test('review regression: issued secrets stay bound to their target during and after issuance', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  for (const [nickname, kind] of [
    ['credential_human', 'human'],
    ['credential_agent', 'agent'],
  ]) {
    expect(
      (
        await api(page, '/api/v1/identity/accounts', {
          idempotency_key: randomUUID(),
          nickname,
          kind,
          role: 'participant',
        })
      ).status(),
    ).toBe(200);
  }
  await page.reload();
  await page.getByText('Participant accounts', { exact: true }).click();
  const human = page.locator('.list-row').filter({ hasText: 'credential_human' });
  const agent = page.locator('.list-row').filter({ hasText: 'credential_agent' });
  await human.getByRole('button', { name: 'Manage credentials' }).click();
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/v1/identity/credentials', async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Issue enrollment ticket', exact: true }).click();
    await ready;
    // Boolean assertions keep one-time secrets out of failure DOM snapshots.
    expect(await agent.getByRole('button', { name: 'Manage credentials' }).isDisabled()).toBe(true);
    release();
    await expect.poll(async () => page.getByLabel('Issued secret').count()).toBe(1);
    expect(await agent.getByRole('button', { name: 'Manage credentials' }).isDisabled()).toBe(true);
    expect(
      await page
        .getByText('Enrollment ticket for credential_human — shown once', {
          exact: true,
        })
        .count(),
    ).toBe(1);
    const secret = await page.getByLabel('Issued secret').inputValue();
    expect(JSON.stringify(await savedIntents(page)).includes(secret)).toBe(false);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await agent.getByRole('button', { name: 'Manage credentials' }).click();
    expect(await page.getByLabel('Issued secret').count()).toBe(0);
    await expect(
      page.getByRole('button', { name: 'Issue agent credential', exact: true }),
    ).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('review regression: definitive setup rejection can be corrected after reload', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await page.getByLabel('Community name', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Create community', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  const rejected = (await savedIntents(page)).find((r) => r.slot === 'setup');
  expect(rejected.state).toBe('rejected');
  await page.reload();
  await page.getByRole('button', { name: 'Prepare corrected setup' }).click();
  await expect(page.getByLabel('Community name', { exact: true })).toBeEnabled();
  const prepared = (await savedIntents(page)).find((r) => r.slot === 'setup');
  await page.getByLabel('Community name', { exact: true }).fill('Corrected community');
  await expect
    .poll(async () => (await savedIntents(page)).find((r) => r.slot === 'setup')?.body)
    .toEqual({ ...prepared.body, community_name: 'Corrected community' });
  await page.reload();
  await expect(page.getByLabel('Community name', { exact: true })).toHaveValue(
    'Corrected community',
  );
  const corrected = (await savedIntents(page)).find((r) => r.slot === 'setup');
  expect(corrected.key).not.toBe(rejected.key);
  await page.getByRole('button', { name: 'Create community', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Community', exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/loom/admin/community');
  expect(new URL(page.url()).searchParams.get('intent')).toBe(corrected.key);
});

test('review regression: rejected admission preserves editable correction and uncertain retries keep identity', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeDisabled();
  for (const nickname of ['synthetic_admin', 'invalid nickname!']) {
    await page.getByLabel('Nickname', { exact: true }).fill(nickname);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const rejected = (await savedIntents(page)).find((r) => r.slot === 'admission');
    expect(rejected.state).toBe('rejected');
    await page.reload();
    await page.getByRole('button', { name: 'Prepare corrected account operation' }).click();
    await expect(page.getByLabel('Nickname', { exact: true })).toBeEnabled();
    const corrected = (await savedIntents(page)).find((r) => r.slot === 'admission');
    expect(corrected.key).not.toBe(rejected.key);
    await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue(nickname);
  }
  await page.getByLabel('Nickname', { exact: true }).fill('corrected_agent');
  await expect
    .poll(async () => (await savedIntents(page)).find((r) => r.slot === 'admission')?.body.nickname)
    .toBe('corrected_agent');
  await page.reload();
  await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('corrected_agent');
  let original: unknown;
  await page.route('**/api/v1/identity/accounts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    original = route.request().postDataJSON();
    await route.fetch();
    await route.abort('connectionfailed');
  });
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same account creation' })).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
  await page.reload();
  await page.getByText('Participant accounts', { exact: true }).click();
  await expect(page.getByText('corrected_agent · agent · active', { exact: true })).toBeVisible();
  const administrator = await page.evaluate(
    async () => (await (await fetch('/api/v1/identity/self')).json()).participant_id,
  );
  await server.database.transaction((tx) =>
    tx.query("UPDATE loom.participants SET role='participant' WHERE id=$1", [administrator]),
  );
  await page.route('**/api/v1/identity/accounts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    expect(route.request().postDataJSON()).toEqual(original);
    const response = await route.fetch();
    expect(response.status()).toBe(403);
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Retry same account creation' }).click();
  await expect(
    page.getByText('This action requires current administrator authority.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('corrected_agent · agent · active', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('corrected_agent');
  expect(
    await page.evaluate(async () => (await (await fetch('/api/v1/identity/self')).json()).role),
  ).toBe('participant');
  const uncertain = (await savedIntents(page)).find((r) => r.slot === 'admission');
  expect(uncertain.state).toBe('uncertain');
  expect(uncertain.body).toEqual(original);
  expect(
    await page.getByRole('button', { name: 'Prepare corrected account operation' }).count(),
  ).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
  await server.database.transaction((tx) =>
    tx.query("UPDATE loom.participants SET role='administrator' WHERE id=$1", [administrator]),
  );
  await page.getByRole('button', { name: 'Check account operation' }).click();
  await expect(
    page.getByRole('button', { name: 'Issue agent credential', exact: true }),
  ).toBeVisible();

  await reviewAgentAccess(page, server);

  // A selected human account starts from protected metadata, while the pending
  // enrollment request must keep its own private kind through role withdrawal.
  await expect
    .poll(async () => (await savedIntents(page)).find((r) => r.slot === 'admission'))
    .toBeUndefined();
  expect(
    (
      await api(page, '/api/v1/identity/accounts', {
        idempotency_key: randomUUID(),
        nickname: 'human_recovery',
        kind: 'human',
        role: 'participant',
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await page.getByText('Participant accounts', { exact: true }).click();
  await page.getByLabel('Exact account ID or nickname').fill('human_recovery');
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await page
    .locator('.list-row')
    .filter({ hasText: 'human_recovery · human · active' })
    .getByRole('button', { name: 'Manage credentials' })
    .click();
  let releaseSecret!: () => void,
    secretReady = false,
    secretWrites = 0;
  const secretHeld = new Promise<void>((resolve) => {
    releaseSecret = resolve;
  });
  await page.route('**/api/v1/identity/credentials', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    secretWrites++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    secretReady = true;
    await secretHeld;
    await route.fulfill({ response });
  });
  try {
    const sent = page.waitForRequest(
      (r) => r.url().endsWith('/api/v1/identity/credentials') && r.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Issue enrollment ticket', exact: true }).click();
    const original = (await sent).postDataJSON();
    expect(original.kind).toBe('enrollment');
    await expect.poll(() => secretReady).toBe(true);
    await server.database.transaction((tx) =>
      tx.query("UPDATE loom.participants SET role='participant' WHERE id=$1", [administrator]),
    );
    await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
    await expect(page.getByText('human_recovery · human · active', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Issue enrollment ticket', exact: true }),
    ).toBeVisible();
    const retained = (await savedIntents(page)).find((r) => r.slot === 'admission');
    expect(retained.body).toEqual(original);
    releaseSecret();
    await expect(
      page.getByRole('button', { name: 'Check account operation', exact: true }),
    ).toBeEnabled();
    expect((await savedIntents(page)).find((r) => r.slot === 'admission')).toEqual(retained);
    await expect(page.getByLabel('Issued secret', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Issue enrollment ticket', exact: true }),
    ).toBeVisible();
    expect(secretWrites).toBe(1);
  } finally {
    releaseSecret();
    await page.unrouteAll({ behavior: 'wait' });
    await server.database.transaction((tx) =>
      tx.query("UPDATE loom.participants SET role='administrator' WHERE id=$1", [administrator]),
    );
  }
  await page.getByRole('button', { name: 'Check account operation', exact: true }).click();
  await expect(
    page.getByText('Credential issued — secret unavailable', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await savedIntents(page)).find((r) => r.slot === 'admission'))
    .toBeUndefined();
  expect(secretWrites).toBe(1);

  // A late account receipt creates private recovery controls. Mounting those
  // controls must not implicitly start a new credentials read after withdrawal.
  await page.reload();
  await page.getByText('Participant accounts', { exact: true }).click();
  await page.getByLabel('Exact account ID or nickname').fill('human_recovery');
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await expect(page.getByText('human_recovery · human · active', { exact: true })).toBeVisible();
  await page.getByLabel('Nickname', { exact: true }).fill('late_account_recovery');
  let releaseAccount!: () => void,
    accountReady = false,
    credentialReads = 0;
  const accountHeld = new Promise<void>((resolve) => {
    releaseAccount = resolve;
  });
  await page.route('**/api/v1/identity/accounts', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    accountReady = true;
    await accountHeld;
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/identity/credentials/query', async (route) => {
    credentialReads++;
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect.poll(() => accountReady).toBe(true);
    await server.database.transaction((tx) =>
      tx.query("UPDATE loom.participants SET role='participant' WHERE id=$1", [administrator]),
    );
    const refusal = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/v1/identity/accounts/query') &&
        r.request().method() === 'POST' &&
        r.status() === 403,
    );
    await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
    await refusal;
    await expect(page.getByText('human_recovery · human · active', { exact: true })).toHaveCount(0);
    releaseAccount();
    await expect
      .poll(async () => (await savedIntents(page)).find((r) => r.slot === 'admission'))
      .toBeUndefined();
    await expect(
      page.getByRole('button', { name: 'Issue agent credential', exact: true }),
    ).toBeEnabled();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(credentialReads).toBe(0);
    await server.database.transaction((tx) =>
      tx.query("UPDATE loom.participants SET role='administrator' WHERE id=$1", [administrator]),
    );
    await page.getByText('Credentials for this account', { exact: true }).click();
    await page.getByRole('button', { name: 'Refresh credentials', exact: true }).click();
    await expect.poll(() => credentialReads).toBe(1);
  } finally {
    releaseAccount();
    await page.unrouteAll({ behavior: 'wait' });
    await server.database.transaction((tx) =>
      tx.query("UPDATE loom.participants SET role='administrator' WHERE id=$1", [administrator]),
    );
  }
});

async function reviewAgentAccess(page: Page, server: Awaited<ReturnType<typeof syntheticServer>>) {
  const review = await admissionReview(page, 'follow-up'),
    heading = page.getByRole('heading', { name: 'Managing @corrected_agent', exact: true });
  const navigationReview = await adminNavigationReview(page, 'participant-recovery');
  await expect(heading).toBeVisible();
  await expect(
    page.getByText('Account created for @corrected_agent.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Access has not been issued yet. Issue an agent credential next.', {
      exact: true,
    }),
  ).toBeVisible();
  // Fixture-only population below every generated v4 account ID. Real bounded
  // queries must omit the target; navigation still uses ordinary exact lookup.
  const fillers = Array.from(
    { length: 26 },
    (_, i) => `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
  );
  await server.observer.query(
    `INSERT INTO loom.participants(id,state,role,kind,nickname)
  SELECT id::uuid,'active','participant','agent','ux_qa_page_'||ordinality FROM unnest($1::text[]) WITH ORDINALITY AS p(id,ordinality)`,
    [fillers],
  );
  const queryBodies: any[] = [],
    issuanceBodies: any[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/identity/accounts/query'))
      queryBodies.push(request.postDataJSON());
    if (request.url().endsWith('/identity/credentials') && request.method() === 'POST')
      issuanceBodies.push(request.postDataJSON());
  });
  await page.getByRole('button', { name: 'Back to admission', exact: true }).click();
  const summary = page.getByText('Participant accounts', { exact: true });
  if (!(await summary.locator('..').evaluate((element: HTMLDetailsElement) => element.open)))
    await summary.click();
  await page.getByRole('button', { name: 'Refresh accounts', exact: true }).click();
  await expect(page.getByText('Loading accounts page…')).toHaveCount(0);
  await expect(page.getByText('ux_qa_page_1 · agent · active', { exact: true })).toBeVisible();
  await expect(page.getByText('corrected_agent · agent · active', { exact: true })).toHaveCount(0);
  await page.getByLabel('Exact account ID or nickname').fill('corrected_agent');
  await page.getByRole('button', { name: 'Find account', exact: true }).click();
  await page
    .locator('.list-row')
    .filter({ hasText: 'corrected_agent · agent · active' })
    .getByRole('button', { name: 'Manage credentials', exact: true })
    .click();
  await expect(heading).toBeVisible();
  let release!: () => void,
    entered!: () => void,
    writes = 0;
  const held = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  await page.route(
    '**/api/v1/identity/credentials',
    async (route) => {
      writes++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      entered();
      await held;
      await route.abort('failed');
    },
    { times: 1 },
  );
  const issue = page.getByRole('button', { name: 'Issue agent credential', exact: true });
  await issue.focus();
  await page.keyboard.press('Enter');
  await ready;
  const pending = (await savedIntents(page)).find((r) => r.slot === 'admission');
  expect(pending.kind).toBe('credential.issue');
  expect(pending.state).toBe('uncertain');
  try {
    await expect(
      page.getByRole('button', { name: 'Issuing credential…', exact: true }),
    ).toBeDisabled();
    await page.keyboard.press('Enter');
    expect(writes).toBe(1);
    await expect(page.getByText(/Credential issuance is unconfirmed/)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Check credential issuance', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText(/Access has not been issued yet/)).toHaveCount(0);
    await review.capture('off-page-issuance-pending', heading, [
      'Fixture-only 26 lower-ID agent accounts exclude the target from page one. Playwright holds the committed issuance response before dropping it.',
    ]);
  } finally {
    release();
  }
  await expect(
    page.getByRole('button', { name: 'Retry same credential issuance', exact: true }),
  ).toBeEnabled();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByText(/Credential issuance is unconfirmed/)).toBeVisible();
  await review.capture('off-page-issuance-unconfirmed', heading, [
    'Playwright dropped a real committed issuance response. Target was selected by ordinary exact nickname lookup.',
  ]);
  let lookupEntered!: () => void,
    releaseLookup!: () => void,
    metadataReads = 0;
  const lookupReady = new Promise<void>((r) => (lookupEntered = r)),
    lookupHeld = new Promise<void>((r) => (releaseLookup = r));
  await page.route('**/api/v1/identity/accounts/lookup', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ id: pending.body.participant_id });
    metadataReads++;
    if (metadataReads === 1) {
      lookupEntered();
      await lookupHeld;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'service_unavailable',
            message: 'Synthetic participant lookup unavailable',
            recovery: { action: 'retry_same_request' },
          },
        }),
      });
    } else {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response });
    }
  });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.goto(server.origin + '/loom/help');
  await page.getByRole('link', { name: /credential.issue/ }).click();
  await expect(page).toHaveURL(server.origin + '/loom/admin/participants?intent=' + pending.key);
  await lookupReady;
  try {
    await expect(page.getByText('Loading participant details…', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Nickname', { exact: true })).toHaveAttribute(
      'placeholder',
      'Loading nickname…',
    );
    expect((await savedIntents(page)).find((r) => r.slot === 'admission')).toEqual(pending);
    await review.capture(
      'off-page-lookup-loading',
      page.getByRole('heading', { name: 'Managing participant access', exact: true }),
      [
        'One exact-ID metadata lookup is held, then will receive fixture HTTP 503. The saved issuance remains untouched.',
      ],
    );
  } finally {
    releaseLookup();
  }
  await expect(
    page.getByRole('button', { name: 'Retry participant lookup', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Synthetic participant lookup unavailable', { exact: true }),
  ).toBeVisible();
  expect((await savedIntents(page)).find((r) => r.slot === 'admission')).toEqual(pending);
  await review.capture(
    'off-page-lookup-unavailable',
    page.getByRole('heading', { name: 'Managing participant access', exact: true }),
    [
      'One exact-ID metadata lookup received deterministic HTTP 503; credential request/key/body are unchanged.',
    ],
  );
  await page.getByRole('button', { name: 'Check credential issuance', exact: true }).click();
  await expect(
    page.getByText('Credential issued — secret unavailable', { exact: true }),
  ).toBeVisible();
  expect(await page.getByLabel('Issued secret', { exact: true }).count()).toBe(0);
  await page.getByRole('button', { name: 'Retry participant lookup', exact: true }).click();
  await expect(heading).toBeVisible();
  await expect(page.getByLabel('Nickname', { exact: true })).toHaveValue('corrected_agent');
  await expect
    .poll(async () => (await savedIntents(page)).find((r) => r.slot === 'admission'))
    .toBeUndefined();
  expect(issuanceBodies).toEqual([pending.body]);
  expect(metadataReads).toBe(2);
  expect(
    (
      await server.observer.query('SELECT id FROM loom.participants WHERE id=$1', [
        pending.body.participant_id,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await server.observer.query(
        'SELECT count(*)::int n FROM loom.participant_credentials WHERE participant_id=$1',
        [pending.body.participant_id],
      )
    ).rows[0].n,
  ).toBe(1);
  await review.capture('off-page-issuance-recovered', heading, [
    'Earlier committed issuance response was dropped; exact reconciliation and the retried authorized ID lookup are live. No issuance replay or duplicate credential.',
  ]);
  await navigationReview.capture(
    'retained-issuance-recovered',
    [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
    [
      '26 fixture-only lower-ID accounts exclude the target from page one. A real committed credential response was dropped. Navigation left Participants and returned through its Local drafts recovery link. The first exact-ID metadata lookup was held then returned fixture HTTP 503; explicit retry and reconciliation used live authorized endpoints.',
    ],
  );
  await page.unroute('**/api/v1/identity/accounts/lookup');
  await page.getByText('Credentials for this account', { exact: true }).click();
  const credentials = page.getByText('Credentials for this account', { exact: true }).locator('..');
  await expect(credentials.getByText(/Synthetic participation · agent · active/)).toBeVisible();
  await credentials.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(credentials.getByText(/Synthetic participation · agent · revoked/)).toBeVisible();
  await issue.click();
  await expect.poll(async () => page.getByLabel('Issued secret', { exact: true }).count()).toBe(1);
  // Assertions while a secret is visible return booleans, never the credential.
  expect(
    (await page
      .getByText('Agent credential for corrected_agent — shown once', { exact: true })
      .count()) === 1,
  ).toBe(true);
  const secret = await page.getByLabel('Issued secret', { exact: true }).inputValue();
  expect(secret.length > 0).toBe(true);
  expect(JSON.stringify(await savedIntents(page)).includes(secret)).toBe(false);
  page.once('dialog', (d) => {
    expect(d.message()).toContain('one-time credential handoff');
    return d.dismiss();
  });
  // The one-time value stays only in the mounted handoff after cancelled navigation.
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(server.origin + '/loom/admin/participants?intent=' + pending.key);
  expect((await page.getByLabel('Issued secret', { exact: true }).inputValue()) === secret).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Select credential to copy', exact: true }).click();
  expect(
    await page
      .getByLabel('Issued secret', { exact: true })
      .evaluate(
        (element: HTMLTextAreaElement) =>
          document.activeElement === element &&
          element.selectionStart === 0 &&
          element.selectionEnd === element.value.length,
      ),
  ).toBe(true);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(
    await page
      .getByRole('button', { name: 'Done', exact: true })
      .evaluate((element) => document.activeElement === element),
  ).toBe(true);
  await page.keyboard.press('Enter');
  expect(await page.getByLabel('Issued secret', { exact: true }).count()).toBe(0);
  await backToLoom(page);
  await page.getByRole('link', { name: 'Topics', exact: true }).click();
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  await page.getByRole('link', { name: 'Participants', exact: true }).click();
  await page.getByText('Participant accounts', { exact: true }).click();
  const lookup = page.getByLabel('Exact account ID or nickname');
  await lookup.fill('corrected_agent');
  await lookup.press('Enter');
  const row = page.locator('.list-row').filter({ hasText: 'corrected_agent · agent · active' });
  await row.getByRole('button', { name: 'Manage credentials', exact: true }).click();
  await expect(heading).toBeFocused();
  await expect(page.getByText(/Account created/)).toHaveCount(0);
  await page.getByText('Credentials for this account', { exact: true }).click();
  await expect(
    credentials.getByText('Credentials for @corrected_agent', { exact: true }),
  ).toBeVisible();
  await page.route(
    '**/api/v1/identity/credentials/query',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'service_unavailable',
            message: 'Synthetic credential read unavailable',
            recovery: { action: 'retry_same_request' },
          },
        }),
      }),
    { times: 1 },
  );
  await credentials.getByRole('button', { name: 'Refresh credentials', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    credentials.getByText('Synthetic credential read unavailable', { exact: true }),
  ).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(credentials.getByText(/Synthetic participation · agent · active/)).toBeVisible();
  await credentials.getByRole('button', { name: 'Retry credentials page', exact: true }).click();
  await expect(
    credentials.getByText('Synthetic credential read unavailable', { exact: true }),
  ).toHaveCount(0);
  await credentials
    .getByRole('button', { name: 'Revoke', exact: true })
    .and(page.locator(':enabled'))
    .click();
  await expect(credentials.getByText(/Synthetic participation · agent · active/)).toHaveCount(0);
  await heldCredentialCompletion(page, server, pending.body.participant_id, issuanceBodies);
  const identities = await server.observer.query(
    "SELECT id FROM loom.participants WHERE nickname='corrected_agent'",
  );
  expect(identities.rows.map((r) => r.id)).toEqual([pending.body.participant_id]);
  const issued = await server.observer.query(
    'SELECT id,state FROM loom.participant_credentials WHERE participant_id=$1',
    [pending.body.participant_id],
  );
  expect(issued.rows).toHaveLength(3);
  expect(issued.rows.every((r) => r.state === 'revoked')).toBe(true);
  expect(queryBodies.every((body) => body.limit === 25 && !body.cursor)).toBe(true);
  if (process.env.LOOM_ADMISSION_REVIEW_SCREENS === '1')
    await writeFile(
      '/tmp/loom-review-evidence/ui-04/follow-up/synthetic-agent.json',
      JSON.stringify(
        {
          nickname: 'corrected_agent',
          participant_id: pending.body.participant_id,
          credentials: issued.rows,
          scope:
            'Dedicated agent in the isolated admission fixture. Both credentials observed revoked before fixture teardown; the browser runner disposes the test-owned database.',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
}

async function heldCredentialCompletion(
  page: Page,
  server: Awaited<ReturnType<typeof syntheticServer>>,
  account: string,
  issuanceBodies: any[],
) {
  const review = await adminNavigationReview(page, 'handoff-completion');
  const before = issuanceBodies.length;
  let received!: () => void,
    releaseResponse!: () => void,
    secret = '';
  const committed = new Promise<void>((r) => (received = r)),
    responseHeld = new Promise<void>((r) => (releaseResponse = r));
  await page.route(
    '**/api/v1/identity/credentials',
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      secret = (await response.json()).secret;
      received();
      await responseHeld;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Issue agent credential', exact: true }).click();
  await committed;
  const record = (await savedIntents(page)).find((r) => r.slot === 'admission');
  expect(record.state).toBe('uncertain');
  const prefix = await page.evaluate(
    (key) =>
      Object.keys(localStorage)
        .find((k) => k.endsWith(':' + key))!
        .slice(0, -key.length),
    record.key,
  );
  const lockOwner = await page.context().newPage();
  await lockOwner.goto(server.origin + '/loom/help');
  try {
    await lockOwner.evaluate((prefix) => {
      (window as any).completionEntered = false;
      void navigator.locks.request(prefix, async () => {
        (window as any).completionEntered = true;
        await new Promise<void>((resolve) => ((window as any).releaseCompletion = resolve));
      });
    }, prefix);
    await expect.poll(() => lockOwner.evaluate(() => (window as any).completionEntered)).toBe(true);
    releaseResponse();
    await expect
      .poll(() =>
        lockOwner.evaluate(
          async (prefix) =>
            (await navigator.locks.query()).pending?.filter((l) => l.name === prefix).length,
          prefix,
        ),
      )
      .toBe(1);
    await expect(page.getByLabel('Issued secret', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Overview', exact: true }).click();
    await expect(page).toHaveURL(server.origin + '/loom/admin');
    expect((await savedIntents(page)).find((r) => r.key === record.key)).toEqual(record);
    await lockOwner.evaluate(() => (window as any).releaseCompletion());
    await expect
      .poll(() =>
        lockOwner.evaluate(async (prefix) => {
          const locks = await navigator.locks.query();
          return [...(locks.held ?? []), ...(locks.pending ?? [])].filter((l) => l.name === prefix)
            .length;
        }, prefix),
      )
      .toBe(0);
    expect((await savedIntents(page)).find((r) => r.key === record.key)).toEqual(record);
  } finally {
    releaseResponse();
    await lockOwner.evaluate(() => (window as any).releaseCompletion?.());
    await lockOwner.close();
  }
  await page.unrouteAll({ behavior: 'wait' });
  expect(
    await page.evaluate(
      (secret) => Object.values(localStorage).every((value) => !value.includes(secret)),
      secret,
    ),
  ).toBe(true);
  expect(issuanceBodies.slice(before)).toEqual([record.body]);
  await page.goto(server.origin + '/loom/help');
  await page.getByRole('link', { name: /credential.issue/ }).click();
  await expect(page).toHaveURL(server.origin + '/loom/admin/participants?intent=' + record.key);
  await expect(
    page.getByRole('heading', { name: 'Managing @corrected_agent', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check credential issuance', exact: true }),
  ).toBeEnabled();
  const faults = [
    'A second authenticated fixture tab held the existing journal Web Lock after the server committed and before local completion. The valid response was delivered, then the same administrator navigated to Overview before the lock was released. The exact non-secret record remained; no replacement issuance was sent.',
  ];
  await review.capture(
    'held-completion-retained',
    [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
    faults,
  );
  const status = page.waitForRequest(
    (r) => r.url().endsWith('/identity/reconcile') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Check credential issuance', exact: true }).click();
  expect((await status).postDataJSON()).toEqual({
    operation_kind: 'credential.issue',
    idempotency_key: record.key,
  });
  await expect(
    page.getByText('Credential issued — secret unavailable', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await savedIntents(page)).find((r) => r.key === record.key))
    .toBeUndefined();
  expect(issuanceBodies.slice(before)).toEqual([record.body]);
  expect(
    (
      await server.observer.query(
        'SELECT count(*)::int n FROM loom.participant_credentials WHERE participant_id=$1',
        [account],
      )
    ).rows[0].n,
  ).toBe(3);
  await review.capture(
    'held-completion-reconciled',
    [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
    faults.concat(
      'The existing status endpoint reconciled the same key once. Secretless confirmation retires the record deliberately; credential count remains three including the two earlier explicit issuances.',
    ),
  );
  const credentials = page.getByText('Credentials for this account', { exact: true }).locator('..');
  await page.getByText('Credentials for this account', { exact: true }).click();
  await expect(credentials.getByText(/Synthetic participation · agent · active/)).toBeVisible();
  await credentials
    .getByRole('button', { name: 'Revoke', exact: true })
    .and(page.locator(':enabled'))
    .click();
  await expect(credentials.getByText(/Synthetic participation · agent · active/)).toHaveCount(0);
}

test('review regression: corrected conflict drafts survive navigation and browser process restart', async ({
  server,
  diagnostics,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-conflict-restart-'));
  const options = {
    ignoreHTTPSErrors: true,
    headless: true,
    viewport: { width: 1440, height: 1000 },
  };
  let context = await diagnostics.launchPersistentContext(directory, options);
  try {
    let page = await context.newPage();
    await enter(page, context, server.origin, server.ticket, true);
    await setup(page);
    const d = await createDiscussion(page);
    const url = server.origin + `/loom/resource/${d.resource}/${d.revision}?edit=1`;
    await page.goto(url);
    await page.getByLabel('Text', { exact: true }).fill('Original rejected edit');
    await page.getByLabel('Title', { exact: true }).fill('Original rejected title');
    const newer = await api(page, '/api/v1/revisions', {
      idempotency_key: randomUUID(),
      resource_id: d.resource,
      expected_revision_id: d.revision,
      title: 'Competing title',
      content: text('Competing revision'),
    });
    expect(newer.status()).toBe(201);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Your draft is preserved.')).toBeVisible();
    expect(await page.getByLabel('Text', { exact: true }).isDisabled()).toBe(true);
    const rejected = (await savedIntents(page)).find((r) => r.slot === 'edit:' + d.resource);
    // Local drafts resumes a specific operation via this query parameter.
    await page.goto(url + '&intent=' + rejected.key);
    await page.getByRole('button', { name: 'Prepare corrected submission' }).click();
    await expect(page.getByLabel('Text', { exact: true })).toBeEnabled();
    const corrected = (await savedIntents(page)).find((r) => r.slot === 'edit:' + d.resource);
    expect(corrected.key).not.toBe(rejected.key);
    expect(corrected.body.expected_revision_id).toBe((await newer.json()).revision_id);
    await expect.poll(() => new URL(page.url()).searchParams.get('intent')).toBe(corrected.key);
    const correctedUrl = page.url();
    // A replacement key proves correction, not completion of later autosaves.
    // Hold the real journal lock so input completion cannot stand in for custody.
    const lockName = `loom.intent.v1:${corrected.origin}:${corrected.instance_id}:${corrected.participant_id}:`;
    await page.evaluate(async (name) => {
      await new Promise<void>((entered) => {
        void navigator.locks.request(
          name,
          () =>
            new Promise<void>((release) => {
              (window as any).releaseCorrectedDraftLock = release;
              entered();
            }),
        );
      });
    }, lockName);
    await page.getByLabel('Text', { exact: true }).fill('Corrected text survives restart');
    await page.getByLabel('Title', { exact: true }).fill('Corrected title survives restart');
    await expect
      .poll(() =>
        page.evaluate(
          async (name) =>
            (await navigator.locks.query()).pending?.some((lock) => lock.name === name),
          lockName,
        ),
      )
      .toBe(true);
    expect((await savedIntents(page)).find((r) => r.key === corrected.key)).toEqual(corrected);
    await page.evaluate(() => (window as any).releaseCorrectedDraftLock());
    await expect
      .poll(async () => (await savedIntents(page)).find((r) => r.key === corrected.key)?.body)
      .toEqual({
        ...corrected.body,
        content: { ...corrected.body.content, text: 'Corrected text survives restart' },
        title: 'Corrected title survives restart',
      });
    await page.reload();
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
      'Corrected text survives restart',
    );
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
      'Corrected title survives restart',
    );
    await page.getByRole('link', { name: 'Topics', exact: true }).first().click();
    await page.goto(correctedUrl);
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
      'Corrected text survives restart',
    );
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
      'Corrected title survives restart',
    );
    await context.close();
    context = await diagnostics.launchPersistentContext(directory, options);
    page = await context.newPage();
    await page.goto(correctedUrl);
    await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
      'Corrected text survives restart',
    );
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue(
      'Corrected title survives restart',
    );
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Your publication is saved.', { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('review regression: mismatched and artifact focus never offer reply controls', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const a = await createDiscussion(page, 'Discussion A'),
    b = await createDiscussion(page, 'Discussion B');
  for (const focus of [
    b.resource,
    (await (await api(page, '/api/v1/community')).json()).overview.resource_id,
  ]) {
    await page.goto(server.origin + `/loom/discussion/${a.discussion}?focus=${focus}`);
    if (focus === b.resource) {
      await expect(
        page.getByText('This branch is unavailable in this discussion.', { exact: true }),
      ).toBeVisible();
    } else {
      // An artifact focus produces an unclassified context404. It cannot
      // certify continued source access, even though the URL is simply wrong.
      await expect(page.getByRole('button', { name: 'Retry protected view' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Discussion A', exact: true })).toHaveCount(0);
    }
    expect(await page.getByRole('button', { name: 'Reply', exact: true }).count()).toBe(0);
    expect(await page.locator(`[data-resource-id="${focus}"]`).count()).toBe(0);
  }
  await page.goto(server.origin + `/loom/discussion/${b.discussion}?focus=${b.resource}`);
  await expect(page.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
});

test('review regression: suppressed parents preserve browser branches and eligible revision history', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const d = await createDiscussion(page);
  const parent = await (
    await api(page, '/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: d.discussion,
      parent_id: d.resource,
      content: text('Suppressed parent text'),
    })
  ).json();
  const child = await (
    await api(page, '/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: d.discussion,
      parent_id: parent.resource_id,
      content: text('Eligible nested reply'),
    })
  ).json();
  // A reply expansion is a protected read too. Settle initial reads so this
  // real children denial, rather than an overlapping initial lookup, is causal.
  await page.reload();
  await expect(page.getByText('Suppressed parent text', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
    d.discussion,
  ]);
  const deniedChildren = page.waitForResponse(
    (r) => r.url().includes(`/contributions/${parent.resource_id}/children`) && r.status() === 404,
  );
  await page.getByRole('button', { name: 'Show replies', exact: true }).click();
  expect((await deniedChildren).status()).toBe(404);
  await expect(
    page.getByRole('heading', { name: 'Reading the actual context', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('Suppressed parent text', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry protected view' })).toBeVisible();
  await server.observer.query("UPDATE loom.resources SET state='active' WHERE id=$1", [
    d.discussion,
  ]);
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
    parent.resource_id,
  ]);
  await page.reload();
  await expect(page.getByText('Contribution unavailable', { exact: true })).toBeVisible();
  const branch = page.locator('.comment-branch').filter({ hasText: 'Contribution unavailable' });
  await branch.getByRole('button', { name: 'Show replies', exact: true }).click();
  await expect(
    page
      .locator(`[data-resource-id="${child.resource_id}"]`)
      .getByText('Eligible nested reply', { exact: true }),
  ).toBeVisible();
  await page
    .locator(`[data-resource-id="${child.resource_id}"]`)
    .locator('.message-details > summary')
    .click();
  await page
    .locator(`[data-resource-id="${child.resource_id}"]`)
    .getByRole('button', { name: 'Preview parent', exact: true })
    .click();
  await expect(page.getByRole('complementary', { name: 'Parent preview' })).toContainText(
    'Parent unavailable.',
  );
  await expect(page.getByText('Suppressed parent text', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Eligible nested reply', { exact: true })).toHaveCount(0);
  await page.goto(server.origin + `/loom/discussion/${d.discussion}?focus=${parent.resource_id}`);
  await expect(page.getByText('Contribution unavailable', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-resource-id="${child.resource_id}"]`)).toBeVisible();
  expect(await page.getByText('Suppressed parent text', { exact: true }).count()).toBe(0);
  const newer = await (
    await api(page, '/api/v1/revisions', {
      idempotency_key: randomUUID(),
      resource_id: child.resource_id,
      expected_revision_id: child.revision_id,
      title: null,
      content: text('Suppressed current body'),
    })
  ).json();
  await server.observer.query("UPDATE loom.revisions SET availability='suppressed' WHERE id=$1", [
    newer.revision_id,
  ]);
  await page.goto(server.origin + `/loom/resource/${child.resource_id}`);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Retained revisions', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Revision 1/ })).toBeVisible();
  expect(await page.getByText('Suppressed current body', { exact: true }).count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Edit this text' }).count()).toBe(0);
  await page.getByRole('link', { name: /Revision 1/ }).click();
  await expect(page.getByText('Eligible nested reply', { exact: true })).toBeVisible();
  await page.goto(server.origin + `/loom/resource/${child.resource_id}/${randomUUID()}`);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await expect(page.getByRole('link', { name: /Revision 1/ })).toBeVisible();
  // A failed history read is a resource refusal; a missing exact revision above
  // must leave this independently authorized path discoverable.
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
    child.resource_id,
  ]);
  await page.getByRole('button', { name: 'Revision history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry protected view' })).toBeVisible();
  expect(await page.getByRole('link', { name: /Revision 1/ }).count()).toBe(0);
  const area = (await (await api(page, `/api/v1/discussions/${d.discussion}`)).json()).area;
  await page.goto(server.origin + `/loom/area/${area.id}`);
  await expect(page.getByRole('heading', { level: 1, name: area.title })).toBeVisible();
  await page.getByText('Routine attention', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute routine updates' })).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  await server.observer.query("UPDATE loom.resources SET state='suppressed' WHERE id=$1", [
    area.id,
  ]);
  await page
    .getByRole('group', { name: 'Topic content' })
    .getByRole('button', { name: 'Artifacts', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Retry protected view' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: area.title })).toHaveCount(0);
});

test('review regression: a stale tab preserves separate edits without overwriting dispatched intent', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const d = await createDiscussion(page);
  const url = server.origin + `/loom/resource/${d.resource}/${d.revision}?edit=1`;
  await page.goto(url);
  await page.getByLabel('Text', { exact: true }).fill('Original request committed by A');
  const original = (await savedIntents(page)).find((r) => r.slot === 'edit:' + d.resource);
  const other = await context.newPage();
  await other.goto(url + '&intent=' + original.key);
  await expect(other.getByLabel('Text', { exact: true })).toHaveValue(original.body.content.text);
  const staleList = await context.newPage();
  await staleList.goto(server.origin + '/loom/help');
  const originalRow = staleList.locator('.list-row').filter({
    has: staleList.getByRole('link', { name: /revision.publish · draft/ }),
  });
  await expect(originalRow.getByRole('button', { name: 'Remove local record' })).toBeVisible();
  let otherPosts = 0;
  await other.route('**/api/v1/revisions', (route) => {
    otherPosts++;
    return route.abort();
  });
  let committed!: () => void;
  const ready = new Promise<void>((resolve) => {
    committed = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/revisions', async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed();
    await held;
    await route.abort('failed');
  });
  try {
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await ready;
    await originalRow.getByRole('button', { name: 'Remove local record' }).click();
    await expect(staleList.getByRole('alert')).toContainText('changed in another view');
    await other.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(other.getByRole('alert')).toContainText('changed in another view');
    expect(otherPosts).toBe(0);
    await other.getByLabel('Text', { exact: true }).fill('Unsent edits made in B');
    await expect
      .poll(async () => (await savedIntents(other)).find((r) => r.key === original.key)?.body)
      .toEqual(original.body);
    const retained = (await savedIntents(other)).find((r) => r.key === original.key);
    expect(retained.state).toBe('uncertain');
    await expect(
      other.getByText('Your changes were saved separately.', { exact: true }),
    ).toBeVisible();
    await expect(other.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    const separate = (await savedIntents(other)).find(
      (r) => r.key !== original.key && r.slot === original.slot,
    );
    expect(separate.body.content.text).toBe('Unsent edits made in B');
    expect(separate.state).toBe('draft');
    expect(separate.blocked_by).toBe(original.key);
    await other.reload();
    await expect(other.getByLabel('Text', { exact: true })).toHaveValue('Unsent edits made in B');
    await expect(other.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('button', { name: 'Retry same publication' })).toBeVisible();
    await page.unrouteAll({ behavior: 'wait' });
    await page.getByRole('button', { name: 'Retry same publication' }).click();
    await expect(page.getByText('Your publication is saved.', { exact: true })).toBeVisible();
    const result = await api(page, `/api/v1/resources/${d.resource}/history`);
    expect((await result.json()).items).toHaveLength(2);
    expect((await savedIntents(other)).find((r) => r.key === original.key).body).toEqual(
      original.body,
    );
    await other.getByRole('button', { name: 'Continue with separate draft' }).click();
    await expect(other.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    expect(otherPosts).toBe(0);
  } finally {
    release();
    await other.close();
    await staleList.close();
  }
});

for (const kind of ['artifacts', 'discussions', 'replies'] as const)
  test(`review regression: the next ${kind} draft survives browser restart`, async ({
    server,
    diagnostics,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'loom-next-draft-'));
    const options = { ignoreHTTPSErrors: true, headless: true };
    let context = await diagnostics.launchPersistentContext(directory, options);
    try {
      let page = await context.newPage();
      await enter(page, context, server.origin, server.ticket, true);
      await setup(page);
      const discussion = kind === 'replies' ? await createDiscussion(page) : undefined;
      const areas = await (await api(page, '/api/v1/areas')).json();
      const area = areas.items.find((a: { title: string }) => a.title === 'General');
      const url =
        server.origin +
        (discussion
          ? `/loom/discussion/${discussion.discussion}?focus=${discussion.resource}`
          : `/loom/area/${area.id}?compose=${kind}`);
      await page.goto(url);
      if (discussion) await page.getByRole('button', { name: 'Reply', exact: true }).click();
      else await page.getByLabel('Title', { exact: true }).fill('First publication');
      const label = discussion ? 'Your reply' : 'Text';
      await page.getByLabel(label, { exact: true }).fill('First body');
      const operation =
        kind === 'artifacts'
          ? 'artifact.create'
          : kind === 'discussions'
            ? 'discussion.create'
            : 'reply.create';
      await expect
        .poll(
          async () =>
            (await savedIntents(page)).find((r) => r.kind === operation && r.state === 'draft')
              ?.body.content.text,
        )
        .toBe('First body');
      const first = (await savedIntents(page)).find((r) => r.kind === operation);
      await page.goto(url + '&intent=' + first.key);
      await page
        .getByRole('button', {
          name: discussion ? 'Post reply' : 'Publish',
          exact: true,
        })
        .click();
      if (discussion) await expect(page.getByText('Reply posted', { exact: true })).toBeVisible();
      await (
        discussion
          ? page
              .locator('.reading-grid > div > article.comment')
              .getByRole('button', { name: 'Reply', exact: true })
          : page.getByRole('button', { name: 'Write another', exact: true })
      ).click();
      if (!discussion) await page.getByLabel('Title', { exact: true }).fill('Second publication');
      await page.getByLabel(label, { exact: true }).fill('Second body survives restart');
      await expect
        .poll(
          async () =>
            (await savedIntents(page)).find((r) => r.kind === operation && r.state === 'draft')
              ?.body.content.text,
        )
        .toBe('Second body survives restart');
      const nextUrl = page.url();
      await page.reload();
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(
        'Second body survives restart',
      );
      await context.close();
      context = await diagnostics.launchPersistentContext(directory, options);
      page = await context.newPage();
      await page.goto(nextUrl);
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(
        'Second body survives restart',
      );
      if (!discussion)
        await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Second publication');
      const retained = (await savedIntents(page)).filter((r) => r.kind === operation);
      expect(retained).toHaveLength(discussion ? 2 : 1);
      if (discussion) {
        expect(retained.find((r) => r.key === first.key)?.state).toBe('committed');
        expect(retained.find((r) => r.state === 'draft')?.key).not.toBe(first.key);
      }
    } finally {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('publication fails closed without browser locks while retained drafts remain readable', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const d = await createDiscussion(page);
  await page.goto(server.origin + `/loom/resource/${d.resource}?edit=1`);
  await page.getByLabel('Text', { exact: true }).fill('Retained before browser locks unavailable');
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find((r) => r.slot === 'edit:' + d.resource)?.body.content.text,
    )
    .toBe('Retained before browser locks unavailable');
  const before = await page.evaluate(publicationJournalBytes);
  // Retain a real maintenance request too: lack of Web Locks must prevent
  // cleanup of either owner-scoped store without preventing server sign-out.
  await page.goto(server.origin + '/loom/admin/search');
  await page.route(
    '**/api/v1/admin/search/rebuild',
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('failed');
    },
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Rebuild index', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Rebuild index', exact: true })
    .click();
  await expect(page.getByText('Outcome not confirmed', { exact: true })).toBeVisible();
  const maintenanceRecords = () =>
    page.evaluate(() =>
      Object.entries(localStorage).filter(([key]) => key.startsWith('loom.search-maintenance.v1:')),
    );
  const maintenanceBefore = await maintenanceRecords();
  expect(maintenanceBefore).toHaveLength(1);
  expect(JSON.parse(maintenanceBefore[0]![1])).toEqual({
    version: 1,
    sequence: 1,
    state: 'uncertain',
    request: { kind: 'rebuild', body: { expected_generation: 1 } },
  });
  await page.goto(server.origin + `/loom/resource/${d.resource}?edit=1`);
  await page.addInitScript(() => Object.defineProperty(navigator, 'locks', { value: undefined }));
  await page.reload();
  let posts = 0;
  await page.route('**/api/v1/revisions', (route) => {
    posts++;
    return route.abort();
  });
  await expect(page.getByLabel('Text', { exact: true })).toHaveValue(
    'Retained before browser locks unavailable',
  );
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Web Locks support');
  expect(posts).toBe(0);
  expect(await page.evaluate(publicationJournalBytes)).toEqual(before);
  await page.goto(server.origin + '/loom/help');
  await expect(page.getByRole('button', { name: 'Export drafts' })).toBeEnabled();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const signedOut = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/identity/logout'),
  );
  await page.getByRole('button', { name: 'Clear local drafts and sign out' }).click();
  expect((await signedOut).status()).toBe(200);
  expect(await (await signedOut).json()).toEqual({ session_state: 'revoked' });
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
  const warning = page.getByRole('alert');
  await expect(warning).toContainText('Signed out, but');
  await expect(warning).toContainText('local drafts could not be cleared.');
  await expect(warning).toContainText('search maintenance recovery could not be cleared.');
  await expect(warning).toContainText('They remain scoped to this account on this browser.');
  expect(await page.evaluate(publicationJournalBytes)).toEqual(before);
  expect(await maintenanceRecords()).toEqual(maintenanceBefore);
});

test('publication persists the visible text again after a failed draft save', async ({
  page,
  context,
  server,
}) => {
  await enter(page, context, server.origin, server.ticket, true);
  await setup(page);
  const d = await createDiscussion(page);
  await page.goto(server.origin + `/loom/resource/${d.resource}?edit=1`);
  await page.getByLabel('Text', { exact: true }).fill('Previously saved text');
  await expect
    .poll(
      async () =>
        (await savedIntents(page)).find((r) => r.slot === 'edit:' + d.resource)?.body.content.text,
    )
    .toBe('Previously saved text');
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('loom.intent.v1:') && JSON.parse(value).state === 'draft')
        throw new DOMException('Simulated draft storage failure', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await page.getByLabel('Text', { exact: true }).fill('Visible text after failed autosave');
  await expect(page.getByRole('alert')).toContainText('Simulated draft storage failure');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Your publication is saved.', { exact: true })).toBeVisible();
  const current = await (await api(page, `/api/v1/resources/${d.resource}`)).json();
  expect(current.content.text).toBe('Visible text after failed autosave');
});
