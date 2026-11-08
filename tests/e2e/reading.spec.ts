import { chromium, type Page, type BrowserContext } from '@playwright/test';
import { test, expect } from '../helpers/browser-fixtures.js';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { syntheticServer } from '../helpers/participation-server.js';
import type { BrowserDiagnostics } from '../helpers/browser-diagnostics.js';
const endpoint = '/api/v1/me/reading';
const batchReviewRoot = '/private/tmp/loom-review-evidence/reading-viewport';
async function batchReviewCapture(
  page: Page,
  state: string,
  width: 1440 | 390,
  anchorSelector?: string,
) {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  if (anchorSelector) await page.locator(anchorSelector).scrollIntoViewIfNeeded();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await mkdir(batchReviewRoot, { recursive: true });
  const name = `${state}-${width}x${width === 1440 ? 1000 : 844}`;
  await page.screenshot({ path: join(batchReviewRoot, name + '.png'), fullPage: false });
  await writeFile(
    join(batchReviewRoot, name + '.json'),
    JSON.stringify(
      {
        source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty_tree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(Boolean),
        route: new URL(page.url()).pathname,
        viewport: { width, height: width === 1440 ? 1000 : 844 },
        browser: 'Chromium',
        account_role: 'synthetic enrolled administrator',
        state,
        source_diff_sha256: createHash('sha256')
          .update(execFileSync('git', ['diff', '--binary']))
          .digest('hex'),
        reproduction: 'LOOM_READING_VIEWPORT_REVIEW=1 npm run test:e2e -- reading.spec.ts',
        authentication: 'ordinary virtual WebAuthn passkey',
        mocked_responses: [],
        held_requests:
          state === 'pending' ? ['Automatic reading state request held at the browser route.'] : [],
        injected_failures: state.includes('conflict')
          ? [
              'A was marked unread through the ordinary UI before the held automatic batch reached the server.',
            ]
          : [],
      },
      null,
      2,
    ),
  );
}
const text = (text: string) => ({ format: 'loom-markdown-v1', text, mentions: [] });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function api(page: Page, path: string, body?: unknown) {
  const self = await (
    await page.request.get(new URL('/api/v1/identity/self', page.url()).href, {
      ignoreHTTPSErrors: true,
    })
  ).json();
  const result =
    body === undefined
      ? await page.request.get(new URL(path, page.url()).href, { ignoreHTTPSErrors: true })
      : await page.request.post(new URL(path, page.url()).href, {
          ignoreHTTPSErrors: true,
          data: body,
          headers: { origin: new URL(page.url()).origin, 'x-loom-csrf': self.csrf },
        });
  expect(result.ok()).toBe(true);
  return result.json();
}
async function setup(
  page: Page,
  context: BrowserContext,
  server: Awaited<ReturnType<typeof syntheticServer>>,
  preference: 'off' | 'default' = 'off',
) {
  const cdp = await context.newCDPSession(page);
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
  await page.goto(server.origin + '/loom');
  await page.getByText('Set up an admitted account', { exact: true }).click();
  await page.getByLabel('Enrollment ticket', { exact: true }).fill(server.ticket);
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(
    page.getByRole('heading', { name: 'Set up your community', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create community', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Community', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /Back to Loom/ }).click();
  if (preference === 'off') {
    await page.goto(server.origin + '/loom/reading');
    await page
      .getByLabel('Automatically mark visible text read on this account and browser')
      .uncheck();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.keys(localStorage).some(
            (key) => key.endsWith(':automatic') && localStorage.getItem(key) === 'false',
          ),
        ),
      )
      .toBe(true);
  }
  const area = (await api(page, '/api/v1/areas')).items.find((r: any) => r.title === 'General').id;
  const opening = await api(page, '/api/v1/discussions', {
    idempotency_key: randomUUID(),
    area_id: area,
    title: 'Reading discussion',
    content: text('Opening main text'),
  });
  const discussion = (await api(page, '/api/v1/resources/' + opening.resource_id)).discussion_id;
  const reply = async (body = 'Selected reply', parent = opening.resource_id) =>
    api(page, '/api/v1/replies', {
      idempotency_key: randomUUID(),
      discussion_id: discussion,
      parent_id: parent,
      content: text(body),
    });
  const artifact = async (body = 'Artifact main text') =>
    api(page, '/api/v1/artifacts', {
      idempotency_key: randomUUID(),
      area_id: area,
      title: 'Reading artifact',
      content: text(body),
    });
  return { area, opening, discussion, reply, artifact };
}
const control = (page: Page, revision: string) =>
  page.locator(`[data-reading-target="${revision}"]`).locator('xpath=..');
