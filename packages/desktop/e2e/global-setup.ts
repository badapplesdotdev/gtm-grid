// Playwright global setup: prepare a hermetic Electron + mock-cloud world.
//
//   1. Build the renderer to `dist-e2e/` with VITE_API_URL/VITE_API pointed at
//      the mock origin (so the cloud + engine clients call the mock).
//   2. Build the Electron main/preload (picks up the GTMGRID_RENDERER_URL hook).
//   3. Start the mock HTTP server (static renderer + mock cloud/engine APIs) and
//      wait until it answers, recording its PID for global teardown.
//
// Set SKIP_E2E_BUILD=1 to reuse an existing build for faster local iteration.

import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DESKTOP_DIR, DIST_E2E_DIR, ELECTRON_MAIN, MOCK_PID_FILE, ORIGIN, PORT } from "./config.mjs";

async function waitForMock(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ORIGIN}/__health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`mock server did not become ready on ${ORIGIN} within ${timeoutMs}ms`);
}

export default async function globalSetup(): Promise<void> {
  const env = {
    ...process.env,
    VITE_API_URL: ORIGIN,
    VITE_API: ORIGIN,
    // Leave realtime/analytics off for determinism.
    VITE_PARTY_URL: "",
    VITE_POSTHOG_KEY: "",
  };

  const skipBuild = process.env.SKIP_E2E_BUILD === "1" && existsSync(join(DIST_E2E_DIR, "index.html"));
  if (!skipBuild) {
    console.log("[e2e] building renderer → dist-e2e …");
    execSync("pnpm exec vite build --outDir dist-e2e --emptyOutDir", {
      cwd: DESKTOP_DIR,
      env,
      stdio: "inherit",
    });
  }
  if (!existsSync(ELECTRON_MAIN) || !skipBuild) {
    console.log("[e2e] building electron main/preload …");
    execSync("node scripts/build-electron.mjs", { cwd: DESKTOP_DIR, env, stdio: "inherit" });
  }

  // Reuse a healthy server if one is already up (fast local re-runs); otherwise
  // start one. Either way reset it to a clean world before the suite runs.
  let alreadyUp = false;
  try {
    alreadyUp = (await fetch(`${ORIGIN}/__health`)).ok;
  } catch {
    alreadyUp = false;
  }

  if (alreadyUp) {
    console.log(`[e2e] reusing mock server already listening on ${ORIGIN}`);
  } else {
    console.log("[e2e] starting mock server …");
    const child = spawn(process.execPath, [join(DESKTOP_DIR, "e2e/mock/server.mjs")], {
      cwd: DESKTOP_DIR,
      env,
      stdio: "inherit",
      detached: true,
    });
    child.unref();
    writeFileSync(MOCK_PID_FILE, String(child.pid), "utf8");
    await waitForMock();
    console.log(`[e2e] mock server ready on ${ORIGIN} (pid ${child.pid}, port ${PORT})`);
  }

  // Always start each suite run from a clean, signed-in/paid world.
  await fetch(`${ORIGIN}/__test/reset`, { method: "POST" }).catch(() => {});
}
