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
