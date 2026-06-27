// GTM Grid — Electron main process. Replaces the Tauri Rust shell.
//
// Owns the window, the system tray, deep-link OAuth, the auto-updater, and the
// Node engine (run as an Electron `utilityProcess` — NOT a separately-bundled node
// binary). The engine is the same `server.mjs` the Tauri build spawned; the parent
// is now Node (Electron main) instead of Rust, which removes the whole class of
// Rust↔Node boundary bugs (verbatim paths, key-baking via cargo cache, console-less
// spawn handles, the bundled-node lock-on-update).

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { autoUpdater } from "electron-updater";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Build-time defines (scripts/build-electron.mjs). The PostHog key is injected as a
// plain JS string from the build env — no Rust/cargo cache to defeat it.
declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;
declare const __APP_VERSION__: string;

const ENGINE_PORT = process.env.GTMGRID_PORT ?? "8787";
const DEV = !app.isPackaged;
const DEV_URL = "http://localhost:5173";
// Packaged renderer is served over a custom standard scheme so it has a clean,
// stable origin (vs file://) that we can allow-list on the engine's CORS.
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://gtmgrid`;
const RENDERER_DIR = join(__dirname, "..", "..", "dist");

const POSTHOG_KEY = typeof __POSTHOG_KEY__ === "string" ? __POSTHOG_KEY__ : "";
const POSTHOG_HOST = typeof __POSTHOG_HOST__ === "string" ? __POSTHOG_HOST__ : "https://us.i.posthog.com";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: UtilityProcess | null = null;
let isQuitting = false;
let shuttingDownEngine = false;
const pendingDeepLinks: string[] = [];

// ── Diagnostics (mirrors the Rust `Diagnostics` facts + stderr tail) ──────────
const STDERR_MAX = 40;
const stderrTail: string[] = [];
const facts: Record<string, unknown> = {
  appVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : app.getVersion(),
  os: process.platform,
  arch: process.arch,
  spawnStatus: "pending",
};

// ── Main-process PostHog (server-side; the only path that always delivers) ────
function postHog(event: string, properties: Record<string, unknown>): void {
  if (!POSTHOG_KEY) return;
  const body = JSON.stringify({
    api_key: POSTHOG_KEY,
    event,
    distinct_id: "desktop-shell",
    properties: { source: "electron-main", platform: process.platform, arch: process.arch, version: app.getVersion(), ...properties },
  });
  net
    .fetch(`${POSTHOG_HOST}/i/v0/e/`, { method: "POST", headers: { "content-type": "application/json" }, body })
    .catch(() => {});
}
function reportException(value: string, location = ""): void {
  if (!POSTHOG_KEY) return;
  postHog("$exception", {
    $exception_list: [{ type: "ElectronMainError", value }],
    $exception_type: "ElectronMainError",
    $exception_message: value,
    location,
  });
}

