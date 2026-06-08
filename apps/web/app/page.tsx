/* eslint-disable @next/next/no-img-element */
// GTM Grid — marketing landing page.
//
// Mirrors the Claude Design handoff (project/gtm-grid/Website.html) but rewired
// to the REAL app: repo badapplesdotdev/gtm-grid, version from the latest GitHub
// release, source-available under FSL-1.1-MIT (not "open source / MIT"), the 20
// real connectors with their method counts, the real cloud pricing
// (Free local-only · Team $20 · Business $40 · Unlimited $99), the real MCP tool
// names, and the real download flow (DownloadCTA → /api/download/<platform>).
//
// Voice: lowercase wordmark, direct second person, technical precision, no emoji.
// Brand accent is GTM green (DESIGN.md). Styles are scoped under `.gtm-home`
// (see _home/site.css) so they can't leak into /invite or /download.

import "./_home/site.css";
import { ALL_RELEASES_URL, getLatestRelease, RELEASE_REPO } from "@/lib/releases";
import { CONNECTORS, CONNECTOR_COUNT, faviconUrl } from "./_home/connectors";
import { CopyButton } from "./_home/CopyButton";
import { DownloadCTA } from "./_home/DownloadCTA";
import { HeroGrid } from "./_home/HeroGrid";
import { Nav } from "./_home/Nav";
import { Pricing } from "./_home/Pricing";
import { QuickStart } from "./_home/QuickStart";

// Revalidate hourly so a new release / star count surfaces without a redeploy.
export const revalidate = 3600;

const REPO_URL = `https://github.com/${RELEASE_REPO}`;
const CLONE_CMD = `git clone https://github.com/${RELEASE_REPO}.git`;

/** Real star count from the GitHub API, or null (never a fabricated number). */
async function getStars(): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASE_REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { stargazers_count?: number };
    return typeof json.stargazers_count === "number" ? json.stargazers_count : null;
  } catch {
    return null;
  }
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}
function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

const MARQUEE = CONNECTORS.filter((c) => c.domain).slice(0, 12);

