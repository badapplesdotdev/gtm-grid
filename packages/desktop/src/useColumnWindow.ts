/**
 * useColumnWindow (TRI-3286) — horizontal column virtualization for the grids.
 *
 * The X-axis companion to the row virtualization in `VirtualGridBody`. Both the
 * local grid (`App.tsx`) and the cloud grid (`cloud/CloudGrid.tsx`) render a
 * single `<table>` that can grow to hundreds of columns; mounting a `<td>` for
 * every column in every visible row blows up the DOM and WebView memory. This
 * hook wraps `@tanstack/react-virtual`'s horizontal `useVirtualizer` so only the
 * columns inside (and just around) the viewport are materialised.
 *
 * It returns the windowed virtual columns plus the left/right spacer widths
 * ({@link computeColumnSpacers}) that each rendered `<tr>` — and the `<thead>`
 * row — use to reserve the width of the off-screen columns. The spacer-cell
 * pattern (gutter `<th>`/`<td>` → left spacer → windowed cells → right spacer →
 * add-column cell) mirrors the spacer-row pattern used for rows, so
 * `table-layout: fixed` widths, the sticky header and the horizontal scrollbar
 * all stay correct while offscreen columns are unmounted.
 *
 * GUTTER IS RESERVED EXACTLY ONCE (TRI-3286 re-run fix). The row-number gutter
 * is the grid's own always-present sticky cell — it is NOT virtualized here.
 * The virtualizer therefore runs with `paddingStart = 0` and windows ONLY the
 * data columns, so `spacers.left` is the offset of the first visible DATA column
 * with the gutter excluded. Folding the gutter into `paddingStart` (the previous
 * attempt) double-counts it: `item.start` would include the gutter AND the grid
 * still renders the gutter cell, shifting every column right by one gutter and
 * making the table one gutter wider than its wrapper. Do not reintroduce that.
 *
 * The same {@link ColumnWindow} is shared between the header and the body so the
 * header cells and the body cells window to exactly the same column slice and
 * therefore stay aligned at scroll 0 and after horizontal scroll.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { type RefObject } from "react";
import {
  computeColumnSpacers,
  type SpacerWidths,
  type VirtualColItem,
} from "./gridVirtual";

/** The windowed column slice + spacer widths, shared by header and body. */
export interface ColumnWindow {
  /** The data columns currently inside (or just around) the viewport. */
  readonly virtualColumns: readonly VirtualColItem[];
  /**
   * Widths of the leading/trailing spacer cells for the unmounted DATA columns.
   * The gutter is NOT included — it is the grid's own always-present cell.
   */
  readonly spacers: SpacerWidths;
  /**
   * Total pixel width of ALL data columns (the virtualizer's total size). Used
   * by callers to size the `<table>` as `gutter + totalDataWidth + addCol`, so
   * the table is never wider than the off-screen columns it represents.
   */
  readonly totalDataWidth: number;
}

interface UseColumnWindowArgs {
  /** Number of columns in the table (the full, un-windowed count). */
  count: number;
  /** The horizontal scroll container (the `.grid-wrap`). May be `null`. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Resolve the pixel width of the column at `index`. */
  getColumnWidth: (index: number) => number;
  /**
   * Columns rendered left/right of the viewport. The X-axis buffer against
   * windowing latency (see {@link VirtualGridBody}'s `overscan`): on a fast
   * horizontal fling WebKit can scroll past the rendered columns into the blank
   * spacer before React re-windows, so a too-small buffer flashes blank columns.
   */
  overscan?: number;
}

/**
 * Virtualize the table's DATA columns. Returns the windowed column slice, the
 * left/right spacer widths to pad the unmounted columns with, and the total
 * data-column width. The gutter is reserved by the caller's own gutter cell and
 * is deliberately NOT part of this window.
 */
export function useColumnWindow({
  count,
  scrollRef,
  getColumnWidth,
  overscan = 8,
}: UseColumnWindowArgs): ColumnWindow {
  const virtualizer = useVirtualizer({
    horizontal: true,
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: getColumnWidth,
    overscan,
    // The row-number gutter is the grid's own sticky cell, rendered once before
    // these columns. It is NOT part of the virtualized range, so paddingStart
    // stays 0 — the window covers ONLY the data columns and `spacers.left` is
    // the first visible data column's offset with the gutter excluded.
    paddingStart: 0,
  });

  const virtualColumns = virtualizer.getVirtualItems();
  const totalDataWidth = virtualizer.getTotalSize();
  const spacers = computeColumnSpacers(virtualColumns, totalDataWidth);

  return { virtualColumns, spacers, totalDataWidth };
}
