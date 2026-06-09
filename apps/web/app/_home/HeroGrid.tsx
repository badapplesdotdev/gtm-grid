"use client";

// The hero's live grid. Ports project/gtm-grid/hero-grid.js to React: the table
// is rendered as JSX (so it's in the SSR HTML), then a post-mount effect plays
// the real product lifecycle per function cell — empty → running (spinner) →
// done (value | "200" pill) — looping continuously, paused for reduced motion.
// Function names mirror real connector/AI methods (trigify.enrichProfile,
// leadmagic.findEmail, ai.generate).

import { useEffect, useRef } from "react";

interface Col {
  readonly name: string;
  readonly kind: "manual" | "fn";
  readonly fn?: string;
  readonly w: number;
  readonly json?: boolean;
}
interface Row {
  readonly name: string;
  readonly company: string;
  readonly Title: string;
  readonly Fit: string;
}

const COLS: readonly Col[] = [
  { name: "Name", kind: "manual", w: 150 },
  { name: "Company", kind: "manual", w: 130 },
  { name: "Title", kind: "fn", fn: "trigify.enrichProfile", w: 150 },
  { name: "Email", kind: "fn", fn: "leadmagic.findEmail", w: 120, json: true },
  { name: "Fit", kind: "fn", fn: "ai.generate", w: 78 },
];

const ROWS: readonly Row[] = [
  { name: "Alex Rivera", company: "Linear", Title: "Head of Growth", Fit: "94" },
  { name: "Maya Chen", company: "Ramp", Title: "VP Sales", Fit: "88" },
  { name: "Jordan Okafor", company: "Vercel", Title: "Founding AE", Fit: "91" },
  { name: "Priya Nair", company: "Retool", Title: "RevOps Lead", Fit: "79" },
  { name: "Sam Delgado", company: "Clay", Title: "GTM Engineer", Fit: "96" },
  { name: "Noa Friedman", company: "Cursor", Title: "Head of Sales", Fit: "85" },
  { name: "Liam Walsh", company: "Browserbase", Title: "Founder", Fit: "90" },
];

const FN_COLS = COLS.filter((c) => c.kind === "fn");

const EMPTY = `<span class="cell-empty">—</span>`;
const RUN = `<span class="cell-run"><span class="spinner"></span>running</span>`;
const PILL_STATIC = `<span class="status-pill ok">Status Code: 200</span>`;
const val = (v: string) => `<span class="cell-val cell-enter">${v}</span>`;
const pill = () => `<span class="status-pill ok cell-enter">Status Code: 200</span>`;

export function HeroGrid() {
  const rootRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const t = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      timers.push(id);
      return id;
    };
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
    };

    const rows = Array.from(root.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    const total = rows.length * FN_COLS.length;
    const setCounter = (cur: number) => {
      const el = runRef.current?.querySelector(".runtxt");
      if (el) el.textContent = cur >= total ? "Run" : `Running ${cur}/${total}`;
    };

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      rows.forEach((tr, ri) =>
        FN_COLS.forEach((c) => {
          const cell = tr.querySelector(`[data-cell="${c.name}"]`);
          if (cell) cell.innerHTML = c.json ? PILL_STATIC : `<span class="cell-val">${ROWS[ri][c.name as "Title" | "Fit"]}</span>`;
        }),
      );
      setCounter(1);
      return;
    }

    const play = () => {
      clearTimers();
      rows.forEach((tr) =>
        FN_COLS.forEach((c) => {
          const cell = tr.querySelector(`[data-cell="${c.name}"]`);
          if (cell) cell.innerHTML = EMPTY;
        }),
      );
      setCounter(0);

      let delay = 420;
      let done = 0;
      rows.forEach((tr, ri) => {
        FN_COLS.forEach((c) => {
          const cell = tr.querySelector(`[data-cell="${c.name}"]`);
          if (!cell) return;
          const startAt = delay;
          const dur = 520 + ((ri * 7 + c.name.length * 13) % 420); // deterministic jitter
          t(() => {
            cell.innerHTML = RUN;
          }, startAt);
          t(() => {
            cell.innerHTML = c.json ? pill() : val(ROWS[ri][c.name as "Title" | "Fit"]);
            if (ri % 2 === 0 || c.name === "Fit") {
              tr.classList.add("flash");
              t(() => tr.classList.remove("flash"), 520);
            }
            done++;
            setCounter(done);
          }, startAt + dur);
          delay = startAt + dur * 0.42; // overlap → bounded-concurrency feel
        });
      });
      t(play, delay + 2600); // hold finished grid, then loop
    };

    // Start once the grid scrolls into view (or immediately if already visible).
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      play();
    };
    let io: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) {
              start();
              io?.disconnect();
            }
          });
        },
        { threshold: 0.2 },
      );
      io.observe(root);
    } else {
      start();
    }

    return () => {
      clearTimers();
      io?.disconnect();
    };
  }, []);

  return (
    <div className="frame-shell">
      <div className="frame-glow" />
      <div className="window">
        <div className="win-bar">
          <div className="traffic"><i /><i /><i /></div>
          <div className="win-title">
            Founders <span className="meta">· 7 rows · 5 cols</span>
          </div>
          <span className="win-online">online</span>
          <span className="win-run" ref={runRef}>
            <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            <span className="runtxt">Run</span>
          </span>
        </div>
        <div ref={rootRef}>
          <div className="lg-scroll">
            <table className="lg">
              <colgroup>
                <col style={{ width: 44 }} />
                {COLS.map((c) => (
                  <col key={c.name} style={{ width: c.w }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="rownum" />
                  {COLS.map((c) => (
                    <th key={c.name}>
                      <div className="th-inner">
                        <span>{c.name}</span>
                        {c.kind === "fn" && c.fn ? (
                          <span className="fn-badge">{c.fn.split(".").pop()}</span>
                        ) : null}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r, i) => (
                  <tr key={r.name}>
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
      </div>
    </div>
  );
}
