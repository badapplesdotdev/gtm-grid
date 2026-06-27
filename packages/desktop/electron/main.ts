// GTM Grid — Electron main process. Replaces the Tauri Rust shell.
//
// The DOMAIN logic (engine lifecycle, auto-updater, PostHog observability) lives in
// composable Effect services (./services.ts), run through a ManagedRuntime. This
// file is the thin Electron-lifecycle GLUE — window, tray, deep-link, single
// instance, the custom app:// protocol, and the IPC surface — that delegates into
// those services. The Node engine runs as an Electron utilityProcess (no separate
// node binary), which removes the Rust↔Node boundary bug class entirely.

import { app, BrowserWindow, ipcMain, Menu, net, protocol, shell, Tray } from "electron";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EngineService, ObservabilityService, UpdaterService, makeRuntime } from "./services";

const DEV = !app.isPackaged;
const DEV_URL = "http://localhost:5173";
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://gtmgrid`;
const RENDERER_DIR = join(__dirname, "..", "..", "dist");

const runtime = makeRuntime();
// Run a service effect (resolving the service from the layer) on the app runtime.
const run = <A>(effect: Effect.Effect<A, never, EngineService | UpdaterService | ObservabilityService>): Promise<A> =>
  runtime.runPromise(effect);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const pendingDeepLinks: string[] = [];

// ── Window + custom renderer protocol ─────────────────────────────────────────
function iconPath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : join(__dirname, "..", "..", "build-resources", name);
}

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
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
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => {
    win?.show();
    for (const url of pendingDeepLinks.splice(0)) win?.webContents.send("oauth-callback", url);
  });
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
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp(): void {
  isQuitting = true;
  void run(Effect.flatMap(EngineService, (e) => e.stop)).finally(() => app.quit());
}

function createTray(): void {
  try {
    const p = iconPath("trayTemplate.png");
    tray = new Tray(existsSync(p) ? p : iconPath("icon.png"));
  } catch {
    return;
  }
  tray.setToolTip("GTM Grid");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show GTM Grid", click: () => showWindow() },
      { type: "separator" },
      { label: "Quit", click: () => quitApp() },
    ]),
  );
  tray.on("click", () => showWindow());
}

// ── Deep-link OAuth (gtmgrid://) ──────────────────────────────────────────────
function emitOauthCallback(url: string): void {
  if (win && !win.webContents.isLoading()) win.webContents.send("oauth-callback", url);
  else pendingDeepLinks.push(url);
}
const deepLinkFromArgv = (argv: string[]): string | undefined => argv.find((a) => a.startsWith("gtmgrid://"));

// ── IPC (the preload electronAPI surface) — delegates to the Effect services ──
function registerIpc(): void {
  ipcMain.handle("sidecar_diagnostics", () => run(Effect.flatMap(EngineService, (e) => e.diagnostics)));
  ipcMain.handle("stop_sidecar", () => run(Effect.flatMap(EngineService, (e) => e.stop)));
  ipcMain.handle("open_external", (_e, url: string) => shell.openExternal(url));
  ipcMain.handle("updater:quit-and-install", () => {
    isQuitting = true;
    return run(Effect.flatMap(UpdaterService, (u) => u.quitAndInstall));
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
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
  app.on("open-url", (_e, url) => emitOauthCallback(url));

  app.whenReady().then(() => {
    registerAppProtocol();
    registerIpc();
    createWindow();
    createTray();
    // Start the engine + wire the updater (which sends events to the renderer).
    void run(
      Effect.gen(function* () {
        const engine = yield* EngineService;
        yield* Effect.catchAll(engine.start, () => Effect.void); // a spawn failure is already reported to PostHog
        const updater = yield* UpdaterService;
        yield* updater.setup((channel, ...args) => win?.webContents.send(channel, ...args));
      }),
    );
    const cold = deepLinkFromArgv(process.argv);
    if (cold) emitOauthCallback(cold);
    app.on("activate", () => showWindow());
  });

  app.on("window-all-closed", () => {
    /* keep running in the tray (all platforms) */
  });
  app.on("before-quit", () => {
    isQuitting = true;
  });

  process.on("uncaughtException", (err) => {
    void run(Effect.flatMap(ObservabilityService, (o) => o.reportException(err.message, err.stack?.split("\n")[1]?.trim() ?? "")));
    console.error("[electron] uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    void run(Effect.flatMap(ObservabilityService, (o) => o.reportException(`unhandledRejection: ${String(reason)}`)));
  });
}
