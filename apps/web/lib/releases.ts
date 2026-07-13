/**
 * Desktop release metadata — the single source of truth for the marketing
 * download experience. The cross-platform installers are built in GitHub Actions
 * (`.github/workflows/release.yml`) and published as assets on each GitHub
 * release of the PUBLIC repo {@link RELEASE_REPO}; the asset names embed the
 * version (electron-builder names, e.g. `GTM-Grid-1.0.0-arm64.dmg`,
 * `GTM-Grid-Setup-1.0.0.exe`, `GTM-Grid-1.0.0-amd64.deb`), so we resolve the right
 * file from the LATEST release at request time rather than hard-coding a version.
 *
 * Consumed by:
 *   - `app/api/download/[platform]/route.ts` — 302s to the matching asset.
 *   - `app/download/page.tsx` — lists every platform with its size.
 */

export const RELEASE_REPO = "badapplesdotdev/gtm-grid";

/** A user-facing download target, keyed by the `[platform]` route segment. */
export interface Platform {
  /** URL/route key. */
  readonly key: string;
  /** Human label shown in the UI. */
  readonly label: string;
  /** Matches the release asset filename for this platform. */
  readonly match: RegExp;
}

/**
 * The four distributable installers (the `.app.tar.gz` updater artifacts are
 * intentionally excluded — those are for the auto-updater, not direct download).
 * Linux ships as `.deb` only: the AppImage bundler's upstream tool download is
 * unreliable (persistent 504s), so the `linux` key resolves to the `.deb`.
 */
export const PLATFORMS: readonly Platform[] = [
  { key: "mac-arm", label: "macOS (Apple Silicon)", match: /-arm64\.dmg$/ },
  { key: "mac-intel", label: "macOS (Intel)", match: /-x64\.dmg$/ },
  { key: "windows", label: "Windows", match: /-Setup-[^/]*\.exe$/ },
  { key: "linux", label: "Linux (.deb)", match: /-amd64\.deb$/ },
];

export const platformByKey = (key: string): Platform | undefined =>
  PLATFORMS.find((p) => p.key === key);

/** The browser path to all releases (fallback when an asset can't be resolved). */
export const ALL_RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;

interface GitHubAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}
interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly assets: readonly GitHubAsset[];
}

/** A resolved download for one platform. */
export interface ResolvedDownload {
  readonly key: string;
  readonly label: string;
  readonly url: string;
  /** Human size, e.g. "48 MB". */
  readonly size: string;
}

/** The latest release plus its per-platform resolved downloads. */
export interface LatestRelease {
  /** Version without a leading `v` (e.g. "0.2.0"). */
  readonly version: string;
  readonly htmlUrl: string;
  readonly downloads: readonly ResolvedDownload[];
}

const mb = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`;

/**
 * Fetch the latest GitHub release and resolve each platform's asset URL + size.
 * Cached for a few minutes (`revalidate`) so a freshly-cut release reflects on the
 * site within minutes WITHOUT a redeploy — the previous 1h window meant the download
 * page lagged a full hour behind every release. The fetch is server-side and shared
 * (Next dedupes by URL), so this is ~12 GitHub calls/hour — well under the 60/hr
 * unauthenticated limit. Returns `null` if the release can't be fetched — callers
 * fall back to {@link ALL_RELEASES_URL}.
 */
export async function getLatestRelease(): Promise<LatestRelease | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) return null;
    const rel = (await res.json()) as GitHubRelease;
    const downloads: ResolvedDownload[] = [];
    for (const p of PLATFORMS) {
      const asset = rel.assets.find((a) => p.match.test(a.name));
      if (asset) {
        downloads.push({
          key: p.key,
          label: p.label,
          url: asset.browser_download_url,
          size: mb(asset.size),
        });
      }
    }
    return {
      version: rel.tag_name.replace(/^v/, ""),
      htmlUrl: rel.html_url,
      downloads,
    };
  } catch {
    return null;
  }
}

/** Resolve the direct asset URL for a platform key from the latest release. */
export async function assetUrlFor(key: string): Promise<string> {
  const latest = await getLatestRelease();
  return latest?.downloads.find((d) => d.key === key)?.url ?? ALL_RELEASES_URL;
}
