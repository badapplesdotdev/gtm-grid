// Preload bridge — the ONLY surface the renderer uses to reach the Electron main
// process (contextIsolation is on). Replaces every `@tauri-apps/*` plugin.

import { contextBridge, ipcRenderer } from "electron";

function on(channel: string, cb: (...args: unknown[]) => void): () => void {
  const handler = (_e: unknown, ...args: unknown[]) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  isElectron: true as const,

  /** Engine boot diagnostics for the "Copy diagnostics" support blob (Rust
   *  `sidecar_diagnostics` equivalent). */
  sidecarDiagnostics: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("sidecar_diagnostics"),

  /** Kill the engine + wait for it to exit (releases file locks before update). */
  stopSidecar: (): Promise<void> => ipcRenderer.invoke("stop_sidecar"),

  /** Open a URL in the system browser (OAuth / billing / external links). */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open_external", url),

  /** Subscribe to `gtmgrid://` deep-link callbacks (OAuth). Returns an unsubscribe. */
  onOauthCallback: (cb: (url: string) => void): (() => void) =>
    on("oauth-callback", (url) => cb(url as string)),

  // ── Auto-updater ──────────────────────────────────────────────────────────
  onUpdateAvailable: (cb: (info: { version: string; notes: unknown }) => void): (() => void) =>
    on("updater:available", (i) => cb(i as { version: string; notes: unknown })),
  onUpdateProgress: (cb: (percent: number) => void): (() => void) =>
    on("updater:progress", (p) => cb(p as number)),
  onUpdateDownloaded: (cb: (version: string) => void): (() => void) =>
    on("updater:downloaded", (v) => cb(v as string)),
  onUpdateError: (cb: (message: string) => void): (() => void) =>
    on("updater:error", (m) => cb(m as string)),
  /** Start downloading the offered update. */
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke("updater:download"),
  /** Stop the engine, then quit + install the downloaded update. */
  quitAndInstall: (): Promise<void> => ipcRenderer.invoke("updater:quit-and-install"),
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld("electronAPI", api);
