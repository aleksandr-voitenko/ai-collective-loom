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
const layoutReproduction = 'npm run app:build && node tests/review/run-topic-layout.mjs after';
const layoutBaselineReproduction =
  'From a checkout of efcbb96610d360ab54f5fd648066b158c638d5fe, copy the review checkout’s tests/review/ directory and tests/helpers/topic-discussion-review.ts. Run npm run app:build && node tests/review/run-topic-layout.mjs before';
export const topicLayoutReview = process.env.LOOM_TOPIC_LAYOUT_REVIEW;
type Review = 'browsing' | 'freshness' | 'layout';
const captureSets: Record<Review, unknown[]> = { browsing: [], freshness: [], layout: [] };

type CaptureOptions = {
  desktopTop?: number;
  mobileTop?: number;
  injected?: string[];
  scroll?: 'top';
  viewport?: 'desktop' | 'mobile';
  visibleInViewport?: Locator[];
} & (
  | { review: 'layout'; role: 'administrator' | 'participant' }
  | { review?: 'freshness'; role?: 'administrator' | 'participant' }
);

export async function captureTopicDiscussions(
  page: Page,
  state: string,
  target: Locator,
  options: CaptureOptions = {},
) {
  const review = options.review ?? 'browsing';
  const phase = topicLayoutReview === 'before' ? 'before' : 'after';
  const profiles = {
    browsing: {
      enabled: topicDiscussionReview,
      directory: process.env.LOOM_TOPIC_DISCUSSION_REVIEW_DIR,
      name: 'topic-discussions',
      reproduction: browsingReproduction,
      manifest: 'manifest.json',
    },
    freshness: {
      enabled: freshnessReview,
      directory: process.env.LOOM_TOPIC_DISCUSSION_FRESHNESS_REVIEW_DIR,
      name: 'topic-discussion-freshness',
      reproduction: freshnessReproduction,
      manifest: 'manifest.json',
    },
    layout: {
      enabled: topicLayoutReview === 'before' || topicLayoutReview === 'after',
      directory: process.env.LOOM_TOPIC_LAYOUT_REVIEW_DIR,
      name: 'topic-layout',
      reproduction: phase === 'before' ? layoutBaselineReproduction : layoutReproduction,
      manifest: `manifest-${phase}.json`,
    },
  };
  const profile = profiles[review];
  if (!profile.enabled) return;
  const directory = profile.directory ?? join(tmpdir(), 'loom-review-evidence', profile.name);
  const captures = captureSets[review];
  const inputs = applicationInputs(process.cwd());
  const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
  if (inputs.sha256 !== build.sha256) throw new Error('Topic discussion source and build differ.');
  const migration = 'db/migrations/0033_topic_discussion_freshness.sql';
  const databaseMigration =
    review !== 'browsing'
      ? {
          path: migration,
          sha256: createHash('sha256')
            .update(await readFile(migration))
            .digest('hex'),
        }
      : undefined;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
  const status = git('status', '--porcelain', '--untracked-files=all');
  const sourceCommit = git('rev-parse', 'HEAD');
  const viewports = {
    desktop: { width: 1440, height: 1000 },
    mobile: { width: 390, height: 844 },
  };
  const original = page.viewportSize()!;
  const scroll = await page.evaluate(() => scrollY);
  try {
    for (const viewport of options.viewport
      ? [viewports[options.viewport]]
      : Object.values(viewports)) {
      await page.setViewportSize(viewport);
      await target.waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      });
      const top = viewport.width === 390 ? options.mobileTop : options.desktopTop;
      if (options.scroll === 'top') await page.evaluate(() => window.scrollTo(0, 0));
      else if (top === undefined) await target.scrollIntoViewIfNeeded();
      else
        await target.evaluate(
          (node, top) => window.scrollBy(0, node.getBoundingClientRect().top - top),
          top,
        );
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Horizontal overflow in ${state} at ${viewport.width}px`);
      if (options.scroll === 'top' && (await page.evaluate(() => scrollY)) !== 0)
        throw new Error(`Page did not start at the top in ${state} at ${viewport.width}px`);
      for (const locator of options.visibleInViewport ?? []) {
        const box = await locator.boundingBox();
        if (!box || box.y >= viewport.height || box.y + box.height <= 0)
          throw new Error(`${locator} is outside the initial viewport at ${viewport.width}px`);
      }
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
        test_account_role: options.role ?? 'administrator',
        authentication: 'Ordinary synthetic WebAuthn',
        demonstrated_state: state,
        mocked_responses_and_injected_failures: options.injected ?? [],
        reproduction: profile.reproduction,
        full_viewport: true,
        scroll_y: await page.evaluate(() => scrollY),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  } finally {
    await page.setViewportSize(original);
    await page.evaluate((offset) => window.scrollTo(0, offset), scroll);
  }
  await writeFile(
    join(directory, profile.manifest),
    JSON.stringify(
      {
        screenshots: captures,
        reproduction: profile.reproduction,
        isolation:
          'Compiled Loom application, disposable PostgreSQL and HTTPS, actual Chromium WebAuthn, and synthetic participants publishing through ordinary authenticated routes. No authentication material was exported.',
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
