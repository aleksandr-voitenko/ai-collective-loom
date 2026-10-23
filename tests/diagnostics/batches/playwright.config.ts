import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', timeout: 8000, workers: 1, retries: 0,
  reporter: [['../../helpers/browser-reporter.ts']],
  use: { trace: 'off', screenshot: 'off' },
});
