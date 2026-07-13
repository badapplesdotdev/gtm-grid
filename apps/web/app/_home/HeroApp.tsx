"use client";

// The hero "app window": a live Founders grid beside a Claude Code agent panel.
// The full window *structure* is rendered as JSX, so it's server-rendered and on
// screen immediately (no blank flash). The looping demo — Claude typing a prompt,
// streaming tool calls, and the grid cells filling pending → running → done, then
// sorting by fit — is an imperative animation driven from a single effect scoped
// to this component's root ref. That's the idiomatic way to host a canvas-like
// animation in React: declarative shell, imperative motion. Paused for reduced
// motion (a static, fully-enriched grid is rendered instead).

import { useEffect, useRef } from "react";
import { faviconUrl } from "./connectors";
import { ClaudeMark } from "./icons";

interface FnCol {
  readonly name: "Title" | "Email" | "Fit";
  readonly fn: string;
  readonly src: string;
  readonly json?: boolean;
}
const COLS = [
  { name: "Name", kind: "manual" as const },
  { name: "Company", kind: "manual" as const },
  { name: "Title", kind: "fn" as const, fn: "trigify.enrich", src: "trigify.io" },
  { name: "Email", kind: "fn" as const, fn: "leadmagic.find", src: "leadmagic.io", json: true },
  { name: "Fit", kind: "fn" as const, fn: "ai.generate", src: "ai" },
];
const ROWS = [
  { name: "Alex Rivera", company: "Linear", Title: "Head of Growth", Fit: "94" },
  { name: "Maya Chen", company: "Ramp", Title: "VP Sales", Fit: "88" },
  { name: "Jordan Okafor", company: "Vercel", Title: "Founding AE", Fit: "91" },
  { name: "Priya Nair", company: "Retool", Title: "RevOps Lead", Fit: "79" },
  { name: "Sam Delgado", company: "Clay", Title: "GTM Engineer", Fit: "96" },
  { name: "Noa Friedman", company: "Cursor", Title: "Head of Sales", Fit: "85" },
  { name: "Liam Walsh", company: "Browserbase", Title: "Founder", Fit: "90" },
] as const;
const FNCOLS: readonly FnCol[] = COLS.filter((c): c is typeof COLS[number] & { kind: "fn" } => c.kind === "fn").map(
  (c) => ({ name: c.name as FnCol["name"], fn: c.fn!, src: c.src!, json: c.json }),
);
const TOTAL = ROWS.length * FNCOLS.length;
const PROMPT = "Enrich all 7 founders — pull their title and a work email, then score GTM fit 0–100.";

const SVG = {
  arrow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  spark:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/></svg>',
  claude:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#D97757" stroke-width="1.9" stroke-linecap="round"><line x1="3.8" y1="12" x2="20.2" y2="12"/><line x1="4.9" y1="7.9" x2="19.1" y2="16.1"/><line x1="7.9" y1="4.9" x2="16.1" y2="19.1"/><line x1="12" y1="3.8" x2="12" y2="20.2"/><line x1="16.1" y1="4.9" x2="7.9" y2="19.1"/><line x1="19.1" y1="7.9" x2="4.9" y2="16.1"/></g></svg>',
  cursor:
    '<svg viewBox="0 0 24 24" fill="#fff" stroke="#1d1d22" stroke-width="1.5" stroke-linejoin="round"><path d="M5 3l15 7.5-6.2 2.1L11 19z"/></svg>',
};

