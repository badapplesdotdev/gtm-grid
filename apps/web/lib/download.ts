// Shared logic for the desktop download CTAs (`app/_home/DownloadCTA.tsx` and
// its twin `app/DownloadButton.tsx`). OS detection and the resulting
// href/feedback decision live here so the two buttons stay in lock-step and the
// branching is unit-testable without a DOM.

export type DetectedOS = { readonly key: string; readonly os: string } | null;

/**
 * Map a user-agent string to the matching desktop build, or `null` when there
 * is no desktop installer for it (mobile or an unknown/absent UA). Mirrors the
 * order the buttons relied on: mobile first, then macOS (default Apple
 * Silicon), Windows, Linux.
 */
export function detectOS(userAgent: string | undefined | null): DetectedOS {
  if (!userAgent) return null;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return null; // no desktop build
  if (/Mac/i.test(userAgent)) return { key: "mac-arm", os: "macOS" }; // default Apple Silicon
  if (/Win/i.test(userAgent)) return { key: "windows", os: "Windows" };
  if (/Linux/i.test(userAgent)) return { key: "linux", os: "Linux" };
  return null;
}

export type DownloadTarget = {
  /** Where the button points. */
  readonly href: string;
  /** `platform` / `os` for the `download_initiated` analytics event. */
  readonly platform: string;
  readonly os: string;
  /**
   * `true` when the click starts an in-page binary download — the
   * `/api/download/<platform>` route 302s straight to the installer, so the
   * page never changes and the button must surface its own "download starting"
   * feedback. `false` when we instead navigate to the full `/download` page,
   * which is its own feedback.
   */
  readonly startsInPageDownload: boolean;
};

/** Resolve the href, analytics labels, and feedback mode for a detected OS. */
export function resolveDownload(detected: DetectedOS): DownloadTarget {
  if (detected) {
    return {
      href: `/api/download/${detected.key}`,
      platform: detected.key,
      os: detected.os,
      startsInPageDownload: true,
    };
  }
  return {
    href: "/download",
    platform: "unknown",
    os: "unknown",
    startsInPageDownload: false,
  };
}
