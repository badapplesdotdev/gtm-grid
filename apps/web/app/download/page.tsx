import type { Metadata } from "next";
import Link from "next/link";
import { ALL_RELEASES_URL, getLatestRelease } from "@/lib/releases";

export const metadata: Metadata = {
  title: "Download GTM Grid",
  description:
    "Download the GTM Grid desktop app for macOS, Windows, or Linux. Local-first — your data and keys stay on your machine.",
};

// Revalidate hourly so a new release surfaces without a redeploy.
export const revalidate = 3600;

// Group the resolved downloads into the three OS families for display.
const GROUPS: ReadonlyArray<{ os: string; keys: readonly string[]; note?: string }> = [
  { os: "macOS", keys: ["mac-arm", "mac-intel"], note: "Apple Silicon (M-series) or Intel" },
  { os: "Windows", keys: ["windows"], note: "Windows 10/11, 64-bit" },
  { os: "Linux", keys: ["linux", "linux-deb"], note: "AppImage (portable) or .deb (Debian/Ubuntu)" },
];

export default async function DownloadPage() {
  const latest = await getLatestRelease();

  return (
    <main className="container download">
      <Link className="wordmark download__home" href="/">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="wordmark__mark" src="/brand/icon.png" alt="" width={16} height={16} aria-hidden="true" />
        GTM Grid
      </Link>

      <header className="download__head">
        <span className="eyebrow">local-first · bring your own key</span>
        <h1>Download GTM Grid</h1>
        <p className="download__lede">
          The desktop app runs entirely on your machine — SQLite engine, QuickJS sandbox,
          your own AI key. {latest ? `Latest version ${latest.version}.` : ""}
        </p>
      </header>

      {latest && latest.downloads.length > 0 ? (
        <div className="download__groups">
          {GROUPS.map((g) => {
            const items = g.keys
              .map((k) => latest.downloads.find((d) => d.key === k))
              .filter((d): d is NonNullable<typeof d> => Boolean(d));
            if (items.length === 0) return null;
            return (
              <section className="download__group" key={g.os}>
                <h2>{g.os}</h2>
                {g.note ? <p className="download__note">{g.note}</p> : null}
                <ul className="download__list">
                  {items.map((d) => (
                    <li key={d.key}>
                      <a className="btn btn--primary download__btn" href={`/api/download/${d.key}`}>
                        {d.label}
                      </a>
                      <span className="download__size">{d.size}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <p className="download__lede">
          Downloads are published on{" "}
          <a className="download__link" href={ALL_RELEASES_URL}>GitHub Releases</a>.
        </p>
      )}

      <footer className="download__foot">
        <a className="download__link" href={ALL_RELEASES_URL}>All versions &amp; release notes →</a>
        <span className="download__sep">·</span>
        <Link className="download__link" href="/">Back to home</Link>
      </footer>
    </main>
  );
}
