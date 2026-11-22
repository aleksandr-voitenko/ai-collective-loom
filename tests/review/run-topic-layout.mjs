import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { requireRepositoryRuntime } from '../../scripts/check-runtime.mjs';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

const reviews = {
  layout: {
    spec: 'topic-layout.spec.ts',
    flag: 'LOOM_TOPIC_LAYOUT_REVIEW',
    commit: 'efcbb96610d360ab54f5fd648066b158c638d5fe',
    applicationHash: '17dca3a1db9e2d314f2c968e16a84d0b7e7595af80917ff6d7e6498bad72770c',
  },
  directory: {
    spec: 'topic-directory.spec.ts',
    flag: 'LOOM_TOPIC_DIRECTORY_REVIEW',
    commit: '263a319eebe75e6874abd986f1ce6459b5945ec9',
    applicationHash: '7ead4b152cc31e7781805dc0c52cea10b6c5df52c2dd87d09e744e1074cd5981',
  },
  returns: {
    spec: 'topic-directory.spec.ts',
    flag: 'LOOM_TOPIC_RETURN_REVIEW',
    commit: 'cb0f2a38276f0ee30ee07ecd81bb0f62ff4c59ec',
    applicationHash: '2815249c55d8b81815ce072ab94f19f00281579efef18402db73e8b1724492d3',
  },
};

function run(phase, name = 'layout') {
  requireRepositoryRuntime();
  if ((phase !== 'before' && phase !== 'after') || !Object.hasOwn(reviews, name))
    throw new Error(
      'Usage: node tests/review/run-topic-layout.mjs before|after [layout|directory|returns]',
    );
  const review = reviews[name];

  const source = applicationInputs(process.cwd());
  if (phase === 'before') {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    if (
      git('rev-parse', 'HEAD') !== review.commit ||
      source.sha256 !== review.applicationHash ||
      git('status', '--porcelain', '--untracked-files=all', '--', 'db/migrations')
    )
      throw new Error(`Before captures require the unchanged application at ${review.commit}.`);
  }
  const build = JSON.parse(readFileSync('dist/release.json', 'utf8'));
  if (source.sha256 !== build.sha256) throw new Error('Run npm run app:build before capturing.');

  const privateOutput = mkdtempSync(join(tmpdir(), 'loom-topic-layout-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'node_modules/@playwright/test/cli.js',
        'test',
        '--config',
        'tests/review/playwright.config.ts',
        review.spec,
      ],
      {
        env: {
          ...process.env,
          [review.flag]: phase,
          LOOM_TOPIC_LAYOUT_PRIVATE_OUTPUT: privateOutput,
        },
        stdio: 'ignore',
      },
    );
    // Playwright can include enrollment inputs in raw failures and attachments.
    // Print only a fixed outcome and the source line of a failed assertion.
    let report;
    try {
      report = JSON.parse(readFileSync(join(privateOutput, 'result.json'), 'utf8'));
    } catch {
      throw new Error('The browser review produced no readable result.');
    }
    if (result.status !== 0 || report.stats.expected !== 1) {
      const specs = report.suites.flatMap((suite) => suite.specs);
      const attempts = specs.flatMap((spec) => spec.tests.flatMap((test) => test.results));
      const failure = attempts.find((attempt) => attempt.status === 'failed')?.errorLocation;
      const file = basename(failure?.file ?? '');
      const location =
        (file === review.spec || file === 'topic-discussion-review.ts') &&
        Number.isSafeInteger(failure.line)
          ? ` (${file}:${failure.line})`
          : '';
      throw new Error(`Topic ${name} review failed${location}.`);
    }
    console.log(`Topic ${name} review passed (${phase}).`);
  } finally {
    rmSync(privateOutput, { recursive: true, force: true });
  }
}

try {
  run(process.argv[2], process.argv[3]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
