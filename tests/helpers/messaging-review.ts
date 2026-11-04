import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

const screenshots: unknown[] = [];
export async function captureMessaging(
  page: Page,
  state: string,
  faults: string[] = [],
  mockedResponses: string[] = [],
) {
  const nextReview = process.env.LOOM_NEXT_REVIEW === '1';
  if (
    nextReview &&
    ![
      'composer',
      'close-save-failure',
      'formatting-help',
      'parent-preview',
      'drafts',
      'publication-confirmed',
    ].includes(state)
  )
    return;
  const replyReview = process.env.LOOM_REPLY_REVIEW === '1' && state.startsWith('reply-');
  if (process.env.LOOM_MESSAGING_REVIEW !== '1' && !replyReview && !nextReview) return;
  const directory =
    '/tmp/loom-review-evidence/' +
    (nextReview ? 'messaging-next' : replyReview ? 'reply-navigation' : 'messaging');
  const inputs = applicationInputs(process.cwd());
  const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
  if (inputs.sha256 !== build.sha256) throw new Error('Messaging review source and build differ.');
  if (await page.getByLabel('Issued secret', { exact: true }).count())
    throw new Error('Credential display cannot enter review evidence.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await page.waitForLoadState('networkidle');
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
    test_account_role: 'participant',
    authentication: 'Ordinary synthetic WebAuthn enrollment and sign-in',
    mocked_responses: mockedResponses,
    injected_failures: faults,
    full_viewport: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await writeFile(
    directory + '/manifest.json',
    JSON.stringify(
      {
        screenshots,
        reproduction: `${nextReview ? 'LOOM_NEXT_REVIEW' : replyReview ? 'LOOM_REPLY_REVIEW' : 'LOOM_MESSAGING_REVIEW'}=1 npm run test:e2e -- participation.spec.ts --grep "administrator setup/admission"`,
        isolation:
          'Actual compiled React app, disposable PostgreSQL/HTTPS and virtual passkey. No staging/pilot, cookies, credentials or authentication exports.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
