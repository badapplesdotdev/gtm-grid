/**
 * DataGrid — the ONE grid renderer shared by the local and cloud environments.
 *
 * Historically the local grid (inline in App.tsx) and the cloud grid
 * (CloudGrid.tsx) were two separate implementations, so cloud silently drifted
 * out of parity: it had no header context menu (right-click DELETED a column
 * with no confirmation), a stripped add-column (hardcoded text column), no
 * resize, no edit-column, etc. This component removes that divergence: both
 * environments render the EXACT same grid here, and the only thing that differs
 * is the {@link GridController} they inject — the set of action callbacks
 * (setCell / addRow / addColumn / delete / run …) that fire the correct
 * local-vs-cloud function, plus the data source (full load vs paged + realtime).
 *
 * Presentation the grid OWNS internally (so both envs share it for free): the
 * toolbar, headers with the right-click context menu + resize handle, the
 * virtualized + column-windowed body, the trailing add-column button, the
 * "no columns yet" empty state, and the context menu itself. Everything that
 * mutates data goes through the controller. The heavier authoring overlays
 * (add-column popover, edit-column, cell details, expanded editor) are rendered
 * by each parent and opened via controller intents.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Icon } from "./App";
import { FnIcon, type ColumnMeta } from "./FnIcon";
import { missingInputs } from "./columnInputs";
import { isSyncedColumn } from "./api";
import type { Cell, Column, FullTable } from "./api";
import { VirtualGridBody } from "./VirtualGridBody";
import { useColumnWindow } from "./useColumnWindow";
import { GridColSpacer } from "./GridColSpacer";
import { useElementWidth } from "./useElementWidth";
import { GridRow, type GridRowHandlers, type GridRowInteraction } from "./GridRow";
import { csvFilename, downloadCsv, tableToCsv } from "./csvExport";
import { PresenceAvatars } from "./PresenceAvatars";
import { type GridPresenceView, presenceCellKey } from "./gridPresence";
import { useGridKeyboardNav } from "./useGridKeyboardNav";

/** A `<td>` style that also carries the per-cell presence-ring color variable. */
type PresenceTdStyle = CSSProperties & { "--presence-color"?: string };

/** Row-number gutter width (px) — matches `.col-row-num` in styles.css. */
const GUTTER_W = 48;
/** Trailing add-column width (px) — matches `.add-col-th`. */
const ADD_COL_W = 44;

/**
 * Everything the shared grid needs to render and the intents it fires. Local
 * (App.tsx) and cloud (CloudGrid.tsx) each build one of these from their own
 * data hooks + mutation layer; the grid itself is environment-agnostic.
 */
export interface GridController {
  /** The table to render (normalized `FullTable` shape in both envs). */
  readonly table: FullTable;
  /** Per-density row height (px). */
  readonly rowHeight: number;
  /** Effective rendered width (px) for a column. */
  readonly columnWidth: (colId: string) => number;
  /** Minimum/maximum column width (px) for the resize clamp + `<th>` styling. */
  readonly minColWidth: number;
  readonly maxColWidth?: number;

  // ── Run state ──────────────────────────────────────────────────────────
  /** Local bulk-run progress; `null` when idle. Cloud leaves this null. */
  readonly runProgress: { current: number; total: number } | null;
  /** The column currently running via its header button (or null). */
  readonly runningColId: string | null;
  /** In-flight per-cell runs, keyed `${rowId}:${colId}`. */
  readonly runningCells: ReadonlySet<string>;
  /** Number of function columns (drives the Run button label + enablement). */
  readonly fnColCount: number;
  /** When false, run affordances are disabled (e.g. cloud signed-out). */
  readonly canRun: boolean;
  /** Tooltip explaining why running is disabled (when `canRun` is false). */
  readonly runDisabledReason?: string;
  /** When false, Add row is disabled (e.g. a local bulk run in progress). */
  readonly canAddRow: boolean;

  // ── Toolbar slots (environment-specific extras) ────────────────────────
  /** Local auto-run toggle; omit to hide (cloud has no auto-run). */
  readonly autoRun?: { value: boolean; onToggle: () => void };
  /** Extra controls in the LEFT cluster, next to Auto-run (e.g. local Dedupe). */
  readonly toolbarLeftExtras?: ReactNode;
  /** Always-inline status content rendered in the right cluster (e.g. the cloud
   *  LIVE badge). Unlike {@link toolbarActions} this is NOT folded into the
   *  overflow menu — it stays visible, since it is status, not an action. */
  readonly toolbarExtras?: ReactNode;
  /** Environment-specific toolbar ACTIONS (e.g. cloud Dedupe / Webhook). Rendered
   *  inline as buttons when the toolbar is wide, and folded into a single "⋯"
   *  overflow menu (alongside the built-in Export CSV / Add row) when it is too
   *  narrow to fit them — so a squeezed toolbar (agent panel open) stays usable. */
  readonly toolbarActions?: readonly ToolbarAction[];

  // ── Column presentation (provider identity) ────────────────────────────
  /** Resolve presentation metadata for a function column (provider logo/name,
   *  method label, credits) from the connector catalog. Omit to fall back to
   *  the plain text method badge. */
  readonly columnMeta?: (col: Column) => ColumnMeta | null;

