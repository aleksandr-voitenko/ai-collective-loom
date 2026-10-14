import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'diagnostics.probe.ts', timeout: 8000, workers: 1, retries: 0,
  expect: { timeout: 300 }, reporter: [['../helpers/browser-reporter.ts']],
  use: { trace: 'off', screenshot: 'off', actionTimeout: 1000, navigationTimeout: 1500 },
});
