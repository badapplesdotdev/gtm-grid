// GTM Grid — Electron main process.
//
// Replaces the Tauri Rust shell. Owns the window + the Node engine (run as an
// Electron `utilityProcess`, NOT a separately-bundled node binary). The engine is
// the same `server.mjs` the Tauri build spawned; the only difference is the parent
// is Node (Electron main) instead of Rust — which removes the whole class of
// Rust↔Node boundary bugs (verbatim paths, key-baking, console-less spawn).
//
// Phase 0: window + engine fork + connect. Tray/deep-link/updater/IPC land in the
// later phases.

import { app, BrowserWindow, utilityProcess, type UtilityProcess } from "electron";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ENGINE_PORT = "8787";
const DEV = !app.isPackaged;
const DEV_URL = "http://localhost:5173";

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;

/** The bundled sidecar dir (server.mjs, mcp.mjs, extensions, native node_modules).
 *  Packaged: shipped via electron-builder `extraResources` → `<resources>/sidecar`.
 *  Dev: the repo's built sidecar (`packages/desktop/sidecar`); __dirname is
 *  `packages/desktop/build/electron`. */
function sidecarDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "sidecar")
    : join(__dirname, "..", "..", "sidecar");
}

/** macOS GUI apps launch with a minimal PATH; the agent CLIs (`claude`/`codex`)
 *  live in the user's login PATH. Reproduce the Tauri shell's `sidecar_path()`:
 *  ask the login+interactive shell for its PATH and prepend the usual bin dirs. */
function augmentedPath(): string {
  const base = process.env.PATH ?? "";
  if (process.platform === "win32") return base;
  const home = process.env.HOME ?? "";
  let login = "";
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    login = execSync(`${shell} -lic 'echo "$PATH"'`, { encoding: "utf8", timeout: 4000 }).trim();
  } catch {
    /* fall back to the inherited PATH */
  }
  return [login, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.npm-global/bin`, base]
    .filter(Boolean)
    .join(":");
}

function startEngine(): void {
  const dir = sidecarDir();
  const server = join(dir, "server.mjs");
  if (!existsSync(server)) {
    console.error(`[electron] engine not found at ${server} — did the sidecar bundle run?`);
    return;
  }
  engine = utilityProcess.fork(server, [], {
    cwd: dir,
    stdio: "pipe",
    env: {
      ...process.env,
      GTMGRID_PROJECT: process.env.GTMGRID_PROJECT ?? "default",
      GTMGRID_PORT: process.env.GTMGRID_PORT ?? ENGINE_PORT,
      // The MCP server the agent CLI spawns is launched as `node mcp.mjs`, where
      // "node" is THIS Electron binary run as plain Node. The ELECTRON_RUN_AS_NODE
      // flag is added by mcpEnv() onto the MCP's OWN spawn env — it must NOT be set
      // here, where it would conflict with the engine's utilityProcess (which is
      // already a Node process and exits if ELECTRON_RUN_AS_NODE is present).
      GTMGRID_MCP_NODE: process.execPath,
      GTMGRID_MCP_SCRIPT: join(dir, "mcp.mjs"),
      GTMGRID_EXT_DIR: join(dir, "extensions"),
      PATH: augmentedPath(),
    },
  });
  engine.stdout?.on("data", (d) => process.stdout.write(`[engine] ${d}`));
  engine.stderr?.on("data", (d) => process.stderr.write(`[engine] ${d}`));
  engine.on("exit", (code) => console.error(`[electron] engine exited (code ${code})`));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "gtm grid",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  if (DEV) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  }
}

// Single instance — a second launch focuses the existing window (deep-link
// forwarding wired in Phase 1).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    startEngine();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    engine?.kill();
  });
}
