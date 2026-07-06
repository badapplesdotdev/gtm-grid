/**
 * In-app auto-updater surface (electron-updater, driven by the Electron main).
 *
 * The main process checks GitHub releases on launch + on an interval and
 * forwards the updater lifecycle over IPC; downloads start on the USER'S
 * click (autoDownload is off), so this hook is a small phase machine the
 * redesigned update dialog renders directly:
 *
 *   available ──download()──▶ downloading (live %) ─▶ verifying ─▶ ready
 *      ready ──install()──▶ installing (quit + swap + relaunch)
 *
 * Squirrel failures arrive AFTER install() resolves via `updater:error` —
 * surfacing them here is what keeps a failed install from silently looping
 * ("offer → install → old version → same offer").
 *
 * Desktop-only: outside the Electron app (the web/dev build) the hook is a
 * no-op, except for a localStorage-driven mock in dev for styling the dialogs.
 */

import { useCallback, useEffect, useState } from "react";
import { electron } from "./electron";
import { parseReleaseNotes } from "./changelog";

export type UpdatePhase = "available" | "downloading" | "verifying" | "ready" | "installing";

export interface AvailableUpdate {
  /** The newer version available, e.g. "1.6.1". */
  readonly version: string;
  /** Incoming release's notes, categorized (parsed from the GitHub release body). */
  readonly added: readonly string[];
  readonly fixed: readonly string[];
}

export interface UpdateCheck {
  readonly update: AvailableUpdate | null;
  readonly phase: UpdatePhase;
  /** Download percentage, 0–100 (meaningful in the downloading phase). */
  readonly progress: number;
  /** Start downloading the offered update. */
  readonly download: () => void;
  /** Quit + install the downloaded update (stops the engine first). */
  readonly install: () => Promise<void>;
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

const NOOP_INSTALL = async () => {};

export function useUpdateCheck(): UpdateCheck {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("available");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mock, setMock] = useState(false);

  useEffect(() => {
    // DEV-only preview: outside the app the real updater is unavailable, so let a
    // developer simulate an update via localStorage["gtmgrid:mockUpdate"]. Never
    // honored in production.
    if (IS_DEV) {
      try {
        const mockVersion = localStorage.getItem("gtmgrid:mockUpdate");
        if (mockVersion) {
          setMock(true);
          setUpdate({
            version: mockVersion,
            added: ["A brand-new capability to admire in this dialog."],
            fixed: ["A bug that no longer exists.", "A rough edge, sanded."],
          });
          return;
        }
      } catch {
        /* ignore */
      }
    }

    const api = electron();
    if (!api) return;
    const offAvailable = api.onUpdateAvailable?.((info) => {
      const notes = parseReleaseNotes(info.notes);
      setError(null);
      setPhase("available");
      setProgress(0);
      setUpdate({ version: info.version, added: notes.added, fixed: notes.fixed });
    });
    const offProgress = api.onUpdateProgress?.((percent) => {
      setPhase((p) => (p === "available" || p === "downloading" ? "downloading" : p));
      setProgress(percent);
    });
    const offDownloaded = api.onUpdateDownloaded((version) => {
      setError(null);
      setProgress(100);
      setPhase("ready");
      // Older mains (autoDownload=true, no available event) land straight here.
      setUpdate((u) => u ?? { version, added: [], fixed: [] });
    });
    const offError = api.onUpdateError?.((message) => {
      setError(message);
      setPhase("available");
    });
    return () => {
      offAvailable?.();
      offProgress?.();
      offDownloaded();
      offError?.();
    };
  }, []);

  const download = useCallback(() => {
    setError(null);
    if (mock) {
      // Dev preview walks the phases so the dialog can be styled end to end.
      setPhase("downloading");
      let pct = 0;
      const iv = setInterval(() => {
        pct = Math.min(100, pct + 4 + Math.random() * 6);
        setProgress(Math.round(pct));
        if (pct >= 100) {
          clearInterval(iv);
          setPhase("verifying");
          setTimeout(() => setPhase("ready"), 900);
        }
      }, 90);
      return;
    }
    const api = electron();
    if (!api?.downloadUpdate) return;
    setPhase("downloading");
    setProgress(0);
    void api.downloadUpdate().catch(() => {
      setError("The download couldn't start. Check your connection and try again.");
      setPhase("available");
    });
  }, [mock]);

  const install = useCallback(async () => {
    setPhase("installing");
    if (mock) return NOOP_INSTALL();
    const api = electron();
    if (!api) return;
    try {
      await api.quitAndInstall();
    } catch {
      setPhase("ready");
      setError("Update failed — please try again.");
    }
  }, [mock]);

  // A downloading phase where the percent never moves but update-downloaded
  // fires is fine; the "verifying" phase is entered when the bar completes but
  // the ready signal hasn't landed yet.
  useEffect(() => {
    if (phase === "downloading" && progress >= 100) setPhase("verifying");
  }, [phase, progress]);

  return { update, phase, progress, download, install, error };
}
