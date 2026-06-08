/**
 * In-app auto-updater (Tauri `@tauri-apps/plugin-updater`).
 *
 * The app asks the updater to `check()` the configured endpoint (`latest.json`
 * on the latest GitHub release). The endpoint + the release's `.sig` files are
 * verified against the public key baked into `tauri.conf.json`, so only releases
 * signed with our private key are accepted. When a newer signed release exists,
 * {@link useUpdateCheck} returns it with an `install()` that downloads +
 * installs it and relaunches the app.
 *
 * The updater is pull-based (no server push), so we re-check so a long-running
 * app surfaces the banner without a relaunch: once on launch, on a fixed
 * interval ({@link POLL_INTERVAL_MS}), and when the window regains focus
 * (throttled by {@link MIN_FOCUS_GAP_MS}). Polling stops as soon as an update is
 * found — the banner is sticky and re-checking would be wasted work.
 *
 * Tauri-only: outside Tauri (web/dev) `check()` isn't available, so the hook is a
 * no-op returning `null`. Best-effort: any failure (offline, no `latest.json`
 * yet, signature mismatch) resolves to `null` — no banner, never a crash.
 */

import { useEffect, useState } from "react";
import { isTauri } from "./cloud/desktop-oauth";

/** How often a running app re-polls for a newer release (2 hours). */
const POLL_INTERVAL_MS = 2 * 60 * 60 * 1000;
/**
 * Minimum gap between focus-triggered re-checks, so rapid window switching
 * doesn't hammer the endpoint (15 minutes).
 */
const MIN_FOCUS_GAP_MS = 15 * 60 * 1000;

export interface AvailableUpdate {
  /** The newer version available, e.g. "0.3.7". */
  readonly version: string;
  /** Optional release notes from `latest.json`. */
  readonly notes: string | null;
  /** Download + install the signed update, then relaunch the app. */
  readonly install: () => Promise<void>;
}

export function useUpdateCheck(): AvailableUpdate | null {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let found = false;
    let lastCheckAt = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const runCheck = async () => {
      // Stop once an update is in hand, or after teardown.
      if (cancelled || found) return;
      lastCheckAt = Date.now();
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const result = await check();
        if (result === null || cancelled || found) return;
        found = true;
        if (timer) clearInterval(timer);
        setUpdate({
          version: result.version,
          notes: result.body ?? null,
          install: async () => {
            await result.downloadAndInstall();
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
          },
        });
      } catch {
        /* no signed update available / offline / not Tauri — no banner */
      }
    };

    // Launch check + steady interval poll while the app stays open.
    void runCheck();
    timer = setInterval(() => void runCheck(), POLL_INTERVAL_MS);

    // Re-check when the user returns to the app (throttled), so coming back to a
    // long-idle window picks up a release that landed in the meantime.
    const onFocus = () => {
      if (Date.now() - lastCheckAt >= MIN_FOCUS_GAP_MS) void runCheck();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return update;
}