  // ── Actions / intents (fire the correct local-vs-cloud function) ───────
  readonly addRow: () => void;
  readonly runAll: () => void;
  /** Run every function column, but scoped to just the given row IDs (the
   *  user's current selection). Lets the user process a custom batch at a time
   *  instead of the whole table. */
  readonly runRows: (rowIds: string[]) => void;
  /** Run a function column. `opts` scopes the run: `force` re-runs cells that
   *  are already done; `rowIds` restricts to specific rows. No opts = the
   *  environment's default run (local: unrun + errored rows; cloud: force). */
  readonly runColumn: (colId: string, opts?: { force?: boolean; rowIds?: string[] }) => void;
  readonly runCell: (rowId: string, colId: string) => void;
  /** Run an explicit set of function cells (the range-selection "Run N cells");
   *  grouped per column into force+rowIds runs. Omit to hide the menu item. */
  readonly runCells?: (cells: Array<{ rowId: string; colId: string }>) => void;
  readonly setCell: (rowId: string, colId: string, value: string) => void;
  readonly deleteRow: (rowId: string) => void;
  readonly deleteColumn: (colId: string) => void;
  readonly clearCell: (rowId: string, colId: string) => void;
  readonly editColumn: (col: Column) => void;
  /** Rename a column in place (header inline input); omit to hide Rename. */
  readonly renameColumn?: (colId: string, name: string) => void;
  /** Duplicate a column (config copied, cells empty); omit to hide Duplicate. */
  readonly duplicateColumn?: (col: Column) => void;
  /** Open the add-column popover anchored at the clicked "+" button. */
  readonly openAddColumn: (anchor: { left: number; top: number }) => void;
  /** Drag-resize a column; omit to disable resizing (cloud columns are fixed). */
  readonly resizeColumn?: (colId: string, startX: number, startWidth: number) => void;
  /** Open the cell-details drawer (object/error cells); omit to disable.
   *  `rowId` lets the drawer fetch run metadata / the raw response archive. */
  readonly openCellDetails?: (col: Column, cell: Cell | undefined, rowId?: string) => void;
  /** Open the expanded cell editor; omit to disable. */
  readonly expandCell?: (args: {
    rowId: string;
    colId: string;
    columnName: string;
    value: string;
    editable: boolean;
    anchor: { left: number; top: number; width: number };
  }) => void;
  /** Called when the viewport nears the bottom (cloud lazy paging); omit = no-op. */
  readonly onScrollNearBottom?: () => void;

  // ── Multiplayer presence (cloud only; omit for the local grid) ─────────
  /** Remote members' cursors/editing, resolved for rendering; omit to disable. */
  readonly presence?: GridPresenceView;
  /** The local user selected a cell (publishes their presence cursor). */
  readonly onActiveCellChange?: (cell: { rowId: string; colId: string } | null) => void;
  /** The local user started/stopped editing a cell (stronger presence indicator). */
  readonly onEditingCellChange?: (cell: { rowId: string; colId: string } | null) => void;
}

/**
 * The subset of {@link GridController} that a single cell fires. The memoized
 * GridRow/GridCell depend on THIS (a referentially-stable bundle) rather than the
 * whole controller — the controller object is rebuilt every parent render (its
 * `table` field changes on every realtime flush), so comparing it would re-render
 * every row on every update. These callbacks, by contrast, are stable, so a flush
 * that only changes one row's data re-renders exactly that one row.
 */
export type CellActions = Pick<
  GridController,
  | "setCell"
  | "runCell"
  | "clearCell"
  | "openCellDetails"
  | "expandCell"
  | "onActiveCellChange"
  | "onEditingCellChange"
  | "canRun"
>;

/**
 * Optional body override: render the shared toolbar but replace the grid/empty
 * body with custom content (e.g. the local "Pulling results from Trigify…"
 * warming state for a freshly-created, still-empty Trigify table).
 */

export type CtxItem =
  | { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }
  | { separator: true }
  | { header: string };

/**
 * A toolbar action the environment injects (cloud Dedupe / Webhook). Rendered as
 * an inline button when the toolbar is wide, or as an item in the "⋯" overflow
 * menu when it is narrow. `side` controls the inline cluster (default "right");
 * `active` shows a small status dot on the inline button (e.g. auto-dedupe on).
 */
export interface ToolbarAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly active?: boolean;
  readonly side?: "left" | "right";
}

/** Below this toolbar width (px) the actions collapse into the overflow menu. */
const COMPACT_TOOLBAR_PX = 760;
/** Approx. overflow-menu width, used to right-align it under the "⋯" button. */
const OVERFLOW_MENU_PX = 190;

/** A rectangular cell-range selection over row/column INDICES (anchor + head). */
export type Sel = {
  anchor: { r: number; c: number };
  head: { r: number; c: number };
};

/** The normalized (min/max) bounds of a {@link Sel}, in row/column indices. */
export interface SelRect {
  readonly r1: number;
  readonly r2: number;
  readonly c1: number;
  readonly c2: number;
}

