/**
 * GridCell — one memoized `<td>` of the shared {@link DataGrid} body.
 *
 * Extracted from DataGrid's inline `renderRow` so the cell is a real
 * `React.memo` boundary (TRI render-perf). The grid is doubly virtualized, but
 * before this every visible `<td>` and its ~6 event closures were rebuilt on
 * EVERY DataGrid re-render and every scroll frame — only the leaf
 * {@link CellContent} memoized, so the wrapper reconciliation still ran for the
 * whole window each frame and saturated the main thread (the source of the
 * scroll/hover jank).
 *
 * Now: a `<GridCell>` skips re-render under the DEFAULT shallow compare whenever
 * its own inputs are unchanged — `cell`/`col` keep their identity (the
 * incremental projector preserves them), the flags are primitives, and every
 * handler is referentially stable (it comes from the parent's memoized
 * `handlers`/controller). So on a horizontal scroll only the newly-entering
 * cells render (the overlap skips), and a single cell update re-renders exactly
 * one `<td>`. The per-cell action closures are built INSIDE the memo, so they
 * allocate only when this cell actually re-renders — not on every parent render.
 *
 * The markup, classes, ARIA and handlers are a verbatim move of the old inline
 * cell — no behavior change.
 */

import { memo, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { CellContent } from "./App";
import { isSyncedColumn } from "./api";
import type { Cell, Column } from "./api";
import type { CellActions, CtxItem, Sel } from "./DataGrid";
import { BotGlyph } from "./PresenceAvatars";
import type { PresenceUser } from "./gridPresence";
import { cellDomId } from "./useGridKeyboardNav";

/** A `<td>` style that also carries the per-cell presence-ring color variable. */
type PresenceTdStyle = CSSProperties & { "--presence-color"?: string };

export interface GridCellProps {
  /** Stable cell-action bundle (built in a parent `useMemo`). */
  readonly actions: CellActions;
  readonly col: Column;
  readonly cell: Cell | undefined;
  readonly rowId: string;
  readonly rowIdx: number;
  readonly colIndex: number;
  /** Other members on this cell (presence ring/chip); undefined = nobody. */
  readonly here: readonly PresenceUser[] | undefined;
  readonly isEditingHere: boolean;
  readonly flash: boolean;
  readonly inSel: boolean;
  readonly isAnchor: boolean;
  readonly isActiveCell: boolean;
  readonly running: boolean;
  readonly waiting: boolean;
  readonly pinnedLeft: number | undefined;
  readonly editSignal: number;
  readonly editSeed: string | undefined;
  readonly tabIndex: 0 | -1;
  /** Number of cells in the active range selection (drives the ctx-menu choice). */
  readonly selCellCount: number;

  // ── Stable handlers (referentially stable so the memo can skip) ──────────
  readonly setSel: Dispatch<SetStateAction<Sel | null>>;
  readonly dragSelRef: { current: boolean };
  readonly dragMovedRef: { current: boolean };
  readonly openCtx: (e: React.MouseEvent, items: CtxItem[]) => void;
  readonly rowCtxItems: (rowId: string, extra?: CtxItem[]) => CtxItem[];
  readonly selectionMenuItems: () => CtxItem[];
  readonly onCellFocus: (row: number, col: number) => void;
}

function GridCellInner({
  actions,
  col,
  cell,
  rowId,
  rowIdx,
  colIndex,
  here,
  isEditingHere,
  flash,
  inSel,
  isAnchor,
  isActiveCell,
  running,
  waiting,
  pinnedLeft,
  editSignal,
  editSeed,
  tabIndex,
  selCellCount,
  setSel,
  dragSelRef,
  dragMovedRef,
  openCtx,
  rowCtxItems,
  selectionMenuItems,
  onCellFocus,
}: GridCellProps) {
  const isPipelineOutput = actions.pipelineOutputColumnIds?.has(col.id) ?? false;
  const runThisCell = isPipelineOutput && actions.runPipelineCell
    ? () => actions.runPipelineCell!(rowId, col.id)
    : col.kind === "function"
      ? () => actions.runCell(rowId, col.id)
      : undefined;
  const tdStyle: PresenceTdStyle | undefined = here || pinnedLeft !== undefined
    ? { ...(here ? { "--presence-color": here[0].color } : {}), ...(pinnedLeft !== undefined ? { left: pinnedLeft } : {}) }
    : undefined;
  return (
    <td
      role="gridcell"
      aria-colindex={colIndex + 1}
      aria-selected={inSel || undefined}
      data-cell={cellDomId(rowIdx, colIndex)}
      tabIndex={tabIndex}
      className={`grid-td${pinnedLeft !== undefined ? " pinned-column" : ""}${here ? " cell-presence" : ""}${isEditingHere ? " presence-editing" : ""}${flash ? " presence-flash" : ""}${inSel ? " cell-selected" : ""}${isAnchor ? " cell-sel-anchor" : ""}`}
      style={tdStyle}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Never hijack interactions with an open inline editor.
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        setSel((s) =>
          e.shiftKey && s
            ? { anchor: s.anchor, head: { r: rowIdx, c: colIndex } }
            : { anchor: { r: rowIdx, c: colIndex }, head: { r: rowIdx, c: colIndex } },
        );
        if (e.shiftKey) e.preventDefault(); // extend, don't start a text selection
        dragSelRef.current = true;
        dragMovedRef.current = false;
      }}
      onMouseEnter={() => {
        if (!dragSelRef.current) return;
        dragMovedRef.current = true;
        setSel((s) => (s ? { anchor: s.anchor, head: { r: rowIdx, c: colIndex } } : s));
      }}
      onFocus={() => {
        onCellFocus(rowIdx, colIndex);
        actions.onActiveCellChange?.({ rowId, colId: col.id });
      }}
      onClickCapture={(e) => {
        // A drag that extended the range must not ALSO open the inline editor of
        // the cell it ended on.
        if (dragMovedRef.current) {
          dragMovedRef.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onClick={
        actions.onActiveCellChange
          ? () => actions.onActiveCellChange!({ rowId, colId: col.id })
          : undefined
      }
      onContextMenu={(e) => {
        // Right-click inside a multi-cell range selection acts on the range;
        // otherwise the row-selection-aware menu applies.
        if (inSel && selCellCount > 1) {
          openCtx(e, selectionMenuItems());
          return;
        }
        openCtx(
          e,
          rowCtxItems(rowId, [
            ...(runThisCell
              ? ([
                  { label: isPipelineOutput ? "Run pipeline" : "Run cell", disabled: !actions.canRun, onClick: runThisCell },
                  ...(actions.openCellDetails
                    ? [{ label: "View cell details", onClick: () => actions.openCellDetails!(col, cell, rowId) }]
                    : []),
                ] satisfies CtxItem[])
              : []),
            {
              label: "Copy value",
              onClick: () => {
                const v = cell?.value;
                const text = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
                void navigator.clipboard?.writeText(text).catch(() => {});
              },
            },
            // Synced (CRM-owned) cells are read-only — clearing would overwrite
            // CRM data with "" and, outside update mode, the loss is permanent.
            ...(isSyncedColumn(col)
              ? []
              : [{ label: "Clear cell", onClick: () => actions.clearCell(rowId, col.id) }]),
          ]),
        );
      }}
    >
      {here && (
        <span
          className="presence-cell-chip"
          style={{ background: here[0].color }}
          title={here
            .map((u) => `${u.name ?? u.userId}${u.isAgent && u.activity ? ` — ${u.activity}` : ""}`)
            .join(", ")}
        >
          {here[0].isAgent ? (
            <BotGlyph size={9} color="#fff" />
          ) : here[0].image ? (
            <img src={here[0].image} alt="" referrerPolicy="no-referrer" />
          ) : (
            (here[0].name ?? "?").slice(0, 1).toUpperCase()
          )}
        </span>
      )}
      <CellContent
        cell={cell}
        col={col}
        onEdit={(v) => actions.setCell(rowId, col.id, v)}
        onEditingChange={
          actions.onEditingCellChange
            ? (ed) => actions.onEditingCellChange!(ed ? { rowId, colId: col.id } : null)
            : undefined
        }
        onOpenDetails={actions.openCellDetails ? () => actions.openCellDetails!(col, cell, rowId) : undefined}
        onExpand={
          actions.expandCell
            ? (anchor) =>
                actions.expandCell!({
                  rowId,
                  colId: col.id,
                  columnName: col.name,
                  value: cell?.value != null ? String(cell.value) : "",
                  editable: col.kind === "manual" && !isSyncedColumn(col),
                  anchor,
                })
            : undefined
        }
        onRunCell={runThisCell}
        running={running}
        waiting={waiting}
        isActive={isActiveCell}
        editSignal={editSignal}
        editSeed={editSeed}
      />
    </td>
  );
}

/**
 * Memoized cell. The default shallow compare is correct here: `cell`/`col` keep
 * their identity across renders (the projector reuses unchanged objects), the
 * flags are primitives, and every handler prop is referentially stable, so an
 * unchanged cell skips re-render even while its row or the grid re-renders.
 */
export const GridCell = memo(GridCellInner);
