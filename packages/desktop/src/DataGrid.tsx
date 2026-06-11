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

import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CellContent, Icon } from "./App";
import type { Cell, Column, FullTable } from "./api";
import { VirtualGridBody } from "./VirtualGridBody";
import { useColumnWindow } from "./useColumnWindow";
import { GridColSpacer } from "./GridColSpacer";
import { PresenceAvatars } from "./PresenceAvatars";
import { type GridPresenceView, presenceCellKey } from "./gridPresence";

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
  /** Extra toolbar controls rendered in the right cluster (e.g. cloud Webhook). */
  readonly toolbarExtras?: ReactNode;

  // ── Actions / intents (fire the correct local-vs-cloud function) ───────
  readonly addRow: () => void;
  readonly runAll: () => void;
  readonly runColumn: (colId: string) => void;
  readonly runCell: (rowId: string, colId: string) => void;
  readonly setCell: (rowId: string, colId: string, value: string) => void;
  readonly deleteRow: (rowId: string) => void;
  readonly deleteColumn: (colId: string) => void;
  readonly clearCell: (rowId: string, colId: string) => void;
  readonly editColumn: (col: Column) => void;
  /** Open the add-column popover anchored at the clicked "+" button. */
  readonly openAddColumn: (anchor: { left: number; top: number }) => void;
  /** Drag-resize a column; omit to disable resizing (cloud columns are fixed). */
  readonly resizeColumn?: (colId: string, startX: number, startWidth: number) => void;
  /** Open the cell-details drawer (object/error cells); omit to disable. */
  readonly openCellDetails?: (col: Column, cell: Cell | undefined) => void;
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
 * Optional body override: render the shared toolbar but replace the grid/empty
 * body with custom content (e.g. the local "Pulling results from Trigify…"
 * warming state for a freshly-created, still-empty Trigify table).
 */

type CtxItem = { label: string; danger?: boolean; onClick: () => void };

export function DataGrid({
  controller: c,
  bodyOverride,
}: {
  controller: GridController;
  bodyOverride?: ReactNode;
}) {
  const { table } = c;
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  // The cell briefly flashed after a follow-jump, keyed `${rowId}:${colId}`.
  const [flashCell, setFlashCell] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openCtx = useCallback((e: React.MouseEvent, items: CtxItem[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
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

  // Column virtualization (TRI-3286): window the DATA columns horizontally so a
  // table with hundreds of columns mounts only the visible columns × visible
  // rows. The gutter is the always-present sticky cell rendered once, excluded
  // from the window. Runs unconditionally to keep hook order stable.
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
  const totalWidth =
    GUTTER_W + table.columns.reduce((s, col) => s + c.columnWidth(col.id), 0) + ADD_COL_W;

  return (
    <>
      {/* Toolbar */}
      <div className="toolbar">
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

        <div className="toolbar-spacer" />

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

        <button className="btn btn-outline btn-sm" onClick={c.addRow} disabled={!c.canAddRow}>
          <Icon.Plus size={11} /> Add row
        </button>
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
        <div className="grid-wrap" ref={gridScrollRef} onScroll={onScroll}>
          <table className="grid-table" style={{ width: totalWidth }}>
            <thead>
              <tr>
                {/* Row-number gutter — the ONLY gutter cell (reserved once) */}
                <th className="grid-th row-num-th col-row-num" />
                <GridColSpacer side="left" width={columnWindow.spacers.left} as="th" />
                {columnWindow.virtualColumns.map((vc) => {
                  const col = table.columns[vc.index];
                  return (
                    <th
                      key={col.id}
                      className="grid-th"
                      style={{ width: c.columnWidth(col.id), minWidth: c.minColWidth, maxWidth: c.maxColWidth }}
                      onContextMenu={(e) =>
                        openCtx(e, [
                          { label: `Edit column “${col.name}”`, onClick: () => c.editColumn(col) },
                          { label: `Delete column “${col.name}”`, danger: true, onClick: () => c.deleteColumn(col.id) },
                        ])
                      }
                    >
                      <div className="th-inner">
                        <span className="th-name">{col.name}</span>
                        {col.kind === "function" && col.fn && (
                          <span className="th-fn-badge" title={col.fn}>{col.fn.split(".").pop()}</span>
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
                  <tr key={row.id} className="grid-tr">
                    <td
                      className="grid-td row-num-td"
                      onContextMenu={(e) =>
                        openCtx(e, [{ label: "Delete row", danger: true, onClick: () => c.deleteRow(row.id) }])
                      }
                    >
                      {idx + 1}
                    </td>
                    <GridColSpacer side="left" width={cw.spacers.left} />
                    {cw.virtualColumns.map((vc) => {
                      const col = table.columns[vc.index];
                      const cell: Cell | undefined = row.cells[col.id];
                      const key = presenceCellKey(row.id, col.id);
                      const here = c.presence?.byCell.get(key);
                      const isEditingHere = here?.some((u) => u.editing) ?? false;
                      const tdStyle: PresenceTdStyle | undefined = here
                        ? { "--presence-color": here[0].color }
                        : undefined;
                      return (
                        <td
                          key={col.id}
                          className={`grid-td${here ? " cell-presence" : ""}${isEditingHere ? " presence-editing" : ""}${flashCell === key ? " presence-flash" : ""}`}
                          style={tdStyle}
                          onClick={
                            c.onActiveCellChange
                              ? () => c.onActiveCellChange!({ rowId: row.id, colId: col.id })
                              : undefined
                          }
                          onContextMenu={(e) =>
                            openCtx(e, [
                              { label: "Clear cell", onClick: () => c.clearCell(row.id, col.id) },
                              { label: "Delete row", danger: true, onClick: () => c.deleteRow(row.id) },
                            ])
                          }
                        >
                          {here && (
                            <span
                              className="presence-cell-chip"
                              style={{ background: here[0].color }}
                              title={here.map((u) => u.name ?? u.userId).join(", ")}
                            >
                              {here[0].image ? (
                                <img src={here[0].image} alt="" referrerPolicy="no-referrer" />
                              ) : (
                                (here[0].name ?? "?").slice(0, 1).toUpperCase()
                              )}
                            </span>
                          )}
                          <CellContent
                            cell={cell}
                            col={col}
                            onEdit={(v) => c.setCell(row.id, col.id, v)}
                            onEditingChange={
                              c.onEditingCellChange
                                ? (ed) =>
                                    c.onEditingCellChange!(ed ? { rowId: row.id, colId: col.id } : null)
                                : undefined
                            }
                            onOpenDetails={
                              c.openCellDetails ? () => c.openCellDetails!(col, cell) : undefined
                            }
                            onExpand={
                              c.expandCell
                                ? (anchor) =>
                                    c.expandCell!({
                                      rowId: row.id,
                                      colId: col.id,
                                      columnName: col.name,
                                      value: cell?.value != null ? String(cell.value) : "",
                                      editable: col.kind === "manual",
                                      anchor,
                                    })
                                : undefined
                            }
                            onRunCell={col.kind === "function" ? () => c.runCell(row.id, col.id) : undefined}
                            running={c.runningCells.has(`${row.id}:${col.id}`)}
                          />
                        </td>
                      );
                    })}
                    <GridColSpacer side="right" width={cw.spacers.right} />
                    <td className="grid-td" />
                  </tr>
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
            {ctxMenu.items.map((it, i) => (
              <button
                key={i}
                className={`ctx-item ${it.danger ? "danger" : ""}`}
                onClick={() => { setCtxMenu(null); it.onClick(); }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
