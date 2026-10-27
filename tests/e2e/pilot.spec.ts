import { diagnosticTest, expect } from '../helpers/browser-fixtures.js';
import {
  pilotFixture,
  populatePilot,
  pilotCommand,
  readInstance,
  sql,
  owned,
  name,
  freePort,
} from '../helpers/pilot.js';
import { docker } from '../../scripts/lib/pilot-files.mjs';
import { httpsCall } from '../../scripts/lib/recovery.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Page, BrowserContext } from '@playwright/test';

async function device(page: Page, context: BrowserContext, credentials: any[] = []) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of credentials)
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  return { cdp, authenticatorId };
}
async function enter(
  page: Page,
  context: BrowserContext,
  origin: string,
  ticket: string,
  initialSetup = false,
) {
  const authenticator = await device(page, context);
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
  return authenticator;
}
async function independentStatus(
  context: BrowserContext,
  origin: string,
  ca: string,
  key: string,
  csrf: string,
) {
  const cookies = await context.cookies(origin),
    cookie = cookies.map((x) => x.name + '=' + x.value).join('; ');
  const { request } = await import('node:https');
  return new Promise<any>((resolve, reject) => {
    const bytes = JSON.stringify({ operation_kind: 'reply.create', idempotency_key: key });
    const req = request(
      new URL('/api/v1/operations/status', origin),
      {
        ca,
        agent: false,
        method: 'POST',
        headers: { cookie, origin, 'x-loom-csrf': csrf, 'content-type': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      },
    );
    req.setTimeout(20000, () => req.destroy(new Error('Independent HTTPS deadline')));
    req.on('error', reject);
    req.end(bytes);
  });
}
async function journals(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('loom.intent.'))
      .map((k) => JSON.parse(localStorage.getItem(k)!)),
  );
}