const pair = (s: any) => ({ resource_id: s.resource_id, revision_id: s.revision_id });
const state = async (page: Page, s: any) =>
  (await api(page, endpoint + '/lookup', { targets: [pair(s)] })).items[0];
async function enable(page: Page, origin: string) {
  await page.goto(origin + '/loom/reading');
  await page.getByLabel('Automatically mark visible text read on this account and browser').check();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (k) => k.endsWith(':automatic') && localStorage.getItem(k) === 'true',
        ),
      ),
    )
    .toBe(true);
}
async function readingTools(page: Page, revision: string) {
  const parent = control(page, revision);
  await parent.waitFor({ state: 'visible' });
  const details = parent.locator('.post-footer .message-details').first();
  if ((await details.getAttribute('open')) === null)
    await details.locator(':scope > summary').click();
}
async function exact(page: Page, origin: string, s: any) {
  await page.goto(origin + `/loom/resource/${s.resource_id}/${s.revision_id}`);
  await expect(control(page, s.revision_id).locator('.prose')).toBeVisible();
}

async function nativeLifecycleBrowser(diagnostics: BrowserDiagnostics) {
  // The ordinary harness forces focus in its own CDP session; another session
  // cannot undo that override. Connect to native Chromium without that default.
  const directory = await mkdtemp(join(tmpdir(), 'loom-reading-lifecycle-'));
  const native = spawn(
    chromium.executablePath(),
    [
      '--headless',
      '--no-sandbox',
      '--no-first-run',
      '--ignore-certificate-errors',
      '--remote-debugging-port=0',
      '--user-data-dir=' + directory,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let launchError: Error | undefined;
  const stopped = new Promise<void>((resolve) => {
    native.once('error', (error) => {
      launchError = error;
      resolve();
    });
    native.once('close', () => resolve());
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const contexts: BrowserContext[] = [];
  async function close() {
    try {
      if (browser?.isConnected()) {
        for (const context of contexts)
          for (const page of context.pages()) await diagnostics.snapshot(page);
        // Closing a CDP-attached default context only disconnects Playwright.
        // Ask Chromium to finish its profile writers before removing the profile;
        // SIGTERM + parent exit still allowed rm to fail with ENOTEMPTY on Linux.
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
        await expect.poll(() => native.exitCode).toBe(0);
      }
    } finally {
      // Startup/close failures still dispose this test-owned process and propagate.
      if (native.exitCode === null && native.signalCode === null) native.kill('SIGTERM');
      await stopped;
      try {
        for (const context of contexts) await context.close();
        if (browser?.isConnected()) await browser.close();
        if (launchError) throw launchError;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  try {
    let port = '';
    await expect
      .poll(async () => {
        if (launchError) throw launchError;
        try {
          port = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!;
          return Number(port) > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { noDefaults: true });
    const context = diagnostics.track(browser.contexts()[0]!, 'explicit');
    contexts.push(context);
    return { context, directory, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('default viewport reading covers short and long main text without redundant writes', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server, 'default');
  const long = await d.artifact(
    Array.from({ length: 40 }, (_, index) =>
      `Paragraph ${index}. Main text is visible before its end. `.repeat(4),
    ).join('\n\n'),
  );
  const writes: any[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(endpoint + '/state')) writes.push(request.postDataJSON());
  });
  await exact(page, server.origin, long);
  const prose = control(page, long.revision_id).locator('.prose');
  expect((await prose.boundingBox())!.height).toBeGreaterThan(1000);
  await expect.poll(async () => (await state(page, long)).read).toBe(true);
  if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
    await batchReviewCapture(page, 'resource', 1440);
    await batchReviewCapture(page, 'resource', 390);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  expect(
    writes.filter((body) =>
      body.targets.some((target: any) => target.revision_id === long.revision_id),
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(prose).toBeVisible();
  await page.waitForTimeout(400);
  expect(
    writes.filter((body) =>
      body.targets.some((target: any) => target.revision_id === long.revision_id),
    ),
  ).toHaveLength(1);
  await expect(control(page, long.revision_id).getByText('Reading status')).toHaveCount(0);
  await expect(
    control(page, long.revision_id).getByRole('button', { name: 'Mark read' }),
  ).toHaveCount(0);
  await expect(control(page, long.revision_id).getByText(/private · revision/)).toHaveCount(0);
  await readingTools(page, long.revision_id);
  await expect(
    control(page, long.revision_id).getByRole('button', { name: 'Mark unread' }),
  ).toBeEnabled();
  if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
    const footer = `[data-reading-target="${long.revision_id}"] ~ .post-footer .message-details`;
    await batchReviewCapture(page, 'resource-more', 1440, footer);
    await batchReviewCapture(page, 'resource-more', 390, footer);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  const parent = await d.reply('Parent visible');
  const child = await d.reply('Nested child', parent.resource_id);
  const deep = await d.reply('Deep collapsed text', child.resource_id);
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  await expect(page.locator(`[data-presented-revision="${deep.revision_id}"]`)).toHaveCount(0);
  expect((await state(page, deep)).version).toBe(0);
  await page.goto(server.origin + '/loom/updates');
  expect((await state(page, deep)).version).toBe(0);
  const preparation = await api(page, '/api/v1/summary-preparations', {
    idempotency_key: randomUUID(),
    discussion_id: d.discussion,
    scope: 'full',
  });
  const summary = await api(page, '/api/v1/summaries', {
    idempotency_key: randomUUID(),
    discussion_id: d.discussion,
    title: 'Reading summary',
    content: text('The full summary main text'),
    coverage: { preparation_id: preparation.preparation_id },
  });
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  await expect(page.getByRole('link', { name: 'Reading summary' })).toBeVisible();
  expect((await state(page, summary)).version).toBe(0);
  await exact(page, server.origin, summary);
  await expect.poll(async () => (await state(page, summary)).read).toBe(true);
  await readingTools(page, summary.revision_id);
  await expect(
    control(page, summary.revision_id).getByRole('button', { name: 'Mark unread' }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await exact(page, server.origin, long);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('Mark unread survives focus and partial scrolling, then a full exit permits a new visit', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server, 'default');
  const a = await d.reply('Visible short comment');
  await d.reply(
    Array.from(
      { length: 80 },
      (_, index) => `Filler ${index}. ` + 'Read down the page. '.repeat(8),
    ).join('\n\n'),
  );
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  await control(page, a.revision_id).locator('.prose').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await state(page, a)).read).toBe(true);
  await readingTools(page, a.revision_id);
  const button = control(page, a.revision_id).getByRole('button', { name: 'Mark unread' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page, a)).read).toBe(false);
  const unreadVersion = (await state(page, a)).version;
  await expect(button).toBeFocused();
  await expect(
    control(page, a.revision_id).getByRole('status', { name: 'Unread revision' }),
  ).toBeVisible();
  await page.evaluate(() => scrollBy(0, 10));
  await page.waitForTimeout(450);
  expect((await state(page, a)).version).toBe(unreadVersion);
  const other = await context.newPage();
  await other.goto(server.origin + '/loom/reading');
  await page.bringToFront();
  await page.waitForTimeout(450);
  expect((await state(page, a)).version).toBe(unreadVersion);
  await other.close();
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect
    .poll(() =>
      control(page, a.revision_id)
        .locator('.prose')
        .evaluate((node) => node.getBoundingClientRect().bottom <= 0),
    )
    .toBe(true);
  await control(page, a.revision_id).locator('.prose').scrollIntoViewIfNeeded();
  await expect.poll(async () => (await state(page, a)).read).toBe(true);
  expect((await state(page, a)).version).toBe(unreadVersion + 1);
});

test('routine automatic settlement keeps message height and reading position stable', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server, 'default');
  const a = await d.reply('A short anchored comment');
  const b = await d.reply('The next comment stays in place');
  const pending = barrier();
  const release = barrier();
  await page.route('**/api/v1/me/reading/state', async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.basis === 'presentation' &&
      body.targets.some((v: any) => v.revision_id === a.revision_id)
    ) {
      pending.release();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.goto(server.origin + '/loom/discussion/' + d.discussion);
    await control(page, a.revision_id).locator('.prose').scrollIntoViewIfNeeded();
    await pending.promise;
    await expect(
      control(page, a.revision_id).getByRole('status', { name: 'Syncing reading' }),
    ).toBeVisible();
    const before = await page.evaluate(
      ({ first, second }) => {
        const a = document.querySelector(`[data-resource-id="${first}"]`)!;
        const b = document.querySelector(`[data-resource-id="${second}"]`)!;
        return {
          height: a.getBoundingClientRect().height,
          nextTop: b.getBoundingClientRect().top,
          scrollY,
        };
      },
      { first: a.resource_id, second: b.resource_id },
    );
    release.release();
    await expect.poll(async () => (await state(page, a)).read).toBe(true);
    await expect(
      control(page, a.revision_id).getByRole('status', { name: 'Syncing reading' }),
    ).toHaveCount(0);
    const after = await page.evaluate(
      ({ first, second }) => {
        const a = document.querySelector(`[data-resource-id="${first}"]`)!;
        const b = document.querySelector(`[data-resource-id="${second}"]`)!;
        return {
          height: a.getBoundingClientRect().height,
          nextTop: b.getBoundingClientRect().top,
          scrollY,
        };
      },
      { first: a.resource_id, second: b.resource_id },
    );
    expect(Math.abs(after.height - before.height)).toBeLessThan(1);
    expect(Math.abs(after.nextTop - before.nextTop)).toBeLessThan(1);
    expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThan(1);
  } finally {
    release.release();
    await page.unroute('**/api/v1/me/reading/state');
  }
});

test('collapsing a visible unread branch permits a fresh read only after expansion', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server, 'default');
  const parent = await d.reply('Parent branch');
  const child = await d.reply('Child main text', parent.resource_id);
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  const toggle = control(page, parent.revision_id).locator('xpath=..');
  await toggle.getByRole('button', { name: 'Check replies' }).click();
  const prose = control(page, child.revision_id).locator('.prose');
  await prose.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await state(page, child)).read).toBe(true);
  await readingTools(page, child.revision_id);
  await control(page, child.revision_id).getByRole('button', { name: 'Mark unread' }).click();
  await expect.poll(async () => (await state(page, child)).read).toBe(false);
  const version = (await state(page, child)).version;
  await toggle.getByRole('button', { name: 'Hide replies' }).click();
  await expect(prose).toBeHidden();
  expect((await state(page, child)).version).toBe(version);
  await toggle.getByRole('button', { name: 'Show loaded replies' }).click();
  await prose.scrollIntoViewIfNeeded();
  await expect.poll(async () => (await state(page, child)).read).toBe(true);
  expect((await state(page, child)).version).toBe(version + 1);
});

test('viewport reading review: quiet controls, held Unread, pending batch, conflict and recovery', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server);
  const x = await d.reply('Older skipped X');
  const y = await d.reply('Newer selected Y');
  const newer = await api(page, '/api/v1/revisions', {
    idempotency_key: randomUUID(),
    resource_id: y.resource_id,
    expected_revision_id: y.revision_id,
    title: null,
    content: text('Y2'),
  });
  const after = await d.reply('After selection');
  const a = await d.reply('First exact reading target');
  const b = await d.reply('Second exact reading target');
  const child = await d.reply('A nested reply stays expanded', b.resource_id);
  await api(page, endpoint + '/state', {
    idempotency_key: randomUUID(),
    basis: 'manual',
    episode_id: null,
    targets: [d.opening, x, newer, after].map((source) => ({
      ...pair(source),
      read: true,
      expected_version: 0,
    })),
  });
  await page.goto(server.origin + '/loom/discussion/' + d.discussion);
  await expect(control(page, a.revision_id).locator('.prose')).toBeVisible();
  await control(page, b.revision_id).locator('.prose').scrollIntoViewIfNeeded();
  if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
    await batchReviewCapture(page, 'normal', 1440);
    await batchReviewCapture(page, 'normal', 390);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await readingTools(page, d.opening.revision_id);
  await expect(
    control(page, d.opening.revision_id).getByRole('button', { name: 'Mark unread' }),
  ).toBeEnabled();
  if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
    const opening = `[data-reading-target="${d.opening.revision_id}"]`;
    await batchReviewCapture(page, 'more-open', 1440, opening);
    await batchReviewCapture(page, 'more-open', 390, opening);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await control(page, d.opening.revision_id).getByRole('button', { name: 'Mark unread' }).click();
  await expect.poll(async () => (await state(page, d.opening)).version).toBe(2);
  await expect(
    control(page, d.opening.revision_id).getByRole('status', { name: 'Unread revision' }),
  ).toBeVisible();
  if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
    const opening = `[data-reading-target="${d.opening.revision_id}"]`;
    await batchReviewCapture(page, 'manual-unread', 1440, opening);
    await batchReviewCapture(page, 'manual-unread', 390, opening);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  const openingMenu = control(page, d.opening.revision_id)
    .locator('.post-footer .message-details')
    .first();
  if ((await openingMenu.getAttribute('open')) !== null)
    await openingMenu.locator(':scope > summary').click();
  const held = barrier(),
    release = barrier();
  let original: any;
  await page.route('**' + endpoint + '/state', async (route) => {
    const body = route.request().postDataJSON();
    if (
      body.basis === 'presentation' &&
      body.targets.some((item: any) => item.revision_id === a.revision_id)
    ) {
      original = body;
      held.release();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await page.evaluate(
      ({ a, b }) => {
        const first = document
          .querySelector(`[data-reading-target="${a}"] .prose`)!
          .getBoundingClientRect();
        const second = document
          .querySelector(`[data-reading-target="${b}"] .prose`)!
          .getBoundingClientRect();
        scrollBy(0, (first.top + second.bottom) / 2 - innerHeight / 2);
      },
      { a: a.revision_id, b: b.revision_id },
    );
    const settings = await context.newPage();
    try {
      await enable(settings, server.origin);
    } finally {
      await settings.close();
    }
    await page.bringToFront();
    await Promise.race([
      held.promise,
      page.waitForTimeout(8000).then(() => {
        throw new Error('Automatic batch did not qualify.');
      }),
    ]);
    expect(original.targets.map((item: any) => item.revision_id).sort()).toEqual(
      [a.revision_id, b.revision_id].sort(),
    );
    await expect(
      control(page, a.revision_id).getByRole('status', { name: 'Syncing reading' }),
    ).toBeVisible();
    if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
      await batchReviewCapture(page, 'pending', 1440);
      await batchReviewCapture(page, 'pending', 390);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const branch = control(page, b.revision_id).locator('xpath=..');
    await branch.getByRole('button', { name: 'Check replies', exact: true }).click();
    await expect(control(page, child.revision_id).locator('.prose')).toBeVisible();
    await control(page, b.revision_id).getByRole('button', { name: 'Reply', exact: true }).click();
    const draft = control(page, b.revision_id).getByLabel('Your reply', { exact: true });
    await draft.fill('Draft retained through reading settlement');
    await readingTools(page, a.revision_id);
    const manualButton = control(page, a.revision_id).getByRole('button', { name: 'Mark unread' });
    await manualButton.click();
    await expect.poll(async () => (await state(page, a)).version).toBe(1);
    const readingTop = await control(page, a.revision_id)
      .locator('.prose')
      .evaluate((node) => node.getBoundingClientRect().top);
    release.release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect.poll(async () => (await state(page, b)).read).toBe(true);
    await expect(control(page, a.revision_id).getByText(/Reading change conflicted/)).toBeVisible();
    await expect(manualButton).toBeFocused();
    await expect(draft).toHaveValue('Draft retained through reading settlement');
    await expect(control(page, child.revision_id).locator('.prose')).toBeVisible();
    await expect
      .poll(
        async () =>
          Math.abs(
            (await control(page, a.revision_id)
              .locator('.prose')
              .evaluate((node) => node.getBoundingClientRect().top)) - readingTop,
          ) < 4,
      )
      .toBe(true);
    const menu = control(page, a.revision_id).locator('.post-footer .message-details').first();
    if ((await menu.getAttribute('open')) !== null) await menu.locator(':scope > summary').click();
    await expect(control(page, a.revision_id).getByText(/Reading change conflicted/)).toBeVisible();
    if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
      await batchReviewCapture(page, 'conflict', 1440);
      await batchReviewCapture(page, 'conflict', 390);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await control(page, a.revision_id)
      .getByRole('link', { name: 'Review or dismiss the reading conflict' })
      .click();
    await expect(page.getByRole('heading', { name: 'Private reading progress' })).toBeVisible();
    if (process.env.LOOM_READING_VIEWPORT_REVIEW === '1') {
      await batchReviewCapture(page, 'recovery', 1440);
      await batchReviewCapture(page, 'recovery', 390);
      const beforeRoot = '/private/tmp/loom-review-evidence/reading-batch';
      for (const width of [1440, 390] as const) {
        const size = `${width}x${width === 1440 ? 1000 : 844}`;
        await copyFile(
          join(beforeRoot, `normal-${size}.png`),
          join(batchReviewRoot, `before-normal-${size}.png`),
        );
        await copyFile(
          join(beforeRoot, `normal-${size}.json`),
          join(batchReviewRoot, `before-normal-${size}.json`),
        );
      }
      const before = JSON.parse(
        await readFile(join(batchReviewRoot, 'before-normal-1440x1000.json'), 'utf8'),
      );
      await writeFile(
        join(batchReviewRoot, 'manifest.json'),
        JSON.stringify(
          {
            before_source: before.source_commit,
            before_dirty_tree: before.dirty_tree,
            before_note:
              'Detached reviewed PR #56 commit; only an untracked node_modules dependency symlink was present.',
            before_files: ['before-normal-1440x1000.png', 'before-normal-390x844.png'],
            after_source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            after_dirty_tree: execFileSync('git', ['status', '--short'], { encoding: 'utf8' })
              .trim()
              .split('\n')
              .filter(Boolean),
            after_diff_sha256: createHash('sha256')
              .update(execFileSync('git', ['diff', '--binary']))
              .digest('hex'),
            route: `/loom/discussion/${d.discussion}`,
            browser: 'Chromium',
            role: 'synthetic enrolled administrator',
            viewports: ['1440x1000', '390x844'],
            states: [
              'normal',
              'more-open',
              'manual-unread',
              'pending',
              'conflict',
              'recovery',
              'resource',
              'resource-more',
            ],
            resource_view:
              'Resource main text and its open More action are captured in both viewports.',
            reproduction: 'LOOM_READING_VIEWPORT_REVIEW=1 npm run test:e2e -- reading.spec.ts',
            declared_hold: 'One automatic reading state request held while manual Unread commits.',
            injected_failure:
              'Atomic version conflict is caused by the real concurrent manual Unread.',
          },
          null,
          2,
        ),
      );
    }
  } finally {
    release.release();
  }
});

test('reading storage failure leaves full text and recovery visible without dispatch', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server);
  const a = await d.artifact();
  await exact(page, server.origin, a);
  await readingTools(page, a.revision_id);
  await page.evaluate(() => {
    localStorage.setItem('loom.intent.synthetic-unrelated', 'preserved');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('loom.reading:') && key.includes(':intent:'))
        throw new Error('Synthetic storage fault');
      return original.call(this, key, value);
    };
  });
  const writes: any[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith(endpoint + '/state')) writes.push(request.postDataJSON());
  });
  const button = control(page, a.revision_id).getByRole('button', { name: 'Mark unread' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(control(page, a.revision_id).getByRole('alert')).toContainText('could not be saved');
  await expect(button).toBeFocused();
  await expect(control(page, a.revision_id).locator('.prose')).toBeVisible();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('loom.intent.synthetic-unrelated'))).toBe(
    'preserved',
  );
});

