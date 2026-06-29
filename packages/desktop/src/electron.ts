/**
 * Renderer-side handle on the Electron main process. Replaces every `@tauri-apps/*`
 * plugin: the preload bridge (electron/preload.ts) exposes `window.electronAPI`
 * under contextIsolation, and this module is the single typed accessor the renderer
 * uses. Kept decoupled from the Electron main's types (no `electron` import here);
 * the shape mirrors electron/preload.ts.
 */

export interface ElectronAPI {
  readonly isElectron: true;
  /** Engine boot diagnostics for the support "Copy diagnostics" blob. */
  sidecarDiagnostics(): Promise<Record<string, unknown>>;
  /** Kill the engine + wait for it to exit (releases file locks before an update). */
  stopSidecar(): Promise<void>;
  /** Open a URL in the system browser (OAuth / billing / external links). */
  openExternal(url: string): Promise<void>;
  /** Subscribe to `gtmgrid://` deep-link OAuth callbacks. Returns an unsubscribe. */
  onOauthCallback(cb: (url: string) => void): () => void;
  /** Auto-updater events (electron-updater, driven from main). */
  onUpdateAvailable(cb: (version: string) => void): () => void;
  onUpdateDownloaded(cb: (version: string) => void): () => void;
  onUpdateError(cb: (message: string) => void): () => void;
  /** Stop the engine, then quit + install the downloaded update. */
  quitAndInstall(): Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** Are we running inside the packaged Electron desktop app? The single detection
 *  helper every desktop-only branch funnels through. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI;
}

/** The Electron bridge, or `null` in a web/dev (non-Electron) context. */
export function electron(): ElectronAPI | null {
  return (typeof window !== "undefined" && window.electronAPI) || null;
}