export default async function Home() {
  const [latest, stars] = await Promise.all([getLatestRelease(), getStars()]);
  const version = latest?.version ?? "0.3.12";

  return (
    <div className="gtm-home">
      <Nav repoUrl={REPO_URL} stars={stars} />
      <span id="top" />

      {/* ───────── Hero ───────── */}
      <header className="hero">
        <div className="wrap">
          <h1>
            Every column is <span className="accent">a function.</span>
          </h1>
          <p className="hero-lead">
            gtm grid is a programmable GTM spreadsheet that runs entirely on your machine.
            Type a column, or make it a function — <code>ai.generate</code>, an enrichment
            connector, anything — and watch it run over every row.
          </p>
          <div className="hero-cta">
            <DownloadCTA size="lg" />
            <a className="btn btn-outline btn-lg" href={REPO_URL} target="_blank" rel="noreferrer">
              <GitHubMark />
              Star on GitHub
            </a>
          </div>
          <div className="hero-sub">
            <span><Check /> Bring your own AI key</span>
            <span><Check /> SQLite on your disk</span>
            <span><Check /> Drive it from Claude Code</span>
          </div>
          <HeroGrid />
        </div>
      </header>

      {/* ───────── Connector marquee ───────── */}
      <div className="marquee-band">
        <div className="marquee-lab">One declarative manifest each. Works with the tools you already pay for.</div>
        <div className="marquee">
          {[0, 1].map((track) => (
            <div className="marquee-track" key={track} aria-hidden={track === 1}>
              {MARQUEE.map((c) => (
                <span className="marq-item" key={c.name}>
                  <img className="marq-fav" src={faviconUrl(c.domain!)} alt="" width={22} height={22} loading="lazy" />
                  {c.name}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ───────── Quick start ───────── */}
      <section className="band" id="quickstart">
        <div className="wrap">
          <div className="qs-head">
            <h2><span className="qs-chev">›</span>Quick start</h2>
          </div>
          <QuickStart />
          <p className="qs-caption">
            Runs on macOS, Windows, and Linux. The desktop build bundles its own Node runtime, so it
            works on a clean machine — the agent panel just needs your own <code>claude</code> or{" "}
            <code>codex</code> CLI on PATH. <a href="/download">All platforms &amp; versions →</a>
          </p>
        </div>
      </section>

      {/* ───────── How it works ───────── */}
      <section className="band" id="how">
        <div className="wrap">
          <div className="split">
            <div className="sec-head">
              <span className="eyebrow"><span className="dot" />The model</span>
              <h2>Cells carry a status, not just a value.</h2>
              <p>
                Function columns resolve <span className="tok">{"{{Column Name}}"}</span> templates
                against each row, then run with bounded concurrency. You watch every cell move
                through its lifecycle.
              </p>
              <div className="steps">
                <div className="step">
                  <span className="step-n">1</span>
                  <div className="step-tx"><h4>Add a column</h4><p>Manual text, number, boolean, date, or JSON — or make it a function column.</p></div>
                </div>
                <div className="step">
                  <span className="step-n">2</span>
                  <div className="step-tx"><h4>Pick a function</h4><p><span className="tok">ai.generate</span>, <span className="tok">trigify.enrichProfile</span>, or any connector method like <span className="tok">leadmagic.findEmail</span>.</p></div>
                </div>
                <div className="step">
                  <span className="step-n">3</span>
                  <div className="step-tx"><h4>Run</h4><p>Every row resolves in parallel: <span className="mono" style={{ color: "var(--text-3)" }}>pending → running → done</span>. JSON results collapse into a clickable <span className="mono" style={{ color: "var(--success-ink)" }}>200</span> pill.</p></div>
                </div>
              </div>
            </div>
            <div className="demo-card">
              <div className="demo-card-bar"><div className="traffic"><i /><i /><i /></div><span style={{ marginLeft: 6 }}>Title · function column</span></div>
              <div className="demo-body">
                <pre className="code">{``}<span className="c">{`// resolves per row, bounded concurrency`}</span>{`
`}<span className="k">fn</span>{` Title = trigify.`}<span className="k">enrichProfile</span>{`({
  profile: `}<span className="tok" style={{ background: "var(--accent-bg)" }}>{"{{LinkedIn URL}}"}</span>{`,
  fields: [`}<span className="s">{`"title"`}</span>{`, `}<span className="s">{`"seniority"`}</span>{`]
})

`}<span className="c">{`// row 1 →`}</span>{`  `}<span className="s">{`"Head of Growth"`}</span>{`
`}<span className="c">{`// row 2 →`}</span>{`  `}<span className="s">{`"VP Sales"`}</span>{`
`}<span className="c">{`// row 3 →`}</span>{`  Status Code: `}<span className="s">200</span></pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── Connectors wall ───────── */}
      <section className="band" id="connectors">
        <div className="wrap">
          <div className="sec-head center">
            <span className="eyebrow"><span className="dot" />Extensions</span>
            <h2>{CONNECTOR_COUNT} connectors. Zero glue code.</h2>
            <p>
              Every connector is one JSON manifest — a <span className="tok">baseUrl</span>,{" "}
              <span className="tok">auth</span>, and <span className="tok">methods</span>. That single
              file becomes an <span className="mono" style={{ color: "var(--text)" }}>sdk</span> call,
              an MCP tool, and a UI form. Bring your own keys; credentials are encrypted and scoped.
            </p>
          </div>
          <div className="conn-grid">
            {CONNECTORS.map((c) => (
              <div className={`conn-card${c.featured ? " featured" : ""}`} key={c.name}>
                <span className="conn-ico">
                  {c.domain ? (
                    <img src={faviconUrl(c.domain)} alt="" width={24} height={24} loading="lazy" />
                  ) : (
                    <span className="conn-fallback">{c.mono}</span>
                  )}
                </span>
                <div className="conn-meta">
                  <div className="conn-name-row">
                    <span className="conn-name">
                      <span className="label">{c.name}</span>
                      {c.featured ? <span className="feat-tag">Featured</span> : null}
                    </span>
                  </div>
                  <div className="conn-count"><span className="num">{c.methods}</span> methods</div>
                </div>
              </div>
            ))}
          </div>
          <p className="conn-more">
            Not bundled? Drop a JSON manifest into <span className="mono">extensions/</span> — it&apos;s
            an sdk call, an MCP tool, and a connection form the moment it lands.
          </p>
        </div>
      </section>

      {/* ───────── Agent panel ───────── */}
      <section className="band" id="agent">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow"><span className="dot" />Agent panel</span>
            <h2>Your CLI drives the grid.</h2>
            <p>
              The agents you already use, docked in the grid. AI columns and the agent run on{" "}
              <b style={{ color: "var(--text)", fontWeight: 600 }}>your own Claude Code or Codex
              subscription</b> — the plan you already pay for, with no API keys and no per-token bill.
              gtm grid ships an MCP server, so either one can build tables, add columns, and fill rows
              while you watch.
            </p>
          </div>
          <div className="agent-demo">
            <div className="agent-left">
              <span className="eyebrow">You type</span>
              <div className="agent-prompt">Using <span className="var">gtmgrid</span>, create a table of these 10 founders and enrich each with their GitHub bio and company headcount.</div>
              <div className="agent-points">
                <div className="agent-point">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  <span><b>Runs on your own subscription.</b> AI columns bill to the Claude Code or Codex plan you already pay for — no API keys, no per-token metering.</span>
                </div>
                <div className="agent-point">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
                  <span><b>Real-time.</b> Rows fill in the grid as the agent calls tools — you see every status flip.</span>
                </div>
                <div className="agent-point">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
                  <span><b>Same surface, two agents.</b> Switch between Claude Code and Codex in a tab.</span>
                </div>
              </div>
            </div>
            <div className="agent-panel-mock">
              <div className="apm-tabs">
                <span className="apm-tab active">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.541Zm-.3712 10.2456 2.2914-5.9456 2.2914 5.9456Z" /></svg>
                  Claude Code
                </span>
                <span className="apm-tab off">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 17.42a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 18.95a4.5 4.5 0 0 1-6.14-1.53zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973v5.677a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856L13.104 8.36l2.015-1.16a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.677a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08-4.778 2.759a.795.795 0 0 0-.393.68zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" /></svg>
                  Codex
                </span>
              </div>
              <div className="apm-stream">
                <div><span className="apm-role">You</span></div>
                <div className="apm-msg-user">Add a column that scores GTM fit 0–100 and run it.</div>
                <div className="apm-tool"><span className="d" />add_column <span className="args">name=&quot;Fit&quot; fn=&quot;ai.generate&quot;</span></div>
                <div className="apm-tool"><span className="d" />run_column <span className="args">&quot;Fit&quot; · 7 rows</span></div>
                <div className="apm-result">✓ 7/7 done · wrote to Founders</div>
                <div className="apm-asst">Done. &quot;Fit&quot; is live on all 7 rows — top match is Sam Delgado at Clay (96). Want me to sort descending?</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── Source-available / Local vs Cloud ───────── */}
      <section className="band" id="source">
        <div className="wrap">
          <div className="sec-head center">
            <span className="eyebrow"><span className="dot" />Source-available</span>
            <h2>Free on your machine. <span className="accent">Cloud only when you need it.</span></h2>
            <p>
              The desktop app is free and source-available — run it offline, ship your own connectors,
              send the good ones back as a PR. Cloud is where it gets serious: put your whole team on
              the data and keep every grid running while you&apos;re away.
            </p>
          </div>

          <div className="lc-grid">
            <div className="lc-card local">
              <div className="lc-head">
                <span className="lc-ico"><GitHubMark /></span>
                <span className="lc-tag">Free · FSL-1.1-MIT</span>
              </div>
              <h3>The source-available desktop app</h3>
              <p className="lc-sub">Everything runs on your machine. No account, no caps, no pricing gate — and the full source is yours to read, fork, and extend.</p>
              <ul className="lc-list">
                <li><Check /> <span><b>Unlimited</b> rows, tables &amp; function columns</span></li>
                <li><Check /> <span>Every connector — bring your own keys</span></li>
                <li><Check /> <span><b>Fork it, build connectors, open a PR</b> — features ship from the community</span></li>
                <li><Check /> <span><b>Powered by your own Claude Code or Codex</b> — AI columns run on the subscription you already pay for</span></li>
              </ul>
              <div className="lc-cta">
                <DownloadCTA label="Download free" />
                <a className="btn btn-outline" href={REPO_URL} target="_blank" rel="noreferrer"><GitHubMark />Browse the source</a>
              </div>
            </div>

            <div className="lc-card cloud">
              <div className="lc-head">
                <span className="lc-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .9-8.91 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6 19Z" /></svg>
                </span>
                <span className="lc-tag">Optional · from $20</span>
              </div>
              <h3>Cloud, for when you step away</h3>
              <p className="lc-sub">The same grid, hosted — so it keeps running with your laptop closed, fires on incoming events, and opens up to your whole team.</p>
              <ul className="lc-list">
                <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9a6 6 0 0 0-6-6Z" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg> <span><b>Runs when your computer&apos;s asleep</b> — scheduled refreshes keep firing</span></li>
                <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m13 2-3 7h6l-3 7" /><path d="M5 12h2M17 12h2M12 5V3M12 21v-2" /></svg> <span><b>Webhooks</b> — new rows enrich themselves on inbound events</span></li>
                <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg> <span><b>Team access</b> — shared workspaces &amp; credentials</span></li>
                <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg> <span>Realtime multiplayer on shared grids</span></li>
              </ul>
              <div className="lc-cta">
                <a className="btn btn-primary" href="#pricing">See cloud plans</a>
                <a className="btn btn-ghost" href="#pricing">From $20 / seat →</a>
              </div>
            </div>
          </div>

          <div className="lc-detail-lab">Under the hood — how local-first works</div>
          <div className="feat-grid">
            <div className="feat-card">
              <div className="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" /><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></svg></div>
              <h3>SQLite on disk</h3>
              <p>Tables, columns, and cell history live in a local <code>.db</code> file at <code>~/gtmgrid/&lt;name&gt;.db</code>. Close the laptop lid — it&apos;s still yours.</p>
            </div>
            <div className="feat-card">
              <div className="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg></div>
              <h3>Encrypted credentials</h3>
              <p>Every key is <code>AES-256-GCM</code> encrypted and scoped <span className="mono" style={{ color: "var(--text)" }}>Local / Personal / Team</span>. Nothing is synced to a server.</p>
            </div>
            <div className="feat-card">
              <div className="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg></div>
              <h3>Sandboxed logic</h3>
              <p>Column functions run in a <code>QuickJS</code> sandbox with a declarative HTTP layer. Predictable, bounded, no surprises.</p>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── Pricing ───────── */}
      <section className="band" id="pricing">
        <div className="wrap">
          <div className="sec-head center">
            <span className="eyebrow"><span className="dot" />Cloud pricing</span>
            <h2>The app is free. <span className="accent">Cloud is metered.</span></h2>
            <p>
              Cloud plans are billed per seat and metered by <b>cloud actions</b> — runs that happen on
              our infrastructure instead of your machine. No row, table, or connector caps, ever. The
              desktop app stays free no matter what.
            </p>
          </div>

          <div className="local-strip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></svg>
            <span className="ls-tx"><b>Desktop app — $0, source-available, unlimited.</b> Cloud only covers runs that happen off your machine.</span>
            <a href="/download">Download free <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></a>
          </div>

          <Pricing />

          <div className="bill-notes">
            <div className="bill-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .9-8.91 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6 19Z" /></svg>
              <div><h5>What counts as a cloud action?</h5><p>Any run executed on our cloud instead of your machine — a function-column cell, a webhook fire, or a scheduled refresh. Runs on the desktop app are always free.</p></div>
            </div>
            <div className="bill-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
              <div><h5>Metered by actions, not rows</h5><p>Each member is one seat; allowances pool across the workspace. Rows, tables, and connectors are never capped — only cloud actions are.</p></div>
            </div>
            <div className="bill-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>
              <div><h5>The desktop app is always free</h5><p>Source-available under FSL-1.1-MIT and unlimited on your own machine. Cloud is purely additive — for when grids need to run without you.</p></div>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── FAQ ───────── */}
      <section className="band">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow"><span className="dot" />FAQ</span>
            <h2>The honest answers.</h2>
          </div>
          <div className="faq-list">
            {[
              { q: "Is my data really local?", a: <>Yes. Storage is SQLite in a file on your disk, column logic runs in a local QuickJS sandbox, and credentials are encrypted at rest. The only outbound traffic is the connector and AI calls <em>you</em> trigger, sent directly to those providers.</> },
              { q: "Do I have to use the cloud?", a: <>No. The desktop app is free and source-available — local, solo, unlimited. Cloud is an optional layer you turn on only when a grid needs to run without you: scheduled refreshes while your laptop&apos;s closed, webhook triggers, team workspaces, and shared credentials. If you never need those, you never pay.</> },
              { q: "What does “bring your own key” mean for cost?", a: <>You add your own Anthropic / OpenAI key and your existing connector keys. gtm grid adds no markup — you pay providers their list price, and the app itself is free. AI columns can also run on your own Claude Code or Codex subscription.</> },
              { q: "How do I add a connector that isn't bundled?", a: <>Drop a JSON manifest into <code>extensions/</code> with a <code>baseUrl</code>, an <code>auth</code> block, and your <code>methods</code>. It immediately becomes an <code>sdk.&lt;id&gt;.&lt;method&gt;()</code> call, an MCP tool the agent can use, and a connection form in the UI.</> },
              { q: "Do I have to use the AI agent?", a: <>No. The grid works fully on its own — add columns, pick functions, hit Run. The Claude Code / Codex panel is there when you&apos;d rather describe what you want than click through it.</> },
              { q: "Which platforms are supported?", a: <>It&apos;s a Tauri v2 desktop app. Signed builds ship for macOS, Windows, and Linux (.deb); the CLI and MCP server run anywhere Node does.</> },
              { q: "Is it really open source?", a: <>It&apos;s <b>source-available</b> under the Functional Source License (<code>FSL-1.1-MIT</code>): read, fork, self-host, and modify it for any purpose <em>except</em> building a competing commercial product — and each release automatically converts to the MIT license two years after it ships.</> },
            ].map((item) => (
              <details className="faq-item" key={item.q}>
                <summary className="faq-q">
                  {item.q}
                  <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                </summary>
                <div className="faq-a-inner">{item.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── Final CTA ───────── */}
      <section className="cta-band">
        <div className="wrap">
          <h2>Stop renting your pipeline. <br /><span className="accent">Run it locally.</span></h2>
          <p>Download the app, point it at your keys, and build your first grid in a couple of minutes.</p>
          <div className="cta-cmd">
            <span className="prompt">$</span>
            <span>{CLONE_CMD}</span>
            <CopyButton text={`${CLONE_CMD}`} />
          </div>
          <div className="cta-cta">
            <DownloadCTA size="lg" />
            <a className="btn btn-outline btn-lg" href={REPO_URL} target="_blank" rel="noreferrer">Read the docs</a>
          </div>
        </div>
      </section>

      {/* ───────── Footer ───────── */}
      <footer className="footer">
        <div className="wrap">
          <div className="footer-brand">
            <a className="brand" href="#top" aria-label="GTM Grid — home">
              <img className="brand-logo" src="/brand/logo.svg" alt="GTM Grid" width={136} height={22} />
            </a>
            <p className="footer-tag">Local-first programmable GTM spreadsheet — every column is a function.</p>
          </div>
          <div className="foot-col">
            <h5>Product</h5>
            <a href="#how">How it works</a>
            <a href="#connectors">Connectors</a>
            <a href="#agent">Agent panel</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="foot-col">
            <h5>Developers</h5>
            <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={`${REPO_URL}/tree/main/packages/cli`} target="_blank" rel="noreferrer">CLI</a>
            <a href={`${REPO_URL}/tree/main/packages/mcp`} target="_blank" rel="noreferrer">MCP server</a>
            <a href={`${REPO_URL}/tree/main/extensions`} target="_blank" rel="noreferrer">Connector manifests</a>
          </div>
          <div className="foot-col">
            <h5>Company</h5>
            <a href="/download">Download</a>
            <a href={ALL_RELEASES_URL} target="_blank" rel="noreferrer">Changelog</a>
            <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">License</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="wrap">
            <span>© 2026 Bad Apples Dev</span>
            <span className="mono">v{version} · FSL-1.1-MIT</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