export function DataGrid({
  controller: c,
  bodyOverride,
}: {
  controller: GridController;
  bodyOverride?: ReactNode;
}) {
  const { table } = c;
  const gridScrollRef = useRef<HTMLDivElement>(null);
  // Toolbar width drives the responsive collapse: below COMPACT_TOOLBAR_PX the
  // action buttons fold into the "⋯" overflow menu. We measure the CONTAINER (not
  // the window) so the agent side-panel squeezing the grid also triggers it.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarWidth = useElementWidth(toolbarRef);
  const compactToolbar =
    toolbarWidth !== null && toolbarWidth < COMPACT_TOOLBAR_PX;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  // The cell briefly flashed after a follow-jump, keyed `${rowId}:${colId}`.
  const [flashCell, setFlashCell] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear a pending follow-jump flash on unmount so its trailing setState can't
  // fire on an unmounted grid (e.g. navigating away mid-flash).
  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    };
  }, []);
  // Inline header rename (the Clay flow: rename without opening the editor).
  const [renaming, setRenaming] = useState<{ colId: string; draft: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming?.colId]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitRename = useCallback(() => {
    setRenaming((r) => {
      if (r && r.draft.trim() && c.renameColumn) c.renameColumn(r.colId, r.draft.trim());
      return null;
    });
  }, [c]);

  const openCtx = useCallback((e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  // ── Row selection ──────────────────────────────────────────────────────
  // Pure presentation state owned by the grid so BOTH envs get multi-select for
  // free; the only thing the controller supplies is `runRows`, which runs the
  // function columns scoped to the selected row IDs. Lets the user run a custom
  // batch at a time instead of the whole table.
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  // Anchor for shift-click range selection (last row toggled via its checkbox).
  const lastClickedRef = useRef<string | null>(null);

  // Render-synced snapshot of the state the lazily-invoked context-menu /
  // selection handlers need. They read THIS (updated every render, below) so the
  // handlers themselves stay referentially stable (empty-dep useCallback) — which
  // is what keeps the memoized `handlers` bundle, and therefore the rows, from
  // re-rendering on a realtime flush (where `table`/selection identities churn).
  const snapRef = useRef<{
    table: FullTable;
    c: GridController;
    selectedRows: ReadonlySet<string>;
    selectedCount: number;
    selectedIds: string[];
    selRect: SelRect | null;
    copySelection: () => void;
    clearSelection: () => void;
  }>(undefined as never);

  // Selection intersected with the rows that still exist (rows can be deleted
  // out from under a stale selection), in table order.
  const selectedIds = useMemo(
    () => table.rows.filter((r) => selectedRows.has(r.id)).map((r) => r.id),
    [table.rows, selectedRows],
  );
  const selectedCount = selectedIds.length;
  const allSelected = selectedCount > 0 && selectedCount === table.rows.length;

  const clearSelection = useCallback(() => setSelectedRows(new Set()), []);

  const toggleRow = useCallback((rowId: string, shiftKey: boolean) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      const anchor = lastClickedRef.current;
      if (shiftKey && anchor && anchor !== rowId) {
        // Add the contiguous range between the anchor and this row.
        const ids = snapRef.current.table.rows.map((r) => r.id);
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(rowId);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
        }
      } else if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
    lastClickedRef.current = rowId;
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedRows((prev) => (prev.size > 0 ? new Set() : new Set(table.rows.map((r) => r.id))));
    lastClickedRef.current = null;
  }, [table.rows]);

  const runSelected = useCallback(() => {
    if (selectedIds.length) c.runRows(selectedIds);
  }, [c, selectedIds]);

  // Export the table to CSV — mapped scalar values only (JSON/multi-item cells
  // export blank), every column included. See csvExport.ts.
  const exportCsv = useCallback(() => {
    downloadCsv(csvFilename(table.name), tableToCsv(table));
  }, [table]);

  // Context-menu items shared by the row gutter and data cells. When the
  // right-clicked row is part of the active selection we act on the whole
  // selection; otherwise we act on just that row.
  const rowCtxItems = useCallback((rowId: string, extra: CtxItem[] = []): CtxItem[] => {
    const { c, selectedRows, selectedCount, selectedIds, clearSelection } = snapRef.current;
    const inSel = selectedRows.has(rowId) && selectedCount > 0;
    const ids = inSel ? selectedIds : [rowId];
    const n = ids.length;
    const items: CtxItem[] = [];
    if (c.fnColCount > 0) {
      items.push({
        label: inSel ? `Run ${n} selected row${n !== 1 ? "s" : ""}` : "Run this row",
        disabled: !c.canRun,
        onClick: () => c.runRows(ids),
      });
    }
    if (selectedCount > 0) items.push({ label: "Clear selection", onClick: clearSelection });
    items.push(...extra);
    items.push({
      label: inSel && n > 1 ? `Delete ${n} selected rows` : "Delete row",
      danger: true,
      onClick: () => ids.forEach((id) => c.deleteRow(id)),
    });
    return items;
  }, []);

  // ── Cell range selection (Clay-style) ──────────────────────────────────
  // Click selects a cell, drag or shift+click extends a rectangular range over
  // row/column INDICES; right-click inside it offers Run N cells / Copy /
  // Clear / Delete rows. Selection is presentation-only local state.
  const [sel, setSel] = useState<Sel | null>(null);
  const dragSelRef = useRef(false);
  // True when a drag extended past its anchor — used to swallow the click that
  // fires on mouseup so it doesn't open a manual cell's inline editor.
  const dragMovedRef = useRef(false);

  useEffect(() => {
    const onUp = () => { dragSelRef.current = false; };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  // Selection indices are only meaningful within one table.
  useEffect(() => setSel(null), [table.id]);

  const selRect = useMemo<SelRect | null>(() => {
    if (!sel) return null;
    return {
      r1: Math.min(sel.anchor.r, sel.head.r),
      r2: Math.max(sel.anchor.r, sel.head.r),
      c1: Math.min(sel.anchor.c, sel.head.c),
      c2: Math.max(sel.anchor.c, sel.head.c),
    };
  }, [sel]);
  const selCellCount = selRect ? (selRect.r2 - selRect.r1 + 1) * (selRect.c2 - selRect.c1 + 1) : 0;

  /** Copy the selected range to the clipboard as TSV (Excel/Sheets-pasteable). */
  const copySelection = useCallback(() => {
    if (!selRect) return;
    const cols = table.columns.slice(selRect.c1, selRect.c2 + 1);
    const tsv = table.rows
      .slice(selRect.r1, selRect.r2 + 1)
      .map((row) =>
        cols
          .map((col) => {
            const v = row.cells[col.id]?.value;
            return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
          })
          .join("\t"),
      )
      .join("\n");
    void navigator.clipboard?.writeText(tsv).catch(() => {});
  }, [selRect, table]);

  // Cmd/Ctrl+C copies the selection — unless the user is typing in an input.
  useEffect(() => {
    if (!selRect) return;
    const onCopy = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "c") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (window.getSelection()?.toString()) return; // native text selection wins
      e.preventDefault();
      copySelection();
    };
    window.addEventListener("keydown", onCopy);
    return () => window.removeEventListener("keydown", onCopy);
  }, [selRect, copySelection]);

  /** The context menu for a multi-cell selection (right-click inside the rect). */
  const selectionMenuItems = useCallback((): CtxItem[] => {
    const { selRect, table, c, copySelection } = snapRef.current;
    if (!selRect) return [];
    const rows = table.rows.slice(selRect.r1, selRect.r2 + 1);
    const cols = table.columns.slice(selRect.c1, selRect.c2 + 1);
    const fnCells: Array<{ rowId: string; colId: string }> = [];
    for (const col of cols) {
      if (col.kind !== "function") continue;
      for (const row of rows) fnCells.push({ rowId: row.id, colId: col.id });
    }
    const cellCount = (selRect.r2 - selRect.r1 + 1) * (selRect.c2 - selRect.c1 + 1);
    const items: CtxItem[] = [];
    if (c.runCells && fnCells.length > 0) {
      items.push({
        label: `Run ${fnCells.length} cell${fnCells.length !== 1 ? "s" : ""}`,
        disabled: !c.canRun,
        onClick: () => c.runCells!(fnCells),
      });
      items.push({ separator: true });
    }
    items.push({ label: "Copy", onClick: copySelection });
    // Synced (CRM-owned) columns are read-only — exclude them from the range
    // clear so "Clear N cells" can never wipe CRM data.
    const clearableCols = cols.filter((col) => !isSyncedColumn(col));
    const clearCount = rows.length * clearableCols.length;
    items.push(
      { separator: true },
      ...(clearCount > 0
        ? [
            {
              label: `Clear ${clearCount} cell${clearCount !== 1 ? "s" : ""}`,
              onClick: () => {
                for (const row of rows) for (const col of clearableCols) c.clearCell(row.id, col.id);
                setSel(null);
              },
            },
          ]
        : []),
      {
        label: `Delete ${rows.length} row${rows.length !== 1 ? "s" : ""}`,
        danger: true,
        onClick: () => {
          for (const row of rows) c.deleteRow(row.id);
          setSel(null);
        },
      },
    );
    return items;
  }, []);

  // Follow a member: scroll their cell into view and flash it. Rows are
  // fixed-height so the vertical offset is exact; the horizontal offset sums the
  // widths of the columns before the target. No-op if the row/column isn't loaded.
  const scrollToCell = useCallback(
    (rowId: string, colId: string) => {
      const el = gridScrollRef.current;
      if (el === null) return;
      const rowIdx = table.rows.findIndex((r) => r.id === rowId);
      const colIdx = table.columns.findIndex((col) => col.id === colId);
      if (rowIdx < 0 || colIdx < 0) return;
      let left = GUTTER_W;
      for (let i = 0; i < colIdx; i++) left += c.columnWidth(table.columns[i].id);
      el.scrollTo({
        top: Math.max(0, rowIdx * c.rowHeight - (el.clientHeight - c.rowHeight) / 2),
        left: Math.max(0, left - el.clientWidth / 3),
        behavior: "smooth",
      });
      const key = presenceCellKey(rowId, colId);
      setFlashCell(key);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashCell(null), 1200);
    },
    [table, c],
  );

  // Scroll a cell (by index) just far enough to be visible — used by keyboard
  // navigation. Unlike scrollToCell this is instant and minimal (no centering,
  // no flash), accounts for the sticky row-number gutter, and is a no-op when
  // the cell is already in view.
  const scrollCellIntoView = useCallback(
    (rowIdx: number, colIdx: number) => {
      const el = gridScrollRef.current;
      if (el === null) return;
      const top = rowIdx * c.rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + c.rowHeight > el.scrollTop + el.clientHeight)
        el.scrollTop = top + c.rowHeight - el.clientHeight;

      let left = GUTTER_W;
      for (let i = 0; i < colIdx; i++) left += c.columnWidth(table.columns[i].id);
      const w = table.columns[colIdx] ? c.columnWidth(table.columns[colIdx].id) : 0;
      // Keep the cell clear of the sticky gutter on the left edge.
      if (left - GUTTER_W < el.scrollLeft) el.scrollLeft = Math.max(0, left - GUTTER_W);
      else if (left + w > el.scrollLeft + el.clientWidth)
        el.scrollLeft = left + w - el.clientWidth;
    },
    [c, table.columns],
  );

  // Spreadsheet keyboard navigation (arrows / Home / End / PageUp-Down / type-to-
  // edit). Shared by both envs via this component. Selection callbacks reuse the
  // grid's existing row-selection state.
  const kbd = useGridKeyboardNav({
    rowCount: table.rows.length,
    colCount: table.columns.length,
    rowHeight: c.rowHeight,
    scrollRef: gridScrollRef,
    scrollToIndex: scrollCellIntoView,
    onExtendSelection: (rowIdx) => {
      const id = table.rows[rowIdx]?.id;
      if (id) {
        setSelectedRows((prev) => new Set(prev).add(id));
        lastClickedRef.current = id;
      }
    },
    onToggleSelection: (rowIdx) => {
      const id = table.rows[rowIdx]?.id;
      if (id) toggleRow(id, false);
    },
    onSelectAll: () => setSelectedRows(new Set(table.rows.map((r) => r.id))),
    onClearSelection: clearSelection,
  });

  /** Roving tabindex: one cell is the tab stop — the active cell, or (0,0)
   *  before any cell has been focused — so Tab reaches the grid exactly once. */
  const cellTabIndex = useCallback(
    (rowIdx: number, colIdx: number): 0 | -1 => {
      const a = kbd.active;
      if (a) return a.row === rowIdx && a.col === colIdx ? 0 : -1;
      return rowIdx === 0 && colIdx === 0 ? 0 : -1;
    },
    [kbd.active],
  );

  // Column virtualization (TRI-3286): window the DATA columns horizontally so a
  // table with hundreds of columns mounts only the visible columns × visible
  // rows. The gutter is the always-present sticky cell rendered once, excluded
  // from the window. Runs unconditionally to keep hook order stable.
  //
  // Overscan is kept SMALL on both axes (the VirtualGridBody/useColumnWindow
  // defaults). A bigger buffer is counter-productive: the paint-in lag on a fast
  // scroll is the COST of rendering the newly-windowed cells, so a larger window
  // means MORE cells per scroll step and a LONGER blank, not a shorter one. The
  // lever that actually shortens it is cheaper per-cell rendering, not overscan.
  const columnWindow = useColumnWindow({
    count: table.columns.length,
    scrollRef: gridScrollRef,
    getColumnWidth: (i) => {
      const col = table.columns[i];
      return col ? c.columnWidth(col.id) : c.minColWidth;
    },
  });

  // Tie lazy paging to the viewport: when scrolled within ~10 rows of the bottom
  // pull the next page. The caller guards against concurrent fetches.
  const onScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!c.onScrollNearBottom) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < c.rowHeight * 10) {
        c.onScrollNearBottom();
      }
    },
    [c],
  );

  const runDisabled = !c.canRun;
  const totalWidth = useMemo(
    () => GUTTER_W + table.columns.reduce((s, col) => s + c.columnWidth(col.id), 0) + ADD_COL_W,
    [table.columns, c],
  );

  // ── Per-column run telemetry (Clay's header health bar) ────────────────
  // One pass over the rows per table-state change; streaming runs patch cells
  // in place, so the counts update live as a run progresses.
  const fnStats = useMemo(() => {
    const map = new Map<string, { done: number; error: number; running: number; queued: number; skipped: number }>();
    const fnCols = table.columns.filter((col) => col.kind === "function");
    if (!fnCols.length) return map;
    for (const col of fnCols) map.set(col.id, { done: 0, error: 0, running: 0, queued: 0, skipped: 0 });
    for (const row of table.rows) {
      for (const col of fnCols) {
        const s = map.get(col.id)!;
        const cell = row.cells[col.id];
        const status = cell?.status ?? "empty";
        if (status === "done") s.done++;
        else if (status === "error") s.error++;
        else if (status === "running") s.running++;
        else if (status === "pending") s.queued++;
        else if (cell?.error) s.skipped++; // empty + note = condition-gated row
      }
    }
    return map;
  }, [table]);

  // ── Waiting-for-inputs: required params unset, or {{Refs}} to deleted
  // columns. Cheap (columns × params), recomputed when columns change.
  const columnNameSet = useMemo(() => new Set(table.columns.map((col) => col.name)), [table.columns]);
  const waitingByCol = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const col of table.columns) {
      if (col.kind !== "function") continue;
      const meta = c.columnMeta?.(col) ?? null;
      const missing = missingInputs(col.params ?? {}, meta?.requiredInputs ?? [], columnNameSet);
      if (missing.length) m.set(col.id, missing);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.columns, columnNameSet, c.columnMeta]);

  // ── Memo seams for the virtualized body (TRI render-perf) ────────────────
  // Publish this render's snapshot for the stable context-menu handlers above.
  snapRef.current = {
    table,
    c,
    selectedRows,
    selectedCount,
    selectedIds,
    selRect,
    copySelection,
    clearSelection,
  };

  // A cheap structural signature of the current column window. `columnWindow` is
  // a fresh object every render (react-virtual), so the memoized <GridRow>
  // compares THIS string instead: it's stable across a vertical scroll (the
  // window is unchanged) and only changes on a horizontal scroll. Column WIDTHS
  // are intentionally absent — `table-layout: fixed` propagates a resized
  // column's width to body cells from the `<th>`, so a resize never needs the
  // rows to re-render.
  const columnWindowKey = useMemo(() => {
    const vcs = columnWindow.virtualColumns;
    const first = vcs[0]?.index ?? -1;
    const last = vcs[vcs.length - 1]?.index ?? -1;
    return `${first}:${last}:${vcs.length}:${columnWindow.spacers.left}:${columnWindow.spacers.right}`;
  }, [columnWindow]);

  // The cross-cutting per-cell state, bundled into ONE object so a pure vertical
  // scroll keeps its identity and every <GridRow> in the window skips. Any change
  // here (selection, presence, active cell, a run) re-renders the visible rows
  // once — but the leaf CellContent still memoizes the unchanged cell contents.
  const interaction = useMemo<GridRowInteraction>(
    () => ({
      selRect,
      sel,
      selCellCount,
      activeCell: kbd.active,
      editSignal: kbd.editSignal,
      getEditSeed: kbd.getEditSeed,
      presenceByCell: c.presence?.byCell,
      flashCell,
      runningCells: c.runningCells,
      runningColId: c.runningColId,
      waitingByCol,
    }),
    [
      selRect,
      sel,
      selCellCount,
      kbd.active,
      kbd.editSignal,
      kbd.getEditSeed,
      c.presence,
      c.runningCells,
      c.runningColId,
      flashCell,
      waitingByCol,
    ],
  );

  // The stable cell-action callbacks, decoupled from the controller object (which
  // is rebuilt every parent render). Stable as long as the controller's callbacks
  // are — so a realtime flush that changes one row's data re-renders only that row.
  const cellActions = useMemo<CellActions>(
    () => ({
      setCell: c.setCell,
      runCell: c.runCell,
      clearCell: c.clearCell,
      openCellDetails: c.openCellDetails,
      expandCell: c.expandCell,
      onActiveCellChange: c.onActiveCellChange,
      onEditingCellChange: c.onEditingCellChange,
      canRun: c.canRun,
    }),
    [
      c.setCell,
      c.runCell,
      c.clearCell,
      c.openCellDetails,
      c.expandCell,
      c.onActiveCellChange,
      c.onEditingCellChange,
      c.canRun,
    ],
  );

  // The stable callbacks the rows + cells fire, bundled likewise. Each member is
  // already referentially stable (useCallback / useState setter / ref), so this
  // object's identity only changes when one of those genuinely changes (e.g.
  // selection-derived rowCtxItems), never on scroll.
  const handlers = useMemo<GridRowHandlers>(
    () => ({
      toggleRow,
      openCtx,
      rowCtxItems,
      selectionMenuItems,
      setSel,
      dragSelRef,
      dragMovedRef,
      onCellFocus: kbd.onCellFocus,
      cellTabIndex,
    }),
    [toggleRow, openCtx, rowCtxItems, selectionMenuItems, kbd.onCellFocus, cellTabIndex],
  );

  // Column-header right-click menu (Clay-style): edit/rename/duplicate, scoped
  // run variants for function columns, then delete. Every run item maps onto
  // the engine's existing `{ force, rowIds }` options — a run is always the
  // stored column config executing, never anything AI-mediated.
  const columnMenuItems = (col: Column): CtxItem[] => {
    const items: CtxItem[] = [
      { label: "Edit column", onClick: () => c.editColumn(col) },
    ];
    if (c.renameColumn) {
      items.push({ label: "Rename", onClick: () => setRenaming({ colId: col.id, draft: col.name }) });
    }
    if (c.duplicateColumn) {
      items.push({ label: "Duplicate", onClick: () => c.duplicateColumn!(col) });
    }
    if (col.kind === "function") {
      items.push({ separator: true }, { header: "Run" });
      const busy = runDisabled || c.runningColId === col.id;
      items.push(
        {
          label: "Run unrun & errored rows",
          disabled: busy,
          // Explicit force:false — the non-forced run skips `done` cells, so
          // exactly the unrun + errored rows execute (in both environments).
          onClick: () => c.runColumn(col.id, { force: false }),
        },
        {
          label: "Run first 10 rows",
          disabled: busy || table.rows.length === 0,
          onClick: () =>
            c.runColumn(col.id, { force: true, rowIds: table.rows.slice(0, 10).map((r) => r.id) }),
        },
        {
          label: "Force run all rows",
          disabled: busy,
          onClick: () => c.runColumn(col.id, { force: true }),
        },
      );
    }
    items.push(
      { separator: true },
      { label: `Delete column “${col.name}”`, danger: true, onClick: () => c.deleteColumn(col.id) },
    );
    return items;
  };

  // The full ordered toolbar-action set: the environment's actions (cloud Dedupe
  // / Webhook) followed by the built-in Export CSV + Add row. Rendered inline when
  // the toolbar is wide, or folded into the "⋯" overflow menu when it is narrow.
  const toolbarActions: ToolbarAction[] = [
    ...(c.toolbarActions ?? []),
    {
      id: "export-csv",
      label: "Export CSV",
      icon: <Icon.Download size={11} />,
      onClick: exportCsv,
      disabled: table.columns.length === 0 || table.rows.length === 0,
      title:
        "Export this table as CSV (mapped values only — JSON / multi-item cells export blank)",
    },
    {
      id: "add-row",
      label: "Add row",
      icon: <Icon.Plus size={11} />,
      onClick: c.addRow,
      disabled: !c.canAddRow,
    },
  ];
  const leftToolbarActions = toolbarActions.filter((a) => a.side === "left");
  const rightToolbarActions = toolbarActions.filter((a) => a.side !== "left");

  /** Render one toolbar action as an inline outline button (wide layout). */
  const renderToolbarAction = (a: ToolbarAction) => (
    <button
      key={a.id}
      className="btn btn-outline btn-sm"
      onClick={a.onClick}
      disabled={a.disabled}
      title={a.title}
    >
      {a.icon}
      {a.icon ? " " : null}
      {a.label}
      {a.active && <span className="dedupe-on-dot" title="On" />}
    </button>
  );

  /** Open the "⋯" overflow menu (compact layout), reusing the ctx-menu surface.
   *  Disabled actions are skipped so a no-op item never appears in the menu. */
  const openToolbarMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setCtxMenu({
      x: Math.max(8, r.right - OVERFLOW_MENU_PX),
      y: r.bottom + 4,
      items: toolbarActions
        .filter((a) => !a.disabled)
        .map((a) => ({ label: a.label, onClick: a.onClick })),
    });
  };

  return (
    <>
      {/* Toolbar */}
      <div className="toolbar" ref={toolbarRef}>
        <span className="toolbar-title">{table.name}</span>
        <span className="toolbar-meta">
          {table.rows.length} rows · {table.columns.length} cols
        </span>

        {c.autoRun && (
          <button
            className="autorun-toggle"
            onClick={c.autoRun.onToggle}
            title="Computed fields auto-run when inputs change"
          >
            <span className="autorun-label">Auto-run</span>
            <span className={`autorun-switch${c.autoRun.value ? " on" : ""}`}>
              <span className="autorun-knob" />
            </span>
          </button>
        )}

        {c.toolbarLeftExtras}
        {/* Left-cluster actions inline only when there's room; otherwise they
            fold into the overflow menu below. */}
        {!compactToolbar && leftToolbarActions.map(renderToolbarAction)}

        <div className="toolbar-spacer" />

        {selectedCount > 0 && (
          <span className="sel-bar">
            <span className="sel-count">{selectedCount} selected</span>
            <button
              className="btn btn-primary btn-sm"
              onClick={runSelected}
              disabled={runDisabled || c.fnColCount === 0}
              title={
                runDisabled
                  ? c.runDisabledReason ?? "Running…"
                  : c.fnColCount === 0
                    ? "No function columns to run"
                    : `Run ${c.fnColCount} function column${c.fnColCount !== 1 ? "s" : ""} on ${selectedCount} selected row${selectedCount !== 1 ? "s" : ""}`
              }
            >
              <Icon.Play size={10} /> Run {selectedCount}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={clearSelection} title="Clear selection">
              Clear
            </button>
          </span>
        )}

        {c.runProgress && (
          <span className="run-progress">
            <span className="cell-spinner" style={{ width: 11, height: 11 }} />
            Running {c.runProgress.current}/{c.runProgress.total}
          </span>
        )}

        {c.presence && (
          <PresenceAvatars
            users={c.presence.users}
            onJump={(u) => {
              if (u.cursor) scrollToCell(u.cursor.rowId, u.cursor.columnId);
            }}
          />
        )}

        {c.toolbarExtras}

        {/* Wide: every action inline. Narrow: a single "⋯" menu so the toolbar
            never crowds the primary Run button off-screen. */}
        {compactToolbar ? (
          <button
            className="btn btn-outline btn-sm toolbar-overflow-btn"
            onClick={openToolbarMenu}
            title="More actions"
            aria-label="More actions"
          >
            <Icon.More />
          </button>
        ) : (
          rightToolbarActions.map(renderToolbarAction)
        )}
        <div className="toolbar-sep" />
        <button
          className="btn btn-primary btn-sm"
          onClick={c.runAll}
          disabled={runDisabled || c.fnColCount === 0}
          title={
            runDisabled
              ? c.runDisabledReason ?? "Running…"
              : c.fnColCount === 0
                ? "No function columns to run"
                : `Run ${c.fnColCount} function column${c.fnColCount !== 1 ? "s" : ""}`
          }
        >
          <Icon.Play size={10} />
          {c.runProgress ? "Running…" : "Run"}
        </button>
      </div>

      {/* Grid / no-columns empty state (or a caller-supplied body override) */}
      {bodyOverride !== undefined ? (
        bodyOverride
      ) : table.columns.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon.Zap /></div>
          <div className="empty-title">No columns yet</div>
          <p className="empty-sub">
            Add columns to define your data structure. Use function columns to enrich rows automatically.
          </p>
          <button
            className="btn btn-primary"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              c.openAddColumn({ left: r.left, top: r.bottom });
            }}
          >
            <Icon.Plus /> Add first column
          </button>
        </div>
      ) : (
        <div className="grid-wrap" ref={gridScrollRef} onScroll={onScroll} onKeyDown={kbd.onKeyDown}>
          <table
            className="grid-table"
            style={{ width: totalWidth }}
            role="grid"
            aria-rowcount={table.rows.length}
            aria-colcount={table.columns.length}
          >
            <thead>
              <tr role="row">
                {/* Row-number gutter — the ONLY gutter cell (reserved once) */}
                <th className="grid-th row-num-th col-row-num">
                  {table.rows.length > 0 && (
                    <input
                      type="checkbox"
                      className="row-select"
                      aria-label={allSelected ? "Clear selection" : "Select all rows"}
                      title={allSelected ? "Clear selection" : "Select all rows"}
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedCount > 0 && !allSelected;
                      }}
                      onChange={toggleAll}
                    />
                  )}
                </th>
                <GridColSpacer side="left" width={columnWindow.spacers.left} as="th" />
                {columnWindow.virtualColumns.map((vc) => {
                  const col = table.columns[vc.index];
                  // Column-header ring: a participant (the agent) is working
                  // over this whole column (run_column etc.).
                  const colHere = c.presence?.byColumn.get(col.id);
                  const thStyle: PresenceTdStyle = {
                    width: c.columnWidth(col.id),
                    minWidth: c.minColWidth,
                    maxWidth: c.maxColWidth,
                    ...(colHere ? { "--presence-color": colHere[0].color } : {}),
                  };
                  const meta = col.kind === "function" ? c.columnMeta?.(col) ?? null : null;
                  const stats = fnStats.get(col.id);
                  const totalRows = table.rows.length;
                  const settled = stats ? stats.done + stats.error + stats.skipped : 0;
                  const showBar =
                    !!stats && totalRows > 0 &&
                    (stats.running > 0 || stats.queued > 0 || (settled > 0 && settled < totalRows));
                  const waiting = waitingByCol.get(col.id);
                  const statsLine = stats && totalRows > 0
                    ? ` — ✓ ${stats.done}${stats.error ? ` · ✕ ${stats.error}` : ""}${stats.skipped ? ` · ⊘ ${stats.skipped}` : ""} of ${totalRows}`
                    : "";
                  const headTitle = meta
                    ? `${meta.providerName} · ${meta.methodLabel}${meta.credits ? ` · ${meta.credits} credit${meta.credits !== 1 ? "s" : ""}/row` : ""}${statsLine}`
                    : col.fn ? `${col.fn}${statsLine}` : undefined;
                  return (
                    <th
                      key={col.id}
                      role="columnheader"
                      aria-colindex={vc.index + 1}
                      className={`grid-th${colHere ? " col-presence" : ""}`}
                      title={colHere ? colHere.map((u) => `${u.name ?? u.userId}${u.activity ? ` — ${u.activity}` : ""}`).join(", ") : undefined}
                      style={thStyle}
                      onContextMenu={(e) => openCtx(e, columnMenuItems(col))}
                    >
                      <div className="th-inner" title={headTitle}>
                        {meta && (
                          <span className="th-provider">
                            <FnIcon fn={{ logo: meta.logo, providerName: meta.providerName, category: meta.category }} size={16} />
                          </span>
                        )}
                        {renaming?.colId === col.id ? (
                          <input
                            ref={renameInputRef}
                            className="th-rename-input"
                            value={renaming.draft}
                            onChange={(e) => setRenaming({ colId: col.id, draft: e.target.value })}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setRenaming(null);
                            }}
                            onContextMenu={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="th-name">{col.name}</span>
                        )}
                        {waiting ? (
                          <span
                            className="th-wait-badge"
                            title={`Waiting for inputs: ${waiting.join(", ")}`}
                          >
                            Waiting for inputs
                          </span>
                        ) : (
                          col.kind === "function" && (meta || col.fn) && (
                            <span className="th-fn-badge" title={headTitle}>
                              {meta ? meta.methodLabel : col.fn!.split(".").pop()}
                            </span>
                          )
                        )}
                        {stats && stats.error > 0 && (
                          <button
                            className="th-err-chip"
                            title={`${stats.error} row${stats.error !== 1 ? "s" : ""} errored — click to re-run errored & unrun rows`}
                            onClick={() => c.runColumn(col.id, { force: false })}
                            disabled={runDisabled || c.runningColId === col.id}
                          >
                            ✕ {stats.error}
                          </button>
                        )}
                        {col.kind === "function" && (
                          <button
                            className="th-run-btn"
                            title={`Run ${col.name}`}
                            onClick={() => c.runColumn(col.id)}
                            disabled={c.runningColId === col.id || runDisabled}
                          >
                            {c.runningColId === col.id ? <span className="cell-spinner" /> : <Icon.Play size={9} />}
                          </button>
                        )}
                      </div>
                      {showBar && stats && (
                        <div className="th-progress" aria-hidden>
                          <span className="th-progress-done" style={{ width: `${(stats.done / totalRows) * 100}%` }} />
                          <span className="th-progress-err" style={{ width: `${(stats.error / totalRows) * 100}%` }} />
                        </div>
                      )}
                      {c.resizeColumn && (
                        <div
                          className="col-resize"
                          title="Drag to resize"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            c.resizeColumn!(col.id, e.clientX, c.columnWidth(col.id));
                          }}
                        />
                      )}
                    </th>
                  );
                })}
                <GridColSpacer side="right" width={columnWindow.spacers.right} as="th" />
                {/* Add column */}
                <th className="grid-th add-col-th" style={{ width: ADD_COL_W }}>
                  <button
                    className="add-col-btn"
                    title="Add column"
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      c.openAddColumn({ left: r.left, top: r.bottom });
                    }}
                  >
                    <Icon.Plus size={16} />
                  </button>
                </th>
              </tr>
            </thead>
            {table.rows.length === 0 ? (
              <tbody>
                <tr>
                  <td className="grid-td row-num-td" />
                  <GridColSpacer side="left" width={columnWindow.spacers.left} />
                  {columnWindow.virtualColumns.map((vc) => {
                    const col = table.columns[vc.index];
                    return (
                      <td key={col.id} className="grid-td">
                        <div className="cell-wrap"><span className="cell-empty">—</span></div>
                      </td>
                    );
                  })}
                  <GridColSpacer side="right" width={columnWindow.spacers.right} />
                  <td className="grid-td" />
                </tr>
              </tbody>
            ) : (
              <VirtualGridBody
                rows={table.rows}
                scrollRef={gridScrollRef}
                rowHeight={c.rowHeight}
                colSpan={table.columns.length + 2}
                columnWindow={columnWindow}
                renderRow={(row, idx, cw) => (
                  <GridRow
                    key={row.id}
                    actions={cellActions}
                    row={row}
                    rowIdx={idx}
                    columns={table.columns}
                    columnWindow={cw}
                    columnWindowKey={columnWindowKey}
                    selected={selectedRows.has(row.id)}
                    interaction={interaction}
                    handlers={handlers}
                  />
                )}
              />
            )}
          </table>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <>
          <div
            className="ctx-backdrop"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
          />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {ctxMenu.items.map((it, i) => {
              if ("separator" in it) return <div key={i} className="ctx-sep" />;
              if ("header" in it) return <div key={i} className="ctx-header">{it.header}</div>;
              return (
                <button
                  key={i}
                  className={`ctx-item ${it.danger ? "danger" : ""}`}
                  disabled={it.disabled}
                  onClick={() => { setCtxMenu(null); it.onClick(); }}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
