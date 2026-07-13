// Static, server-rendered sections of the marketing homepage. These hold no
// client state — they're the design handoff (gtm-grid/Website.html) expressed as
// JSX so the whole page is in the SSR HTML. Interactive pieces are delegated to
// client components (HeroApp, Nav, QuickStart, Pricing, Faq, DownloadCTA,
// CopyButton); connector data comes from the real catalog in connectors.ts.

import { CONNECTORS, CONNECTOR_COUNT } from "./connectors";
import { DownloadCTA } from "./DownloadCTA";
import { CopyButton } from "./CopyButton";
import { Favicon } from "./Favicon";
import { HeroApp } from "./HeroApp";
import { BellIcon, Check, ClaudeMark, CodexMark, GitHubMark } from "./icons";

const REPO = "https://github.com/badapplesdotdev/gtm-grid";
const CLONE_CMD = "git clone https://github.com/badapplesdotdev/gtm-grid.git";

/* ─────────────────────────── Hero ─────────────────────────── */
export function Hero({ version }: { version: string }) {
  return (
    <header className="hero">
      <div className="hero-bg" aria-hidden="true">
        {/* Grid + circuit share ONE coordinate space (the 1440×560 viewBox, sliced
            to fill) so the traces always sit exactly on the grid lines. The grid is
            a 48-unit pattern; every rail/trace/signal bend lands on a multiple of
            48, so the circuit reads as etched onto the graph paper at any size. */}
        <svg className="circuit" viewBox="0 0 1440 560" preserveAspectRatio="xMidYMid slice">
          <defs>
            <pattern id="gl-grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path className="gl-line" d="M48 0H0V48" />
            </pattern>
          </defs>
          <rect className="gl-grid-fill" x="0" y="0" width="1440" height="560" fill="url(#gl-grid)" />
          <path className="rail" d="M0 96 H1440" />
          <path className="rail" d="M0 480 H1440" />
          <path className="trace" d="M0 144 H240 V288 H432" />
          <path className="trace" d="M0 336 H144 V432 H336 V528" />
          <path className="trace" d="M240 0 V144 H432" />
          <path className="trace" d="M1440 144 H1200 V288 H1056" />
          <path className="trace" d="M1440 384 H1296 V480 H1104 V528" />
          <path className="trace" d="M1200 0 V192 H1008" />
          <g className="signals">
            <path className="signal" pathLength={1000} d="M0 96 H1440" style={{ animationDuration: "9s" }} />
            <path className="signal" pathLength={1000} d="M1440 480 H0" style={{ animationDuration: "11s", animationDelay: "-4s" }} />
            <path className="signal" pathLength={1000} d="M0 144 H240 V288 H432" style={{ animationDuration: "6.5s", animationDelay: "-2s" }} />
            <path className="signal" pathLength={1000} d="M1440 144 H1200 V288 H1056" style={{ animationDuration: "7.5s", animationDelay: "-3s" }} />
          </g>
        </svg>
      </div>
      <div className="wrap">
        <span className="hero-badge">
          <span className="pill">v{version} · macOS</span>
          Source-available. Self-host free. Bring your own keys.
        </span>
        <h1 id="hero-headline">
          The headless GTM <span className="accent">engine.</span>
        </h1>
        <p className="hero-lead">
          Grid is the headless GTM engine that runs your go-to-market programmatically. Enrich, score, route, and sync every record from <code>Claude Code</code>, MCP, the CLI, or a REST call — with a live grid so you always see what&rsquo;s running.
        </p>
        <div className="hero-cta">
          <DownloadCTA size="lg" />
          <a className="btn btn-outline btn-lg" href={REPO}>
            <GitHubMark />
            GitHub
          </a>
        </div>
        <div className="hero-sub">
          <span><Check className="ck" width={15} height={15} strokeWidth="2.5" /> Headless: MCP · CLI · REST</span>
          <span><Check className="ck" width={15} height={15} strokeWidth="2.5" /> Driven by Claude Code or Codex</span>
          <span><Check className="ck" width={15} height={15} strokeWidth="2.5" /> A live grid to watch it run</span>
        </div>
        <HeroApp />
      </div>
    </header>
  );
}

