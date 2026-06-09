/**
 * Tests for the grid row-virtualization spacer math (TRI-3267).
 *
 * The rendering itself (mounting only viewport rows) is owned by
 * `@tanstack/react-virtual`; the testable LOGIC the grids add on top is the
 * pair of spacer `<tr>` heights that keep the `<table>` scrollbar + column
 * layout correct while offscreen rows are unmounted. We assert that, for a
 * given virtual window, the spacers exactly account for every offscreen pixel
 * (top + rendered span + bottom === totalSize) across the edge cases the grids
 * hit: top of list, middle, bottom, empty list, and transient over-measurement.
 */

import { describe, expect, it } from "vitest";
import {
  computeColumnSpacers,
  computeSpacerHeights,
  type VirtualColItem,
  type VirtualRowItem,
} from "./gridVirtual";

const ROW_H = 34;
const COL_W = 180;

/** Build a contiguous window of virtual rows like the virtualizer produces. */
const window = (startIndex: number, count: number): VirtualRowItem[] =>
  Array.from({ length: count }, (_, i) => {
    const index = startIndex + i;
    const start = index * ROW_H;
    return { index, start, end: start + ROW_H };
  });

describe("computeSpacerHeights", () => {
  it("collapses the full list height into the top spacer when nothing is rendered", () => {
    const total = 10_000 * ROW_H;
    expect(computeSpacerHeights([], total)).toEqual({ top: total, bottom: 0 });
  });

  it("has no top spacer at the very top of the list", () => {
    const total = 10_000 * ROW_H;
    const rows = window(0, 30);
    const { top, bottom } = computeSpacerHeights(rows, total);
    expect(top).toBe(0);
    expect(bottom).toBe(total - 30 * ROW_H);
  });

  it("accounts for offscreen pixels above and below in the middle of the list", () => {
    const total = 10_000 * ROW_H;
    const rows = window(5_000, 30); // window starting at row 5000
    const { top, bottom } = computeSpacerHeights(rows, total);
    expect(top).toBe(5_000 * ROW_H);
    // top + rendered span + bottom must reconstruct the whole list height.
    const renderedSpan = 30 * ROW_H;
    expect(top + renderedSpan + bottom).toBe(total);
  });

  it("has no bottom spacer at the very bottom of the list", () => {
    const total = 10_000 * ROW_H;
    const rows = window(9_970, 30); // last 30 rows
    const { top, bottom } = computeSpacerHeights(rows, total);
    expect(bottom).toBe(0);
    expect(top).toBe(9_970 * ROW_H);
  });

  it("never returns negative heights when measurement transiently overshoots totalSize", () => {
    // Virtualizer can briefly report an `end` past totalSize mid-scroll.
    const rows: VirtualRowItem[] = [
      { index: 0, start: -10, end: 24 },
      { index: 1, start: 24, end: 58 },
    ];
    const { top, bottom } = computeSpacerHeights(rows, 40);
    expect(top).toBe(0); // clamped from -10
    expect(bottom).toBe(0); // clamped from 40 - 58
  });

  it("scales to 10k rows without enumerating every row", () => {
    // The whole point of virtualization: a small window over a huge list.
    const total = 10_000 * ROW_H;
    const rows = window(4_000, 25);
    const { top, bottom } = computeSpacerHeights(rows, total);
    expect(rows.length).toBe(25); // only the window is materialised
    expect(top + 25 * ROW_H + bottom).toBe(total);
  });
});

/**
 * Column virtualization (TRI-3286) — the X-axis mirror of the row spacer math,
 * asserting the REAL rendering invariant after the re-run gutter-double-count
 * fix.
 *
 * The grids render, per row: gutter cell → left spacer → windowed data cells →
 * right spacer → add-column cell. The gutter is the grid's own always-present
 * sticky cell and is reserved EXACTLY ONCE — it is NOT part of the virtualized
 * column range. The virtualizer therefore runs with `paddingStart = 0`, so
 * `totalSize` and every `start`/`end` cover ONLY the data columns and the left
 * spacer EXCLUDES the gutter.
 *
 * The load-bearing invariant the grids depend on is the full table width:
 *
 *   GUTTER + computeColumnSpacers.left
 *          + sum(visible column widths)
 *          + computeColumnSpacers.right
 *          + ADD_COL
 *   === GUTTER + totalDataWidth + ADD_COL  (the wrapper's declared width)
 *
 * i.e. the rendered leading width is the gutter PLUS the left spacer (never the
 * gutter twice), and the table is never wider than its wrapper. We assert this
 * at scroll 0 AND after a horizontal scroll offset, and explicitly that the
 * left spacer is NOT the gutter (the previous attempt's bug, which made the
 * table one gutter wider with a blank gap at the left edge).
 */

