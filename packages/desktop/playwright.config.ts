import { defineConfig } from "@playwright/test";

// Playwright config for the Electron E2E suite.
//
// We drive the REAL Electron app via Playwright's `_electron` API (see
// e2e/fixtures.ts), so there are no browser `projects` — every test launches the
// app itself. Global setup builds a hermetic renderer + starts a mock cloud
// (e2e/global-setup.ts); teardown stops it. Workers are forced to 1: Electron
// instances share a fixed mock origin with mutable state, so tests run serially.

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
