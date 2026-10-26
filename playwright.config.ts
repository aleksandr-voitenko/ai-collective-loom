import { defineConfig } from "@playwright/test";
export default defineConfig({
  // Application/worker modules use the same tsx projection as native suites.
  // Playwright still transforms test files; coverage rejects conflicting maps.
  build: { external: ["**/src/**", "**/scripts/**", "**/dist/**"] },
  testDir: "./tests/e2e",
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  reporter: [["./tests/helpers/browser-reporter.ts"]],
  use: {
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 15000,
    navigationTimeout: 20000,
    trace: "off",
    screenshot: "off",
  },
});
