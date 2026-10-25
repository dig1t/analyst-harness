import { defineConfig } from '@playwright/test';

/** Browser tests for the dashboard UI: `npm run test:e2e` (needs a Chromium build). */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } },
});
