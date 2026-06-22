// GENERATED — verbatim body of the Claude Design handoff (gtm-grid/Website.html),
// the .page element. Rendered via dangerouslySetInnerHTML under a .gtm-home wrapper
// in page.tsx; all interactivity is ported to HomeClient.tsx. Do not hand-edit.
export const PAGE_HTML = String.raw`<div class="page">

<!-- ───────────────────────── Nav ───────────────────────── -->
<nav class="nav" id="nav">
  <div class="wrap">
    <a class="brand" href="#top" aria-label="Grid — home">
      <svg class="brand-mark" viewBox="0 0 213 203" fill="none" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M62.9001 0.959961H171.36L140.37 54.6299H31.9102L62.9001 0.959961Z" fill="#22c55e"/>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M86.1399 148.56H181.1L150.11 202.24H55.1499L0.919922 108.31L31.9099 54.6299L86.1399 148.56Z" fill="#22c55e"/>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M212.09 94.8899L181.1 148.57L157.86 108.31H109.38L140.37 54.6299H188.85L212.09 94.8899Z" fill="#22c55e"/>
      </svg>
      <span class="brand-name">Grid</span>
    </a>
    <div class="nav-links">
      <a class="nav-link" href="#how">How it works</a>
      <a class="nav-link" href="#surfaces">Surfaces</a>
      <a class="nav-link" href="#connectors">Connectors</a>
      <a class="nav-link" href="#agent">Agent</a>
      <a class="nav-link" href="#local">Open source</a>
      <a class="nav-link" href="#pricing">Pricing</a>
    </div>
    <div class="nav-actions">
      <a class="btn btn-ghost" href="https://github.com/maxtrigify/gtm-grid">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"></path></svg>
        15.2k
        <span class="star-count">Open source</span>
      </a>
      <a class="btn btn-primary" href="#download">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>
        Download
      </a>
    </div>
  </div>
</nav>

<a id="top"></a>

<!-- ───────────────────────── Hero ───────────────────────── -->
<header class="hero">
  <div class="hero-bg" aria-hidden="true">
    <div class="gl-grid"></div>
    <svg class="circuit" viewBox="0 0 1440 560" preserveAspectRatio="xMidYMid slice">
      <!-- long rails carry travelling signals -->
      <path class="rail" d="M-40 64 H1480"></path>
      <path class="rail" d="M-40 498 H1480"></path>
      <!-- circuit traces feeding toward the centre -->
      <path class="trace" d="M-30 92 H250 V220 H392"></path>
      <path class="trace" d="M-30 300 H150 V410 H330 V540"></path>
      <path class="trace" d="M250 -20 V140 H430"></path>
      <path class="trace" d="M1470 110 H1200 V250 H1060"></path>
      <path class="trace" d="M1470 330 H1300 V450 H1110 V540"></path>
      <path class="trace" d="M1190 -20 V170 H1010"></path>
      <!-- travelling signals (thin lines, not dots) -->
      <g class="signals">
        <path class="signal" pathLength="1000" d="M-40 64 H1480" style="animation-duration:9s"></path>
        <path class="signal" pathLength="1000" d="M1480 498 H-40" style="animation-duration:11s;animation-delay:-4s"></path>
        <path class="signal" pathLength="1000" d="M-30 92 H250 V220 H392" style="animation-duration:6.5s;animation-delay:-2s"></path>
        <path class="signal" pathLength="1000" d="M1470 110 H1200 V250 H1060" style="animation-duration:7.5s;animation-delay:-3s"></path>
      </g>
    </svg>
  </div>
  <div class="wrap">
    <span class="hero-badge">
      <span class="pill">v0.4 · macOS</span>
      Local-first. Open source. No pricing gate.
    </span>
    <h1 id="hero-headline">The headless GTM <span class="accent">engine.</span></h1>
    <p class="hero-lead">
      Grid is the headless GTM engine that runs your go-to-market programmatically. Enrich, score, route, and sync every record from <code>Claude Code</code>, MCP, the CLI, or a REST call — with a live grid so you always see what’s running.
    </p>
    <div class="hero-cta">
      <a class="btn btn-primary btn-lg" href="#download">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.7-2.1c.9-1.2 1.2-2.4 1.3-2.5-.1 0-2.4-1-2.4-3.6zM14.3 5.4c.6-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.2-.5 2.8-1.3z"/></svg>
        Download for macOS
      </a>
      <a class="btn btn-outline btn-lg" href="https://github.com/maxtrigify/gtm-grid">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"></path></svg>
        15.2k
        <span class="star-count">Open source</span>
      </a>
    </div>
    <div class="hero-sub">
      <span><svg class="ck" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Headless: MCP · CLI · REST</span>
      <span><svg class="ck" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Driven by Claude Code or Codex</span>
      <span><svg class="ck" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> A live grid to watch it run</span>
    </div>

    <!-- live app window — ask Claude Code, watch it enrich the grid -->
    <div class="frame-shell">
      <div class="frame-glow"></div>
      <div class="window hero-app" id="hero-app">
        <div class="win-bar">
          <div class="traffic"><i></i><i></i><i></i></div>
          <div class="win-title">Founders <span class="meta">· 7 rows · 5 cols</span></div>
          <span class="win-online">online</span>
          <span class="win-run" id="win-run"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span class="runtxt">Run</span></span>
        </div>
        <div class="hero-app-body">
          <div class="hero-grid-pane">
            <div id="live-grid"></div>
          </div>
          <aside class="hero-agent" aria-label="Claude Code agent panel">
            <div class="ha-tabs">
              <span class="ha-tab active">
                <svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#D97757" stroke-width="1.9" stroke-linecap="round"><line x1="3.8" y1="12" x2="20.2" y2="12"/><line x1="4.9" y1="7.9" x2="19.1" y2="16.1"/><line x1="7.9" y1="4.9" x2="16.1" y2="19.1"/><line x1="12" y1="3.8" x2="12" y2="20.2"/><line x1="16.1" y1="4.9" x2="7.9" y2="19.1"/><line x1="19.1" y1="7.9" x2="4.9" y2="16.1"/></g></svg>
                Claude Code
              </span>
              <span class="ha-tab off">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 17.42a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 18.95a4.5 4.5 0 0 1-6.14-1.53zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973v5.677a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856L13.104 8.36l2.015-1.16a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.677a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08-4.778 2.759a.795.795 0 0 0-.393.68zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"></path></svg>
                Codex
              </span>
              <span class="ha-tab off">
                <img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=128" alt="Cursor" width="14" height="14" style="border-radius:3px;display:block">
                Cursor
              </span>
            </div>
            <div class="ha-ctx"><span class="ha-ctx-dot"></span>Context: <strong>Founders</strong> · MCP connected</div>
            <div class="ha-stream" id="ha-stream"></div>
            <div class="ha-input">
              <div class="ha-input-text" id="ha-input-text"><span class="ha-ph">Message Claude Code…</span></div>
              <button class="ha-send" id="ha-send" tabindex="-1" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </div>
</header>

<!-- ───────────────────────── Connector marquee ───────────────────────── -->
<div class="marquee-band">
  <div class="marquee-lab">One declarative manifest each. Works with the tools you already pay for.</div>
  <div class="marquee">
    <div class="marquee-track" id="marq-a"></div>
    <div class="marquee-track" id="marq-b" aria-hidden="true"></div>
  </div>
</div>

<!-- ───────────────────────── Surfaces (headless) ───────────────────────── -->
<section class="band surfaces-band" id="surfaces">
  <div class="wrap">
    <div class="sec-head center">
      <span class="eyebrow"><span class="dot"></span>Headless by design</span>
      <h2>One engine. <span class="accent">Every surface.</span></h2>
      <p>Grid is a headless engine — your data, function columns, and connectors live in one place and run the same way no matter how you reach them. Drive it from the surface that fits the job, or all of them at once.</p>
    </div>
    <div class="surf-grid">
      <article class="surf-card">
        <div class="surf-visual surf-agents">
          <span class="surf-tile claude"><svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#D97757" stroke-width="1.9" stroke-linecap="round"><line x1="3.8" y1="12" x2="20.2" y2="12"/><line x1="4.9" y1="7.9" x2="19.1" y2="16.1"/><line x1="7.9" y1="4.9" x2="16.1" y2="19.1"/><line x1="12" y1="3.8" x2="12" y2="20.2"/><line x1="16.1" y1="4.9" x2="7.9" y2="19.1"/><line x1="19.1" y1="7.9" x2="4.9" y2="16.1"/></g></svg></span>
          <span class="surf-tile codex"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 17.42a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 18.95a4.5 4.5 0 0 1-6.14-1.53zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973v5.677a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856L13.104 8.36l2.015-1.16a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.677a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08-4.778 2.759a.795.795 0 0 0-.393.68zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"/></svg></span>
          <span class="surf-tile cursor"><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=128" alt="Cursor" width="30" height="30" style="border-radius:7px"></span>
        </div>
        <div class="surf-body">
          <h3>Any agent <span class="surf-badge">Claude · Codex · Cursor</span></h3>
          <p>Point Claude Code, Codex, or Cursor at Grid and describe the outcome — it builds tables, adds columns, and runs them through the MCP server while you watch.</p>
        </div>
      </article>

      <article class="surf-card">
        <div class="surf-visual surf-connectors" id="surf-conn"></div>
        <div class="surf-body">
          <h3>Pre-mapped, or anything <span class="surf-badge">22 connectors</span></h3>
          <p>Use the tools we've already mapped, or connect anything with one JSON manifest — it becomes an SDK call, an MCP tool, and a UI form.</p>
        </div>
      </article>

      <article class="surf-card">
        <div class="surf-visual surf-mockwrap">
          <div class="surf-mini">
            <div class="smini-row smini-head"><span>Name</span><span>Title</span><span>Fit</span></div>
            <div class="smini-row"><span>Alex Rivera</span><span>Head of Growth</span><span class="smini-pill ok">200</span></div>
            <div class="smini-row"><span>Maya Chen</span><span>VP Sales</span><span class="smini-pill ok">200</span></div>
            <div class="smini-row"><span>Sam Delgado</span><span class="smini-run"><span class="smini-spin"></span>running</span><span>—</span></div>
          </div>
        </div>
        <div class="surf-body">
          <h3>A live grid</h3>
          <p>Watch every row move <span class="surf-mono">pending → running → done</span>, with JSON collapsing into a clickable 200 pill.</p>
        </div>
      </article>

      <article class="surf-card">
        <div class="surf-visual surf-mockwrap">
          <div class="surf-term">
            <span class="st"><span class="st-p">$</span> grid run Founders --col Fit</span>
            <span class="st st-ok">✓ 7/7 done · wrote to Founders</span>
            <span class="st st-dim">POST /v1/columns/Fit/run</span>
            <span class="st st-dim">mcp ▸ run_column "Fit"</span>
            <span class="st st-dim">webhook ▸ row.created → enrich</span>
          </div>
        </div>
        <div class="surf-body">
          <h3>CLI · MCP · REST · Webhooks</h3>
          <p>Call the same engine from a terminal, an MCP client, a REST endpoint, or an inbound webhook — no UI required.</p>
        </div>
      </article>
    </div>
  </div>
</section>

<!-- ───────────────────────── How it works ───────────────────────── -->
<section class="band" id="how">
  <div class="wrap">
    <div class="split">
      <div class="sec-head">
        <span class="eyebrow"><span class="dot"></span>The engine</span>
        <h2>Cells carry a status, not just a value.</h2>
        <p>Every column is a function — <span class="tok">ai.generate</span>, an enrichment connector, anything. Grid resolves <span class="tok">{{Column Name}}</span> templates per row and runs them with bounded concurrency — whether you hit Run, call the API, or let an agent drive.</p>
        <div class="steps">
          <div class="step">
            <span class="step-n">1</span>
            <div class="step-tx"><h4>Add a column</h4><p>Manual text, number, boolean, date, or JSON — or make it a function column.</p></div>
          </div>
          <div class="step">
            <span class="step-n">2</span>
            <div class="step-tx"><h4>Pick a function</h4><p><span class="tok">ai.generate</span>, <span class="tok">github.getUser</span>, or any connector method like <span class="tok">trigify.enrich</span>.</p></div>
          </div>
          <div class="step">
            <span class="step-n">3</span>
            <div class="step-tx"><h4>Run</h4><p>Every row resolves in parallel: <span class="mono" style="color:var(--text-3)">pending → running → done</span>. JSON results collapse into a clickable <span class="mono" style="color:var(--success-ink)">200</span> pill.</p></div>
          </div>
        </div>
      </div>
      <div class="demo-card">
        <div class="demo-card-bar"><div class="traffic"><i></i><i></i><i></i></div><span style="margin-left:6px">Title · function column</span></div>
        <div class="demo-body">
<div class="code"><span class="c">// resolves per row, bounded concurrency</span>
<span class="k">fn</span> Title = trigify.<span class="k">enrich</span>({
  profile: <span class="tok" style="background:var(--accent-bg)">{{LinkedIn URL}}</span>,
  fields: [<span class="s">"title"</span>, <span class="s">"seniority"</span>]
})

<span class="c">// row 1 →</span>  <span class="s">"Head of Growth"</span>
<span class="c">// row 2 →</span>  <span class="s">"VP Sales"</span>
<span class="c">// row 3 →</span>  Status Code: <span class="s">200</span></div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ───────────────────────── Connectors wall ───────────────────────── -->
<section class="band" id="connectors">
  <div class="wrap">
    <div class="sec-head center">
      <span class="eyebrow"><span class="dot"></span>Extensions</span>
      <h2>22 connectors. Zero glue code.</h2>
      <p>Every connector is one JSON manifest — a <span class="tok">baseUrl</span>, <span class="tok">auth</span>, and <span class="tok">methods</span>. That single file becomes an <span class="mono" style="color:var(--text)">sdk</span> call, an MCP tool, and a UI form. Bring your own keys; credentials are encrypted and scoped.</p>
    </div>
    <div class="conn-grid" id="conn-grid"></div>
  </div>
</section>

<!-- ───────────────────────── Agent panel ───────────────────────── -->
<section class="band" id="agent">
  <div class="wrap">
    <div class="sec-head">
      <span class="eyebrow"><span class="dot"></span>Headless control</span>
      <h2>Drive it from your agent.</h2>
      <p>Your agents can build anything you want. Point Claude Code, Codex, or Cursor at Grid, describe the outcome, and they use your pre-mapped connectors — or connect anything new — to build tables, add columns, and fill rows while you watch. It all runs on the <b style="color:var(--text);font-weight:600">subscription you already pay for</b> — no API keys, no per-token bill.</p>
    </div>
    <div class="agent-demo">
      <div class="agent-left">
        <span class="eyebrow">You type</span>
        <div class="agent-prompt">Using <span class="var">grid</span>, create a table of these 10 founders and enrich each with their GitHub bio and company headcount.</div>
        <div class="agent-points">
          <div class="agent-point">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span><b>Build anything you want.</b> Your agent uses Grid’s pre-mapped connectors — or connects anything new — to build tables, add columns, and enrich rows.</span>
          </div>
          <div class="agent-point">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            <span><b>Real-time.</b> Rows fill in the grid as the agent calls tools — you see every status flip.</span>
          </div>
          <div class="agent-point">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            <span><b>Three agents, one surface.</b> Claude Code, Codex, and Cursor — on the subscription you already pay for, no API keys.</span>
          </div>
        </div>
      </div>
      <div class="agent-panel-mock">
        <div class="apm-tabs">
          <span class="apm-tab active">
            <svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#D97757" stroke-width="1.9" stroke-linecap="round"><line x1="3.8" y1="12" x2="20.2" y2="12"/><line x1="4.9" y1="7.9" x2="19.1" y2="16.1"/><line x1="7.9" y1="4.9" x2="16.1" y2="19.1"/><line x1="12" y1="3.8" x2="12" y2="20.2"/><line x1="16.1" y1="4.9" x2="7.9" y2="19.1"/><line x1="19.1" y1="7.9" x2="4.9" y2="16.1"/></g></svg>
            Claude Code
          </span>
          <span class="apm-tab off">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 17.42a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 18.95a4.5 4.5 0 0 1-6.14-1.53zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973v5.677a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856L13.104 8.36l2.015-1.16a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.677a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08-4.778 2.759a.795.795 0 0 0-.393.68zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z"></path></svg>
            Codex
          </span>
          <span class="apm-tab off">
            <img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=128" alt="Cursor" width="14" height="14" style="border-radius:3px;display:block">
            Cursor
          </span>
        </div>
        <div class="apm-stream">
          <div><span class="apm-role">You</span></div>
          <div class="apm-msg-user">Add a column that scores GTM fit 0–100 and run it.</div>
          <div class="apm-tool"><span class="d"></span>create_column <span class="args">name="Fit" fn="ai.generate"</span></div>
          <div class="apm-tool"><span class="d"></span>run_column <span class="args">"Fit" · 7 rows</span></div>
          <div class="apm-result">✓ 7/7 done · 1 credit/row · wrote to Founders</div>
          <div class="apm-asst">Done. "Fit" is live on all 7 rows — top match is Sam Delgado at Clay (96). Want me to sort descending?</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ───────────────────────── Quick start ───────────────────────── -->
<section class="band" id="quickstart">
  <div class="wrap">
    <div class="qs-head">
      <h2><span class="qs-chev">&rsaquo;</span>Quick start</h2>
    </div>
    <div class="qs-card">
      <div class="qs-bar">
        <div class="traffic"><i></i><i></i><i></i></div>
        <div class="qs-tabs" id="qs-tabs">
          <button class="qs-tab active" data-tab="one-liner">One-liner</button>
          <button class="qs-tab" data-tab="npm">npm</button>
          <button class="qs-tab" data-tab="hackable">Hackable</button>
          <button class="qs-tab" data-tab="apps">Apps</button>
        </div>
        <div class="qs-bar-right">
          <div class="qs-plat" id="qs-plat">
            <button class="qs-pill active" data-plat="mac">macOS &amp; Linux</button>
            <button class="qs-pill" data-plat="win">Windows</button>
          </div>
          <span class="qs-beta">&beta; BETA</span>
        </div>
      </div>
      <div class="qs-body">
        <div class="qs-comment" id="qs-comment"># Works everywhere. Installs everything. You're welcome.</div>
        <div class="qs-cmd-row">
          <span class="qs-prompt">$</span>
          <code class="qs-cmd" id="qs-cmd">curl -fsSL https://grid.dev/install.sh | bash</code>
          <button class="qs-copy" id="qs-copy" title="Copy" aria-label="Copy command">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
        </div>
      </div>
    </div>
    <p class="qs-caption">Works on macOS, Linux, and Windows. The one-liner installs Node.js and everything else for you. Switch versions later with <code>grid update</code>.</p>
  </div>
</section>

<!-- ───────────────────────── Open source / Local vs Cloud ───────────────────────── -->
<section class="band" id="local">
  <div class="wrap">
    <div class="sec-head center">
      <span class="eyebrow"><span class="dot"></span>Open source</span>
      <h2>Free on your machine. <span class="accent">Cloud only when you need it.</span></h2>
      <p>The desktop app is open source and free forever — run it offline, ship your own connectors, send the good ones back as a PR. Cloud is where it gets serious: put your whole team on the data and keep every grid running while you're away.</p>
    </div>

    <div class="lc-grid">
      <!-- LOCAL -->
      <div class="lc-card local">
        <div class="lc-head">
          <span class="lc-ico">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"></path></svg>
          </span>
          <span class="lc-tag">Free forever · MIT</span>
        </div>
        <h3>The open-source desktop app</h3>
        <p class="lc-sub">Everything runs on your machine. No account, no caps, no pricing gate — and the full source is yours to read, fork, and extend.</p>
        <ul class="lc-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span><b>Unlimited</b> rows, tables &amp; function columns</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span>Every connector — bring your own keys</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span><b>Fork it, build connectors, open a PR</b> — features ship from the community</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span><b>Powered by your own Claude Code or Codex</b> — AI columns run on the subscription you already pay for</span></li>
        </ul>
        <div class="lc-cta">
          <a class="btn btn-primary" href="#download">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.7-2.1c.9-1.2 1.2-2.4 1.3-2.5-.1 0-2.4-1-2.4-3.6zM14.3 5.4c.6-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.2-.5 2.8-1.3z"/></svg>
            Download free
          </a>
          <a class="btn btn-outline" href="https://github.com/maxtrigify/gtm-grid">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"></path></svg>
            15.2k<span class="star-count">GitHub</span>
          </a>
        </div>
      </div>

      <!-- CLOUD -->
      <div class="lc-card cloud">
        <div class="lc-head">
          <span class="lc-ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 0 0 .9-8.91 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6 19Z"/></svg>
          </span>
          <span class="lc-tag">Optional · from $0</span>
        </div>
        <h3>Cloud, for when you step away</h3>
        <p class="lc-sub">The same grid, hosted — so it keeps running with your laptop closed, fires on incoming events, and opens up to your whole team.</p>
        <ul class="lc-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9a6 6 0 0 0-6-6Z"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg> <span><b>Runs when your computer's asleep</b> — scheduled refreshes keep firing</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m13 2-3 7h6l-3 7"/><path d="M5 12h2M17 12h2M12 5V3M12 21v-2"/></svg> <span><b>Webhooks</b> — new rows enrich themselves on inbound events</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg> <span><b>Team access</b> — shared workspaces &amp; credentials</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> <span>Realtime multiplayer on shared grids</span></li>
        </ul>
        <div class="lc-cta">
          <a class="btn btn-primary" href="#pricing">See cloud plans</a>
          <a class="btn btn-ghost" href="#pricing">Starts free →</a>
        </div>
      </div>
    </div>

    <div class="lc-detail-lab">Under the hood — how local-first works</div>
    <div class="feat-grid">
      <div class="feat-card">
        <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg></div>
        <h3>SQLite on disk</h3>
        <p>Tables, columns, and cell history live in a local <code>.db</code> file. Close the laptop lid — it's still yours.</p>
      </div>
      <div class="feat-card">
        <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <h3>Encrypted credentials</h3>
        <p>Every key is <code>AES-256-GCM</code> encrypted and scoped <span class="mono" style="color:var(--text)">Personal&nbsp;/&nbsp;Team&nbsp;/&nbsp;Local</span>. Nothing is synced to a server.</p>
      </div>
      <div class="feat-card">
        <div class="feat-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></div>
        <h3>Sandboxed logic</h3>
        <p>Column functions run in a <code>QuickJS</code> sandbox with a declarative HTTP layer. Predictable, bounded, no surprises.</p>
      </div>
    </div>
  </div>
</section>

<!-- ───────────────────────── Pricing / BYO key ───────────────────────── -->
<section class="band" id="pricing">
  <div class="wrap">
    <div class="sec-head center">
      <span class="eyebrow"><span class="dot"></span>Cloud pricing</span>
      <h2>The app is free. <span class="accent">Cloud is metered.</span></h2>
      <p>Cloud plans are billed per seat and metered by <b>cloud actions</b> — runs that happen on our infrastructure instead of your machine. No row, table, or connector caps, ever. The desktop app stays free no matter what.</p>
    </div>

    <div class="local-strip">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
      <span class="ls-tx"><b>Desktop app — $0, open source, unlimited.</b> Cloud only covers runs that happen off your machine.</span>
      <a href="#download">Download free <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>
    </div>

    <div class="bill-toggle" role="tablist" aria-label="Billing period">
      <button class="bill-opt is-active" data-bill="monthly" role="tab" aria-selected="true">Monthly</button>
      <button class="bill-opt" data-bill="annual" role="tab" aria-selected="false">Annual <span class="bill-save">2 months free</span></button>
    </div>

    <div class="pricing">
      <!-- Free -->
      <div class="price-card">
        <div class="price-head">
          <span class="plan-name">Free</span>
          <p class="plan-tagline">Cloud basics, hard-capped.</p>
        </div>
        <div class="price-tag"><span class="price-amt">$0</span><span class="price-per">/ forever</span></div>
        <p class="price-bill">No card required</p>
        <div class="price-quota">
          <div class="price-meter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9a6 6 0 0 0-6-6Z"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            <span><b style="color:var(--text);font-weight:600">2,000</b> cloud actions / mo</span>
          </div>
          <p class="price-over"><b>Overage</b> — hard cap, no overage</p>
        </div>
        <a class="btn btn-outline" href="#download" style="width:100%;justify-content:center">Start free</a>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span class="li-strong">Everything in the free desktop app</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Webhooks &amp; scheduled runs</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Cloud sync for 1 workspace</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 2,000 cloud actions every month</li>
        </ul>
      </div>

      <!-- Team -->
      <div class="price-card">
        <div class="price-head">
          <span class="plan-name">Team</span>
          <p class="plan-tagline">Shared cloud grids for small teams.</p>
        </div>
        <div class="price-tag"><span class="price-amt" data-m="$20" data-a="$17">$20</span><span class="price-per">/ seat / mo</span></div>
        <p class="price-bill" data-m="Billed monthly" data-a="$200 / seat / yr">Billed monthly</p>
        <div class="price-quota">
          <div class="price-meter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9a6 6 0 0 0-6-6Z"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            <span><b style="color:var(--text);font-weight:600">50,000</b> cloud actions / mo</span>
          </div>
          <p class="price-over"><b>Overage</b> — then $0.50 / 1,000</p>
        </div>
        <a class="btn btn-outline" href="#download" style="width:100%;justify-content:center">Start 7-day trial</a>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span class="li-strong">Everything in Free</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Team workspaces &amp; shared credentials</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Realtime multiplayer on shared grids</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 50,000 cloud actions / seat / mo</li>
        </ul>
      </div>

      <!-- Business (recommended) -->
      <div class="price-card featured">
        <span class="plan-badge">Recommended</span>
        <div class="price-head">
          <span class="plan-name">Business</span>
          <p class="plan-tagline">5× the headroom, lower overage.</p>
        </div>
        <div class="price-tag"><span class="price-amt" data-m="$40" data-a="$33">$40</span><span class="price-per">/ seat / mo</span></div>
        <p class="price-bill" data-m="Billed monthly" data-a="$400 / seat / yr">Billed monthly</p>
        <div class="price-quota">
          <div class="price-meter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9a6 6 0 0 0-6-6Z"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
            <span><b style="color:var(--text);font-weight:600">250,000</b> cloud actions / mo</span>
          </div>
          <p class="price-over"><b>Overage</b> — then $0.40 / 1,000</p>
        </div>
        <a class="btn btn-primary" href="#download" style="width:100%;justify-content:center">Start 7-day trial</a>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span class="li-strong">Everything in Team</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 250,000 cloud actions / seat / mo</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Lower overage — $0.40 / 1k vs $0.50</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Priority support</li>
        </ul>
      </div>

      <!-- Unlimited -->
      <div class="price-card">
        <div class="price-head">
          <span class="plan-name">Unlimited</span>
          <p class="plan-tagline">No metering. No overage. Ever.</p>
        </div>
        <div class="price-tag"><span class="price-amt" data-m="$99" data-a="$83">$99</span><span class="price-per">/ seat / mo</span></div>
        <p class="price-bill" data-m="Billed monthly" data-a="$990 / seat / yr">Billed monthly</p>
        <div class="price-quota">
          <div class="price-meter">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.18 8A10 10 0 1 0 12 22"/><path d="M12 2v4M4.93 4.93l2.83 2.83"/></svg>
            <span><b style="color:var(--text);font-weight:600">Unlimited</b> cloud actions</span>
          </div>
          <p class="price-over"><b>Overage</b> — none, no caps</p>
        </div>
        <a class="btn btn-outline" href="#download" style="width:100%;justify-content:center">Start 7-day trial</a>
        <ul class="price-list">
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> <span class="li-strong">Everything in Business</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Unlimited cloud actions, no metering</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> No overage charges, ever</li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Realtime multiplayer + shared credentials</li>
        </ul>
      </div>
    </div>

    <div class="bill-notes">
      <div class="bill-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9a6 6 0 0 0-6-6Z"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        <div><h5>What counts as a cloud action?</h5><p>Any run executed on our cloud instead of your machine — a function-column cell, a webhook fire, or a scheduled refresh. Runs on the desktop app are always free.</p></div>
      </div>
      <div class="bill-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <div><h5>Metered by actions, not rows</h5><p>Each member is one seat. Allowances are per seat and pool across the workspace. Rows, tables, and connectors are never capped — only cloud actions are.</p></div>
      </div>
      <div class="bill-note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.55 2.87 8.4 6.84 9.76.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.86.09-.66.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"/></svg>
        <div><h5>The desktop app is always free</h5><p>Open source and MIT-licensed, unlimited on your own machine. Cloud is purely additive — for when grids need to run without you.</p></div>
      </div>
    </div>
  </div>
</section>

<!-- ───────────────────────── FAQ ───────────────────────── -->
<section class="band">
  <div class="wrap">
    <div class="sec-head">
      <span class="eyebrow"><span class="dot"></span>FAQ</span>
      <h2>The honest answers.</h2>
    </div>
    <div class="faq-list" id="faq">
      <div class="faq-item">
        <button class="faq-q">What do you mean by &quot;headless&quot;?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">The engine isn’t tied to a dashboard. The same tables, function columns, and connectors are driven from Claude Code, an MCP client, the CLI, a REST call, or a webhook — and the desktop grid is just one head on top, so you can watch every row fill as it runs.</div></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Is my data really local?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">Yes. Storage is SQLite in a file on your disk, column logic runs in a local QuickJS sandbox, and credentials are encrypted at rest. The only outbound traffic is the connector and AI calls <em>you</em> trigger, sent directly to those providers.</div></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Do I have to use the cloud?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">No. The desktop app is fully open source and free forever — local, solo, unlimited. Cloud is an optional layer you turn on only when a grid needs to run without you: scheduled refreshes while your laptop's closed, webhook triggers, team workspaces, and shared credentials. If you never need those, you never pay.</div></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">What does "bring your own key" mean for cost?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">You add your own Anthropic / OpenAI key and your existing connector keys. Grid adds no markup — you pay providers their list price, and the app itself is free. AI columns can also run on your own Claude Code or Codex subscription.</div></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">How do I add a connector that isn't bundled?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">Drop a JSON manifest into <code>extensions/</code> with a <code>baseUrl</code>, an <code>auth</code> block, and your <code>methods</code>. It immediately becomes an <code>sdk.&lt;id&gt;.&lt;method&gt;()</code> call, an MCP tool the agent can use, and a connection form in the UI.</div></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Do I have to use the AI agent?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">No. The grid works fully on its own — add columns, pick functions, hit Run. The Claude Code / Codex panel is there when you'd rather describe what you want than click through it.</div></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Which platforms are supported?<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
        <div class="faq-a"><div class="faq-a-inner">It's a Tauri v2 desktop app. macOS is available now; Windows and Linux builds are next. The CLI and MCP server run anywhere Node does.</div></div>
      </div>
    </div>
  </div>
</section>

<!-- ───────────────────────── Final CTA ───────────────────────── -->
<section class="cta-band" id="download">
  <div class="wrap">
    <h2>Run your go-to-market <br><span class="accent">headless.</span></h2>
    <p>Install Grid, point it at your keys, and drive your first grid from Claude Code, the CLI, or an API call in minutes.</p>
    <div class="cta-cmd">
      <span class="prompt">$</span>
      <span id="cta-cmd-text">brew install --cask grid</span>
      <span class="copy" id="cta-copy" title="Copy">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </span>
    </div>
    <div class="cta-cta">
      <a class="btn btn-primary btn-lg" href="#top">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.7-2.1c.9-1.2 1.2-2.4 1.3-2.5-.1 0-2.4-1-2.4-3.6zM14.3 5.4c.6-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.1 1.8-1 2.9 1.1.1 2.2-.5 2.8-1.3z"/></svg>
        Download for macOS
      </a>
      <a class="btn btn-outline btn-lg" href="https://github.com/maxtrigify/gtm-grid">Read the docs</a>
    </div>
  </div>
</section>

<!-- ───────────────────────── Footer ───────────────────────── -->
<footer class="footer">
  <div class="wrap">
    <div class="footer-brand">
      <a class="brand" href="#top" aria-label="GTM Grid — home">
        <img class="brand-logo" src="/brand/logo.svg" alt="GTM Grid" style="height:24px;width:auto;display:block">
      </a>
      <p class="footer-tag">The headless GTM engine — programmable, local-first, every column a function.</p>
    </div>
    <div class="foot-col">
      <h5>Product</h5>
      <a href="#how">How it works</a>
      <a href="#connectors">Connectors</a>
      <a href="#agent">Agent panel</a>
      <a href="#pricing">Pricing</a>
    </div>
    <div class="foot-col">
      <h5>Developers</h5>
      <a href="https://github.com/maxtrigify/gtm-grid">GitHub</a>
      <a href="#">CLI</a>
      <a href="#">MCP server</a>
      <a href="#">Manifest spec</a>
    </div>
    <div class="foot-col">
      <h5>Company</h5>
      <a href="#">Changelog</a>
      <a href="#">Privacy</a>
      <a href="#">License</a>
    </div>
  </div>
  <div class="footer-bottom">
    <div class="wrap">
      <span>© 2026 Grid</span>
      <span class="mono">v0.4.1 · MIT</span>
    </div>
  </div>
</footer>
</div><!-- /.page -->
`;
