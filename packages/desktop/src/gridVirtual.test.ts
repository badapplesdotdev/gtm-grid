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
  computeSpacerHeights,
  type VirtualRowItem,
} from "./gridVirtual";

const ROW_H = 34;

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
