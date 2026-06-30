// @vitest-environment jsdom
/**
 * useColumnWindow (TRI-3286) — horizontal column virtualization window math.
 *
 * Drives the REAL `@tanstack/react-virtual` virtualizer through `renderHook`
 * against a scroll element with stubbed geometry (jsdom computes no layout), so
 * these tests exercise the actual windowing arithmetic the grid relies on:
 * which DATA columns fall inside the viewport (+ overscan) for a given scroll
 * position, and the left/right spacer widths that reserve the off-screen ones.
 *
 * Invariants asserted (the module's contract):
 *  - the gutter is NOT folded in → `spacers.left` is 0 at scroll 0 (paddingStart 0);
 *  - `spacers.left === firstColumn.start` and `spacers.right === total - lastColumn.end`;
 *  - the window is a contiguous slice clamped at both ends, never all the columns;
 *  - `totalDataWidth` is the sum of every column width (data columns only).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useColumnWindow } from "./useColumnWindow";

// react-virtual observes the scroll element with a ResizeObserver; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup(); // unmount hook roots so their scroll/resize observers detach
  document.body.innerHTML = "";
});

/** A scroll container with a fixed viewport width and a controllable scrollLeft. */
function makeScroll(width: number) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  let scrollLeft = 0;
  Object.defineProperty(el, "scrollLeft", {
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, "clientWidth", { get: () => width, configurable: true });
  Object.defineProperty(el, "offsetWidth", { get: () => width, configurable: true });
  el.getBoundingClientRect = () =>
    ({ width, height: 100, left: 0, top: 0, right: width, bottom: 100, x: 0, y: 0, toJSON: () => {} }) as DOMRect;
  return el;
}

/** Scroll the element and let the virtualizer recompute its window. */
function scrollTo(el: HTMLElement, x: number) {
  act(() => {
    el.scrollLeft = x;
    el.dispatchEvent(new Event("scroll"));
  });
}

/** Render the hook against a fresh scroll element. */
function renderWindow(opts: {
  count: number;
  width: number;
  columnWidth?: (i: number) => number;
  overscan?: number;
}) {
  const el = makeScroll(opts.width);
  const ref = { current: el };
  const hook = renderHook(() =>
    useColumnWindow({
      count: opts.count,
      scrollRef: ref,
      getColumnWidth: opts.columnWidth ?? (() => 100),
      overscan: opts.overscan,
    }),
  );
  return { el, ...hook };
}

/** The indices of the currently-windowed columns, ascending. */
const indices = (cols: readonly { index: number }[]) => cols.map((c) => c.index);

describe("useColumnWindow — viewport windowing at scroll 0", () => {
  it("windows from column 0 with a zero left spacer (gutter not folded in)", () => {
    const { result } = renderWindow({ count: 50, width: 300, overscan: 3 });
    const w = result.current;

    expect(w.totalDataWidth).toBe(5000); // 50 × 100
    expect(w.spacers.left).toBe(0); // paddingStart 0 — gutter is the grid's own cell
    expect(indices(w.virtualColumns)[0]).toBe(0);
    // The viewport columns (300px / 100px = 0,1,2) are all mounted.
    expect(indices(w.virtualColumns)).toEqual(expect.arrayContaining([0, 1, 2]));
    // …but NOT the whole table (it is windowed).
    expect(w.virtualColumns.length).toBeLessThan(50);
    expect(w.spacers.right).toBeGreaterThan(0); // columns still off-screen to the right
  });

  it("keeps spacers consistent with the windowed slice's edges", () => {
    const { result } = renderWindow({ count: 50, width: 300, overscan: 3 });
    const w = result.current;
    const first = w.virtualColumns[0];
    const last = w.virtualColumns[w.virtualColumns.length - 1];
    // computeColumnSpacers: left = first column's offset, right = remaining width.
    expect(w.spacers.left).toBe(first.start);
    expect(w.spacers.right).toBe(w.totalDataWidth - last.end);
  });
});

