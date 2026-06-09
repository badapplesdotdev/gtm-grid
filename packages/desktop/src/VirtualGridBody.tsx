/**
 * VirtualGridBody (TRI-3267) — the windowed `<tbody>` shared by both grids.
 *
 * Wraps `@tanstack/react-virtual`'s `useVirtualizer` so the local grid
 * (`App.tsx`) and the cloud grid (`cloud/CloudGrid.tsx`) mount only the rows
 * inside (and just around) the viewport. Offscreen rows are NOT in the DOM,
 * which keeps the node count and WebView memory bounded at 10k+ rows.
 *
 * It uses the "spacer row" pattern (top spacer `<tr>` → rendered rows → bottom
 * spacer `<tr>`) rather than absolute-positioning each `<tr>`: absolute
 * positioning breaks `table-layout: fixed` column widths and the sticky
 * `<thead>`. The spacer heights come from {@link computeSpacerHeights}, which is
 * unit-tested. Each visible row is rendered via the `renderRow` render-prop so
 * each grid keeps its own cell markup, context menus and `CellContent` props —
 * the component owns only the virtualization machinery, not the cell content.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, type RefObject } from "react";
import { computeSpacerHeights } from "./gridVirtual";

interface VirtualGridBodyProps<Row> {
  /** The full row list. Only the windowed slice is mounted. */
  rows: readonly Row[];
  /**
   * The scroll container element (the `.grid-wrap`). The virtualizer reads
   * scroll position from this. May be `null` before mount.
   */
  scrollRef: RefObject<HTMLElement | null>;
  /** Pixel height of one row (matches the CSS `--row-h` for the density). */
  rowHeight: number;
  /** Rows rendered above/below the viewport to avoid blank flashes on scroll. */
  overscan?: number;
  /**
   * Number of trailing `<td>`s a spacer row must span so the spacer keeps the
   * `<table>` column layout intact: row-number gutter + data columns + the
   * trailing add/delete column.
   */
  colSpan: number;
  /** Render the cells for one row (the `<td>`s inside its `<tr>`). */
  renderRow: (row: Row, index: number) => ReactNode;
}

/**
 * Renders a virtualized `<tbody>`. Must be placed directly inside a `<table>`.
 */
export function VirtualGridBody<Row>({
  rows,
  scrollRef,
  rowHeight,
  overscan = 8,
  colSpan,
  renderRow,
}: VirtualGridBodyProps<Row>) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const { top, bottom } = computeSpacerHeights(
    virtualRows,
    virtualizer.getTotalSize(),
  );

  return (
    <tbody>
      {top > 0 && (
        <tr aria-hidden="true" className="grid-spacer-row">
          <td colSpan={colSpan} style={{ height: top, padding: 0, border: "none" }} />
        </tr>
      )}
      {virtualRows.map((vr) => renderRow(rows[vr.index], vr.index))}
      {bottom > 0 && (
        <tr aria-hidden="true" className="grid-spacer-row">
          <td colSpan={colSpan} style={{ height: bottom, padding: 0, border: "none" }} />
        </tr>
      )}
    </tbody>
  );
}
