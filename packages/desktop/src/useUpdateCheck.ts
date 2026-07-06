/**
 * In-app auto-updater surface (electron-updater, driven by the Electron main).
 *
 * The main process checks GitHub releases on launch + on an interval, auto-
 * downloads a newer signed release, and forwards `update-downloaded` to the
 * renderer over IPC. This hook surfaces that as an {@link AvailableUpdate}; the
 * banner's "install" stops the engine and quits-and-installs (handled in main, so
 * the Windows file-lock ordering is correct by construction).
 *
 * Desktop-only: outside the Electron app (the web/dev build) the hook is a no-op
 * returning `null`, so the web flows are untouched.
 */

import { useEffect, useState } from "react";
import { electron } from "./electron";

export interface AvailableUpdate {
  /** The newer version available, e.g. "0.3.7". */
  readonly version: string;
  /** Optional release notes. */
  readonly notes: string | null;
  /** Quit + install the already-downloaded update (stops the engine first). */
  readonly install: () => Promise<void>;
}

export interface UpdateCheck {
  readonly update: AvailableUpdate | null;
  /**
   * The updater's LAST error (download or install). Squirrel failures happen
   * AFTER quitAndInstall resolves, so without this channel a failed install is
   * invisible — the app relaunches on the old version and re-offers the same
   * update forever.
   */
  readonly error: string | null;
}

/** Vite dev flag, read defensively (import.meta.env isn't typed in this project). */
const IS_DEV = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

export function useUpdateCheck(): UpdateCheck {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // DEV-only preview: outside the app the real updater is unavailable, so let a
    // developer simulate an update via localStorage["gtmgrid:mockUpdate"]. Never
    // honored in production.
    if (IS_DEV) {
      try {
        const mockVersion = localStorage.getItem("gtmgrid:mockUpdate");
        if (mockVersion) {
          setUpdate({
            version: mockVersion,
            notes: localStorage.getItem("gtmgrid:mockUpdateNotes"),
            install: async () => {
              // eslint-disable-next-line no-console
              console.info("[mock-update] would stop engine + quit + install");
            },
          });
          return;
        }
      } catch {
        /* ignore */
      }
    }

    const api = electron();
    if (!api) return;
    // The main process auto-downloads; surface the banner once it's ready to
    // apply. A fresh download clears any stale failure.
    const offDownloaded = api.onUpdateDownloaded((version) => {
      setError(null);
      setUpdate({ version, notes: null, install: () => api.quitAndInstall() });
    });
    const offError = api.onUpdateError?.((message) => setError(message));
    return () => {
      offDownloaded();
      offError?.();
    };
  }, []);
  return { update, error };
}
