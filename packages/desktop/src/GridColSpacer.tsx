/**
 * GridColSpacer (TRI-3286) — the leading/trailing column spacer cells.
 *
 * Column virtualization mounts only the data columns inside the viewport. To
 * keep `table-layout: fixed` widths and the horizontal scrollbar correct, each
 * windowed row (and the header row) pads the unmounted DATA columns with two
 * zero-content spacer cells whose widths come from {@link ColumnWindow.spacers}.
 *
 * The spacers reserve the OFF-SCREEN DATA columns only — the row-number gutter
 * is the grid's own always-present sticky cell and is NOT reserved here (so the
 * gutter is counted exactly once). Render order per row is:
 * gutter cell → left spacer → windowed cells → right spacer → add-column cell.
 *
 * This is the X-axis analogue of the spacer `<tr>`s in `VirtualGridBody`. The
 * header renders them as `<th>` and the body rows as `<td>`, but the
 * width/aria/className handling is identical, so it lives here once.
 */

interface GridColSpacerProps {
  /** Which side of the window this spacer is on (chooses a stable React key). */
  side: "left" | "right";
  /** Pixel width to reserve for the off-screen data columns on this side. */
  width: number;
  /** Render as a `<th>` (header) or `<td>` (body). Defaults to `<td>`. */
  as?: "td" | "th";
}

/**
 * A single zero-content column spacer. Renders nothing when `width <= 0` so the
 * windowed cells sit flush against the gutter / table edge.
 */
export function GridColSpacer({ side, width, as = "td" }: GridColSpacerProps) {
  if (width <= 0) return null;
  const Cell = as;
  return (
    <Cell
      aria-hidden="true"
      className="grid-col-spacer"
      style={{ width, minWidth: width, maxWidth: width, padding: 0, border: "none" }}
      data-spacer={side}
    />
  );
}
