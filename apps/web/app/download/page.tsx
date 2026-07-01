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

// Group the resolved downloads into the three OS families for display. `hint`
// renders a smaller first-launch instruction below the buttons.
const GROUPS: ReadonlyArray<{
  os: string;
  keys: readonly string[];
  note?: string;
  hint?: string;
}> = [
  {
    os: "macOS",
    keys: ["mac-arm", "mac-intel"],
    note: "Apple Silicon (M-series) or Intel",
    // The app is ad-hoc signed (not notarized — no paid Apple Developer ID yet),
    // so first launch shows an "unidentified developer" warning. Right-click → Open
    // (or clear the quarantine flag) gets past it; subsequent launches are normal.
    hint: 'First launch: right-click the app → Open → Open. If macOS still blocks it, run “xattr -cr \'/Applications/GTM Grid.app\'” in Terminal once.',
  },
  { os: "Windows", keys: ["windows"], note: "Windows 10/11, 64-bit" },
  { os: "Linux", keys: ["linux"], note: ".deb (Debian/Ubuntu)" },
];

// Cloud plans are started from inside the desktop app — creating a workspace
// auto-enrols it in a 7-day, no-card Team trial (see packages/cloud seats.ts).
// There is no web signup, so when a visitor arrives from a cloud "Start 7-day
// trial" CTA (`?plan=<id>`) we surface a short explainer connecting the download
// to the in-app trial instead of dropping them on a bare installer list.
const CLOUD_PLAN_NAMES: Record<string, string> = {
  team: "Team",
  business: "Business",
  unlimited: "Unlimited",
};

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan } = await searchParams;
  const cloudPlan = plan ? CLOUD_PLAN_NAMES[plan] : undefined;
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

      {plan ? (
        <aside className="download__cloud" aria-label="Starting a cloud trial">
          <h2 className="download__cloud-title">
            Starting {cloudPlan ? `your ${cloudPlan} trial` : "a cloud trial"}
          </h2>
          <p className="download__cloud-body">
            Cloud runs inside the same app. Install Grid below, open it, and sign in — every new
            workspace starts on a <b>7-day trial, no card required</b>.
            {cloudPlan && cloudPlan !== "Team"
              ? ` Upgrade to ${cloudPlan} from the in-app billing panel whenever you're ready.`
              : ""}
          </p>
        </aside>
      ) : null}

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
                {g.hint ? <p className="download__hint">{g.hint}</p> : null}
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