const test = diagnosticTest;
test('pilot retained browser draft and committed uncertain command survive reload, browser process restart and API crash', async ({
  diagnostics,
}) => {
  let f: any, context: BrowserContext | undefined;
  diagnostics.phase('server_starting');
  try {
    f = await pilotFixture((x) => {
      f = x;
    });
    const p = await populatePilot(f);
    diagnostics.setOrigin(p.c.origin);
    diagnostics.phase('server_ready');
    const profile = join(f.directory, 'browser-profile');
    mkdirSync(profile, { mode: 0o700 });
    const options = {
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    };
    context = await diagnostics.launchPersistentContext(profile, options);
    let page = await context.newPage();
    const authenticator = await enter(page, context, p.c.origin, p.browser.token);
    await page.goto(p.c.origin + '/loom/discussion/' + p.discussion);
    let opening = page.locator(`[data-resource-id="${p.opening.resource_id}"]`);
    await opening.getByRole('button', { name: 'Reply', exact: true }).click();
    await opening.getByLabel('Your reply').fill('Browser exact retained uncertain reply');
    await expect
      .poll(async () => JSON.stringify(await journals(page)))
      .toContain('Browser exact retained uncertain reply');
    await page.reload();
    await expect(page.getByLabel('Your reply')).toHaveValue(
      'Browser exact retained uncertain reply',
    );
    let posted: any, committed: any, resolveBarrier!: () => void;
    const barrier = new Promise<void>((r) => (resolveBarrier = r));
    await page.route('**/api/v1/replies', async (route) => {
      posted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committed = await response.json();
      // Observed committed response establishes ordering; SIGKILL is a real process loss.
      owned(p.d, 'container', name(p.d, 'api'));
      docker(['kill', '--signal', 'KILL', name(p.d, 'api')]);
      await route.abort('connectionfailed');
      resolveBarrier();
    });
    await page.getByRole('button', { name: 'Post reply', exact: true }).click();
    await barrier;
    await expect(
      page.getByText('We couldn’t confirm whether your reply was posted.'),
    ).toBeVisible();
    const uncertain = (await journals(page)).find((r: any) => r.key === posted.idempotency_key);
    expect(uncertain.body).toEqual(posted);
    // Persist only this fixture’s software device, independently of browser profile storage.
    const storedDevice = await authenticator.cdp.send('WebAuthn.getCredentials', {
      authenticatorId: authenticator.authenticatorId,
    });
    await diagnostics.snapshot(page);
    await context.close();
    await f.command('start');
    context = await diagnostics.launchPersistentContext(profile, options);
    page = await context.newPage();
    await device(page, context, storedDevice.credentials);
    await page.goto(p.c.origin + '/loom/discussion/' + p.discussion);
    await expect(page.getByLabel('Your reply')).toHaveValue(
      'Browser exact retained uncertain reply',
    );
    expect((await journals(page)).find((r: any) => r.key === posted.idempotency_key).body).toEqual(
      posted,
    );
    const self = await page.request.get(p.c.origin + '/api/v1/identity/self');
    const selfBody = await self.json();
    expect(selfBody.participant_id).toBe(p.browser.id);
    const independent = await independentStatus(
      context,
      p.c.origin,
      p.c.tls.ca,
      posted.idempotency_key,
      selfBody.csrf,
    );
    expect(independent.status).toBe(200);
    expect(independent.body.revision_id).toBe(committed.revision_id);
    expect(independent.body.resource_id).toBe(committed.resource_id);
    await page.getByRole('button', { name: 'Retry same reply', exact: true }).click();
    await expect(page.getByText('Your reply was posted.', { exact: true })).toBeVisible();
    expect(
      sql(
        p.d,
        `SELECT count(*) FROM loom.idempotency_records WHERE idempotency_key='${posted.idempotency_key}'`,
      ),
    ).toBe('1');
    expect(sql(p.d, `SELECT id FROM loom.revisions WHERE id='${committed.revision_id}'`)).toBe(
      committed.revision_id,
    );
    expect(
      sql(
        p.d,
        `SELECT count(*) FROM loom.shared_activity WHERE revision_id='${committed.revision_id}'`,
      ),
    ).toBe('1');
    await expect
      .poll(() =>
        sql(
          p.d,
          `SELECT count(*) FROM loom.notification_signals WHERE revision_id='${committed.revision_id}' AND recipient_id='${p.alice.id}'`,
        ),
      )
      .toBe('1');
    // Controlled expiry is separate from the valid-session process-restart assertion above.
    sql(
      p.d,
      `UPDATE loom.participant_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id='${selfBody.credential_id}'`,
    );
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Sign in with passkey', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const reauthenticated = await (
      await page.request.get(p.c.origin + '/api/v1/identity/self')
    ).json();
    expect(reauthenticated.participant_id).toBe(p.browser.id);
    expect(reauthenticated.credential_id).not.toBe(selfBody.credential_id);
  } finally {
    await context?.close();
    diagnostics.phase('server_closing');
    await f?.close();
    diagnostics.phase('server_closed');
  }
});

test('pilot unreceived request remains uncertain through provider loss and explicit same-key recovery', async ({
  diagnostics,
}) => {
  let f: any, context: BrowserContext | undefined;
  diagnostics.phase('server_starting');
  try {
    f = await pilotFixture((x) => {
      f = x;
    });
    const p = await populatePilot(f);
    diagnostics.setOrigin(p.c.origin);
    diagnostics.phase('server_ready');
    const profile = join(f.directory, 'browser-profile');
    mkdirSync(profile, { mode: 0o700 });
    context = await diagnostics.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await enter(page, context, p.c.origin, p.browser.token);
    await page.goto(p.c.origin + '/loom/discussion/' + p.discussion);
    const opening = page.locator(`[data-resource-id="${p.opening.resource_id}"]`);
    await opening.getByRole('button', { name: 'Reply', exact: true }).click();
    await opening.getByLabel('Your reply').fill('Never received exact reply');
    let posted: any, done!: () => void;
    const barrier = new Promise<void>((r) => (done = r));
    await page.route('**/api/v1/replies', async (route) => {
      posted = route.request().postDataJSON();
      await route.abort('connectionfailed');
      done();
    });
    await page.getByRole('button', { name: 'Post reply', exact: true }).click();
    await barrier;
    await expect(
      page.getByText('We couldn’t confirm whether your reply was posted.'),
    ).toBeVisible();
    expect(
      sql(
        p.d,
        `SELECT count(*) FROM loom.idempotency_records WHERE idempotency_key='${posted.idempotency_key}'`,
      ),
    ).toBe('0');
    await page.unroute('**/api/v1/replies');
    owned(p.d, 'container', name(p.d, 'postgres'));
    docker(['stop', '--time', '60', name(p.d, 'postgres')]);
    await page.reload();
    await expect
      .poll(async () => JSON.stringify(await journals(page)))
      .toContain('Never received exact reply');
    docker(['start', name(p.d, 'postgres')]);
    await f.command('restart');
    await page.reload();
    await expect(page.getByLabel('Your reply')).toHaveValue('Never received exact reply');
    expect((await journals(page)).find((r: any) => r.key === posted.idempotency_key).body).toEqual(
      posted,
    );
    await page.getByRole('button', { name: 'Retry same reply', exact: true }).click();
    await expect(page.getByText('Your reply was posted.', { exact: true })).toBeVisible();
    expect(
      sql(
        p.d,
        `SELECT count(*) FROM loom.idempotency_records WHERE idempotency_key='${posted.idempotency_key}'`,
      ),
    ).toBe('1');
    const self = await (await page.request.get(p.c.origin + '/api/v1/identity/self')).json();
    const recovered = await independentStatus(
      context,
      p.c.origin,
      p.c.tls.ca,
      posted.idempotency_key,
      self.csrf,
    );
    expect(recovered.status).toBe(200);
    expect(
      sql(p.d, `SELECT content_text FROM loom.revisions WHERE id='${recovered.body.revision_id}'`),
    ).toBe('Never received exact reply');
    expect(
      sql(
        p.d,
        `SELECT count(*) FROM loom.shared_activity WHERE revision_id='${recovered.body.revision_id}'`,
      ),
    ).toBe('1');
  } finally {
    await context?.close();
    diagnostics.phase('server_closing');
    await f?.close();
    diagnostics.phase('server_closed');
  }
});

