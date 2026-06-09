/**
 * Row-virtualization helpers for the spreadsheet grids (TRI-3267).
 *
 * Both the local grid (`App.tsx`) and the cloud grid (`cloud/CloudGrid.tsx`)
 * render a single `<table>` with a sticky `<thead>`. To keep the DOM (and the
 * WebView memory) bounded at 10k+ rows we mount only the rows inside (and just
 * around) the viewport via `@tanstack/react-virtual`'s `useVirtualizer`, then
 * pad the `<tbody>` with two zero-content spacer rows so the scrollbar height
 * and the column-width layout of the `<table>` stay correct.
 *
 * The "spacer row" pattern (top spacer → visible rows → bottom spacer) is used
 * instead of absolute-positioning each `<tr>` because absolute positioning
 * breaks `table-layout: fixed` column alignment and the sticky header. The math
 * for the two spacers is the only piece of the virtualization that is pure and
 * worth unit-testing, so it lives here and is consumed by both grids.
 */

/** A virtual item as produced by `Virtualizer.getVirtualItems()`. */
export interface VirtualRowItem {
  /** Index into the underlying row array. */
  readonly index: number;
  /** Pixel offset of the row's top edge from the start of the list. */
  readonly start: number;
  /** Pixel offset of the row's bottom edge (`start + size`). */
  readonly end: number;
}

/** Heights (px) of the leading and trailing spacer `<tr>`s. */
export interface SpacerHeights {
  /** Height of the spacer above the first rendered row. */
  readonly top: number;
  /** Height of the spacer below the last rendered row. */
  readonly bottom: number;
}

/**
 * Compute the top/bottom spacer heights for a windowed `<tbody>`.
 *
 * - `top` = the offset of the first rendered virtual row (empty space scrolled
 *   past above the window).
 * - `bottom` = the remaining list height below the last rendered row
 *   (`totalSize - lastRow.end`).
 *
 * When nothing is rendered (empty list, or before measurement) the whole list
 * height collapses into the top spacer so the scroll area is still correct.
 *
 * Both results are clamped to `>= 0` so a transient over-measurement (the
 * virtualizer can briefly report an `end` past `totalSize` mid-scroll) never
 * produces a negative `<tr>` height, which the WebView would render as 0 and
 * jump the scroll position.
 */
export function computeSpacerHeights(
  virtualRows: readonly VirtualRowItem[],
  totalSize: number,
): SpacerHeights {
  if (virtualRows.length === 0) {
    return { top: Math.max(0, totalSize), bottom: 0 };
  }
  const first = virtualRows[0];
  const last = virtualRows[virtualRows.length - 1];
  return {
    top: Math.max(0, first.start),
    bottom: Math.max(0, totalSize - last.end),
  };
}

/**
 * A virtual COLUMN item as produced by a horizontal `Virtualizer`. Mirrors
 * {@link VirtualRowItem} but on the X axis — `start`/`end` are pixel offsets
 * along the table's DATA-column width (the row-number gutter is NOT part of the
 * virtualized range; see {@link computeColumnSpacers}).
 */
export interface VirtualColItem {
  /** Index into the underlying column array. */
  readonly index: number;
  /** Pixel offset of the column's left edge from the start of the data columns. */
  readonly start: number;
  /** Pixel offset of the column's right edge (`start + width`). */
  readonly end: number;
}

/** Widths (px) of the leading and trailing spacer `<td>`/`<th>` cells. */
export interface SpacerWidths {
  /** Width of the spacer to the LEFT of the first rendered data column. */
  readonly left: number;
  /** Width of the spacer to the RIGHT of the last rendered data column. */
  readonly right: number;
}

/**
 * Compute the left/right spacer widths for a windowed row of cells — the
 * X-axis analogue of {@link computeSpacerHeights}.
 *
 * Column virtualization (TRI-3286) mounts only the columns inside (and just
 * around) the viewport. To keep `table-layout: fixed` widths, the sticky header
 * and the horizontal scrollbar correct, each rendered `<tr>` (and the `<thead>`
 * row) pads the unmounted DATA columns with two zero-content spacer cells:
 * `left` reserves the width of every data column scrolled past on the left, and
 * `right` reserves the width of every data column still off-screen to the right
 * (`totalSize - lastColumn.end`).
 *
 * IMPORTANT — gutter is reserved EXACTLY ONCE (TRI-3286 re-run fix). The
 * row-number gutter is rendered by each grid as its own always-present sticky
 * `<th>`/`<td>`; it is NOT part of the virtualized column range. Callers MUST
 * therefore drive the virtualizer with `paddingStart = 0` and pass a
 * `totalSize` covering ONLY the data columns, so `left` is the offset of the
 * first visible DATA column with the gutter EXCLUDED. (The previous attempt
 * folded the gutter into `paddingStart`, which baked it into both `start` and
 * the always-present gutter cell, shifting every column right by one gutter and
 * making the table one gutter wider than its wrapper. Do not reintroduce that.)
 *
 * When no columns are rendered the whole data-column width collapses into the
 * left spacer so the scroll area stays correct. Both results are clamped to
 * `>= 0` so a transient over-measurement mid-scroll never yields a negative
 * cell width.
 */
export function computeColumnSpacers(
  virtualColumns: readonly VirtualColItem[],
  totalSize: number,
): SpacerWidths {
  if (virtualColumns.length === 0) {
    return { left: Math.max(0, totalSize), right: 0 };
  }
  const first = virtualColumns[0];
  const last = virtualColumns[virtualColumns.length - 1];
  return {
    left: Math.max(0, first.start),
    right: Math.max(0, totalSize - last.end),
  };
}

/** Fallback row height (px) — matches the default `--row-h` in styles.css. */
export const DEFAULT_ROW_HEIGHT = 34;

/**
 * Resolve the current grid row height (px) from the CSS `--row-h` custom
 * property so virtualization estimates track the active density
 * (compact 30 / default 34 / comfortable 44). Falls back to
 * {@link DEFAULT_ROW_HEIGHT} outside the browser or when the variable is unset.
 */
export function resolveRowHeight(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return DEFAULT_ROW_HEIGHT;
  }
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--row-h")
    .trim();
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : DEFAULT_ROW_HEIGHT;
}
