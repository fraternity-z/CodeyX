import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:1422";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.mjs",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  outputDir: "output/playwright/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: process.env.CODEY_BROWSER_STATIC === "1"
      ? "node scripts/browser-test-server.mjs"
      : "pnpm exec vite --host 127.0.0.1 --port 1422 --strictPort",
    url: `${baseURL}/codey/tests/ui-browser.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