const GUTTER = 48;
const ADD_COL = 44;

/**
 * Build a contiguous window of virtual DATA columns like the horizontal
 * virtualizer produces with `paddingStart = 0` (gutter excluded — offsets start
 * at 0 for the first data column).
 */
const colWindow = (startIndex: number, count: number): VirtualColItem[] =>
  Array.from({ length: count }, (_, i) => {
    const index = startIndex + i;
    const start = index * COL_W;
    return { index, start, end: start + COL_W };
  });

describe("computeColumnSpacers", () => {
  it("collapses the full data width into the left spacer when nothing is rendered", () => {
    const total = 300 * COL_W;
    expect(computeColumnSpacers([], total)).toEqual({ left: total, right: 0 });
  });

  it("reserves the gutter EXACTLY ONCE at scroll 0 — left spacer is 0, NOT the gutter", () => {
    const totalDataWidth = 300 * COL_W;
    const cols = colWindow(0, 10);
    const { left, right } = computeColumnSpacers(cols, totalDataWidth);
    // The first data column sits flush after the gutter cell, so the left spacer
    // is 0 — it does NOT carry the gutter (that codified the prior bug).
    expect(left).toBe(0);
    expect(left).not.toBe(GUTTER);
    // Full wrapper width reconstructs with the gutter counted exactly once.
    const visibleSpan = 10 * COL_W;
    const wrapperWidth = GUTTER + totalDataWidth + ADD_COL;
    expect(GUTTER + left + visibleSpan + right + ADD_COL).toBe(wrapperWidth);
  });

  it("keeps the full-width invariant after a horizontal scroll offset", () => {
    const totalDataWidth = 300 * COL_W;
    const visibleCount = 10;
    const startCol = 150; // scrolled into the middle of the table
    const cols = colWindow(startCol, visibleCount);
    const { left, right } = computeColumnSpacers(cols, totalDataWidth);
    // Left spacer is the offset of the first visible DATA column (gutter NOT
    // included), so it is the width of the columns scrolled past.
    expect(left).toBe(startCol * COL_W);
    const visibleSpan = visibleCount * COL_W;
    const wrapperWidth = GUTTER + totalDataWidth + ADD_COL;
    // gutter + left + visible + right + addCol === wrapper width (gutter once).
    expect(GUTTER + left + visibleSpan + right + ADD_COL).toBe(wrapperWidth);
    // And the table is not wider than its wrapper.
    expect(left + visibleSpan + right).toBe(totalDataWidth);
  });

  it("has no right spacer at the very right of the table", () => {
    const totalDataWidth = 300 * COL_W;
    const cols = colWindow(290, 10); // last 10 columns
    const { left, right } = computeColumnSpacers(cols, totalDataWidth);
    expect(right).toBe(0);
    expect(left).toBe(290 * COL_W);
  });

  it("never returns negative widths when measurement transiently overshoots totalSize", () => {
    // The virtualizer can briefly report an `end` past totalSize mid-scroll.
    const cols: VirtualColItem[] = [
      { index: 0, start: -10, end: 170 },
      { index: 1, start: 170, end: 350 },
    ];
    const { left, right } = computeColumnSpacers(cols, 200);
    expect(left).toBe(0); // clamped from -10
    expect(right).toBe(0); // clamped from 200 - 350
  });

  it("scales to hundreds of columns without enumerating every column", () => {
    // A small window over a very wide table: only the window is materialised.
    const totalDataWidth = 500 * COL_W;
    const cols = colWindow(200, 12);
    const { left, right } = computeColumnSpacers(cols, totalDataWidth);
    expect(cols.length).toBe(12); // only the window is materialised
    expect(left + 12 * COL_W + right).toBe(totalDataWidth);
  });
});
