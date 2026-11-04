import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { applicationInputs } from '../../scripts/lib/release-identity.mjs';

// Explicit review captures stay outside the automatic diagnostic artifacts.
export function uxHighReview() {
  const mode = process.env.LOOM_UX_HIGH_REVIEW;
  const enabled = mode === 'before' || mode === 'after';
  const directory = '/tmp/loom-review-evidence/ux-high-fixes/' + mode;
  const screenshots: unknown[] = [];
  return {
    async capture(page: Page, state: string, faults: string[] = []) {
      if (!enabled) return;
      if (await page.getByLabel('Issued secret', { exact: true }).count())
        throw new Error('Credential display cannot enter UX review captures.');
      const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
      const inputs = applicationInputs(process.cwd());
      const build = JSON.parse(await readFile('dist/release.json', 'utf8'));
      if (build.sha256 !== inputs.sha256) throw new Error('UX review source and build differ.');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
      });
      const viewport = page.viewportSize()!;
      const filename = state + '-' + viewport.width + 'x' + viewport.height + '.png';
      const bytes = await page.screenshot({ path: directory + '/' + filename, fullPage: false });
      screenshots.push({
        filename,
        source_commit: git('rev-parse', 'HEAD'),
        dirty_tree: git('status', '--porcelain').length > 0,
        dirty_paths: git('status', '--porcelain')
          .split('\n')
          .filter(Boolean)
          .map((line) => line.slice(3)),
        application_input_sha256: inputs.sha256,
        build_sha256: build.sha256,
        route: new URL(page.url()).pathname,
        viewport,
        state,
        browser: { name: 'Chromium', version: page.context().browser()!.version() },
        test_account_role: 'administrator',
        authentication:
          'Disposable synthetic account; ordinary virtual WebAuthn enrollment/sign-in',
        mocked_responses: [],
        injected_failures: faults,
        full_viewport: true,
        redactions: [],
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      await writeFile(
        directory +
          '/manifest-' +
          (state.startsWith('navigation') ? 'navigation' : 'recovery') +
          '.json',
        JSON.stringify(
          {
            mode,
            screenshots,
            reproduction:
              'LOOM_UX_HIGH_REVIEW=' +
              mode +
              ' npm run test:e2e -- participation.spec.ts --grep "administrator setup/admission|lost committed response"',
            isolation:
              'Actual compiled React app, synthetic PostgreSQL/HTTPS and virtual passkey. No staging/pilot, credentials, cookies, profiles or authentication exports.',
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
    },
  };
}
