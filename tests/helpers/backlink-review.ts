import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect } from './browser-fixtures.js';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

export async function backlinkReview(
  page: Page,
  options: { state: 'initial-empty' | 'end-of-page' | 'populated' } = { state: 'populated' },
) {
  if (process.env.LOOM_BACKLINK_REVIEW !== '1') return;
  const directory = '/tmp/loom-review-evidence/pr55-followup';
  const inputs = applicationInputs(process.cwd()),
    release = JSON.parse(await readFile('dist/release.json', 'utf8'));
  expect(release.sha256).toBe(inputs.sha256);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const captures: Record<string, unknown>[] =
    options.state === 'populated'
      ? []
      : JSON.parse(await readFile(directory + '/manifest.json', 'utf8')).captures;
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    if (options.state === 'populated')
      await expect(
        page.getByRole('link', { name: 'Related implementation' }).first(),
      ).toBeVisible();
    else
      await expect(
        page.getByText(
          options.state === 'initial-empty'
            ? 'No recorded mentions yet. Earlier text is included only when revised.'
            : 'End of recorded mentions.',
          { exact: true },
        ),
      ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const filename = `${options.state}-${viewport.width}x${viewport.height}.png`;
    await page.screenshot({ path: directory + '/' + filename, fullPage: false });
    captures.push({
      filename,
      viewport,
      route: new URL(page.url()).pathname,
      state: options.state,
    });
  }
  await writeFile(
    directory + '/manifest.json',
    JSON.stringify(
      {
        source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty_tree:
          execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
        application_input_sha256: inputs.sha256,
        browser: page.context().browser()!.version(),
        role: 'participant',
        authentication: 'Disposable synthetic account; existing WebAuthn fixture',
        mocked_responses: [],
        reproduction:
          'LOOM_BACKLINK_REVIEW=1 npm run test:e2e -- references.spec.ts --grep "automatic discussion backlinks"',
        captures,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
