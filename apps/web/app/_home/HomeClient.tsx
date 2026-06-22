"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Client-side behaviour for the marketing homepage. This is a faithful port of
// the inline <script> blocks + hero-grid.js from the Claude Design handoff
// (gtm-grid/Website.html), which is rendered verbatim via dangerouslySetInnerHTML
// in page.tsx. Each initialiser returns a teardown so the effect is clean under
// React StrictMode's double-invoke (no duplicate listeners / runaway timers).

import { useEffect, useRef } from "react";

type Teardown = () => void;

const fav = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

/* ───────── connector data → wall + marquee + surfaces ───────── */
function initConnectors(): Teardown {
  const CONN = [
    { name: "Trigify", domain: "trigify.io", mono: "Tg", methods: 28, featured: true, connected: true },
    { name: "HubSpot", domain: "hubspot.com", mono: "Hs", methods: 22, connected: true },
    { name: "Apollo.io", domain: "apollo.io", mono: "Ap", methods: 9 },
    { name: "Attio", domain: "attio.com", mono: "At", methods: 12, connected: true },
    { name: "LeadMagic", domain: "leadmagic.io", mono: "Lm", methods: 6, connected: true },
    { name: "Supabase", domain: "supabase.com", mono: "Sb", methods: 14 },
    { name: "Smartlead", domain: "smartlead.ai", mono: "Sl", methods: 8 },
    { name: "Instantly", domain: "instantly.ai", mono: "In", methods: 9 },
    { name: "Exa", domain: "exa.ai", mono: "Ex", methods: 4 },
    { name: "Firecrawl", domain: "firecrawl.dev", mono: "Fc", methods: 4 },
    { name: "The Companies API", domain: "thecompaniesapi.com", mono: "Tc", methods: 7 },
    { name: "PlusVibe", domain: "plusvibe.ai", mono: "Pv", methods: 7 },
    { name: "Prospeo", domain: "prospeo.io", mono: "Pr", methods: 5, connected: true },
    { name: "FindyMail", domain: "findymail.com", mono: "Fm", methods: 4 },
    { name: "FullEnrich", domain: "fullenrich.com", mono: "Fe", methods: 3 },
    { name: "BetterContact", domain: "bettercontact.rocks", mono: "Bc", methods: 3 },
    { name: "Fireflies", domain: "fireflies.ai", mono: "Ff", methods: 5, connected: true },
    { name: "Granola", domain: "granola.ai", mono: "Gr", methods: 3 },
    { name: "Apify", domain: "apify.com", mono: "Ay", methods: 5 },
    { name: "Reoon", domain: "reoon.com", mono: "Re", methods: 3 },
    { name: "Smuggler", domain: "smuggler.dev", mono: "Sm", methods: 6 },
    { name: "Avtrz", domain: "avtrz.dev", mono: "Av", methods: 4 },
  ];
  const ico = (c: any) =>
    `<span class="conn-ico"><img src="${fav(c.domain)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="conn-fallback" style="display:none">${c.mono}</span></span>`;

  // Trailing "bring your own" tile — every connector is just a JSON manifest
  // over HTTP, so any REST API can be added the same way.
  const customCard = `
    <div class="conn-card custom">
      <span class="conn-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></span>
      <div class="conn-meta">
        <div class="conn-name-row">
          <span class="conn-name">Custom HTTP</span>
        </div>
        <div class="conn-count">Any REST API — one JSON manifest</div>
      </div>
    </div>`;

  const grid = document.getElementById("conn-grid");
  if (grid)
    grid.innerHTML =
      CONN.map(
        (c) => `
    <div class="conn-card${c.featured ? " featured" : ""}">
      ${ico(c)}
      <div class="conn-meta">
        <div class="conn-name-row">
          <span class="conn-name">${c.name}${c.featured ? `<span class="feat-tag">Featured</span>` : ""}</span>
          <span class="conn-pill ${c.connected ? "on" : "off"}">${c.connected ? "Connected" : "Add key"}</span>
        </div>
        <div class="conn-count"><span class="num">${c.methods}</span> methods</div>
      </div>
    </div>`,
      ).join("") + customCard;

  const marqItems = CONN.slice(0, 11)
    .map(
      (c) =>
        `<span class="marq-item"><span class="marq-fav conn-ico" style="width:22px;height:22px;border:none;background:transparent"><img src="${fav(c.domain)}" alt="" style="width:22px;height:22px;border-radius:5px" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="conn-fallback" style="display:none;width:22px;height:22px;border-radius:5px;background:var(--accent-bg);align-items:center;justify-content:center">${c.mono}</span></span>${c.name}</span>`,
    )
    .join("");
  const a = document.getElementById("marq-a");
  const b = document.getElementById("marq-b");
  if (a) a.innerHTML = marqItems;
  if (b) b.innerHTML = marqItems;

  const surf = document.getElementById("surf-conn");
  if (surf)
    surf.innerHTML = CONN.slice(0, 12)
      .map(
        (c) =>
          '<span class="surf-logo"><img src="' +
          fav(c.domain) +
          '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><span class="conn-fallback" style="display:none">' +
          c.mono +
          "</span></span>",
      )
      .join("");
  return () => {};
}

