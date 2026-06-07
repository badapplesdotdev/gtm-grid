// GTM Grid — marketing landing page.
// Voice: lowercase wordmark, direct second person, technical precision, no emoji.
// Icons are line-drawn SVG (currentColor), never emoji or unicode glyphs.

import { DownloadButton } from "./DownloadButton";

function Wordmark() {
  return (
    <span className="wordmark">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="wordmark__mark" src="/brand/icon.png" alt="" width={16} height={16} aria-hidden="true" />
      GTM Grid
    </span>
  );
}

type IconProps = { className?: string };

function FunctionIcon({ className }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 20c2 0 3-1.3 3.3-3.4L9 5.4C9.3 3.3 10.3 2 12.5 2" />
      <path d="M5 11h6" />
      <path d="m14 11 6 9M20 11l-6 9" />
    </svg>
  );
}

function ShieldIcon({ className }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.4 8.4 8 11 4.6-2.6 8-6 8-11V5l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function PlugIcon({ className }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 2v5M15 2v5" />
      <path d="M7 7h10v3a5 5 0 0 1-10 0V7Z" />
      <path d="M12 15v7" />
    </svg>
  );
}

function TerminalIcon({ className }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </svg>
  );
}

function GridIcon({ className }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  );
}

function WebhookIcon({ className }: IconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8.5 9.5a3.5 3.5 0 1 1 5 3.1l2.4 4" />
      <path d="M14.5 19a3.5 3.5 0 1 1-1.5-6.6" />
      <path d="M9.5 19a3.5 3.5 0 1 1-3-5.2l2.3-4" />
    </svg>
  );
}

