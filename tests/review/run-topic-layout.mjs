import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { requireRepositoryRuntime } from '../../scripts/check-runtime.mjs';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

const baseline = {
  commit: 'efcbb96610d360ab54f5fd648066b158c638d5fe',
  applicationHash: '17dca3a1db9e2d314f2c968e16a84d0b7e7595af80917ff6d7e6498bad72770c',
};

function run(phase) {
  requireRepositoryRuntime();
  if (phase !== 'before' && phase !== 'after')
    throw new Error('Usage: node tests/review/run-topic-layout.mjs before|after');

  const source = applicationInputs(process.cwd());
  if (phase === 'before') {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    if (
      git('rev-parse', 'HEAD') !== baseline.commit ||
      source.sha256 !== baseline.applicationHash ||
      git('status', '--porcelain', '--untracked-files=all', '--', 'db/migrations')
    )
      throw new Error(`Before captures require the unchanged application at ${baseline.commit}.`);
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
      ],
      {
        env: {
          ...process.env,
          LOOM_TOPIC_LAYOUT_REVIEW: phase,
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
        (file === 'topic-layout.spec.ts' || file === 'topic-discussion-review.ts') &&
        Number.isSafeInteger(failure.line)
          ? ` (${file}:${failure.line})`
          : '';
      throw new Error(`Topic layout review failed${location}.`);
    }
    console.log(`Topic layout review passed (${phase}).`);
  } finally {
    rmSync(privateOutput, { recursive: true, force: true });
  }
}

try {
  run(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
