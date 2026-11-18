import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
