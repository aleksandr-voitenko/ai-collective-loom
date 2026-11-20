import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

export const topicDiscussionReview = process.env.LOOM_TOPIC_DISCUSSION_REVIEW === '1';
export const baselineTopicDiscussionReview =
  topicDiscussionReview && process.env.LOOM_TOPIC_DISCUSSION_BASELINE === '1';
const freshnessReview = process.env.LOOM_TOPIC_DISCUSSION_FRESHNESS_REVIEW === '1';

const currentReproduction =
  'npm run app:build && LOOM_TOPIC_DISCUSSION_REVIEW=1 npm run test:e2e -- participation.spec.ts --grep "topic discussion browser"';
const browsingReproduction = baselineTopicDiscussionReview
  ? 'From a checkout of 30672f10d7b612c6a0fa73c08ed6123c283b6ff3, copy the review checkout’s tests/e2e/participation.spec.ts and tests/helpers/topic-discussion-review.ts. Then run npm run app:build && LOOM_TOPIC_DISCUSSION_REVIEW=1 LOOM_TOPIC_DISCUSSION_BASELINE=1 npm run test:e2e -- participation.spec.ts --grep "topic discussion browser appends"'
  : currentReproduction;
const freshnessReproduction =
  'npm run app:build && LOOM_TOPIC_DISCUSSION_FRESHNESS_REVIEW=1 npm run test:e2e -- --workers=1 participation.spec.ts --grep "topic discussion freshness"';
const captureSets: Record<'browsing' | 'freshness', unknown[]> = { browsing: [], freshness: [] };

export async function captureTopicDiscussions(
  page: Page,
  state: string,
  target: Locator,
  options: {
    desktopTop?: number;
    mobileTop?: number;
    injected?: string[];
    review?: 'freshness';
  } = {},
) {
  const freshness = options.review === 'freshness';
  if (!(freshness ? freshnessReview : topicDiscussionReview)) return;
  const directory =
    (freshness
      ? process.env.LOOM_TOPIC_DISCUSSION_FRESHNESS_REVIEW_DIR
      : process.env.LOOM_TOPIC_DISCUSSION_REVIEW_DIR) ??
    join(
      tmpdir(),
      'loom-review-evidence',
      freshness ? 'topic-discussion-freshness' : 'topic-discussions',
    );
  const reproduction = freshness ? freshnessReproduction : browsingReproduction;
  const captures = captureSets[freshness ? 'freshness' : 'browsing'];
  const inputs = applicationInputs(process.cwd());
  const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
  if (inputs.sha256 !== build.sha256) throw new Error('Topic discussion source and build differ.');
  const migration = 'db/migrations/0033_topic_discussion_freshness.sql';
  const databaseMigration = freshness
    ? {
        path: migration,
        sha256: createHash('sha256')
          .update(await readFile(migration))
          .digest('hex'),
      }
    : undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
  const status = git('status', '--porcelain');
  const sourceCommit = git('rev-parse', 'HEAD');
  const original = page.viewportSize()!;
  const scroll = await page.evaluate(() => scrollY);
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await target.waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      });
      const top = viewport.width === 390 ? options.mobileTop : options.desktopTop;
      if (top === undefined) await target.scrollIntoViewIfNeeded();
      else
        await target.evaluate(
          (node, top) => window.scrollBy(0, node.getBoundingClientRect().top - top),
          top,
        );
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Horizontal overflow in ${state} at ${viewport.width}px`);
      const filename = `${state}-${viewport.width}x${viewport.height}.png`;
      const bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
      const location = new URL(page.url());
      captures.push({
        filename,
        source_commit: sourceCommit,
        dirty_tree: status.length > 0,
        dirty_tree_paths: status
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        application_input_sha256: inputs.sha256,
        build_sha256: build.sha256,
        build_node: build.node,
        database_migration: databaseMigration,
        capture_node: process.version,
        route: location.pathname + location.search,
        viewport,
        browser: { name: 'Chromium', version: page.context().browser()!.version() },
        test_account_role: 'administrator',
        authentication: 'Ordinary synthetic WebAuthn',
        demonstrated_state: state,
        mocked_responses_and_injected_failures: options.injected ?? [],
        reproduction,
        full_viewport: true,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  } finally {
    await page.setViewportSize(original);
    await page.evaluate((offset) => window.scrollTo(0, offset), scroll);
  }
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(
      {
        screenshots: captures,
        reproduction,
        isolation:
          'Compiled Loom application, disposable PostgreSQL and HTTPS, actual Chromium WebAuthn, and an independently authenticated synthetic agent creating discussions. No authentication material was exported.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