export function HeroApp() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
    const qa = <T extends Element>(sel: string) => Array.from(root.querySelectorAll<T>(sel));

    /* cancellable timer pool so the loop tears down cleanly under StrictMode */
    let token = 0;
    let pending: Array<{ id: ReturnType<typeof setTimeout>; rej: (r?: unknown) => void }> = [];
    let disposed = false;
    const CANCEL = Symbol("cancel");
    const cancelAll = () => {
      token++;
      pending.forEach((p) => {
        clearTimeout(p.id);
        p.rej(CANCEL);
      });
      pending = [];
    };
    const sleep = (ms: number): Promise<void> => {
      const my = token;
      return new Promise((res, rej) => {
        const id = setTimeout(() => {
          pending = pending.filter((p) => p.id !== id);
          if (my === token) res();
          else rej(CANCEL);
        }, Math.max(0, ms));
        pending.push({ id, rej });
      });
    };
    const md = (s: string) =>
      s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");

    const EMPTY = `<span class="cell-empty">—</span>`;
    const RUN = `<span class="cell-run"><span class="spinner"></span>running</span>`;
    const cellDone = (c: FnCol, ri: number) =>
      c.json
        ? `<span class="status-pill ok cell-enter">Status Code: 200</span>`
        : `<span class="cell-val cell-enter">${ROWS[ri][c.name as "Title" | "Fit"]}</span>`;

    const setRun = (cur: number) => {
      const t = q(".runtxt");
      if (t) t.textContent = cur <= 0 || cur >= TOTAL ? "Run" : `Running ${cur}/${TOTAL}`;
    };

    const stream = () => q<HTMLElement>(".ha-stream");
    const scrollDown = () => {
      const s = stream();
      if (s) s.scrollTop = s.scrollHeight;
    };
    const add = (cls: string, html: string) => {
      const s = stream();
      if (!s) return null;
      const el = document.createElement("div");
      el.className = cls;
      el.innerHTML = html;
      s.appendChild(el);
      scrollDown();
      return el;
    };
    const addUser = (text: string) => {
      const s = stream();
      if (!s) return;
      const el = document.createElement("div");
      el.className = "ha-msg user";
      el.textContent = text;
      s.appendChild(el);
      scrollDown();
    };
    const addAsst = (text: string) =>
      add("ha-msg asst", `<span class="ha-role">${SVG.claude}Claude</span><div class="ha-text">${md(text)}</div>`);
    const addTool = (name: string, args: string) =>
      add(
        "ha-tool",
        `<span class="ha-tc-status"><span class="ha-spin"></span></span><span class="ha-tc-name">${name}</span><span class="ha-tc-args">${args}</span><span class="ha-tc-sum"></span>`,
      );
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
      add(
        "ha-think",
        `<span class="ha-think-spark">${SVG.spark}</span><span class="ha-think-label">${label}</span><span class="ha-think-dots"><span></span><span></span><span></span></span>`,
      );

    const clearStream = () => {
      const s = stream();
      if (s) s.innerHTML = "";
    };
    const clearInput = () => {
      const box = q(".ha-input-text");
      if (box) box.innerHTML = '<span class="ha-ph">Message Claude Code…</span>';
      q(".ha-send")?.classList.remove("ready");
    };
    const typePrompt = async (text: string) => {
      const box = q<HTMLElement>(".ha-input-text");
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
      q(".ha-send")?.classList.add("ready");
      await sleep(440);
    };

    const resetGrid = () => {
      const tbody = q<HTMLElement>("tbody");
      if (tbody) {
        tbody.style.opacity = "1";
        qa<HTMLElement>("tbody tr")
          .sort((a, b) => +a.dataset.row! - +b.dataset.row!)
          .forEach((r, i) => {
            tbody.appendChild(r);
            const rn = r.querySelector(".rownum");
            if (rn) rn.textContent = String(i + 1);
            r.classList.remove("top-match", "flash");
          });
      }
      qa("[data-cell]").forEach((td) => (td.innerHTML = EMPTY));
      qa("th[data-col]").forEach((th) => {
        if (th.querySelector(".fn-badge")) {
          th.classList.add("fn-pending");
          th.classList.remove("fn-active");
        }
      });
      q('th[data-col="Fit"] .sort-caret')?.classList.remove("on");
      q(".top-chip")?.remove();
    };

    let runDone = 0;
    const fillColumn = (col: FnCol) => {
      const th = q(`th[data-col="${col.name}"]`);
      if (th) {
        th.classList.remove("fn-pending");
        th.classList.add("fn-active");
      }
      const rows = qa<HTMLElement>("tbody tr");
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
    };

    const ensureCursor = () => {
      const win = q<HTMLElement>(".hero-app");
      if (!win) return null;
      let cur = win.querySelector<HTMLElement>(".demo-cursor");
      if (!cur) {
        cur = document.createElement("div");
        cur.className = "demo-cursor";
        cur.innerHTML = SVG.cursor;
        win.appendChild(cur);
      }
      return cur;
    };
    const placeCursor = (cur: HTMLElement, x: number, y: number) => {
      cur.style.left = x + "px";
      cur.style.top = y + "px";
    };
    const cursorIntro = async () => {
      const win = q<HTMLElement>(".hero-app");
      const input = q<HTMLElement>(".ha-input");
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
    };

    const sortByFit = async () => {
      const tbody = q<HTMLElement>("tbody");
      if (!tbody) return;
      q('th[data-col="Fit"] .sort-caret')?.classList.add("on");
      const rows = qa<HTMLElement>("tbody tr").sort(
        (a, b) => +ROWS[+b.dataset.row!].Fit - +ROWS[+a.dataset.row!].Fit,
      );
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
    };

    const runOnce = async () => {
      resetGrid();
      clearStream();
      clearInput();
      runDone = 0;
      setRun(0);
      q(".ha-input")?.classList.remove("focused");
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
        q(`th[data-col="${c.name}"]`)?.classList.remove("fn-active");
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
    };

    const loop = async () => {
      while (!disposed) {
        await runOnce();
        await sleep(4400);
      }
    };

    const renderStatic = () => {
      qa<HTMLElement>("tbody tr").forEach((tr, i) =>
        FNCOLS.forEach((c) => {
          const cell = tr.querySelector(`[data-cell="${c.name}"]`);
          if (cell)
            cell.innerHTML = c.json
              ? `<span class="status-pill ok">Status Code: 200</span>`
              : `<span class="cell-val">${ROWS[i][c.name as "Title" | "Fit"]}</span>`;
        }),
      );
      qa("th[data-col]").forEach((th) => th.classList.remove("fn-pending", "fn-active"));
      clearStream();
      clearInput();
      addUser(PROMPT);
      addAsst("On it — reading **Founders**, then running the three enrichment columns.");
      doneTool(addTool("get_table", 'table: "Founders"'), "5 cols · 7 rows");
      FNCOLS.forEach((c) => doneTool(addTool("run_column", `"${c.name}"`), c.json ? "7/7 · 1×404" : "7/7 done"));
      addAsst("Done — enriched all 7 rows across 3 columns. Top GTM fit is **Sam Delgado** at Clay (`96`).");
      setRun(TOTAL);
    };

    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shell = q(".frame-shell");
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
          loop().catch(() => {});
        }
      };
      const grid = q(".hero-grid-pane");
      if (grid && "IntersectionObserver" in window) {
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
        io.observe(grid);
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
  }, []);

  return (
    <div className="frame-shell" ref={rootRef}>
      <div className="frame-glow" />
      <div className="window hero-app">
        <div className="win-bar">
          <div className="traffic"><i /><i /><i /></div>
          <div className="win-title">
            Founders <span className="meta">· 7 rows · 5 cols</span>
          </div>
          <span className="win-online">online</span>
          <span className="win-run">
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            <span className="runtxt">Run</span>
          </span>
        </div>
        <div className="hero-app-body">
          <div className="hero-grid-pane">
            <div className="lg-scroll">
              <table className="lg">
                <colgroup>
                  <col style={{ width: 44 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 128 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 118 }} />
                  <col style={{ width: 78 }} />
                </colgroup>
                <thead>
                  <tr>
                    <th className="rownum" />
                    {COLS.map((c) =>
                      c.kind !== "fn" ? (
                        <th data-col={c.name} key={c.name}>
                          <div className="th-inner"><span>{c.name}</span></div>
                        </th>
                      ) : (
                        <th data-col={c.name} className="fn-pending" key={c.name}>
                          <div className="th-inner">
                            <span>{c.name}</span>
                            {c.name === "Fit" && (
                              <span className="sort-caret">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 10l5 5 5-5" /></svg>
                              </span>
                            )}
                            <span className="fn-badge">{c.fn!.split(".").pop()}</span>
                            {c.src === "ai" ? (
                              <span className="th-src ai" title="ai.generate">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></svg>
                              </span>
                            ) : (
                              <span className="th-src" title={c.fn}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={faviconUrl(c.src!)} alt="" loading="lazy" />
                              </span>
                            )}
                          </div>
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((r, i) => (
                    <tr data-row={i} key={r.name}>
                      <td className="rownum">{i + 1}</td>
                      <td><span className="cell-val">{r.name}</span></td>
                      <td><span className="cell-val">{r.company}</span></td>
                      <td data-cell="Title"><span className="cell-empty">—</span></td>
                      <td data-cell="Email"><span className="cell-empty">—</span></td>
                      <td data-cell="Fit"><span className="cell-empty">—</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <aside className="hero-agent" aria-label="Claude Code agent panel">
            <div className="ha-tabs">
              <span className="ha-tab active"><ClaudeMark />Claude Code</span>
              <span className="ha-tab off">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.142-.08 4.778-2.758a.795.795 0 0 0 .393-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 17.42a4.471 4.471 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 18.95a4.5 4.5 0 0 1-6.14-1.53zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973v5.677a.766.766 0 0 0 .388.677l5.815 3.354-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.787A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.856L13.104 8.36l2.015-1.16a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.677a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.41 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zM8.307 12.863l-2.02-1.164a.08.08 0 0 1-.038-.057V6.074a4.5 4.5 0 0 1 7.376-3.454l-.142.08-4.778 2.759a.795.795 0 0 0-.393.68zm1.097-2.365 2.602-1.5 2.607 1.5v3l-2.597 1.5-2.607-1.5z" /></svg>
                Codex
              </span>
              <span className="ha-tab off">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={faviconUrl("cursor.com")} alt="Cursor" width={14} height={14} style={{ borderRadius: 3, display: "block" }} />
                Cursor
              </span>
            </div>
            <div className="ha-ctx"><span className="ha-ctx-dot" />Context: <strong>Founders</strong> · MCP connected</div>
            <div className="ha-stream" />
            <div className="ha-input">
              <div className="ha-input-text"><span className="ha-ph">Message Claude Code…</span></div>
              <button className="ha-send" tabIndex={-1} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