// ── PATH augmentation (macOS GUI apps get a minimal PATH; the agent CLIs live in
//    the user's login PATH). Reproduces the Tauri shell's `sidecar_path()`. ─────
function augmentedPath(): string {
  const base = process.env.PATH ?? "";
  if (process.platform === "win32") return base;
  const home = process.env.HOME ?? "";
  let login = "";
  try {
    const sh = process.env.SHELL || "/bin/zsh";
    login = execSync(`${sh} -lic 'echo "$PATH"'`, { encoding: "utf8", timeout: 4000 }).trim();
  } catch {
    /* fall back to inherited PATH */
  }
  return [login, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.npm-global/bin`, base]
    .filter(Boolean)
    .join(":");
}

/** Bundled sidecar dir (server.mjs, mcp.mjs, extensions, native node_modules).
 *  Packaged: electron-builder `extraResources` → `<resources>/sidecar`.
 *  Dev: the repo's built sidecar (`packages/desktop/sidecar`). */
function sidecarDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "sidecar") : join(__dirname, "..", "..", "sidecar");
}

/** A stable, real, user-writable working directory for the spawned agent CLIs.
 *  Must be consistent across launches AND identical on the spawn + history-read
 *  paths (Claude/Codex key transcripts by encoded cwd — see agent-history.ts), or
 *  "Resume" silently breaks. NOT the install bundle (the old REPO_ROOT bug). */
function agentCwd(): string {
  return join(app.getPath("home"), ".gtmgrid", "workspace");
}

// ── Engine (utilityProcess.fork) ──────────────────────────────────────────────
function startEngine(): void {
  const dir = sidecarDir();
  const server = join(dir, "server.mjs");
  facts.sidecarDir = dir;
  facts.serverPath = server;
  facts.serverExists = existsSync(server);
  if (!existsSync(server)) {
    facts.spawnStatus = "binary_missing";
    postHog("sidecar_spawn_failed", { reason: "binary_missing", detail: server });
    console.error(`[electron] engine not found at ${server}`);
    return;
  }
  const startedAt = Date.now();
  engine = utilityProcess.fork(server, [], {
    cwd: dir,
    stdio: "pipe",
    env: {
      ...process.env,
      GTMGRID_PROJECT: process.env.GTMGRID_PROJECT ?? "default",
      GTMGRID_PORT: ENGINE_PORT,
      // The MCP the agent CLI spawns is `node mcp.mjs`, where node is THIS Electron
      // binary run as plain Node. The ELECTRON_RUN_AS_NODE flag is added by mcpEnv()
      // onto the MCP's OWN spawn env — never here (it would crash this utilityProcess).
      GTMGRID_MCP_NODE: process.execPath,
      GTMGRID_MCP_SCRIPT: join(dir, "mcp.mjs"),
      GTMGRID_EXT_DIR: join(dir, "extensions"),
      GTMGRID_AGENT_CWD: agentCwd(),
      // The packaged renderer's origin — the engine CORS allow-lists this so the
      // app:// page isn't 403'd (cors.ts merges GTMGRID_ALLOWED_ORIGINS).
      GTMGRID_ALLOWED_ORIGINS: app.isPackaged ? APP_ORIGIN : "",
      GTMGRID_POSTHOG_KEY: POSTHOG_KEY,
      GTMGRID_POSTHOG_HOST: POSTHOG_HOST,
      PATH: augmentedPath(),
    },
  });
  facts.spawnStatus = "spawned";
  engine.stdout?.on("data", (d) => process.stdout.write(`[engine] ${d}`));
  engine.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[engine] ${d}`);
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      stderrTail.push(line);
      if (stderrTail.length > STDERR_MAX) stderrTail.shift();
    }
  });
  engine.on("exit", (code) => {
    const uptime = Date.now() - startedAt;
    facts.spawnStatus = "exited";
    facts.exitCode = code;
    facts.exitedAfterMs = uptime;
    // An exit within the early window that we did NOT initiate is a crash to report.
    if (!shuttingDownEngine && uptime < 30_000) {
      postHog("sidecar_exited", { code, uptime_ms: uptime, stderr_tail: stderrTail.join("\n") });
    }
    console.error(`[electron] engine exited (code ${code}, after ${uptime}ms)`);
  });
}

/** Kill the engine and BLOCK until it exits — releases any file locks before the
 *  updater installs. Idempotent. */
function stopEngine(): Promise<void> {
  shuttingDownEngine = true;
  const e = engine;
  engine = null;
  if (!e) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    e.once("exit", done);
    e.kill();
    setTimeout(done, 3000); // safety net
  });
}

