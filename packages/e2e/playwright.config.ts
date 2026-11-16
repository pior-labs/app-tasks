import { defineConfig, devices } from '@playwright/test';

// The suite runs the real web and API on its own ports, never 5173 or 3000, so
// it cannot collide with (or attach to) a developer's running application.
const webPort = Number(process.env.E2E_WEB_PORT ?? 5273);
const apiPort = Number(process.env.E2E_API_PORT ?? 3173);
const webOrigin = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './tests',
  // One API, one disposable database and two fixture users are shared by the
  // whole run, so the tests run one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webOrigin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The real Hono API on the test fixture: a new tasks_test_* database and
      // the fixture SSO provider. SIGTERM lets it drop the database again.
      name: 'api',
      command: 'node --import tsx test/e2e-server.ts',
      cwd: '../api',
      env: { E2E_WEB_ORIGIN: webOrigin, E2E_API_PORT: String(apiPort) },
      url: `http://localhost:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
    },
    {
      // The Vite dev server, proxying /api to the API above (see vite.config.ts).
      name: 'web',
      command: 'pnpm exec vite',
      cwd: '../web',
      env: { WEB_PORT: String(webPort), API_PORT: String(apiPort) },
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