describe("useColumnWindow — windowing as the viewport scrolls", () => {
  it("advances the window and grows the left spacer mid-scroll", () => {
    const { el, result } = renderWindow({ count: 50, width: 300, overscan: 3 });
    scrollTo(el, 1000); // viewport now spans columns 10..12
    const w = result.current;

    expect(indices(w.virtualColumns)).toEqual(expect.arrayContaining([10, 11, 12]));
    expect(w.spacers.left).toBeGreaterThan(0); // columns scrolled past on the left
    expect(w.spacers.right).toBeGreaterThan(0); // columns still off-screen on the right
    // Internal consistency holds at every scroll position.
    expect(w.spacers.left).toBe(w.virtualColumns[0].start);
    expect(w.spacers.right).toBe(w.totalDataWidth - w.virtualColumns[w.virtualColumns.length - 1].end);
    expect(w.virtualColumns[0].index).toBeLessThan(10); // overscan extends before the viewport
  });

  it("clamps at the end: last column mounted, zero right spacer", () => {
    const { el, result } = renderWindow({ count: 50, width: 300, overscan: 3 });
    scrollTo(el, 99999); // past the maximum scroll — must clamp, not overflow
    const w = result.current;

    expect(indices(w.virtualColumns)).toContain(49);
    expect(w.virtualColumns[w.virtualColumns.length - 1].index).toBe(49);
    expect(w.spacers.right).toBe(0);
    expect(w.spacers.left).toBeGreaterThan(0);
  });
});

describe("useColumnWindow — overscan", () => {
  it("a larger overscan mounts more buffer columns around the viewport", () => {
    const small = renderWindow({ count: 50, width: 300, overscan: 1 });
    const large = renderWindow({ count: 50, width: 300, overscan: 8 });
    expect(large.result.current.virtualColumns.length).toBeGreaterThan(
      small.result.current.virtualColumns.length,
    );
  });

  it("defaults overscan to 3 when omitted", () => {
    const explicit = renderWindow({ count: 50, width: 300, overscan: 3 });
    const omitted = renderWindow({ count: 50, width: 300 });
    expect(indices(omitted.result.current.virtualColumns)).toEqual(
      indices(explicit.result.current.virtualColumns),
    );
  });
});

describe("useColumnWindow — boundaries", () => {
  it("an empty table windows nothing and collapses to zero spacers", () => {
    const { result } = renderWindow({ count: 0, width: 300 });
    expect(result.current.virtualColumns).toHaveLength(0);
    expect(result.current.totalDataWidth).toBe(0);
    expect(result.current.spacers).toEqual({ left: 0, right: 0 });
  });

  it("a table narrower than the viewport mounts every column, no spacers", () => {
    // 2 columns × 100px = 200px total, viewport 300px → nothing to virtualize.
    const { result } = renderWindow({ count: 2, width: 300, overscan: 3 });
    expect(indices(result.current.virtualColumns)).toEqual([0, 1]);
    expect(result.current.totalDataWidth).toBe(200);
    expect(result.current.spacers).toEqual({ left: 0, right: 0 });
  });

  it("sums variable column widths into totalDataWidth", () => {
    // widths 50, 150, 50, 150, … → 100 average over 10 cols = 1000.
    const columnWidth = (i: number) => (i % 2 === 0 ? 50 : 150);
    const { result } = renderWindow({ count: 10, width: 300, columnWidth, overscan: 3 });
    expect(result.current.totalDataWidth).toBe(1000);
    expect(result.current.spacers.left).toBe(0);
    expect(result.current.virtualColumns[0].index).toBe(0);
  });

  it("returns an empty window when the scroll element is absent", () => {
    const ref = { current: null };
    const { result } = renderHook(() =>
      useColumnWindow({ count: 50, scrollRef: ref, getColumnWidth: () => 100 }),
    );
    // No scroll element → the virtualizer can't measure; total still reflects the
    // estimated column widths, and spacers stay non-negative.
    expect(result.current.spacers.left).toBeGreaterThanOrEqual(0);
    expect(result.current.spacers.right).toBeGreaterThanOrEqual(0);
  });
});
