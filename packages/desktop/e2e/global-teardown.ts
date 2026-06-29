// Playwright global teardown: stop the mock server started in global setup.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { MOCK_PID_FILE } from "./config.mjs";

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(MOCK_PID_FILE)) return;
  const pid = Number(readFileSync(MOCK_PID_FILE, "utf8").trim());
  rmSync(MOCK_PID_FILE, { force: true });
  if (!Number.isFinite(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