/* ─────────────────────────── Connector marquee ─────────────────────────── */
function MarqueeTrack({ id, ariaHidden }: { id: string; ariaHidden?: boolean }) {
  return (
    <div className="marquee-track" id={id} aria-hidden={ariaHidden}>
      {CONNECTORS.slice(0, 11).map((c) => (
        <span className="marq-item" key={c.name}>
          <Favicon
            domain={c.domain}
            mono={c.mono}
            className="marq-fav conn-ico"
            wrapperStyle={{ border: "none", background: "transparent" }}
            fallbackStyle={{ width: 22, height: 22, borderRadius: 5, background: "var(--accent-bg)", display: "flex", alignItems: "center", justifyContent: "center" }}
          />
          {c.name}
        </span>
      ))}
    </div>
  );
}
export function Marquee() {
  return (
    <div className="marquee-band">
      <div className="marquee-lab">One declarative manifest each. Works with the tools you already pay for.</div>
      <div className="marquee">
        <MarqueeTrack id="marq-a" />
        <MarqueeTrack id="marq-b" ariaHidden />
      </div>
    </div>
  );
}

/* ─────────────────────────── Surfaces ─────────────────────────── */
export function Surfaces() {
  return (
    <section className="band surfaces-band" id="surfaces">
      <div className="wrap">
        <div className="sec-head center">
          <span className="eyebrow"><span className="dot" />Headless by design</span>
          <h2>One engine. <span className="accent">Every surface.</span></h2>
          <p>Grid is a headless engine — your data, function columns, and connectors live in one place and run the same way no matter how you reach them. Drive it from the surface that fits the job, or all of them at once.</p>
        </div>
        <div className="surf-grid">
          <article className="surf-card">
            <div className="surf-visual surf-agents">
              <span className="surf-tile claude"><ClaudeMark /></span>
              <span className="surf-tile codex"><CodexMark /></span>
              <span className="surf-tile cursor">
                <Favicon domain="cursor.com" mono="Cu" className="" imgStyle={{ width: 30, height: 30, borderRadius: 7 }} />
              </span>
            </div>
            <div className="surf-body">
              <h3>Any agent <span className="surf-badge">Claude · Codex · Cursor</span></h3>
              <p>Point Claude Code, Codex, or Cursor at Grid and describe the outcome — it builds tables, adds columns, and runs them through the MCP server while you watch.</p>
            </div>
          </article>

          <article className="surf-card">
            <div className="surf-visual surf-connectors" id="surf-conn">
              {CONNECTORS.slice(0, 12).map((c) => (
                <Favicon key={c.name} domain={c.domain} mono={c.mono} className="surf-logo" />
              ))}
            </div>
            <div className="surf-body">
              <h3>Pre-mapped, or anything <span className="surf-badge">{CONNECTOR_COUNT}+ connectors</span></h3>
              <p>Use the tools we&rsquo;ve already mapped, or connect anything with one JSON manifest — it becomes an SDK call, an MCP tool, and a UI form.</p>
            </div>
          </article>

          <article className="surf-card">
            <div className="surf-visual surf-mockwrap">
              <div className="surf-mini">
                <div className="smini-row smini-head"><span>Name</span><span>Title</span><span>Fit</span></div>
                <div className="smini-row"><span>Alex Rivera</span><span>Head of Growth</span><span className="smini-pill ok">200</span></div>
                <div className="smini-row"><span>Maya Chen</span><span>VP Sales</span><span className="smini-pill ok">200</span></div>
                <div className="smini-row"><span>Sam Delgado</span><span className="smini-run"><span className="smini-spin" />running</span><span>—</span></div>
              </div>
            </div>
            <div className="surf-body">
              <h3>A live grid</h3>
              <p>Watch every row move <span className="surf-mono">pending → running → done</span>, with JSON collapsing into a clickable 200 pill.</p>
            </div>
          </article>

          <article className="surf-card">
            <div className="surf-visual surf-mockwrap">
              <div className="surf-term">
                <span className="st"><span className="st-p">$</span> grid run Founders --col Fit</span>
                <span className="st st-ok">✓ 7/7 done · wrote to Founders</span>
                <span className="st st-dim">POST /v1/columns/Fit/run</span>
                <span className="st st-dim">mcp ▸ run_column &quot;Fit&quot;</span>
                <span className="st st-dim">webhook ▸ row.created → enrich</span>
              </div>
            </div>
            <div className="surf-body">
              <h3>CLI · MCP · REST · Webhooks</h3>
              <p>Call the same engine from a terminal, an MCP client, a REST endpoint, or an inbound webhook — no UI required.</p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── How it works ─────────────────────────── */
export function HowItWorks() {
  return (
    <section className="band" id="how">
      <div className="wrap">
        <div className="split">
          <div className="sec-head">
            <span className="eyebrow"><span className="dot" />The engine</span>
            <h2>Cells carry a status, not just a value.</h2>
            <p>Every column is a function — <span className="tok">ai.generate</span>, an enrichment connector, anything. Grid resolves <span className="tok">{"{{Column Name}}"}</span> templates per row and runs them with bounded concurrency — whether you hit Run, call the API, or let an agent drive.</p>
            <div className="steps">
              <div className="step">
                <span className="step-n">1</span>
                <div className="step-tx"><h4>Add a column</h4><p>Manual text, number, boolean, date, or JSON — or make it a function column.</p></div>
              </div>
              <div className="step">
                <span className="step-n">2</span>
                <div className="step-tx"><h4>Pick a function</h4><p><span className="tok">ai.generate</span>, <span className="tok">github.getUser</span>, or any connector method like <span className="tok">trigify.enrich</span>.</p></div>
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
              <div className="code">
                <span className="c">{"// resolves per row, bounded concurrency"}</span>{"\n"}
                <span className="k">fn</span>{" Title = trigify."}<span className="k">enrich</span>{"({\n  profile: "}<span className="tok" style={{ background: "var(--accent-bg)" }}>{"{{LinkedIn URL}}"}</span>{",\n  fields: ["}<span className="s">&quot;title&quot;</span>{", "}<span className="s">&quot;seniority&quot;</span>{"]\n})\n\n"}
                <span className="c">{"// row 1 →"}</span>{"  "}<span className="s">&quot;Head of Growth&quot;</span>{"\n"}
                <span className="c">{"// row 2 →"}</span>{"  "}<span className="s">&quot;VP Sales&quot;</span>{"\n"}
                <span className="c">{"// row 3 →"}</span>{"  Status Code: "}<span className="s">200</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Connectors wall ─────────────────────────── */
export function ConnectorsWall() {
  return (
    <section className="band" id="connectors">
      <div className="wrap">
        <div className="sec-head center">
          <span className="eyebrow"><span className="dot" />Extensions</span>
          <h2>{CONNECTOR_COUNT}+ connectors. Zero glue code.</h2>
          <p>Every connector is one JSON manifest — a <span className="tok">baseUrl</span>, <span className="tok">auth</span>, and <span className="tok">methods</span>. That single file becomes an <span className="mono" style={{ color: "var(--text)" }}>sdk</span> call, an MCP tool, and a UI form. Bring your own keys; credentials are encrypted and scoped.</p>
        </div>
        <div className="conn-grid" id="conn-grid">
          {CONNECTORS.map((c) => (
            <div className={`conn-card${c.featured ? " featured" : ""}`} key={c.name}>
              <Favicon domain={c.domain} mono={c.mono} />
              <div className="conn-meta">
                <div className="conn-name-row">
                  <span className="conn-name">
                    {c.name}
                    {c.featured && <span className="feat-tag">Featured</span>}
                  </span>
                </div>
                <div className="conn-count"><span className="num">{c.methods}</span> methods</div>
              </div>
            </div>
          ))}
          <div className="conn-card custom">
            <span className="conn-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            </span>
            <div className="conn-meta">
              <div className="conn-name-row"><span className="conn-name">Custom HTTP</span></div>
              <div className="conn-count">Any REST API — one JSON manifest</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Agent panel ─────────────────────────── */
export function AgentPanel() {
  return (
    <section className="band" id="agent">
      <div className="wrap">
        <div className="sec-head">
          <span className="eyebrow"><span className="dot" />Headless control</span>
          <h2>Drive it from your agent.</h2>
          <p>Your agents can build anything you want. Point Claude Code, Codex, or Cursor at Grid, describe the outcome, and they use your pre-mapped connectors — or connect anything new — to build tables, add columns, and fill rows while you watch. It all runs on the <b style={{ color: "var(--text)", fontWeight: 600 }}>subscription you already pay for</b> — no API keys, no per-token bill.</p>
        </div>
        <div className="agent-demo">
          <div className="agent-left">
            <span className="eyebrow">You type</span>
            <div className="agent-prompt">Using <span className="var">grid</span>, create a table of these 10 founders and enrich each with their GitHub bio and company headcount.</div>
            <div className="agent-points">
              <div className="agent-point">
                <Check strokeWidth="2" />
                <span><b>Build anything you want.</b> Your agent uses Grid&rsquo;s pre-mapped connectors — or connects anything new — to build tables, add columns, and enrich rows.</span>
              </div>
              <div className="agent-point">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" /></svg>
                <span><b>Real-time.</b> Rows fill in the grid as the agent calls tools — you see every status flip.</span>
              </div>
              <div className="agent-point">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>
                <span><b>Three agents, one surface.</b> Claude Code, Codex, and Cursor — on the subscription you already pay for, no API keys.</span>
              </div>
            </div>
          </div>
          <div className="agent-panel-mock">
            <div className="apm-tabs">
              <span className="apm-tab active"><ClaudeMark />Claude Code</span>
              <span className="apm-tab off"><CodexMark />Codex</span>
              <span className="apm-tab off">
                <Favicon domain="cursor.com" mono="Cu" className="" imgStyle={{ width: 14, height: 14, borderRadius: 3, display: "block" }} />
                Cursor
              </span>
            </div>
            <div className="apm-stream">
              <div><span className="apm-role">You</span></div>
              <div className="apm-msg-user">Add a column that scores GTM fit 0–100 and run it.</div>
              <div className="apm-tool"><span className="d" />create_column <span className="args">name=&quot;Fit&quot; fn=&quot;ai.generate&quot;</span></div>
              <div className="apm-tool"><span className="d" />run_column <span className="args">&quot;Fit&quot; · 7 rows</span></div>
              <div className="apm-result">✓ 7/7 done · 1 credit/row · wrote to Founders</div>
              <div className="apm-asst">Done. &quot;Fit&quot; is live on all 7 rows — top match is Sam Delgado at Clay (96). Want me to sort descending?</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Self-host vs Cloud ─────────────────────────── */
export function LocalCloud() {
  return (
    <section className="band" id="local">
      <div className="wrap">
        <div className="sec-head center">
          <span className="eyebrow"><span className="dot" />Source-available</span>
          <h2>Free to self-host. <span className="accent">Cloud when you need it.</span></h2>
          <p>Grid is source-available and free to self-host — point it at your own Postgres, ship your own connectors, send the good ones back as a PR. Cloud is where it gets serious: managed Postgres, your whole team on the data, and every grid running while you&rsquo;re away.</p>
        </div>

        <div className="lc-grid">
          <div className="lc-card local">
            <div className="lc-head">
              <span className="lc-ico"><GitHubMark /></span>
              <span className="lc-tag">Self-host · FSL-1.1-MIT</span>
            </div>
            <h3>Self-host on your own Postgres</h3>
            <p className="lc-sub">Run the backend against a Postgres you control — a local Docker image or your own server. Your keys and execution stay on your machine, and the full source is yours to read, fork, and extend.</p>
            <ul className="lc-list">
              <li><Check /> <span><b>Unlimited</b> rows, tables &amp; function columns</span></li>
              <li><Check /> <span>Every connector — bring your own keys</span></li>
              <li><Check /> <span><b>Fork it, build connectors, open a PR</b> — features ship from the community</span></li>
              <li><Check /> <span><b>Powered by your own Claude Code or Codex</b> — AI columns run on the subscription you already pay for</span></li>
            </ul>
            <div className="lc-cta">
              <DownloadCTA label="Download free" />
              <a className="btn btn-outline" href={REPO}>
                <GitHubMark />
                Browse the source
              </a>
            </div>
          </div>

          <div className="lc-card cloud">
            <div className="lc-head">
              <span className="lc-ico">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .9-8.91 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6 19Z" /></svg>
              </span>
              <span className="lc-tag">Hosted · from $20</span>
            </div>
            <h3>Cloud, for when you step away</h3>
            <p className="lc-sub">The same grid, hosted — so it keeps running with your laptop closed, fires on incoming events, and opens up to your whole team.</p>
            <ul className="lc-list">
              <li><BellIcon /> <span><b>Runs when your computer&rsquo;s asleep</b> — scheduled refreshes keep firing</span></li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m13 2-3 7h6l-3 7" /><path d="M5 12h2M17 12h2M12 5V3M12 21v-2" /></svg>
                <span><b>Webhooks</b> — new rows enrich themselves on inbound events</span>
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                <span><b>Team access</b> — shared workspaces &amp; credentials</span>
              </li>
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                <span>Realtime multiplayer on shared grids</span>
              </li>
            </ul>
            <div className="lc-cta">
              <a className="btn btn-primary" href="#pricing">See cloud plans</a>
              <a className="btn btn-ghost" href="#pricing">From $20 / seat →</a>
            </div>
          </div>
        </div>

        <div className="lc-detail-lab">Under the hood — how it works</div>
        <div className="feat-grid">
          <div className="feat-card">
            <div className="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" /><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" /></svg></div>
            <h3>Postgres source of truth</h3>
            <p>Tables, columns, and cell history live in <code>Postgres</code> — your own self-hosted instance, or our managed cloud.</p>
          </div>
          <div className="feat-card">
            <div className="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg></div>
            <h3>Keys stay on your machine</h3>
            <p>Your connector &amp; AI keys live in a local vault, <code>AES-256-GCM</code> encrypted on disk. Execution runs locally — keys never leave your machine.</p>
          </div>
          <div className="feat-card">
            <div className="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg></div>
            <h3>Sandboxed logic</h3>
            <p>Column functions run in a <code>QuickJS</code> sandbox with a declarative HTTP layer. Predictable, bounded, no surprises.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Pricing notes (under the cards) ─────────────────────────── */
export function PricingNotes() {
  return (
    <div className="bill-notes">
      <div className="bill-note">
        <BellIcon strokeWidth="1.8" />
        <div><h5>What counts as a cloud action?</h5><p>Any run executed on our cloud instead of your machine — a function-column cell, a webhook fire, or a scheduled refresh. Runs on the desktop app are always free.</p></div>
      </div>
      <div className="bill-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
        <div><h5>Metered by actions, not rows</h5><p>Each member is one seat. Allowances are per seat and pool across the workspace. Rows, tables, and connectors are never capped — only cloud actions are.</p></div>
      </div>
      <div className="bill-note">
        <GitHubMark />
        <div><h5>Self-hosting is always free</h5><p>Source-available under FSL-1.1-MIT, unlimited on your own Postgres. Cloud is purely additive — for when grids need to run without you.</p></div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Final CTA ─────────────────────────── */
export function FinalCTA() {
  return (
    <section className="cta-band" id="download">
      <div className="wrap">
        <h2>Run your go-to-market <br /><span className="accent">headless.</span></h2>
        <p>Install Grid, point it at your keys, and drive your first grid from Claude Code, the CLI, or an API call in minutes.</p>
        <div className="cta-cmd">
          <span className="prompt">$</span>
          <span>{CLONE_CMD}</span>
          <CopyButton text={CLONE_CMD} />
        </div>
        <div className="cta-cta">
          <DownloadCTA size="lg" />
          <a className="btn btn-outline btn-lg" href={REPO}>Read the docs</a>
        </div>
      </div>
    </section>
  );
}

/* ─────────────────────────── Footer ─────────────────────────── */
export function Footer({ version }: { version: string }) {
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="footer-brand">
          <a className="brand" href="#top" aria-label="Grid — home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-logo" src="/brand/logo.svg" alt="GTM Grid" style={{ height: 24, width: "auto", display: "block" }} />
          </a>
          <p className="footer-tag">The headless GTM engine — programmable, source-available, every column a function.</p>
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
          <a href={REPO}>GitHub</a>
          <a href={`${REPO}/tree/main/packages/cli`}>CLI</a>
          <a href={`${REPO}/tree/main/packages/mcp`}>MCP server</a>
          <a href={`${REPO}/tree/main/extensions`}>Connector manifests</a>
        </div>
        <div className="foot-col">
          <h5>Company</h5>
          <a href={`${REPO}/releases`}>Changelog</a>
          <a href="/download">Download</a>
          <a href="/docs/attio">Attio integration</a>
          <a href="/terms">Terms</a>
          <a href={`${REPO}/blob/main/LICENSE`}>License</a>
        </div>
      </div>
      <div className="footer-bottom">
        <div className="wrap">
          <span>© 2026 Grid</span>
          <span className="mono">v{version} · FSL-1.1-MIT</span>
        </div>
      </div>
    </footer>
  );
}
