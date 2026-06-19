/**
 * useAdaptiveOverscan — velocity-aware virtualization buffer (TRI render-perf).
 *
 * The grid is windowed, so on a FAST scroll WebKit's momentum/compositor scroll
 * can run ahead of the scroll event that re-windows the list and the viewport
 * reaches the blank spacer before React commits the next rows — you watch rows
 * paint in. The obvious fix (a big static overscan) backfires: it forces WebKit
 * to composite ~N extra rows on EVERY scroll frame, so slow/normal scrolling and
 * the resting view get heavier and JANKIER, not smoother.
 *
 * The resolution: size the buffer to the scroll VELOCITY. At rest / slow scroll
 * we keep a small `idle` overscan (cheap frames, clean resting view); during a
 * fast fling — where blank paint-in actually happens, and where extra rows are
 * imperceptible because everything is a blur — we balloon it to `fast` (e.g. 100
 * rows) so the viewport never reaches the unrendered edge. ~`idleMs` after the
 * last scroll we collapse back to `idle` so the resting DOM stays small.
 *
 * One axis per hook (`"y"` for rows, `"x"` for columns); both read the same
 * scroll container. Adds one passive scroll listener and re-renders only on a
 * genuine idle⇄fast transition (the setter is guarded), so the hook itself costs
 * ~2 renders per fling, not one per scroll event.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

export interface AdaptiveOverscanOptions {
  /** Buffer size at rest / slow scroll (small → cheap frames). */
  readonly idle: number;
  /** Buffer size during a fast fling (large → no blank paint-in). */
  readonly fast: number;
  /**
   * Speed (px/ms) at/above which the `fast` buffer engages. ~1 px/ms ≈ 1000 px/s
   * — a deliberate flick, not a slow reading scroll.
   */
  readonly thresholdPxPerMs?: number;
  /** Idle gap (ms) after the last scroll before collapsing back to `idle`. */
  readonly idleMs?: number;
}

/**
 * Returns the overscan to feed the virtualizer for one axis, widened while the
 * scroll velocity on that axis is high and collapsed back when it settles.
 */
export function useAdaptiveOverscan(
  scrollRef: RefObject<HTMLElement | null>,
  axis: "x" | "y",
  { idle, fast, thresholdPxPerMs = 1, idleMs = 120 }: AdaptiveOverscanOptions,
): number {
  const [overscan, setOverscan] = useState(idle);
  // Keep the latest tuning in a ref so the listener never needs re-binding.
  const cfg = useRef({ idle, fast, thresholdPxPerMs, idleMs });
  cfg.current = { idle, fast, thresholdPxPerMs, idleMs };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let lastPos = axis === "y" ? el.scrollTop : el.scrollLeft;
    let lastT = performance.now();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      const pos = axis === "y" ? el.scrollTop : el.scrollLeft;
      const t = performance.now();
      const velocity = Math.abs(pos - lastPos) / Math.max(1, t - lastT);
      lastPos = pos;
      lastT = t;
      const { idle: lo, fast: hi, thresholdPxPerMs: thr, idleMs: gap } = cfg.current;
      if (velocity >= thr) {
        setOverscan((o) => (o === hi ? o : hi)); // guarded: no-op once already fast
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => setOverscan(lo), gap);
      }
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [scrollRef, axis]);

  return overscan;
}