/* ───────── nav shadow on scroll ───────── */
function initNav(): Teardown {
  const nav = document.getElementById("nav");
  if (!nav) return () => {};
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  return () => window.removeEventListener("scroll", onScroll);
}

/* ───────── FAQ accordion ───────── */
function initFaq(): Teardown {
  const handlers: Array<[Element, () => void]> = [];
  document.querySelectorAll("#faq .faq-item").forEach((item) => {
    const q = item.querySelector(".faq-q");
    const a = item.querySelector<HTMLElement>(".faq-a");
    if (!q || !a) return;
    const onClick = () => {
      const open = item.classList.contains("open");
      document.querySelectorAll("#faq .faq-item.open").forEach((o) => {
        o.classList.remove("open");
        const oa = o.querySelector<HTMLElement>(".faq-a");
        if (oa) oa.style.maxHeight = "";
      });
      if (!open) {
        item.classList.add("open");
        a.style.maxHeight = a.scrollHeight + "px";
      }
    };
    q.addEventListener("click", onClick);
    handlers.push([q, onClick]);
  });
  return () => handlers.forEach(([el, fn]) => el.removeEventListener("click", fn));
}

/* ───────── copy install command (final CTA) ───────── */
function initCtaCopy(): Teardown {
  const btn = document.getElementById("cta-copy");
  if (!btn) return () => {};
  const onClick = () => {
    const txt = document.getElementById("cta-cmd-text")?.textContent ?? "";
    if (navigator.clipboard) navigator.clipboard.writeText(txt);
    const old = btn.innerHTML;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      btn.innerHTML = old;
    }, 1400);
  };
  btn.addEventListener("click", onClick);
  return () => btn.removeEventListener("click", onClick);
}

/* ───────── Quick start — tabs + platform toggle + copy ───────── */
function initQuickStart(): Teardown {
  // Real distribution paths (verified against README): run from source, drive
  // it from Claude Code over MCP, or grab the signed desktop build. No
  // fabricated brew/curl/npm one-liners — those don't exist for this project.
  const QS: Record<string, { c: string; cmd: string }> = {
    source: {
      c: "# Clone and run from source. Needs Node 20+ and pnpm.",
      cmd: "git clone https://github.com/badapplesdotdev/gtm-grid.git && cd gtm-grid && pnpm install && pnpm tauri:dev",
    },
    claude: {
      c: "# Drive the grid from your terminal Claude Code over MCP.",
      cmd: 'claude mcp add gtmgrid -s user -e GTMGRID_PROJECT=default -- "$HOME/dev/gtmgrid/bin/gtmgrid-mcp"',
    },
    app: {
      c: "# Prefer a click? Grab the signed build for macOS, Windows or Linux.",
      cmd: "open https://gtmgrid.com/download",
    },
  };
  const tabs = document.getElementById("qs-tabs");
  const cEl = document.getElementById("qs-comment");
  const cmdEl = document.getElementById("qs-cmd");
  const copy = document.getElementById("qs-copy");
  if (!tabs || !cEl || !cmdEl || !copy) return () => {};
  const state = { tab: "source" };
  const render = () => {
    const d = QS[state.tab] ?? QS.source;
    cEl.textContent = d.c;
    cmdEl.textContent = d.cmd;
  };
  const onTabs = (e: Event) => {
    const b = (e.target as Element).closest<HTMLElement>(".qs-tab");
    if (!b) return;
    state.tab = b.dataset.tab as string;
    tabs.querySelectorAll(".qs-tab").forEach((x) => x.classList.toggle("active", x === b));
    render();
  };
  const onCopy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(cmdEl.textContent ?? "");
    const old = copy.innerHTML;
    copy.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent-2)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      copy.innerHTML = old;
    }, 1400);
  };
  tabs.addEventListener("click", onTabs);
  copy.addEventListener("click", onCopy);
  return () => {
    tabs.removeEventListener("click", onTabs);
    copy.removeEventListener("click", onCopy);
  };
}

