/**
 * CloudGrid (T9) — the LIVE multiplayer grid view for a CLOUD project.
 *
 * Renders a cloud table straight from Convex via {@link useCloudTable} (a
 * `useQuery` subscription), so cell edits / added rows / run statuses by any
 * workspace member appear here without a refresh. Edits, add row and add column
 * call the T4 Convex mutations ({@link useCloudGridMutations}); running a column
 * goes through the local sidecar with a Convex-backed engine via the
 * {@link runCloudColumn} Effect orchestration.
 *
 * It reuses the existing `CellContent` cell renderer and the shared `.grid-*`
 * CSS, so cloud and local grids look identical — only the data source differs.
 * The component stays plain React; the run LOGIC is the Effect service.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { CellContent, Icon } from "../App";
import type { Cell } from "../api";
import { runCloudColumn } from "./cloud-run";
import { WebhookModal } from "./WebhookModal";
import {
  useCloudGridMutations,
  useCloudSession,
  useCloudTable,
} from "./useCloudGrid";

interface CloudGridProps {
  /** The active cloud table to render, or `null` when none is selected. */
  tableId: Id<"tables"> | null;
  /**
   * A monotonically-increasing token that, when it changes to a truthy value,
   * auto-opens the webhook setup form for the current table. Used by the
   * "New table → Webhook" chooser flow to land directly on the webhook form
   * after creating/selecting the cloud table. `0`/undefined = do nothing.
   */
  openWebhookToken?: number;
}

/**
 * The cloud grid. Self-contained: it owns its own column-run / cell-run busy
 * state (the live `running` cell status comes from Convex, so we only track the
 * in-flight request to disable the trigger).
 */
