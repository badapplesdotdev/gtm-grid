/**
 * GridRow — one memoized `<tr>` of the shared {@link DataGrid} body.
 *
 * Extracted from DataGrid's inline `renderRow` render-prop so each row is a real
 * `React.memo` boundary (TRI render-perf). Before this, every visible row's
 * `<tr>`/`<td>` subtree re-ran on EVERY DataGrid re-render and every scroll frame
 * even when nothing about the row changed — the per-frame cost behind the
 * scroll/hover jank.
 *
 * The two cross-cutting bundles — {@link GridRowInteraction} (selection, presence,
 * active cell, run/flash state) and {@link GridRowHandlers} (the stable callbacks)
 * — are each a single object the parent memoizes, so on a pure VERTICAL scroll
 * they keep their identity and every row that stayed in the window skips. The
 * comparator deliberately compares `columnWindowKey` (a cheap structural string)
 * instead of the `columnWindow` object, which `@tanstack/react-virtual` rebuilds
 * every render: that lets vertical scroll skip while a HORIZONTAL scroll (key
 * changes) re-renders rows so they window the new column slice — where the
 * {@link GridCell} memo then skips the overlapping cells.
 *
 * On a realtime/optimistic cell update only the changed row's `row` identity
 * changes (the incremental projector preserves the others), so exactly that one
 * row re-renders. Markup is a verbatim move of the old inline row.
 */

import { memo, type Dispatch, type SetStateAction } from "react";
import type { Column, Row } from "./api";
import type { CellActions, CtxItem, Sel, SelRect } from "./DataGrid";
import { GridCell } from "./GridCell";
import { GridColSpacer } from "./GridColSpacer";
import { type PresenceUser, presenceCellKey } from "./gridPresence";
import type { ActiveCell } from "./useGridKeyboardNav";
import type { ColumnWindow } from "./useColumnWindow";
import { cellIsRunning } from "./gridRun";

/** Cross-cutting interaction state shared by every cell in the row. */
export interface GridRowInteraction {
  readonly selRect: SelRect | null;
  readonly sel: Sel | null;
  readonly selCellCount: number;
  readonly activeCell: ActiveCell | null;
  readonly editSignal: number;
  readonly getEditSeed: () => string | undefined;
  readonly presenceByCell: ReadonlyMap<string, readonly PresenceUser[]> | undefined;
  readonly flashCell: string | null;
  readonly runningCells: ReadonlySet<string>;
  /** The column currently running via a column-level run (header / save & run),
   *  or null. Its not-yet-resolved cells render a loading state immediately —
   *  before the per-cell `status: "running"` realtime patches arrive. */
  readonly runningColId: string | null;
  readonly waitingByCol: ReadonlyMap<string, string[]>;
  readonly pinnedLeftByCol: ReadonlyMap<string, number>;
}

/** The stable callbacks the row + its cells fire (all referentially stable). */
export interface GridRowHandlers {
  readonly toggleRow: (rowId: string, shiftKey: boolean) => void;
  readonly openCtx: (e: React.MouseEvent, items: CtxItem[]) => void;
  readonly rowCtxItems: (rowId: string, extra?: CtxItem[]) => CtxItem[];
  readonly selectionMenuItems: () => CtxItem[];
  readonly setSel: Dispatch<SetStateAction<Sel | null>>;
  readonly dragSelRef: { current: boolean };
  readonly dragMovedRef: { current: boolean };
  readonly onCellFocus: (row: number, col: number) => void;
  readonly cellTabIndex: (rowIdx: number, colIdx: number) => 0 | -1;
}

export interface GridRowProps {
  /** Stable cell-action bundle (decoupled from the controller object). */
  readonly actions: CellActions;
  readonly row: Row;
  readonly rowIdx: number;
  /** The full column list (stable identity; the projector reuses it). */
  readonly columns: readonly Column[];
  /** The windowed column slice — rebuilt every render (compared via the key). */
  readonly columnWindow: ColumnWindow;
  /** Structural signature of `columnWindow` used by the memo comparator. */
  readonly columnWindowKey: string;
  readonly selected: boolean;
  readonly interaction: GridRowInteraction;
  readonly handlers: GridRowHandlers;
}

