// Playwright fixtures for the Electron E2E suite.
//
// `launchApp(scenario)` resets the mock world to the given scenario, then boots
// the REAL Electron app (Playwright `_electron`) pointed at the mock renderer +
// cloud. Each launch gets an isolated Chromium user-data dir so localStorage
// (the Better Auth bearer token, persisted UI prefs) never leaks between tests.
// All launched apps are closed automatically at the end of each test.

import { test as base, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_DIR, ELECTRON_MAIN, ORIGIN, RENDERER_URL } from "./config.mjs";

export type Scenario = {
  signedIn?: boolean;
  paid?: boolean;
  [k: string]: unknown;
};

export async function resetMock(scenario: Scenario = {}): Promise<void> {
  const res = await fetch(`${ORIGIN}/__test/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(scenario),
  });
  if (!res.ok) throw new Error(`mock reset failed: ${res.status}`);
}

export async function mockState(): Promise<any> {
  const res = await fetch(`${ORIGIN}/__test/state`);
  return res.json();
}

type LaunchResult = { app: ElectronApplication; window: Page };

type Fixtures = {
  launchApp: (scenario?: Scenario) => Promise<LaunchResult>;
};

// Monotonic engine-port allocator, module-scoped so it's unique across every
// launch in the whole test run (see GTMGRID_PORT in the launch env below).
let enginePortSeq = 0;

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the fixtures arg even with no deps
  launchApp: async ({}, use) => {
    const launched: Array<{ app: ElectronApplication; userDataDir: string }> = [];

    const launchApp = async (scenario: Scenario = {}): Promise<LaunchResult> => {
      // Fresh mock world for this scenario, BEFORE the renderer reads the session.
      await resetMock(scenario);

      const userDataDir = mkdtempSync(join(tmpdir(), "gtmgrid-e2e-"));
      const app = await electron.launch({
        args: [`--user-data-dir=${userDataDir}`, ELECTRON_MAIN],
        cwd: DESKTOP_DIR,
        env: {
          ...process.env,
          GTMGRID_ELECTRON_DEV: "1",
          GTMGRID_RENDERER_URL: RENDERER_URL,
          // A UNIQUE engine port per launch across the whole run. Each app spawns
          // its own engine sidecar; on the shared default :8787 they collide and the
          // engine's port-reclaim kills the previous app's sidecar — cross-test
          // flakiness even though the renderer only talks to the mock origin.
          GTMGRID_PORT: String(18800 + enginePortSeq++),
          // Keep the real engine sidecar irrelevant — the renderer's health check
          // targets the mock origin (baked VITE_API). Quiet analytics.
          VITE_API_URL: ORIGIN,
          VITE_API: ORIGIN,
          VITE_POSTHOG_KEY: "",
        },
      });
      launched.push({ app, userDataDir });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      return { app, window };
    };

    await use(launchApp);

    for (const { app, userDataDir } of launched) {
      await app.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
});

export const expect = test.expect;