export function CloudGrid({ tableId, openWebhookToken }: CloudGridProps) {
  const data = useCloudTable(tableId);
  const session = useCloudSession();
  const { setCell, addRow, addColumn, deleteRow, deleteColumn } =
    useCloudGridMutations();

  const [runningColId, setRunningColId] = useState<string | null>(null);
  const [runningCells, setRunningCells] = useState<Set<string>>(new Set());
  const [showWebhook, setShowWebhook] = useState(false);

  // Auto-open the webhook form when the chooser's "Webhook" flow bumps the token
  // (and a table is actually present to bind it to).
  const lastTokenRef = useRef(0);
  useEffect(() => {
    if (!openWebhookToken || openWebhookToken === lastTokenRef.current) return;
    lastTokenRef.current = openWebhookToken;
    if (tableId !== null) setShowWebhook(true);
  }, [openWebhookToken, tableId]);

  const runColumn = useCallback(
    async (columnId: string) => {
      if (tableId === null) return;
      setRunningColId(columnId);
      try {
        await runCloudColumn(session, { tableId, columnId });
      } catch {
        /* surfaced live via the cell error status from Convex */
      } finally {
        setRunningColId(null);
      }
    },
    [tableId, session],
  );

  const runCell = useCallback(
    async (rowId: string, columnId: string) => {
      if (tableId === null) return;
      const key = `${rowId}:${columnId}`;
      setRunningCells((s) => new Set(s).add(key));
      try {
        await runCloudColumn(session, {
          tableId,
          columnId,
          force: true,
          rowIds: [rowId],
        });
      } catch {
        /* surfaced live via the cell error status from Convex */
      } finally {
        setRunningCells((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [tableId, session],
  );

  if (tableId === null) {
    return (
      <div className="empty-state">
        <div className="empty-icon"><Icon.Grid /></div>
        <div className="empty-title">No table selected</div>
        <p className="empty-sub">Select a cloud table to view it live.</p>
      </div>
    );
  }

  if (data === undefined) {
    return (
      <div className="empty-state">
        <div className="cell-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="empty-state">
        <div className="empty-icon"><Icon.Zap /></div>
        <div className="empty-title">Table unavailable</div>
        <p className="empty-sub">This cloud table no longer exists.</p>
      </div>
    );
  }

  const fnColCount = data.columns.filter((c) => c.kind === "function").length;

  return (
    <>
      <div className="toolbar">
        <span className="toolbar-title">{data.name}</span>
        <span className="toolbar-meta">
          {data.rows.length} rows · {data.columns.length} cols
        </span>
        <span className="free-badge" title="Live multiplayer (Convex)">LIVE</span>
        <div className="toolbar-spacer" />
        <button
          className="btn btn-outline btn-sm"
          onClick={() => addRow(data.id as Id<"tables">)}
        >
          <Icon.Plus size={11} /> Add row
        </button>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => setShowWebhook(true)}
          title="Configure this table's inbound webhook"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17a4 4 0 0 1 3.6-3.98" /><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" /></svg>{" "}
          Webhook
        </button>
        <div className="toolbar-sep" />
        <button
          className="btn btn-primary btn-sm"
          disabled={fnColCount === 0 || session === null}
          title={
            session === null
              ? "Sign in to run cloud columns"
              : fnColCount === 0
                ? "No function columns to run"
                : `Run ${fnColCount} function column${fnColCount !== 1 ? "s" : ""}`
          }
          onClick={async () => {
            for (const col of data.columns.filter((c) => c.kind === "function")) {
              await runColumn(col.id);
            }
          }}
        >
          <Icon.Play size={10} /> Run
        </button>
      </div>

      {data.columns.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><Icon.Zap /></div>
          <div className="empty-title">No columns yet</div>
          <p className="empty-sub">
            Add a column to define this cloud table's structure.
          </p>
          <button
            className="btn btn-primary"
            onClick={() =>
              addColumn(data.id as Id<"tables">, { name: "Column", type: "text" })
            }
          >
            <Icon.Plus /> Add first column
          </button>
        </div>
      ) : (
        <div className="grid-wrap">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="grid-th row-num-th col-row-num" />
                {data.columns.map((col) => (
                  <th
                    key={col.id}
                    className="grid-th"
                    style={{ width: 180, minWidth: 80 }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      deleteColumn(col.id as Id<"columns">);
                    }}
                    title="Right-click to delete column"
                  >
                    <div className="th-inner">
                      <span className="th-name">{col.name}</span>
                      {col.kind === "function" && col.fn && (
                        <span className="th-fn-badge" title={col.fn}>
                          {col.fn.split(".").pop()}
                        </span>
                      )}
                      {col.kind === "function" && (
                        <button
                          className="th-run-btn"
                          title={`Run ${col.name}`}
                          onClick={() => runColumn(col.id)}
                          disabled={runningColId === col.id || session === null}
                        >
                          {runningColId === col.id ? (
                            <span className="cell-spinner" />
                          ) : (
                            <Icon.Play size={9} />
                          )}
                        </button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="grid-th add-col-th">
                  <button
                    className="add-col-btn"
                    title="Add column"
                    onClick={() =>
                      addColumn(data.id as Id<"tables">, { name: "Column", type: "text" })
                    }
                  >
                    <Icon.Plus size={16} />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 ? (
                <tr>
                  <td className="grid-td row-num-td" />
                  {data.columns.map((col) => (
                    <td key={col.id} className="grid-td">
                      <div className="cell-wrap"><span className="cell-empty">—</span></div>
                    </td>
                  ))}
                  <td className="grid-td" />
                </tr>
              ) : (
                data.rows.map((row, idx) => (
                  <tr key={row.id} className="grid-tr">
                    <td className="grid-td row-num-td">{idx + 1}</td>
                    {data.columns.map((col) => {
                      const cell: Cell | undefined = row.cells[col.id];
                      return (
                        <td key={col.id} className="grid-td">
                          <CellContent
                            cell={cell}
                            col={col}
                            onEdit={(v) =>
                              setCell(
                                row.id as Id<"rows">,
                                col.id as Id<"columns">,
                                v,
                              )
                            }
                            onRunCell={
                              col.kind === "function"
                                ? () => runCell(row.id, col.id)
                                : undefined
                            }
                            running={runningCells.has(`${row.id}:${col.id}`)}
                          />
                        </td>
                      );
                    })}
                    <td className="grid-td">
                      <button
                        className="th-run-btn"
                        title="Delete row"
                        onClick={() => deleteRow(row.id as Id<"rows">)}
                      >
                        <Icon.X />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {showWebhook && (
        <WebhookModal
          tableId={data.id as Id<"tables">}
          columns={data.columns}
          tableName={data.name}
          rowCount={data.rows.length}
          onClose={() => setShowWebhook(false)}
        />
      )}
    </>
  );
}
