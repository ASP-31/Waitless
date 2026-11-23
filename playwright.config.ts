import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration for the seeded demo stack.
 *
 * The base URL comes from the environment (E2E_BASE_URL, or the Playwright
 * standard PLAYWRIGHT_BASE_URL) so the same specs work against a local dev
 * server and against the CI-deployed API/web pair. All requests are made
 * through the web origin; Vite proxies /api and /socket.io to the API.
 */
const baseURL =
  process.env.E2E_BASE_URL ?? process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5173";
const apiBaseURL = process.env.E2E_API_BASE_URL ?? "http://localhost:4000";
const managedServers = process.env.E2E_SKIP_WEB_SERVER !== "true";

export default defineConfig({
  testDir: "./apps/web/e2e",
  outputDir: "./apps/web/e2e-results",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: managedServers
    ? [
        {
          command: "pnpm --filter @waitless/api dev",
          url: `${apiBaseURL}/api/v1/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "pnpm --filter @waitless/web dev",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : undefined,
});
