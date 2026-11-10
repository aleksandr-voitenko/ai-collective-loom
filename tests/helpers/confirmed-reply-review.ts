import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

const directory = '/tmp/loom-review-evidence/confirmed-replies';
const screenshots: unknown[] = [];

export async function captureConfirmedReply(
  page: Page,
  state: string,
  target: Locator,
  injectedFailures: string[] = [],
) {
  if (process.env.LOOM_CONFIRMED_REPLY_REVIEW !== '1') return;
  const inputs = applicationInputs(process.cwd());
  const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
  if (inputs.sha256 !== build.sha256) throw new Error('Reply review source and build differ.');
  if (await page.getByLabel('Issued secret', { exact: true }).count())
    throw new Error('Credential display cannot enter review evidence.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await target.scrollIntoViewIfNeeded();
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const filename = `${state}-${viewport.width}x${viewport.height}.png`;
    const bytes = await page.screenshot({ path: `${directory}/${filename}`, fullPage: false });
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
    screenshots.push({
      filename,
      state,
      source_commit: git('rev-parse', 'HEAD'),
      dirty_tree: git('status', '--porcelain').length > 0,
      source_diff_sha256: createHash('sha256').update(git('diff', '--binary')).digest('hex'),
      application_input_sha256: inputs.sha256,
      build_sha256: build.sha256,
      route: new URL(page.url()).pathname + new URL(page.url()).search,
      viewport,
      browser: { name: 'Chromium', version: page.context().browser()!.version() },
      test_account_role: 'administrator',
      authentication: 'Ordinary synthetic WebAuthn enrollment and sign-in',
      mocked_responses: [],
      injected_failures: injectedFailures,
      full_viewport: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`Horizontal overflow in ${filename}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await writeFile(
    `${directory}/manifest.json`,
    JSON.stringify(
      {
        screenshots,
        reproduction:
          'npm run app:build && LOOM_CONFIRMED_REPLY_REVIEW=1 npm run test:e2e -- participation.spec.ts --grep "a confirmed reply appears|separately confirmed replies|a separately confirmed reply collapses|a restored inline reply draft|failed content read|depth-limit reply"',
        isolation:
          'Actual compiled React app, disposable PostgreSQL/HTTPS and virtual passkey. No credentials, cookies or authentication exports.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