/* ───────── Pricing — monthly / annual toggle ───────── */
function initPricing(): Teardown {
  const toggle = document.querySelector(".bill-toggle");
  if (!toggle) return () => {};
  const amts = document.querySelectorAll<HTMLElement>(".price-amt[data-m]");
  const bills = document.querySelectorAll<HTMLElement>(".price-bill[data-m]");
  const onClick = (e: Event) => {
    const b = (e.target as Element).closest<HTMLElement>(".bill-opt");
    if (!b) return;
    const mode = b.dataset.bill;
    toggle.querySelectorAll(".bill-opt").forEach((o) => {
      const on = o === b;
      o.classList.toggle("is-active", on);
      o.setAttribute("aria-selected", on ? "true" : "false");
    });
    const key = mode === "annual" ? "a" : "m";
    amts.forEach((el) => {
      el.textContent = el.dataset[key] ?? el.textContent;
    });
    bills.forEach((el) => {
      el.textContent = el.dataset[key] ?? el.textContent;
    });
  };
  toggle.addEventListener("click", onClick);
  return () => toggle.removeEventListener("click", onClick);
}

/* ───────── scroll-reveal + agent-demo play-in ───────── */
function initReveal(): Teardown {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return () => {};

  const sel =
    ".sec-head, .qs-card, .qs-caption, .conn-card, .feat-card, .lc-card, .lc-detail-lab, .price-card, .bill-note, .demo-card, .faq-item, .local-strip, .cta-band .wrap, .surf-card";
  const items = [...document.querySelectorAll<HTMLElement>(sel)];
  items.forEach((el) => el.classList.add("reveal"));
  document.querySelectorAll(".conn-grid, .feat-grid, .pricing, .bill-notes, .surf-grid").forEach((grid) => {
    [...grid.children].forEach((c, i) => c.classList.add("d" + ((i % 3) + 1)));
  });
  const revObs = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          obs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );
  items.forEach((el) => revObs.observe(el));

  let demoObs: IntersectionObserver | null = null;
  const demo = document.querySelector(".agent-demo");
  if (demo) {
    demo.classList.add("armed");
    demoObs = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("playing");
            obs.unobserve(e.target);
          }
        });
      },
      { threshold: 0.3 },
    );
    demoObs.observe(demo);
  }
  return () => {
    revObs.disconnect();
    demoObs?.disconnect();
  };
}

