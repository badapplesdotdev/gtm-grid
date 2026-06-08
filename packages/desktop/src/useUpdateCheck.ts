/**
 * In-app update notifier. Compares the running desktop app version against the
 * latest GitHub release and, when a newer one exists, surfaces an "update
 * available" banner that opens the download page. Tauri-only (the web build never
 * needs to self-update); a no-op + `null` outside Tauri.
 *
 * This is the lightweight half of the update system — it NOTIFIES. The heavier
 * download-and-install-in-app step (Tauri `@tauri-apps/plugin-updater`) needs an
 * updater signing keypair + signed bundles; see the follow-up. The version
 * comparison is a pure, unit-tested helper so the policy is verifiable offline.
 */

import { useEffect, useState } from "react";
import { isTauri } from "./cloud/desktop-oauth";

const RELEASE_REPO = "badapplesdotdev/gtm-grid";
const DOWNLOAD_URL = "https://www.gtmgrid.dev/download";

/** Parse "v1.2.3" / "1.2.3" → [1,2,3]; missing/non-numeric parts become 0. */
function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/i, "").split(".");
  const n = (i: number) => {
    const x = Number.parseInt(parts[i] ?? "", 10);
    return Number.isFinite(x) ? x : 0;
  };
  return [n(0), n(1), n(2)];
}

/** True iff `latest` is strictly newer than `current` (major.minor.patch). */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export interface UpdateInfo {
  /** The newer version available, e.g. "0.3.7". */
  readonly version: string;
  /** Where to get it (the marketing download page). */
  readonly url: string;
}

/** Open an external URL via the Tauri opener, falling back to `window.open`. */
export async function openExternal(url: string): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    try {
      window.open(url, "_blank");
    } catch {
      /* nothing else we can do */
    }
  }
}

/**
 * Returns the available update (newer than the running version) or `null`.
 * Checks once on mount and again on window focus (cheap; GitHub's unauthenticated
 * API is fine for a per-launch check). Best-effort: any failure resolves to null.
 */
export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const current = await getVersion();
        const res = await fetch(
          `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
          { headers: { Accept: "application/vnd.github+json" } },
        );
        if (!res.ok) return;
        const rel = (await res.json()) as { tag_name?: string };
        const latest = (rel.tag_name ?? "").replace(/^v/i, "");
        if (!cancelled && latest && isNewerVersion(latest, current)) {
          setUpdate({ version: latest, url: DOWNLOAD_URL });
        }
      } catch {
        /* offline / rate-limited / not Tauri — no banner */
      }
    };
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return update;
}
