import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

const screenshots: unknown[] = [];
const directory = '/tmp/loom-review-evidence/continuous-discussion';

export async function captureContinuousDiscussion(
  page: Page,
  state: string,
  injectedFailures: string[] = [],
) {
  if (process.env.LOOM_CONTINUOUS_REVIEW !== '1') return;
  const inputs = applicationInputs(process.cwd());
  const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
  if (inputs.sha256 !== build.sha256) throw new Error('Discussion review source and build differ.');
  if (await page.getByLabel('Issued secret', { exact: true }).count())
    throw new Error('Credential display cannot enter review evidence.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!state.startsWith('pending')) {
    if (state === 'completed-tail') await page.waitForTimeout(400);
    await page.waitForLoadState('networkidle');
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const viewport = page.viewportSize()!;
  const filename = `${state}-${viewport.width}x${viewport.height}.png`;
  const bytes = await page.screenshot({ path: directory + '/' + filename, fullPage: false });
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
  screenshots.push({
    filename,
    state,
    source_commit: git('rev-parse', 'HEAD'),
    dirty_tree: git('status', '--porcelain').length > 0,
    application_input_sha256: inputs.sha256,
    build_sha256: build.sha256,
    route: new URL(page.url()).pathname,
    viewport,
    browser: { name: 'Chromium', version: page.context().browser()!.version() },
    test_account_role: 'administrator',
    authentication: 'Ordinary synthetic WebAuthn enrollment and sign-in',
    mocked_responses: [],
    injected_failures: injectedFailures,
    full_viewport: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await writeFile(
    directory + '/manifest.json',
    JSON.stringify(
      {
        screenshots,
        reproduction:
          'LOOM_CONTINUOUS_REVIEW=1 npm run test:e2e -- participation.spec.ts --grep "continuous comments and replies"',
        isolation:
          'Actual compiled React app, disposable PostgreSQL/HTTPS and virtual passkey. No credentials, cookies or authentication exports.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