function GridRowInner({
  actions,
  row,
  rowIdx,
  columns,
  columnWindow,
  selected,
  interaction,
  handlers,
}: GridRowProps) {
  const { selRect, sel, activeCell, runningCells, runningColId, waitingByCol, presenceByCell, pinnedLeftByCol } = interaction;
  return (
    <tr
      role="row"
      aria-rowindex={rowIdx + 1}
      aria-selected={selected}
      className={`grid-tr${selected ? " is-selected" : ""}`}
    >
      <td
        className="grid-td row-num-td"
        onContextMenu={(e) => handlers.openCtx(e, handlers.rowCtxItems(row.id))}
      >
        <input
          type="checkbox"
          className="row-select"
          aria-label={`Select row ${rowIdx + 1}`}
          checked={selected}
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation();
            handlers.toggleRow(row.id, e.shiftKey);
          }}
        />
        <span className="row-num-val">{rowIdx + 1}</span>
      </td>
      <GridColSpacer side="left" width={columnWindow.spacers.left} />
      {columnWindow.virtualColumns.map((vc) => {
        const col = columns[vc.index];
        const cell = row.cells[col.id];
        const key = presenceCellKey(row.id, col.id);
        const here = presenceByCell?.get(key);
        const isActiveCell = activeCell?.row === rowIdx && activeCell?.col === vc.index;
        return (
          <GridCell
            key={col.id}
            actions={actions}
            col={col}
            cell={cell}
            rowId={row.id}
            rowIdx={rowIdx}
            colIndex={vc.index}
            here={here}
            isEditingHere={here?.some((u) => u.editing) ?? false}
            flash={interaction.flashCell === key}
            inSel={
              !!selRect &&
              rowIdx >= selRect.r1 &&
              rowIdx <= selRect.r2 &&
              vc.index >= selRect.c1 &&
              vc.index <= selRect.c2
            }
            isAnchor={!!sel && sel.anchor.r === rowIdx && sel.anchor.c === vc.index}
            isActiveCell={isActiveCell}
            running={cellIsRunning(runningCells, runningColId, row.id, col.id, cell?.status)}
            waiting={waitingByCol.has(col.id)}
            pinnedLeft={pinnedLeftByCol.get(col.id)}
            editSignal={isActiveCell ? interaction.editSignal : 0}
            editSeed={isActiveCell ? interaction.getEditSeed() : undefined}
            tabIndex={handlers.cellTabIndex(rowIdx, vc.index)}
            selCellCount={interaction.selCellCount}
            setSel={handlers.setSel}
            dragSelRef={handlers.dragSelRef}
            dragMovedRef={handlers.dragMovedRef}
            openCtx={handlers.openCtx}
            rowCtxItems={handlers.rowCtxItems}
            selectionMenuItems={handlers.selectionMenuItems}
            onCellFocus={handlers.onCellFocus}
          />
        );
      })}
      <GridColSpacer side="right" width={columnWindow.spacers.right} />
      <td className="grid-td" />
    </tr>
  );
}

/**
 * Memo comparator: skip the row unless its own inputs changed. `columnWindow` is
 * a fresh object every render (react-virtual), so it is compared via the cheap
 * `columnWindowKey` string instead — keeping vertical scroll free while a real
 * column-window change (horizontal scroll) still re-renders the row.
 */
function gridRowEqual(prev: GridRowProps, next: GridRowProps): boolean {
  return (
    prev.row === next.row &&
    prev.rowIdx === next.rowIdx &&
    prev.selected === next.selected &&
    prev.columnWindowKey === next.columnWindowKey &&
    prev.columns === next.columns &&
    prev.actions === next.actions &&
    prev.interaction === next.interaction &&
    prev.handlers === next.handlers
  );
}

export const GridRow = memo(GridRowInner, gridRowEqual);
