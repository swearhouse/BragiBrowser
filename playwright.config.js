import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.js",
  fullyParallel: true,
  workers: process.env.CI ? 1 : 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", {open: "never", outputFolder: "playwright-report"}]],
  timeout: 30000,
  expect: {timeout: 5000},
  use: {
    baseURL: "http://127.0.0.1:8765",
    ...devices["Desktop Chrome"],
    viewport: {width: 1280, height: 900},
    reducedMotion: "reduce"
  },
  webServer: {
    command: "node tests/server.mjs",
    url: "http://127.0.0.1:8765/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 15000
  }
});