test('manual and automatic response loss retain exact recovery bodies across browser restarts', async ({
  server,
  diagnostics,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'loom-reading-browser-'));
  let context = await diagnostics.launchPersistentContext(directory, {
    ignoreHTTPSErrors: true,
    headless: true,
  });
  try {
    let page = await context.newPage();
    const d = await setup(page, context, server);
    const manual = await d.artifact('Manual response loss');
    await exact(page, server.origin, manual);
    await readingTools(page, manual.revision_id);
    const lost = barrier();
    let original: any;
    await page.route('**' + endpoint + '/state', async (route) => {
      original = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('connectionfailed');
      lost.release();
    });
    await control(page, manual.revision_id).getByRole('button', { name: 'Mark unread' }).click();
    await lost.promise;
    expect(original.targets).toEqual([{ ...pair(manual), read: false, expected_version: 0 }]);
    await api(page, endpoint + '/state', {
      idempotency_key: randomUUID(),
      basis: 'manual',
      episode_id: null,
      targets: [{ ...pair(manual), read: true, expected_version: 1 }],
    });
    await context.close();
    context = await diagnostics.launchPersistentContext(directory, {
      ignoreHTTPSErrors: true,
      headless: true,
    });
    page = await context.newPage();
    await page.goto(server.origin + '/loom/reading');
    let replay: any;
    page.on('request', (request) => {
      if (request.url().endsWith(endpoint + '/state')) replay = request.postDataJSON();
    });
    await page.getByRole('button', { name: 'Retry same reading change' }).click();
    await expect(page.getByText('No pending reading changes.')).toBeVisible();
    expect(replay).toEqual(original);
    expect(await state(page, manual)).toMatchObject({ read: true, version: 2 });

    await enable(page, server.origin);
    const automatic = await api(page, '/api/v1/artifacts', {
      idempotency_key: randomUUID(),
      area_id: d.area,
      title: 'Automatic restart target',
      content: text('Automatic response loss'),
    });
    const automaticLost = barrier();
    let automaticOriginal: any;
    await page.route('**' + endpoint + '/state', async (route) => {
      const body = route.request().postDataJSON();
      if (body.basis !== 'presentation') return route.continue();
      automaticOriginal = body;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort('connectionfailed');
      automaticLost.release();
    });
    await exact(page, server.origin, automatic);
    await page.bringToFront();
    await Promise.race([
      automaticLost.promise,
      page.waitForTimeout(8000).then(() => {
        throw new Error('Automatic reading did not dispatch after process restart.');
      }),
    ]);
    expect(automaticOriginal.targets).toEqual([
      { ...pair(automatic), read: true, expected_version: 0 },
    ]);
    await context.close();
    context = await diagnostics.launchPersistentContext(directory, {
      ignoreHTTPSErrors: true,
      headless: true,
    });
    page = await context.newPage();
    await page.goto(server.origin + '/loom/reading');
    let automaticReplay: any;
    page.on('request', (request) => {
      if (request.url().endsWith(endpoint + '/state')) automaticReplay = request.postDataJSON();
    });
    await page.getByRole('button', { name: 'Retry same reading change' }).click();
    await expect(page.getByText('No pending reading changes.')).toBeVisible();
    expect(automaticReplay).toEqual(automaticOriginal);
    expect(await state(page, automatic)).toMatchObject({ read: true, version: 1 });
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sign-out fences a late manual reading outcome before local recovery cleanup', async ({
  page,
  context,
  server,
}) => {
  const d = await setup(page, context, server);
  const a = await d.artifact('Sign-out reading target');
  await exact(page, server.origin, a);
  await readingTools(page, a.revision_id);
  const committed = barrier(),
    release = barrier();
  await page.route('**' + endpoint + '/state', async (route) => {
    const response = await route.fetch();
    committed.release();
    await release.promise;
    await route.fulfill({ response });
  });
  try {
    await control(page, a.revision_id).getByRole('button', { name: 'Mark unread' }).click();
    await committed.promise;
    const prefix = await page.evaluate(async () => {
      const key = Object.keys(localStorage).find(
        (candidate) => candidate.startsWith('loom.reading:') && candidate.includes(':intent:'),
      )!;
      const prefix = key.slice(0, key.indexOf('intent:'));
      let unlock!: () => void;
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      (window as any).releaseReadingLock = unlock;
      let acquired!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      void navigator.locks.request(prefix, async () => {
        acquired();
        await held;
      });
      await ready;
      return prefix;
    });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Export reading recovery' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear local drafts and sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to the Loom' })).toBeVisible();
    release.release();
    await page.unrouteAll({ behavior: 'wait' });
    await page.evaluate(() => (window as any).releaseReadingLock());
    await expect
      .poll(() =>
        page.evaluate(
          (readingPrefix) =>
            Object.keys(localStorage).filter((key) => key.startsWith(readingPrefix)).length,
          prefix,
        ),
      )
      .toBe(0);
    expect(
      (
        await server.observer.query(
          'SELECT is_read,version FROM loom.reading_states WHERE revision_id=$1',
          [a.revision_id],
        )
      ).rows,
    ).toEqual([{ is_read: false, version: 1 }]);
  } finally {
    release.release();
    await page.evaluate(() => (window as any).releaseReadingLock?.()).catch(() => {});
  }
});

