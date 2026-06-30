/**
 * `useElementWidth` — track a DOM element's content width via `ResizeObserver`.
 *
 * Returns the observed element's width in px, or `null` until it has been
 * measured (first paint). Used by the grid toolbar to collapse its action
 * buttons into an overflow menu when the toolbar gets too narrow — the relevant
 * width is the CONTAINER's, not the viewport's, because the agent side-panel can
 * squeeze the grid to half-width while the window stays wide.
 *
 * Pure DOM + React; no app deps, so it is reusable and unit-testable with a
 * mocked `ResizeObserver`.
 */

import { useEffect, useState, type RefObject } from "react";

export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // Seed synchronously so the first observable render already has a width
    // (avoids a flash of the wrong layout before the observer fires).
    setWidth(el.getBoundingClientRect().width);
    // Guard for non-DOM environments (SSR / older test runners).
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