test('pilot fresh isolated restore serves exact historical files to compiled Chromium with separate enrollment', async ({
  diagnostics,
}) => {
  let f: any, context: BrowserContext | undefined, destination: string | undefined;
  diagnostics.phase('server_starting');
  try {
    f = await pilotFixture((x) => {
      f = x;
    });
    const p = await populatePilot(f);
    const key = join(f.directory, 'key'),
      backup = join(f.directory, 'backup');
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    await f.command('backup', { backup, 'key-file': key });
    destination = join(f.directory, 'restore');
    await f.command('restore', {
      backup,
      'key-file': key,
      destination,
      port: String(await freePort()),
    });
    await pilotCommand('verify', destination, { expectations: p.expectations });
    const c = JSON.parse(readFileSync(join(destination, 'config.json'), 'utf8'));
    diagnostics.setOrigin(c.origin);
    diagnostics.phase('server_ready');
    const profile = join(f.directory, 'browser-profile');
    mkdirSync(profile, { mode: 0o700 });
    context = await diagnostics.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await enter(page, context, c.origin, p.browser.token);
    for (const [i, revision] of [p.first, p.second].entries()) {
      await page.goto(c.origin + `/loom/resource/${revision.resource_id}/${revision.revision_id}`);
      await expect(
        page.getByText(i ? 'Current artifact' : 'Historical artifact', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Open folder nested', exact: true }).click();
      const pending = page.waitForEvent('download');
      await page
        .getByRole('button', {
          name: i ? 'Download nested/current.txt' : 'Download nested/original.txt',
          exact: true,
        })
        .click();
      const download = await pending;
      expect(readFileSync((await download.path())!).equals(p.bytes[i]!)).toBe(true);
    }
    expect(
      (
        await httpsCall(
          c.origin,
          c.tls.ca,
          '/api/v1/me/notes/' + p.note.note_id,
          undefined,
          p.bob.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (await httpsCall(c.origin, c.tls.ca, '/api/v1/artifacts', p.originalCommand, p.alice.token))
        .body.revision_id,
    ).toBe(p.first.revision_id);
  } finally {
    await context?.close();
    diagnostics.phase('server_closing');
    if (destination && existsSync(join(destination, 'instance.json'))) {
      const d = readInstance(destination);
      await pilotCommand('destroy-test', destination, {
        'test-owner': f.testOwner,
        'confirm-instance': d.id,
      });
    }
    await f?.close();
    diagnostics.phase('server_closed');
  }
});

test('pilot first-run setup is focused, retains exact recovery, and opens the community only after confirmation', async ({
  diagnostics,
}, testInfo) => {
  let f: any, context: BrowserContext | undefined;
  diagnostics.phase('server_starting');
  try {
    f = await pilotFixture((x) => {
      f = x;
    });
    const c = f.config(),
      d = f.instance();
    diagnostics.setOrigin(c.origin);
    diagnostics.phase('server_ready');
    const profile = join(f.directory, 'setup-browser');
    mkdirSync(profile, { mode: 0o700 });
    context = await diagnostics.launchPersistentContext(profile, {
      headless: true,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 1000 },
    });
    const page = await context.newPage();
    const ticket = JSON.parse(
      readFileSync(join(f.path, 'enrollment/enrollment.json'), 'utf8'),
    ).ticket;
    await enter(page, context, c.origin, ticket, true);
    await expect(page.getByText('Local pilot', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Community navigation' })).toHaveCount(0);
    await expect(page.getByText('Operational health', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create root topic', exact: true })).toHaveCount(0);
    const info = await (await page.request.get(c.origin + '/api/v1/community')).json();
    expect(info.installation_mode).toBe('local-pilot');
    expect(info.settings_version).toBe(0);
    await expect(page.getByRole('textbox')).toHaveCount(1);
    await expect(page.getByRole('complementary', { name: 'What setup creates' })).toHaveCount(0);
    const defaults = {
      ordinary_area_name: 'General',
      proposal_area_name: 'Community organization',
      overview: {
        format: 'loom-markdown-v1',
        text: 'Welcome to our shared workspace.\n\nUse General for questions and ongoing work. Propose organizational changes in Community organization.',
        mentions: [],
      },
    };
    await page.getByLabel('Community name', { exact: true }).fill('First-run commons');
    await expect
      .poll(async () => (await journals(page)).find((r: any) => r.slot === 'setup')?.body)
      .toEqual({ ...defaults, community_name: 'First-run commons', idempotency_key: expect.any(String) });
    const draft = (await journals(page)).find((r: any) => r.slot === 'setup');
    await page.reload();
    await expect(page.getByLabel('Community name', { exact: true })).toHaveValue(
      'First-run commons',
    );
    const captureReview = async (name: string) => {
      if (process.env.LOOM_PILOT_SETUP_REVIEW !== '1') return;
      const output = testInfo.outputPath(name + '.png');
      await page.screenshot({ path: output, fullPage: true });
      const review = '/private/tmp/loom-review-evidence/pilot-setup';
      mkdirSync(review, { recursive: true, mode: 0o700 });
      copyFileSync(output, join(review, name + '.png'));
    };
    await captureReview('desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole('button', { name: 'Create community', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await captureReview('mobile');
    await diagnostics.snapshot(page);
    let submitted: any;
    await page.route('**/api/v1/community/setup', async (route) => {
      submitted = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort('connectionfailed');
    });
    await page.getByRole('button', { name: 'Create community', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry same setup', exact: true })).toBeEnabled();
    expect(submitted).toEqual(draft.body);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Check setup status', exact: true }),
    ).toBeVisible();
    expect((await journals(page)).find((r: any) => r.slot === 'setup').body).toEqual(submitted);
    expect(
      sql(
        d,
        `SELECT count(*) FROM loom.idempotency_records WHERE idempotency_key='${submitted.idempotency_key}'`,
      ),
    ).toBe('1');
    await page.getByRole('button', { name: 'Check setup status', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Community navigation' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Close navigation ×', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create community', exact: true }),
    ).toHaveCount(0);
    const initialized = await (await page.request.get(c.origin + '/api/v1/community')).json();
    expect(initialized.instance_id).toBe(info.instance_id);
    expect(initialized.community_name).toBe('First-run commons');
    expect(initialized.settings_version).toBe(1);
    const areas = await (await page.request.get(c.origin + '/api/v1/areas')).json();
    expect(areas.items.map((area: any) => area.title).sort()).toEqual(['Community organization', 'General']);
    const overview = await page.request.get(c.origin + `/api/v1/resources/${initialized.overview.resource_id}/revisions/${initialized.overview.revision_id}`);
    expect(overview.status()).toBe(200);
    expect((await overview.json()).content).toEqual(defaults.overview);
  } finally {
    await context?.close();
    diagnostics.phase('server_closing');
    await f?.close();
    diagnostics.phase('server_closed');
  }
});