function TickIcon({ className }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

function MiniGrid() {
  return (
    <div className="mini-grid" aria-hidden="true">
      <div className="mini-grid__bar">
        <span className="mini-grid__dot" />
        <span className="mini-grid__dot" />
        <span className="mini-grid__dot" />
        <span className="mini-grid__title">founders.table</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>name</th>
            <th><span className="fn">ƒ</span> company</th>
            <th><span className="fn">ƒ</span> opener</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>amara osei</td>
            <td>northwind</td>
            <td>saw northwind shipped&nbsp;…</td>
            <td><span className="pill pill--done">done</span></td>
          </tr>
          <tr>
            <td>lukas vogel</td>
            <td>tidepool</td>
            <td>tidepool&apos;s changelog&nbsp;…</td>
            <td><span className="pill pill--running">running</span></td>
          </tr>
          <tr>
            <td>priya nadar</td>
            <td>—</td>
            <td>—</td>
            <td><span className="pill pill--pending">pending</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <Wordmark />
          <nav className="site-nav" aria-label="Primary">
            <a href="#how">How it works</a>
            <a href="#local">Local-first</a>
            <a href="#pricing">Pricing</a>
            <a href="https://github.com/badapplesdotdev/gtm-grid">GitHub</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="container hero__grid">
            <div>
              <span className="eyebrow">local-first · programmable</span>
              <h1>
                Every column is a <span className="accent">function</span>.
              </h1>
              <p className="hero__lede">
                GTM Grid is a programmable spreadsheet for go-to-market teams.
                Rows are leads, companies, posts. Columns are functions — a manual
                value, an AI prompt, or a connector call. Template inputs with{" "}
                <code>{"{{Column Name}}"}</code>, hit run, and watch cells fill
                pending → running → done.
              </p>
              <div className="hero__cta">
                <DownloadButton />
                <a className="btn btn--ghost" href="#how">
                  See how it works
                </a>
              </div>
              <p className="hero__note">
                runs on your machine — SQLite engine, QuickJS sandbox, bring your own AI key.{" "}
                <a className="hero__note-link" href="/download">All platforms &amp; versions →</a>
              </p>
            </div>
            <MiniGrid />
          </div>
        </section>

        <section className="section" id="how">
          <div className="container">
            <div className="section__head">
              <span className="eyebrow">how it works</span>
              <h2>A spreadsheet that computes.</h2>
              <p>
                No glue scripts, no brittle automations. Define each column once as
                a function, and the grid recomputes the rows that depend on it.
              </p>
            </div>
            <div className="features">
              <article className="card">
                <FunctionIcon className="card__icon" />
                <h3>Functional columns</h3>
                <p>
                  Each column is a manual value, an <code>ai.generate</code> prompt,
                  or a connector call like <code>trigify.enrichProfile</code>. Inputs
                  template off other columns with <code>{"{{name}}"}</code>.
                </p>
              </article>
              <article className="card">
                <TerminalIcon className="card__icon" />
                <h3>In-app agent</h3>
                <p>
                  Drive your grid in plain language. Ask the built-in Claude Code /
                  Codex agent to create a table, add columns, and run them — over
                  MCP, live.
                </p>
              </article>
              <article className="card">
                <PlugIcon className="card__icon" />
                <h3>Declarative connectors</h3>
                <p>
                  Enrichment and outreach providers ship as manifests. Connect a
                  key once, then call <code>leadmagic.findEmail</code> from any cell.
                </p>
              </article>
              <article className="card">
                <GridIcon className="card__icon" />
                <h3>Honest status</h3>
                <p>
                  Cells are literal: <code>pending</code>, <code>running</code>,{" "}
                  <code>done</code>, or an error with its <code>Status Code: 200</code>.
                  Un-run functions read <code>—</code>.
                </p>
              </article>
              <article className="card">
                <WebhookIcon className="card__icon" />
                <h3>Inbound webhooks</h3>
                <p>
                  Give a table a unique POST endpoint. Map incoming JSON to columns,
                  auto-run the functions, and watch deliveries arrive in real time.
                </p>
              </article>
              <article className="card">
                <ShieldIcon className="card__icon" />
                <h3>Your keys, your machine</h3>
                <p>
                  AI keys and connector secrets are AES-256-GCM encrypted and never
                  leave the device. The execution sandbox runs locally — always.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className="section" id="local">
          <div className="container split">
            <div>
              <span className="eyebrow">local-first guarantee</span>
              <h2 style={{ marginTop: "var(--space-4)", fontSize: "clamp(26px, 3.4vw, 34px)" }}>
                Free and offline by default.
              </h2>
              <p style={{ marginTop: "var(--space-5)", color: "var(--text-muted)", fontSize: 16 }}>
                The solo tier is 100% local — a bundled SQLite engine, no caps, no
                account required. Upgrade for a team and only your schema and row
                data sync; keys and execution stay put.
              </p>
              <ul className="guarantee">
                <li>
                  <TickIcon className="tick" />
                  <span>Keys, connector secrets, and the sandbox never leave the machine.</span>
                </li>
                <li>
                  <TickIcon className="tick" />
                  <span>Bundled SQLite storage — works fully offline, no caps.</span>
                </li>
                <li>
                  <TickIcon className="tick" />
                  <span>Cloud sync (Pro) shares schema + rows only; execution still runs local.</span>
                </li>
              </ul>
            </div>
            <div className="mini-grid" style={{ padding: "var(--space-8)" }}>
              <p className="eyebrow" style={{ marginBottom: "var(--space-5)" }}>what stays local</p>
              <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: 1.8 }}>
{`ai.key            local · encrypted
connector.secret  local · encrypted
quickjs.sandbox   local
table.schema      sync (pro)
table.rows        sync (pro)`}
              </pre>
            </div>
          </div>
        </section>

        <section className="section" id="pricing">
          <div className="container split">
            <div className="section__head" style={{ marginBottom: 0 }}>
              <span className="eyebrow">open-core</span>
              <h2>Two tiers. No surprises.</h2>
              <p>
                Start solo and local for free. Move to the cloud when your team
                needs realtime multiplayer — billed per seat.
              </p>
            </div>
            <div className="tiers">
              <div className="tier">
                <div className="tier__name">
                  <h3>Local solo</h3>
                  <span className="tag">free</span>
                </div>
                <p>
                  100% local and offline. Bundled SQLite engine, QuickJS sandbox,
                  bring your own AI key. No caps, no account.
                </p>
              </div>
              <div className="tier tier--featured">
                <div className="tier__name">
                  <h3>Cloud team</h3>
                  <span className="tag">per seat</span>
                </div>
                <p>
                  Realtime multiplayer via Convex, shared connections, inbound
                  webhooks. Execution always stays local on your engine.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container site-footer__inner">
          <Wordmark />
          <nav aria-label="Footer">
            <a href="#how">How it works</a>
            <a href="#local">Local-first</a>
            <a href="#pricing">Pricing</a>
            <a href="https://github.com/badapplesdotdev/gtm-grid">GitHub</a>
          </nav>
          <small>local-first programmable gtm spreadsheet</small>
        </div>
      </footer>
    </>
  );
}
