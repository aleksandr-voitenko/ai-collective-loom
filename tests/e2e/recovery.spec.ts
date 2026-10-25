import { diagnosticTest, expect } from '../helpers/browser-fixtures.js';
import { recoveryFixture } from '../helpers/recovery-fixture.js';
import { backup, restore, verify, destroy } from '../../scripts/lib/recovery.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

type Rehearsal = Awaited<ReturnType<typeof recoveryFixture>> & { origin: string };
const test = diagnosticTest.extend<{ rehearsal: Rehearsal }>({
  context: async ({ context, rehearsal: _rehearsal }, use) => {
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  rehearsal: async ({ diagnostics }, use) => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'loom-restored-browser-')),
      key = directory + '/key';
    writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
    let source: any, destination: any;
    diagnostics.phase('server_starting');
    try {
      const fixture = await recoveryFixture(directory, (d) => {
        source = d;
      });
      await backup(source, directory + '/backup', key);
      await destroy(source);
      source = undefined;
      destination = await restore(directory + '/backup', directory + '/destination', key);
      await verify(destination, fixture.expectations);
      const c = JSON.parse(readFileSync(destination.path + '/config.json', 'utf8'));
      diagnostics.setOrigin(c.origin);
      diagnostics.phase('server_ready');
      await use({ ...fixture, origin: c.origin });
    } finally {
      diagnostics.phase('server_closing');
      if (destination) await destroy(destination);
      if (source) await destroy(source);
      rmSync(directory, { recursive: true, force: true });
      diagnostics.phase('server_closed');
    }
  },
});

test('fresh browser at quarantined restored origin reads exact historical files and current content after source deletion', async ({
  page,
  context,
  rehearsal: f,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(f.origin)) external.push('external request');
  });
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
  await page.goto(f.origin + '/loom');
  await page.getByText('Set up an admitted account', { exact: true }).click();
  await page.getByLabel('Enrollment ticket', { exact: true }).fill(f.browserTicket);
  await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Topics', exact: true })).toBeVisible();
  await page.goto(f.origin + `/loom/resource/${f.first.resource_id}/${f.first.revision_id}`);
  await expect(page.getByText('Historical artifact text Ω', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open folder nested', exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download nested/original.txt', exact: true }).click();
  const download = await pending;
  expect(
    readFileSync((await download.path())!).equals(Buffer.from('Historical native file Ω\r\n')),
  ).toBe(true);
  await page.goto(f.origin + `/loom/resource/${f.first.resource_id}`);
  await expect(page.getByText('Current artifact text', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open folder nested', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Download nested/current.txt', exact: true }),
  ).toBeVisible();
  await page.goto(f.origin + `/loom/resource/${f.promoted.resource_id}/${f.promoted.revision_id}`);
  await expect(
    page.getByRole('button', { name: 'Download source.txt', exact: true }),
  ).toBeVisible();
  expect(external).toEqual([]);
});