// ── Window + custom renderer protocol ─────────────────────────────────────────
function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    // app://gtmgrid/<path> → <dist>/<path>; default + unknown routes → index.html (SPA)
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (!rel || !existsSync(join(RENDERER_DIR, rel))) rel = "index.html";
    return net.fetch(pathToFileURL(join(RENDERER_DIR, rel)).toString());
  });
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
  win.once("ready-to-show", () => {
    win?.show();
    // Replay any deep links that arrived before the webview was ready (cold start).
    for (const url of pendingDeepLinks.splice(0)) win?.webContents.send("oauth-callback", url);
  });
  // Close → hide to tray (keep the engine + agent runs alive); real quit destroys it.
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  if (DEV) void win.loadURL(DEV_URL);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
}

function showWindow(): void {
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): void {
  // Reuse the app icon; a dedicated template icon is a later polish item.
  const iconPath = join(__dirname, "..", "..", "src-tauri", "icons", "32x32.png");
  try {
    tray = new Tray(existsSync(iconPath) ? iconPath : join(process.resourcesPath, "icon.png"));
  } catch {
    return; // tray is best-effort; never block boot
  }
  tray.setToolTip("GTM Grid");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show GTM Grid", click: () => showWindow() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          void stopEngine().finally(() => app.quit());
        },
      },
    ]),
  );
  tray.on("click", () => showWindow());
}

// ── Deep-link OAuth (gtmgrid://) ──────────────────────────────────────────────
function emitOauthCallback(url: string): void {
  if (win && !win.webContents.isLoading()) win.webContents.send("oauth-callback", url);
  else pendingDeepLinks.push(url);
}
function deepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith("gtmgrid://"));
}

// ── Auto-updater (electron-updater) ───────────────────────────────────────────
function setupUpdater(): void {
  if (DEV) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we control the install (stop engine first)
  autoUpdater.on("update-available", (info) => win?.webContents.send("updater:available", info.version));
  autoUpdater.on("update-downloaded", (info) => win?.webContents.send("updater:downloaded", info.version));
  autoUpdater.on("error", (err) => win?.webContents.send("updater:error", String(err)));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  void check();
  setInterval(check, 2 * 60 * 60 * 1000); // every 2h, matching the Tauri poll
}

// ── IPC (the preload `electronAPI` surface) ───────────────────────────────────
function registerIpc(): void {
  ipcMain.handle("sidecar_diagnostics", () => ({ ...facts, stderrTail: stderrTail.join("\n") }));
  ipcMain.handle("stop_sidecar", () => stopEngine());
  ipcMain.handle("open_external", (_e, url: string) => shell.openExternal(url));
  // Renderer asks to install a downloaded update — stop the engine first, then go.
  ipcMain.handle("updater:quit-and-install", async () => {
    isQuitting = true;
    await stopEngine();
    autoUpdater.quitAndInstall();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Register the gtmgrid:// handler (dev needs explicit argv on some platforms).
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("gtmgrid", process.execPath, [process.argv[1]]);
  } else {
    app.setAsDefaultProtocolClient("gtmgrid");
  }

  app.on("second-instance", (_e, argv) => {
    showWindow();
    const url = deepLinkFromArgv(argv);
    if (url) emitOauthCallback(url);
  });
  // macOS delivers deep links via open-url.
  app.on("open-url", (_e, url) => emitOauthCallback(url));

  app.whenReady().then(() => {
    registerAppProtocol();
    registerIpc();
    startEngine();
    createWindow();
    createTray();
    setupUpdater();
    // Cold start: app launched BY a gtmgrid:// link (Windows/Linux pass it in argv).
    const cold = deepLinkFromArgv(process.argv);
    if (cold) emitOauthCallback(cold);
    app.on("activate", () => showWindow());
  });

  // Don't quit when the window is closed — it hides to the tray; the engine lives on.
  app.on("window-all-closed", () => {
    /* keep running in the tray (all platforms) */
  });
  app.on("before-quit", () => {
    isQuitting = true;
  });

  process.on("uncaughtException", (err) => {
    reportException(err.message, err.stack?.split("\n")[1]?.trim() ?? "");
    console.error("[electron] uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    reportException(`unhandledRejection: ${String(reason)}`);
  });
}
