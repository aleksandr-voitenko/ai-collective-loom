import { diagnosticTest as test, expect } from '../helpers/browser-fixtures.js';
import { stagingFixture, populateStaging } from '../helpers/staging.js';
import { createHash, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { httpClient } from '../helpers/participation-http.js';
import type { BrowserContext } from '@playwright/test';

test('staging ordinary non-admin browser enrolls and reconciles a lost committed reply behind the actual TLS proxy', async ({
  diagnostics,
}) => {
  let f: any, context: BrowserContext | undefined;
  diagnostics.phase('server_starting');
  try {
    f = await stagingFixture((x) => {
      f = x;
    });
    const p = await populateStaging(f);
    diagnostics.setOrigin(p.c.origin);
    diagnostics.phase('server_ready');
    const pin = createHash('sha256')
      .update(new X509Certificate(p.c.tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    // Scoped fixture key trust; no blanket TLS exception, system trust, DNS or hosts edit.
    context = await diagnostics.launchPersistentContext(join(f.directory, 'browser'), {
      headless: true,
      ignoreHTTPSErrors: false,
      viewport: { width: 1440, height: 1000 },
      args: [
        '--host-resolver-rules=MAP loom-staging.test 127.0.0.1',
        '--ignore-certificate-errors-spki-list=' + pin,
        '--no-proxy-server',
      ],
    });
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page);
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
    await page.goto(p.c.origin + '/loom');
    await expect(page.getByText('Staging test', { exact: true })).toBeVisible();
    await expect(page.getByText('Invitation-only staging for non-sensitive test material.')).toBeVisible();
    await expect(page.getByText('Local evaluation', { exact: true })).toHaveCount(0);
    if (process.env.LOOM_STAGING_REVIEW_SCREENS === '1') {
      const output = '/tmp/loom-review-evidence/staging';
      mkdirSync(output, { recursive: true, mode: 0o700 });
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: join(output, 'signin-' + viewport.width + '.png') });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.goto(p.c.origin + '/');
    await expect(page.getByRole('heading', { name: 'Invitation-only staging' })).toBeVisible();
    await page.goto(p.c.origin + '/status');
    await expect(page.getByText('Staging participant access is enabled. Sign in with an admitted account.')).toBeVisible();
    await page.goto(p.c.origin + '/loom');
    await page.getByText('Set up an admitted account', { exact: true }).click();
    await page.getByLabel('Enrollment ticket', { exact: true }).fill(p.browser.token);
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    await expect(page.getByText('Staging test', { exact: true })).toBeVisible();
    expect(await page.getByRole('link', { name: 'Administration', exact: true }).count()).toBe(0);
    if (process.env.LOOM_STAGING_REVIEW_SCREENS === '1') {
      const output = '/tmp/loom-review-evidence/staging';
      mkdirSync(output, { recursive: true, mode: 0o700 });
      for (const viewport of [
        { width: 1440, height: 1000 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: join(output, viewport.width + '.png') });
      }
      writeFileSync(
        join(output, 'manifest.json'),
        JSON.stringify({
          source: 'working tree based on befdbbb',
          dirty: true,
          route: '/loom',
          browser: 'Chromium',
          role: 'ordinary human participant',
          state: 'Anonymous sign-in and ordinary participant Topics with staging presentation',
          fixture: 'isolated synthetic accounts; pinned fixture TLS key and scoped DNS',
          command: 'LOOM_STAGING_REVIEW_SCREENS=1 npm run test:e2e -- staging.spec.ts',
        }),
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.goto(p.c.origin + '/loom/discussion/' + p.discussion);
    const opening = page.locator(`[data-resource-id="${p.opening.resource_id}"]`);
    await opening.getByRole('button', { name: 'Reply', exact: true }).click();
    await opening.getByLabel('Your reply').fill('Browser staging committed reply');
    let original: any, committed: any;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const barrier = new Promise<void>((r, j) => {
      resolve = r;
      reject = j;
    });
    // Attach failure custody before dispatch so route errors reach test cleanup.
    void barrier.catch(() => {});
    await page.route('**/api/v1/replies', async (route) => {
      try {
        original = route.request().postDataJSON();
        const response = await httpClient(p.c.origin, p.c.tls.ca, undefined, p.c.transport).call(
          '/api/v1/replies',
          original,
          { headers: route.request().headers() },
        );
        expect(response.status).toBe(201);
        committed = response.body;
        await route.abort('connectionfailed');
        resolve();
      } catch (error) {
        reject(error);
        await route.abort('failed').catch(() => {});
      }
    });
    await page.getByRole('button', { name: 'Post reply', exact: true }).click();
    await barrier;
    await expect(
      page.getByText('We couldn’t confirm whether your reply was posted.'),
    ).toBeVisible();
    await page.unroute('**/api/v1/replies');
    await page.reload();
    await expect(page.getByLabel('Your reply')).toHaveValue('Browser staging committed reply');
    const self = await page.evaluate(async () => {
      const r = await fetch('/api/v1/identity/self');
      return r.json();
    });
    expect(self.participant_id).toBe(p.browser.id);
    expect(self.role).toBe('participant');
    const recovered = await page.evaluate(
      async ({ key, csrf }) => {
        const r = await fetch('/api/v1/operations/status', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-loom-csrf': csrf },
          body: JSON.stringify({ operation_kind: 'reply.create', idempotency_key: key }),
        });
        return r.json();
      },
      { key: original.idempotency_key, csrf: self.csrf },
    );
    expect(recovered.revision_id).toBe(committed.revision_id);
    const cookies = await context.cookies(p.c.origin);
    expect(
      cookies
        .filter((c) => c.name.includes('session'))
        .every((c) => c.secure && c.httpOnly && c.sameSite === 'Strict'),
    ).toBe(true);
    for (const [index, revision] of [p.first, p.second].entries()) {
      await page.goto(
        p.c.origin + `/loom/resource/${revision.resource_id}/${revision.revision_id}`,
      );
      await page.getByRole('button', { name: 'Open folder nested', exact: true }).click();
      const file = index === 0 ? 'original.txt' : 'current.txt';
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download nested/' + file, exact: true }).click();
      const saved = await download;
      expect(readFileSync((await saved.path())!)).toEqual(p.bytes[index]);
      expect(new URL(page.url()).origin).toBe(p.c.origin);
    }
    await diagnostics.snapshot(page);
  } finally {
    await context?.close();
    diagnostics.phase('server_closing');
    await f?.close();
    diagnostics.phase('server_closed');
  }
});
