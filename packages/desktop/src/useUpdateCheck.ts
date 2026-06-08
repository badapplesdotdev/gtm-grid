/**
 * In-app auto-updater (Tauri `@tauri-apps/plugin-updater`).
 *
 * On launch the app asks the updater to `check()` the configured endpoint
 * (`latest.json` on the latest GitHub release). The endpoint + the release's
 * `.sig` files are verified against the public key baked into `tauri.conf.json`,
 * so only releases signed with our private key are accepted. When a newer signed
 * release exists, {@link useUpdateCheck} returns it with an `install()` that
 * downloads + installs it and relaunches the app.
 *
 * Tauri-only: outside Tauri (web/dev) `check()` isn't available, so the hook is a
 * no-op returning `null`. Best-effort: any failure (offline, no `latest.json`
 * yet, signature mismatch) resolves to `null` — no banner, never a crash.
 */

import { useEffect, useState } from "react";
import { isTauri } from "./cloud/desktop-oauth";

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
    void (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const found = await check();
        if (found === null || cancelled) return;
        setUpdate({
          version: found.version,
          notes: found.body ?? null,
          install: async () => {
            await found.downloadAndInstall();
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
          },
        });
      } catch {
        /* no signed update available / offline / not Tauri — no banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return update;
}
