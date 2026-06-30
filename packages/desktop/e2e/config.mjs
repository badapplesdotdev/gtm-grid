// Shared constants for the Playwright Electron E2E harness.
//
// One fixed port is used end-to-end: the renderer build bakes `VITE_API_URL` /
// `VITE_API` to `http://localhost:<PORT>` (so the cloud + engine clients call the
// mock), the mock HTTP server listens on it (serving the built renderer AND the
// mock cloud/engine APIs from one origin — no CORS), and the Electron window is
// pointed at `http://localhost:<PORT>/index.html` via `GTMGRID_RENDERER_URL`.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PORT = 53847;
export const ORIGIN = `http://localhost:${PORT}`;
export const RENDERER_URL = `${ORIGIN}/index.html`;

const here = dirname(fileURLToPath(import.meta.url));
export const DESKTOP_DIR = join(here, "..");
export const DIST_E2E_DIR = join(DESKTOP_DIR, "dist-e2e");
export const ELECTRON_MAIN = join(DESKTOP_DIR, "build", "electron", "main.cjs");
export const MOCK_PID_FILE = join(here, ".mock.pid");
