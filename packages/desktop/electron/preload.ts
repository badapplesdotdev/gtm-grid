// Preload bridge — the ONLY surface the renderer uses to reach the Electron main
// process (contextIsolation is on, so the renderer can't touch Node directly).
// Replaces the `@tauri-apps/*` plugins. Phase 0 exposes a minimal surface +
// `isElectron`; diagnostics/updater/deep-link/opener are filled in Phase 1-2.

import { contextBridge, ipcRenderer } from "electron";

const api = {
  isElectron: true as const,
  /** Engine boot diagnostics for the "Copy diagnostics" support blob. */
  sidecarDiagnostics: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("sidecar_diagnostics"),
  /** Kill the engine + wait for it to exit (releases file locks before an update). */
  stopSidecar: (): Promise<void> => ipcRenderer.invoke("stop_sidecar"),
  /** Open a URL in the system browser (OAuth / billing / external links). */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("open_external", url),
  /** Subscribe to `gtmgrid://` deep-link callbacks (OAuth). Returns an unsubscribe. */
  onOauthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = (_e: unknown, url: string) => cb(url);
    ipcRenderer.on("oauth-callback", handler);
    return () => ipcRenderer.removeListener("oauth-callback", handler);
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld("electronAPI", api);
