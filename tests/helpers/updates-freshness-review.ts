import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

const baseline = '3c7b46b747ab0820d713989bc7e1261bcdfc409c';
const phase = process.env.LOOM_UPDATES_FRESHNESS_REVIEW;
export const captureUpdatesBaseline = phase === 'before';
const directory = '/tmp/loom-review-evidence/updates-freshness';
const screenshots: unknown[] = [];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function captureUpdatesFreshness(
  page: Page,
  state: string,
  anchor: Locator,
  description: string,
  injected: string[] = [],
) {
  if (phase !== 'before' && phase !== 'after') return;
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
  const commit = git('rev-parse', 'HEAD');
  const inputs = applicationInputs(process.cwd());
  const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
  if (build.sha256 !== inputs.sha256)
    throw new Error('Build the reviewed application before capturing Updates.');
  if (
    captureUpdatesBaseline &&
    (commit !== baseline ||
      inputs.sha256 !== 'd8e37bded8553652c6573276a340c3dc0b0c3d7f3bf5b074c727a82281d323d2' ||
      git('status', '--porcelain', '--', 'db/migrations'))
  )
    throw new Error('The before review requires the unchanged Task 12 baseline.');
  const status = git('status', '--porcelain', '--untracked-files=all');
  const assets = [
    'index.html',
    ...(await readdir('dist/web/assets')).sort().map((name) => 'assets/' + name),
  ];
  const compiledAssets = Object.fromEntries(
    await Promise.all(
      assets.map(async (name) => [name, digest(await readFile(join('dist/web', name)))]),
    ),
  );
  const oldSize = page.viewportSize()!;
  const oldScroll = await page.evaluate(() => window.scrollY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, (image) => image.decode()));
      });
      await anchor.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().top - 24));
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Horizontal overflow at ${viewport.width}px in ${state}`);
      const filename = `${state}-${viewport.width}x${viewport.height}.png`;
      const bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
      screenshots.push({
        filename,
        viewport,
        full_viewport: true,
        description,
        scroll_y: await page.evaluate(() => scrollY),
        mocked_responses_and_injected_failures: injected,
        sha256: digest(bytes),
      });
    }
  } finally {
    await page.setViewportSize(oldSize);
    await page.evaluate((top) => window.scrollTo(0, top), oldScroll);
  }
  await writeFile(
    join(directory, `manifest-${phase}.json`),
    JSON.stringify(
      {
        source_commit: commit,
        dirty_tree: Boolean(status),
        dirty_tree_paths: status.split('\n').filter(Boolean),
        application_input_sha256: inputs.sha256,
        build_sha256: build.sha256,
        build_node: build.node,
        compiled_web_assets_sha256: compiledAssets,
        test_conditions: captureUpdatesBaseline
          ? []
          : [
              'Playwright advances only the browser clock for deterministic observation intervals. Service clocks and transactions run normally.',
              'One automatic observation and the first explicit application each receive one synthetic HTTP 503. The retries reach the real API.',
              'The successful explicit application response is held while the second participant publishes another revision.',
            ],
        browser: `Chromium ${page.context().browser()!.version()}`,
        route: new URL(page.url()).pathname,
        account_role: 'Non-administrator participant',
        isolation:
          'Compiled Loom React application served over HTTPS with a fresh PostgreSQL database, ordinary virtual WebAuthn enrollment and sign-in, and a second authenticated participant producing activity. No credential exports.',
        reproduction:
          (captureUpdatesBaseline
            ? `In a checkout of ${baseline}, copy the review checkout’s tests/e2e/updates.spec.ts and tests/helpers/updates-freshness-review.ts. `
            : '') +
          `Using Node 24.19.0, run npm run app:build && LOOM_UPDATES_FRESHNESS_REVIEW=${phase} npm run test:e2e -- updates.spec.ts --grep 'automatically discovers a delayed delivery'`,
        screenshots,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