/* ───────── hero demo — ask Claude Code, watch it enrich the grid ───────── */
function initHero(): Teardown {
  const root = document.getElementById("live-grid");
  if (!root) return () => {};

  const COLS = [
    { name: "Name", kind: "manual" },
    { name: "Company", kind: "manual" },
    { name: "Title", kind: "fn", fn: "trigify.enrich", src: "trigify.io" },
    { name: "Email", kind: "fn", fn: "leadmagic.find", json: true, src: "leadmagic.io" },
    { name: "Fit", kind: "fn", fn: "ai.generate", src: "ai" },
  ] as any[];
  const ROWS = [
    { name: "Alex Rivera", company: "Linear", Title: "Head of Growth", Fit: "94" },
    { name: "Maya Chen", company: "Ramp", Title: "VP Sales", Fit: "88" },
    { name: "Jordan Okafor", company: "Vercel", Title: "Founding AE", Fit: "91" },
    { name: "Priya Nair", company: "Retool", Title: "RevOps Lead", Fit: "79" },
    { name: "Sam Delgado", company: "Clay", Title: "GTM Engineer", Fit: "96" },
    { name: "Noa Friedman", company: "Cursor", Title: "Head of Sales", Fit: "85" },
    { name: "Liam Walsh", company: "Browserbase", Title: "Founder", Fit: "90" },
  ] as any[];
  const FNCOLS = COLS.filter((c) => c.kind === "fn");
  const TOTAL = ROWS.length * FNCOLS.length;
  const PROMPT = "Enrich all 7 founders — pull their title and a work email, then score GTM fit 0–100.";

  const SVG = {
    claude:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#D97757" stroke-width="1.9" stroke-linecap="round"><line x1="3.8" y1="12" x2="20.2" y2="12"/><line x1="4.9" y1="7.9" x2="19.1" y2="16.1"/><line x1="7.9" y1="4.9" x2="16.1" y2="19.1"/><line x1="12" y1="3.8" x2="12" y2="20.2"/><line x1="16.1" y1="4.9" x2="7.9" y2="19.1"/><line x1="19.1" y1="7.9" x2="4.9" y2="16.1"/></g></svg>',
    arrow:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    spark:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
    cursor:
      '<svg viewBox="0 0 24 24" fill="#fff" stroke="#1d1d22" stroke-width="1.5" stroke-linejoin="round"><path d="M5 3l15 7.5-6.2 2.1L11 19z"/></svg>',
    caret:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>',
  };
  function srcMark(c: any) {
    if (c.src === "ai") return `<span class="th-src ai" title="ai.generate">${SVG.spark}</span>`;
    if (c.src) return `<span class="th-src" title="${c.fn}"><img src="${fav(c.src)}" alt="" loading="lazy" onerror="this.parentNode.style.display='none'"></span>`;
    return "";
  }

  /* cancellable timers */
  const speed = 1;
  let token = 0;
  let pending: Array<{ id: any; rej: (r?: any) => void }> = [];
  let disposed = false;
  const CANCEL = Symbol("cancel");
  function cancelAll() {
    token++;
    pending.forEach((p) => {
      clearTimeout(p.id);
      p.rej(CANCEL);
    });
    pending = [];
  }
  function sleep(ms: number): Promise<void> {
    const my = token;
    return new Promise((res, rej) => {
      const id = setTimeout(() => {
        pending = pending.filter((p) => p.id !== id);
        if (my === token) res();
        else rej(CANCEL);
      }, Math.max(0, ms / speed));
      pending.push({ id, rej });
    });
  }
  const md = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");

  function buildShell(el: HTMLElement) {
    el.innerHTML = `
      <div class="lg-scroll"><table class="lg">
        <colgroup>
          <col style="width:44px">
          <col style="width:150px"><col style="width:128px">
          <col style="width:150px"><col style="width:118px"><col style="width:78px">
        </colgroup>
        <thead><tr>
          <th class="rownum"></th>
          ${COLS.map((c) => {
            if (c.kind !== "fn") return `<th data-col="${c.name}"><div class="th-inner"><span>${c.name}</span></div></th>`;
            const caret = c.name === "Fit" ? `<span class="sort-caret">${SVG.caret}</span>` : "";
            return `<th data-col="${c.name}" class="fn-pending"><div class="th-inner"><span>${c.name}</span>${caret}<span class="fn-badge">${c.fn.split(".").pop()}</span>${srcMark(c)}</div></th>`;
          }).join("")}
        </tr></thead>
        <tbody>
          ${ROWS.map(
            (r, i) => `<tr data-row="${i}">
            <td class="rownum">${i + 1}</td>
            <td><span class="cell-val">${r.name}</span></td>
            <td><span class="cell-val">${r.company}</span></td>
            <td data-cell="Title"></td><td data-cell="Email"></td><td data-cell="Fit"></td>
          </tr>`,
          ).join("")}
        </tbody>
      </table></div>`;
  }

  const EMPTY = `<span class="cell-empty">—</span>`;
  const RUN = `<span class="cell-run"><span class="spinner"></span>running</span>`;
  const cellDone = (c: any, ri: number) =>
    c.json ? `<span class="status-pill ok cell-enter">Status Code: 200</span>` : `<span class="cell-val cell-enter">${ROWS[ri][c.name]}</span>`;

  function resetGrid() {
    const tbody = document.querySelector<HTMLElement>("#live-grid tbody");
    if (tbody) {
      tbody.style.opacity = "1";
      [...tbody.querySelectorAll<HTMLElement>("tr")]
        .sort((a, b) => +a.dataset.row! - +b.dataset.row!)
        .forEach((r, i) => {
          tbody.appendChild(r);
          const rn = r.querySelector(".rownum");
          if (rn) rn.textContent = String(i + 1);
          r.classList.remove("top-match", "flash");
        });
    }
    document.querySelectorAll("#live-grid [data-cell]").forEach((td) => (td.innerHTML = EMPTY));
    document.querySelectorAll("#live-grid th[data-col]").forEach((th) => {
      if (th.querySelector(".fn-badge")) {
        th.classList.add("fn-pending");
        th.classList.remove("fn-active");
      }
    });
    const caret = document.querySelector("#live-grid th[data-col=\"Fit\"] .sort-caret");
    if (caret) caret.classList.remove("on");
    const chip = document.querySelector("#live-grid .top-chip");
    if (chip) chip.remove();
  }

  function setRun(cur: number) {
    const el = document.getElementById("win-run");
    if (!el) return;
    const t = el.querySelector(".runtxt");
    if (t) t.textContent = cur <= 0 || cur >= TOTAL ? "Run" : `Running ${cur}/${TOTAL}`;
  }

  const $stream = () => document.getElementById("ha-stream");
  const scrollDown = () => {
    const s = $stream();
    if (s) s.scrollTop = s.scrollHeight;
  };
  function add(cls: string, html: string) {
    const s = $stream();
    if (!s) return null;
    const el = document.createElement("div");
    el.className = cls;
    el.innerHTML = html;
    s.appendChild(el);
    scrollDown();
    return el;
  }
  const addUser = (text: string) => {
    const s = $stream();
    if (!s) return;
    const el = document.createElement("div");
    el.className = "ha-msg user";
    el.textContent = text;
    s.appendChild(el);
    scrollDown();
  };
  const addAsst = (text: string) => add("ha-msg asst", `<span class="ha-role">${SVG.claude}Claude</span><div class="ha-text">${md(text)}</div>`);
  const addTool = (name: string, args: string) =>
    add("ha-tool", `<span class="ha-tc-status"><span class="ha-spin"></span></span><span class="ha-tc-name">${name}</span><span class="ha-tc-args">${args}</span><span class="ha-tc-sum"></span>`);
  const doneTool = (el: HTMLElement | null, sum?: string) => {
    if (!el) return;
    const st = el.querySelector(".ha-tc-status");
    if (st) st.innerHTML = SVG.arrow;
    if (sum) {
      const s = el.querySelector(".ha-tc-sum");
      if (s) s.textContent = sum;
    }
  };
  const addThink = (label: string) =>
    add("ha-think", `<span class="ha-think-spark">${SVG.spark}</span><span class="ha-think-label">${label}</span><span class="ha-think-dots"><span></span><span></span><span></span></span>`);

  function clearStream() {
    const s = $stream();
    if (s) s.innerHTML = "";
  }
  function clearInput() {
    const box = document.getElementById("ha-input-text");
    if (box) box.innerHTML = '<span class="ha-ph">Message Claude Code…</span>';
    const send = document.getElementById("ha-send");
    if (send) send.classList.remove("ready");
  }
  async function typePrompt(text: string) {
    const box = document.getElementById("ha-input-text");
    const send = document.getElementById("ha-send");
    if (!box) return;
    box.innerHTML = "";
    const txt = document.createElement("span");
    const caret = document.createElement("span");
    caret.className = "ha-caret";
    box.appendChild(txt);
    box.appendChild(caret);
    for (let i = 0; i < text.length; i++) {
      txt.textContent = text.slice(0, i + 1);
      await sleep(24 + (text[i] === " " ? 16 : 0) + Math.random() * 22);
    }
    if (send) send.classList.add("ready");
    await sleep(440);
  }

  let runDone = 0;
  function fillColumn(col: any) {
    const th = document.querySelector(`#live-grid th[data-col="${col.name}"]`);
    if (th) {
      th.classList.remove("fn-pending");
      th.classList.add("fn-active");
    }
    const rows = [...document.querySelectorAll<HTMLElement>("#live-grid tbody tr")];
    return Promise.all(
      rows.map((tr, i) =>
        (async () => {
          const ri = +tr.dataset.row!;
          const cell = tr.querySelector(`[data-cell="${col.name}"]`);
          if (!cell) return;
          await sleep(i * 150);
          cell.innerHTML = RUN;
          await sleep(360 + Math.random() * 260);
          cell.innerHTML = cellDone(col, ri);
          tr.classList.add("flash");
          sleep(520)
            .then(() => tr.classList.remove("flash"))
            .catch(() => {});
          runDone++;
          setRun(runDone);
        })(),
      ),
    );
  }

  function ensureCursor() {
    const win = document.querySelector(".hero-app");
    if (!win) return null;
    let cur = win.querySelector<HTMLElement>(".demo-cursor");
    if (!cur) {
      cur = document.createElement("div");
      cur.className = "demo-cursor";
      cur.innerHTML = SVG.cursor;
      win.appendChild(cur);
    }
    return cur;
  }
  function placeCursor(cur: HTMLElement, x: number, y: number) {
    cur.style.left = x + "px";
    cur.style.top = y + "px";
  }
  async function cursorIntro() {
    const win = document.querySelector<HTMLElement>(".hero-app");
    const input = document.querySelector<HTMLElement>(".ha-input");
    const cur = ensureCursor();
    if (!win || !input || !cur) return;
    const wb = win.getBoundingClientRect();
    const ib = input.getBoundingClientRect();
    cur.style.transition = "none";
    placeCursor(cur, wb.width * 0.66, wb.height * 0.95);
    cur.style.opacity = "0";
    await sleep(40);
    cur.style.transition = "";
    cur.style.opacity = "1";
    placeCursor(cur, ib.left - wb.left + 46, ib.top - wb.top + ib.height / 2);
    await sleep(950);
    cur.classList.add("tap");
    input.classList.add("focused");
    await sleep(320);
    cur.classList.remove("tap");
    cur.style.opacity = "0";
    await sleep(240);
  }

  async function sortByFit() {
    const tbody = document.querySelector<HTMLElement>("#live-grid tbody");
    if (!tbody) return;
    const caret = document.querySelector("#live-grid th[data-col=\"Fit\"] .sort-caret");
    if (caret) caret.classList.add("on");
    const rows = [...tbody.querySelectorAll<HTMLElement>("tr")].sort((a, b) => +ROWS[+b.dataset.row!].Fit - +ROWS[+a.dataset.row!].Fit);
    tbody.style.transition = "opacity .2s ease";
    tbody.style.opacity = "0";
    await sleep(220);
    rows.forEach((r, i) => {
      tbody.appendChild(r);
      const rn = r.querySelector(".rownum");
      if (rn) rn.textContent = String(i + 1);
    });
    tbody.style.opacity = "1";
    await sleep(120);
    const top = rows[0];
    top.classList.add("top-match");
    const nameCell = top.querySelector(".cell-val");
    if (nameCell && !nameCell.querySelector(".top-chip")) {
      const chip = document.createElement("span");
      chip.className = "top-chip";
      chip.textContent = "Top fit";
      nameCell.appendChild(chip);
      await sleep(30);
      chip.classList.add("on");
    }
    await sleep(360);
  }

  async function runOnce() {
    resetGrid();
    clearStream();
    clearInput();
    runDone = 0;
    setRun(0);
    const inp = document.querySelector(".ha-input");
    if (inp) inp.classList.remove("focused");
    await sleep(700);

    await cursorIntro();
    await typePrompt(PROMPT);
    addUser(PROMPT);
    clearInput();

    let th = addThink("Thinking");
    await sleep(820);
    th?.remove();
    addAsst("On it — reading **Founders**, then running the three enrichment columns. Watch the cells fill on the left.");
    await sleep(620);

    const t1 = addTool("get_table", 'table: "Founders"');
    th = addThink("Reading table");
    await sleep(720);
    th?.remove();
    doneTool(t1, "5 cols · 7 rows");
    await sleep(420);

    for (const c of FNCOLS) {
      const tool = addTool("run_column", `"${c.name}" · ${c.fn}`);
      th = addThink(`Running ${c.name}`);
      await fillColumn(c);
      th?.remove();
      doneTool(tool, c.json ? "7/7 · 1×404" : "7/7 done");
      const head = document.querySelector(`#live-grid th[data-col="${c.name}"]`);
      if (head) head.classList.remove("fn-active");
      await sleep(360);
    }

    await sleep(180);
    th = addThink("Summarizing");
    await sleep(700);
    th?.remove();
    addAsst("Done — enriched all 7 rows across 3 columns. Top GTM fit is **Sam Delgado** at Clay (`96`). Sorting by fit now.");
    setRun(TOTAL);
    scrollDown();

    await sleep(720);
    await sortByFit();
    addAsst("Sorted, highest fit first. Want me to push the top 3 into a campaign?");
    scrollDown();
  }

  async function loop() {
    while (!disposed) {
      await runOnce();
      await sleep(4400);
    }
  }
  function start() {
    cancelAll();
    loop().catch(() => {});
  }

  function renderStatic() {
    document.querySelectorAll<HTMLElement>("#live-grid tbody tr").forEach((tr, i) =>
      FNCOLS.forEach((c) => {
        const cell = tr.querySelector(`[data-cell="${c.name}"]`);
        if (cell) cell.innerHTML = c.json ? `<span class="status-pill ok">Status Code: 200</span>` : `<span class="cell-val">${ROWS[i][c.name]}</span>`;
      }),
    );
    document.querySelectorAll("#live-grid th[data-col]").forEach((th) => th.classList.remove("fn-pending", "fn-active"));
    clearStream();
    clearInput();
    addUser(PROMPT);
    addAsst("On it — reading **Founders**, then running the three enrichment columns.");
    doneTool(addTool("get_table", 'table: "Founders"'), "5 cols · 7 rows");
    FNCOLS.forEach((c) => doneTool(addTool("run_column", `"${c.name}"`), c.json ? "7/7 · 1×404" : "7/7 done"));
    addAsst("Done — enriched all 7 rows across 3 columns. Top GTM fit is **Sam Delgado** at Clay (`96`).");
    setRun(TOTAL);
  }

  buildShell(root);
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const shell = document.querySelector(".frame-shell");
  if (shell && !reduce) {
    shell.classList.add("pre");
    const reveal = () => shell.classList.remove("pre");
    requestAnimationFrame(() => requestAnimationFrame(reveal));
    setTimeout(reveal, 450);
  }

  let io: IntersectionObserver | null = null;
  if (reduce) {
    renderStatic();
  } else {
    let started = false;
    const begin = () => {
      if (!started && !disposed) {
        started = true;
        start();
      }
    };
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              begin();
              io?.disconnect();
            }
          });
        },
        { threshold: 0.15 },
      );
      io.observe(root);
      setTimeout(begin, 1600);
    } else {
      begin();
    }
  }

  return () => {
    disposed = true;
    cancelAll();
    io?.disconnect();
  };
}

// Renders the design's verbatim markup and owns all of its imperative
// behaviour. The markup is injected via a ref (not dangerouslySetInnerHTML): a
// large raw-HTML blob never byte-matches the browser-parsed DOM, and React 19
// reconciling that mismatch silently aborts effect flushing for the whole root
// (the connector wall, hero animation, etc. then never initialise). Rendering
// an empty wrapper — identical on the server and the first client render —
// avoids the mismatch entirely; we then set innerHTML once and wire up scripts.
export function HomeClient({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (root && root.childElementCount === 0) root.innerHTML = html;
    const teardowns: Teardown[] = [
      initConnectors(),
      initNav(),
      initFaq(),
      initCtaCopy(),
      initQuickStart(),
      initPricing(),
      initReveal(),
      initHero(),
    ];
    return () => teardowns.forEach((t) => t && t());
  }, [html]);
  return <div className="gtm-home" data-theme="light" ref={ref} />;
}
