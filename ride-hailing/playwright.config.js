// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 390, height: 844 },   // mobile-ish, matches driver PWA
  },
  // Start the server automatically before the test run.
  // Uses PORT=3000 to match the configured baseURL above.
  webServer: {
    // REQUEST_TIMEOUT_MS overrides server.requestTimeout so integration tests
    // can use a short body-receipt window (8 s) without waiting up to the
    // production 600 s budget.  Playwright UI tests are unaffected because
    // they intercept /api/auth/register via page.route() before the request
    // reaches the server.
    command: 'PORT=3000 REQUEST_TIMEOUT_MS=8000 node server.js',
    port: 3000,
    timeout: 20_000,
    reuseExistingServer: true,  // use already-running server if available
  },
});
