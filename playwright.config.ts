import { defineConfig, devices } from "@playwright/test";

/**
 * Screenshot goldens are the verification harness for the render engine. Several of the
 * fatal defects from the design review — joint beading, missing stroke tails, transform-
 * relative `clearRect`, DPR scaling — are invisible to unit tests and only show up in
 * rendered pixels.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  expect: {
    toHaveScreenshot: {
      // Canvas AA can differ by a hair across GPU/driver paths. A tight tolerance would
      // make this gate flaky, which trains people to ignore it.
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
    },
  },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});