test('background lifecycle and late abandoned responses cannot qualify', async ({
  server,
  diagnostics,
}) => {
  const native = await nativeLifecycleBrowser(diagnostics);
  const context = native.context;
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const d = await setup(page, context, server, 'default');
    const a = await d.artifact('Foreground eligible text');
    const b = await d.artifact('Abandoned late text');
    const lifecycle = await context.newCDPSession(page);
    const lookupHeld = barrier(),
      lookupRelease = barrier();
    await page.route('**' + endpoint + '/lookup', async (route) => {
      lookupHeld.release();
      await lookupRelease.promise;
      await route.continue();
    });
    await exact(page, server.origin, a);
    await lookupHeld.promise;
    await lifecycle.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await lifecycle.send('Page.setWebLifecycleState', { state: 'frozen' });
    lookupRelease.release();
    expect(await page.evaluate(() => document.visibilityState)).toBe('hidden');
    await page.waitForTimeout(400);
    expect((await state(page, a)).version).toBe(0);
    await lifecycle.send('Page.setWebLifecycleState', { state: 'active' });
    await lifecycle.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.bringToFront();
    await page.unrouteAll({ behavior: 'wait' });
    await expect.poll(async () => (await state(page, a)).read).toBe(true);
    const late = barrier(),
      finish = barrier();
    await page.route(
      `**/api/v1/resources/${b.resource_id}/revisions/${b.revision_id}`,
      async (route) => {
        const response = await page.request.get(route.request().url(), { ignoreHTTPSErrors: true });
        late.release();
        await finish.promise;
        await route.fulfill({ response });
      },
    );
    try {
      await page.goto(server.origin + `/loom/resource/${b.resource_id}/${b.revision_id}`);
      await late.promise;
      await page.goto(server.origin + '/loom/reading');
      finish.release();
      await page.unrouteAll({ behavior: 'wait' });
      await page.waitForTimeout(400);
      expect((await state(page, b)).version).toBe(0);
    } finally {
      finish.release();
    }
  } finally {
    await native.close();
  }
});
