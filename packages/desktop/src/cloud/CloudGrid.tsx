/**
 * CloudGrid — the LIVE multiplayer grid view for a CLOUD project.
 *
 * It renders the SAME {@link DataGrid} the local environment uses (TRI-3313
 * follow-up: one shared grid, no divergence). CloudGrid's only job is to build
 * the {@link GridController} from the cloud data hooks + mutation layer and to
 * mount the SAME column-authoring modals the local grid uses, pointed at a
 * cloud backend via {@link ColumnAuthoringApiProvider}. Everything the user
 * sees and does in the grid — the header right-click menu, add/edit/delete
 * column, add row, run, cells — is therefore identical to local; only the
 * action functions differ (cloud tRPC + realtime instead of the local sidecar).
 *
 * Data source: the NEW tRPC + W3 realtime path via {@link useCloudTablePaged}
 * (paged + live), so edits/added rows/run statuses by any member appear without
 * a refresh. Running a column still goes through the local sidecar via the
 * {@link runCloudColumn} Effect orchestration — which is WHY the authoring
 * adapter reuses the LOCAL `api.aiProviders` / `api.generateFormula` (the same
 * sidecar AI that will execute the column).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useQuery as useReactQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Id } from "./ids";
import { apiClient } from "./client";
import { Icon, ExpandedEditor } from "../App";
import CellDetails, { extractCode } from "../CellDetails";
import { setAgentPresenceTable } from "./agentPresence";
import { api } from "../api";
import type { AiProviderInfo, Cell, ConnectorInfo, Column, FullTable } from "../api";
import {
  AddColumnPopover,
  FunctionsModal,
  ColumnAuthoringApiProvider,
  type ColumnAuthoringApi,
} from "../AddColumn";
import { ColumnEditPanel } from "../ColumnEditPanel";
import { DataGrid, type GridController } from "../DataGrid";
import { buildColumnMetaMap } from "../FnIcon";
import { DedupePopover } from "../DedupePopover";
import { resolveRowHeight } from "../gridVirtual";
import { buildPresenceView } from "../gridPresence";
import { runCloudColumn, runCloudPreview } from "./cloud-run";
import { cascadeDependents, runColumnsInDepOrder } from "../gridRun";
import { WebhookModal } from "./WebhookModal";
import { useMe } from "./auth";
import { gridPresenceStore, useGridPresenceRoster } from "./presenceStore";
import {
  gridQueryKeys,
  useCloudGridMutations,
  useCloudSession,
  useCloudTablePaged,
} from "./useCloudGrid";
import { isCloudTableMissing } from "../tableTree";

/** Fixed cloud column width (px) — cloud columns are not resizable. */
const CLOUD_COL_W = 180;

/**
 * How many dependent columns a cascade runs at once. Independent siblings run in
 * parallel up to this bound; the sidecar already clamps per-column row concurrency
 * and serializes through its own semaphore, so this only caps column fan-out.
 */
const CASCADE_CONCURRENCY = 4;

/** A signal binding's status fields the strip renders (tRPC listSignalBindings). */
interface SignalBindingStatus {
  readonly id: string;
  readonly label: string;
  readonly rowsPulled: number | null;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
  readonly enabled: boolean;
}

/** Compact relative timestamp for the signal strip. */
function agoLabel(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Social-signal status strip for a cloud table backed by Trigify bindings:
 * shows each binding's pull progress (rows pulled, last synced, last error) and
 * a "Sync now" that triggers the member-gated tRPC pull. This is the user's
 * RECOURSE when a signal table looks empty — previously there was no way to
 * see a binding error or re-pull without recreating the table. Renders nothing
 * for tables with no bindings (the common case — one cheap cached query).
 * Auto-refetches while a binding is still waiting for its first results so the
 * strip flips to "n rows" on its own as the warm-up lands them.
 */
function SignalStatusStrip({ tableId }: { tableId: string }) {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const q = useReactQuery({
    queryKey: ["signals", "bindings", tableId],
    enabled: apiClient !== null,
    queryFn: async (): Promise<readonly SignalBindingStatus[]> =>
      (await apiClient!.signals.listSignalBindings.query({
        tableId,
      })) as readonly SignalBindingStatus[],
    staleTime: 15_000,
    // Poll the strip while any binding is pre-first-data (the cloud warm-up is
    // filling it server-side); idle once data has landed.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((b) => (b.rowsPulled ?? 0) === 0 && b.enabled)
        ? 10_000
        : false,
  });
  const bindings = q.data ?? [];
  if (bindings.length === 0) return null;

  const syncNow = async (bindingId: string) => {
    if (apiClient === null) return;
    setSyncing(bindingId);
    setSyncError(null);
    try {
      await apiClient.signals.syncSignalBinding.mutate({ bindingId });
      // Refresh the strip AND the grid page so newly-pulled rows appear without
      // waiting for a window-focus refetch.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["signals", "bindings", tableId] }),
        qc.invalidateQueries({ queryKey: gridQueryKeys.tablePaged(tableId) }),
      ]);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div className="signal-strip" role="status">
      {bindings.map((b) => (
        <div key={b.id} className="signal-strip-row">
          <span className="signal-strip-dot" data-state={b.lastError ? "error" : (b.rowsPulled ?? 0) > 0 ? "ok" : "warming"} />
          <span className="signal-strip-label">{b.label}</span>
          <span className="signal-strip-meta">
            {(b.rowsPulled ?? 0) > 0
              ? `${b.rowsPulled} rows pulled${b.lastSyncedAt ? ` · synced ${agoLabel(b.lastSyncedAt)}` : ""}`
              : "waiting for first results — Trigify is scraping (~1 min)"}
          </span>
          {b.lastError && <span className="signal-strip-error" title={b.lastError}>{b.lastError}</span>}
          <button
            className="btn btn-outline btn-sm"
            disabled={syncing !== null}
            onClick={() => void syncNow(b.id)}
            title="Pull the latest results from Trigify now"
          >
            {syncing === b.id ? "Syncing…" : "Sync now"}
          </button>
        </div>
      ))}
      {syncError && <div className="signal-strip-error">{syncError}</div>}
    </div>
  );
}

interface CloudGridProps {
  /** The active cloud table to render, or `null` when none is selected. */
  tableId: Id<"tables"> | null;
  /** The connector/function catalog for the Functions browser (shared with local). */
  connectors: ConnectorInfo[];
  /** Open the AI-provider settings (the Functions browser's "configure AI" link). */
  onOpenAiSettings?: () => void;
  /**
   * A monotonically-increasing token that, when it changes to a truthy value,
   * auto-opens the webhook setup form for the current table.
   */
  openWebhookToken?: number;
  /**
   * Fired when the open cloud table's load returns 404 / not-found so the parent
   * can self-heal to the table's current linked cloud id (TRI-3312).
   */
  onMissing?: () => void;
}

export function CloudGrid({
  tableId,
  connectors,
  onOpenAiSettings,
  openWebhookToken,
  onMissing,
}: CloudGridProps) {
  const { data, loadMore, hasMore, isLoadingMore } = useCloudTablePaged(tableId);
  const session = useCloudSession();
  const {
    setCell,
    addRow,
    addColumn,
    updateColumn,
    deleteRow,
    deleteColumn,
    setDedupe,
    dedupeTable,
  } = useCloudGridMutations();

  const [runningColId, setRunningColId] = useState<string | null>(null);
  const [runningCells, setRunningCells] = useState<Set<string>>(new Set());
  const [showWebhook, setShowWebhook] = useState(false);
  // Authoring overlays (shared with the local grid; opened via controller intents).
  const [showAddCol, setShowAddCol] = useState(false);
  const [addColAnchor, setAddColAnchor] = useState<{ left: number; top: number } | null>(null);
  const [showFunctions, setShowFunctions] = useState(false);
  const [editCol, setEditCol] = useState<Column | null>(null);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  // Cell-details drawer (view a function/HTTP cell's full response) + expanded
  // editor (long text). Mirrors the local grid so synced responses are inspectable.
  const [detail, setDetail] = useState<{ columnName: string; value: unknown } | null>(null);
  const [cellExpand, setCellExpand] = useState<{
    rowId: string;
    colId: string;
    columnName: string;
    value: string;
    editable: boolean;
    anchor: { left: number; top: number; width: number };
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rowHeight = resolveRowHeight();

  // ── Multiplayer presence ───────────────────────────────────────────────
  // The live roster (fed by the realtime hook) resolved into the avatar stack +
  // per-cell cursor index, with the local user excluded.
  const me = useMe();
  const selfId = me?.user._id ?? null;
  const roster = useGridPresenceRoster();
  const presenceView = useMemo(
    () => buildPresenceView(roster, selfId),
    [roster, selfId],
  );

  // "provider.method" → presentation metadata (logo, labels, credits) for the
  // grid headers; rebuilt only when the connector catalog changes.
  const fnColumnMeta = useMemo(() => buildColumnMetaMap(connectors), [connectors]);

  // model id → AI provider identity, so ai.generate columns wear the logo of
  // the model they call. The LOCAL sidecar's provider catalog is correct here
  // too — it's the engine that executes cloud AI columns.
  const [aiProviders, setAiProviders] = useState<AiProviderInfo[]>([]);
  useEffect(() => {
    let ignore = false;
    api
      .aiProviders()
      .then((p) => {
        if (!ignore) setAiProviders(p);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);
  const aiModelMeta = useMemo(() => {
    const m = new Map<string, { providerName: string; logo: string | null }>();
    for (const p of aiProviders) {
      for (const model of p.models) if (!m.has(model)) m.set(model, { providerName: p.name, logo: p.logo });
    }
    return m;
  }, [aiProviders]);

  const columnMeta = useCallback(
    (col: Column) => {
      const base = col.fn ? fnColumnMeta.get(col.fn) ?? null : null;
      if (col.provider === "ai") {
        const model = typeof col.params?.model === "string" ? col.params.model : "";
        const mp = model ? aiModelMeta.get(model) : undefined;
        if (mp) {
          return {
            providerName: mp.providerName,
            logo: mp.logo,
            methodLabel: model,
            category: "AI",
            credits: base?.credits,
            requiredInputs: base?.requiredInputs,
          };
        }
      }
      return base;
    },
    [fnColumnMeta, aiModelMeta],
  );
  // Seed our identity (name/image) so cursor publishes carry it; re-seed when the
  // open table changes (a fresh subscription registers a new publisher).
  useEffect(() => {
    if (me?.user) {
      gridPresenceStore.updateLocal({
        userId: me.user._id,
        name: me.user.name,
        image: me.user.image,
      });
    }
  }, [me, tableId]);

  // Publish the open table's identity (name + column name→id) for the agent
  // presence mapper — read at tool-event time, never re-rendering anything.
  useEffect(() => {
    if (tableId !== null && data != null) {
      setAgentPresenceTable({
        tableId,
        tableName: data.name,
        columnIdByName: new Map(
          data.columns.map((col) => [col.name.trim().toLowerCase(), col.id]),
        ),
      });
    }
    return () => setAgentPresenceTable(null);
  }, [tableId, data]);

  // Auto-open the webhook form when the chooser's "Webhook" flow bumps the token.
  const lastTokenRef = useRef(0);
  useEffect(() => {
    if (!openWebhookToken || openWebhookToken === lastTokenRef.current) return;
    lastTokenRef.current = openWebhookToken;
    if (tableId !== null) setShowWebhook(true);
  }, [openWebhookToken, tableId]);

  // Open-cloud-table 404 self-heal (TRI-3312): tell the parent ONCE per
  // (table, missing) so it can re-point to the current linked cloud id.
  const missingFiredFor = useRef<string | null>(null);
  useEffect(() => {
    if (tableId !== null && isCloudTableMissing(data)) {
      if (missingFiredFor.current !== tableId) {
        missingFiredFor.current = tableId;
        onMissing?.();
      }
    } else if (!isCloudTableMissing(data)) {
      missingFiredFor.current = null;
    }
  }, [tableId, data, onMissing]);

  // Latest function-column set, read by the cascade closures at call time so they
  // stay referentially stable across realtime updates (runCell is part of the
  // memoized `cellActions` bundle — see DataGrid; a `data`-dependent closure would
  // re-render every visible cell on each cell.upsert).
  const cascadeColumnsRef = useRef<Column[]>([]);
  cascadeColumnsRef.current = data?.columns ?? [];

  // Raw single-column run (sidecar call + header spinner), WITHOUT cascading — the
  // unit that the cascade and run-all compose over.
  const runColumnRaw = useCallback(
    async (columnId: string, opts: { force?: boolean; rowIds?: string[] }) => {
      if (tableId === null) return;
      setRunningColId(columnId);
      try {
        await runCloudColumn(session, {
          tableId,
          columnId,
          force: opts.force,
          rowIds: opts.rowIds,
        });
      } catch {
        /* surfaced live via the cell error status */
      } finally {
        setRunningColId(null);
      }
    },
    [tableId, session],
  );

  // The data cascade: once the seed columns produced data for `rowIds`, run every
  // column DOWNSTREAM of them (force, because their input just changed) in
  // dependency order — independent siblings in parallel, chained ones serialized.
  // e.g. Get API data → map field in sibling → compute value in next sibling.
  const cascadeFrom = useCallback(
    async (seedColumnIds: string[], rowIds?: string[]) => {
      const fnCols = cascadeColumnsRef.current.filter((c) => c.kind === "function");
      await cascadeDependents(seedColumnIds, fnCols, rowIds, CASCADE_CONCURRENCY, runColumnRaw);
    },
    [runColumnRaw],
  );

  const runColumn = useCallback(
    async (columnId: string, opts?: { force?: boolean; rowIds?: string[] }) => {
      // FORCE by default on an explicit column run: a synced/re-run table arrives
      // with cells already "done", and a non-forced run skips them. The header
      // context menu's scoped variants pass `opts` explicitly (e.g. force:false).
      await runColumnRaw(columnId, { force: opts?.force ?? true, rowIds: opts?.rowIds });
      // …then populate everything that depends on it for the same rows.
      await cascadeFrom([columnId], opts?.rowIds);
    },
    [runColumnRaw, cascadeFrom],
  );

  // Run every function column for a subset of rows (the user's selection) in
  // dependency order — independent columns in parallel, dependents after sources.
  const runRows = useCallback(
    async (rowIds: string[]) => {
      if (tableId === null || rowIds.length === 0) return;
      const fnCols = cascadeColumnsRef.current.filter((c) => c.kind === "function");
      // Non-force: "Run selected rows" computes the unrun cells in dep order.
      await runColumnsInDepOrder(fnCols, rowIds, CASCADE_CONCURRENCY, runColumnRaw, false);
    },
    [tableId, runColumnRaw],
  );

  const runCell = useCallback(
    async (rowId: string, columnId: string) => {
      if (tableId === null) return;
      const key = `${rowId}:${columnId}`;
      setRunningCells((s) => new Set(s).add(key));
      try {
        await runCloudColumn(session, { tableId, columnId, force: true, rowIds: [rowId] });
      } catch {
        /* surfaced live via the cell error status */
      } finally {
        setRunningCells((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
      // Cascade dependents for just this row.
      await cascadeFrom([columnId], [rowId]);
    },
    [tableId, session, cascadeFrom],
  );

  // Run an explicit set of function cells (range selection's "Run N cells"):
  // one scoped force+rowIds run per column, then cascade the affected columns/rows.
  const runCells = useCallback(
    async (cells: Array<{ rowId: string; colId: string }>) => {
      if (tableId === null) return;
      const byCol = new Map<string, string[]>();
      for (const { rowId, colId } of cells) {
        const list = byCol.get(colId) ?? [];
        list.push(rowId);
        byCol.set(colId, list);
      }
      for (const [columnId, rowIds] of byCol) {
        const keys = rowIds.map((r) => `${r}:${columnId}`);
        setRunningCells((s) => { const n = new Set(s); for (const k of keys) n.add(k); return n; });
        try {
          await runCloudColumn(session, { tableId, columnId, force: true, rowIds });
        } catch {
          /* surfaced live via the cell error status */
        } finally {
          setRunningCells((s) => { const n = new Set(s); for (const k of keys) n.delete(k); return n; });
        }
      }
      await cascadeFrom([...byCol.keys()], [...new Set(cells.map((c) => c.rowId))]);
    },
    [tableId, session, cascadeFrom],
  );

  // Surface mutation failures inline instead of dropping them as unhandled
  // rejections (a failed add previously looked like the button "did nothing").
  const guard = useCallback(async (fn: () => Promise<unknown>, what: string) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : `Failed to ${what}`);
    }
  }, []);

  // ── Stable cell-level intents (TRI render-perf) ──────────────────────────
  // These feed the memoized grid rows/cells via DataGrid's `cellActions` bundle,
  // so they MUST keep a stable identity across renders — otherwise a realtime
  // flush (which rebuilds the controller object) would re-render every visible
  // cell. `guard`, the mutation fns and `tableId` are all themselves stable.
  const handleSetCell = useCallback(
    (rowId: string, colId: string, value: string) => {
      if (tableId === null) return;
      void guard(
        () => setCell(tableId, rowId as Id<"rows">, colId as Id<"columns">, value),
        "set cell",
      );
    },
    [guard, setCell, tableId],
  );
  const handleClearCell = useCallback(
    (rowId: string, colId: string) => {
      if (tableId === null) return;
      void guard(
        () => setCell(tableId, rowId as Id<"rows">, colId as Id<"columns">, ""),
        "clear cell",
      );
    },
    [guard, setCell, tableId],
  );
  const handleOpenCellDetails = useCallback((col: Column, cell: Cell | undefined) => {
    // One right rail at a time: the details drawer overlaps the edit panel.
    setEditCol(null);
    setDetail({
      columnName: col.name,
      value: cell?.value ?? (cell?.error ? { error: cell.error } : null),
    });
  }, []);
  const handleActiveCellChange = useCallback(
    (cell: { rowId: string; colId: string } | null) =>
      gridPresenceStore.updateLocal({
        cursor: cell ? { rowId: cell.rowId, columnId: cell.colId } : null,
        editing: null,
      }),
    [],
  );
  const handleEditingCellChange = useCallback(
    (cell: { rowId: string; colId: string } | null) =>
      gridPresenceStore.updateLocal(
        cell
          ? {
              editing: { rowId: cell.rowId, columnId: cell.colId },
              cursor: { rowId: cell.rowId, columnId: cell.colId },
            }
          : { editing: null }, // stopped editing — keep the selection cursor
      ),
    [],
  );

  // The cloud column-authoring backend. addColumn / updateColumn target the
  // cloud tRPC API; generateFormula / aiProviders reuse the LOCAL sidecar (which
  // is what runs cloud columns), so AI + formula authoring works identically.
  const cloudColumnApi = useMemo<ColumnAuthoringApi>(
    () => ({
      addColumn: async (tId, body) => {
        const id = await addColumn(tId as Id<"tables">, {
          name: body.name,
          type: body.type,
          fn: body.fn,
          code: body.code ?? undefined,
          params: body.params,
        });
        return { id: String(id) };
      },
      updateColumn: async (columnId, patch) => {
        if (tableId === null) throw new Error("No table selected");
        const col = await updateColumn(tableId, columnId as Id<"columns">, {
          name: patch.name,
          type: patch.type as
            | "text" | "number" | "boolean" | "date" | "json" | undefined,
          kind: patch.kind as "manual" | "function" | undefined,
          provider: patch.provider,
          method: patch.method,
          code: patch.code,
          params: patch.params as Record<string, unknown> | undefined,
          condition: patch.condition,
        });
        // The live `column.update` broadcast patches the grid; return the shape
        // the modal expects.
        return { ok: true as const, id: col.id, tableId: col.tableId };
      },
      generateFormula: api.generateFormula,
      aiProviders: api.aiProviders,
      // Previewing a function dry-runs it through the sidecar's cloud preview
      // route (same worker-backed store as a cloud column run, but persisting /
      // metering nothing). Authenticated as the signed-in member via `session`.
      previewFunction: (tId, body) => runCloudPreview(session, { tableId: tId, ...body }),
    }),
    [addColumn, updateColumn, tableId, session],
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

  // Webhook setup renders INLINE in this pane (replacing the grid).
  if (showWebhook) {
    return (
      <WebhookModal
        inline
        tableId={data.id as Id<"tables">}
        columns={data.columns}
        tableName={data.name}
        rowCount={data.rows.length}
        onClose={() => setShowWebhook(false)}
      />
    );
  }

  const table: FullTable = data;
  const fnColCount = table.columns.filter((c) => c.kind === "function").length;

  // ── Promote a JSON field to a column (from the Cell details drawer) ──
  // Mirrors the local grid's promoteCreate/promoteMap: a FUNCTION column whose
  // code extracts the chosen path from the source cell ({{<source column>}}),
  // so the mapping applies to every row — existing (run now) and future (the
  // webhook worker's auto-run enriches new rows).
  const uniqueColName = (base: string): string => {
    const existing = new Set(table.columns.map((c) => c.name.toLowerCase()));
    if (!existing.has(base.toLowerCase())) return base;
    let n = 2;
    while (existing.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  };
  const promoteCreate = async (path: string[], label: string) => {
    if (!detail) return;
    const srcName = detail.columnName;
    // Dismiss the cell-details drawer immediately — the new column appears in the
    // grid with its cells loading while the run (below) fills them.
    setDetail(null);
    const id = await addColumn(tableId, {
      name: uniqueColName(label),
      type: "text",
      code: extractCode(path),
      params: { src: `{{${srcName}}}` },
    });
    await runColumn(String(id)).catch(() => {});
  };
  const promoteMap = async (path: string[], targetId: string) => {
    if (!detail) return;
    const srcName = detail.columnName;
    // Dismiss the cell-details drawer immediately; the mapped column's cells show
    // a loading state until the run populates them.
    setDetail(null);
    await updateColumn(tableId, targetId as Id<"columns">, {
      kind: "function",
      provider: null,
      method: null,
      code: extractCode(path),
      params: { src: `{{${srcName}}}` },
    });
    await runColumn(targetId).catch(() => {});
  };

  // Duplicate a column: copy the config (incl. custom code), then carry the run
  // condition over via updateColumn (the cloud addColumn mutation has no
  // condition field). Cells start empty — duplicating copies the recipe, not
  // the results.
  const duplicateColumn = async (col: Column) => {
    const body: { name: string; type?: string; fn?: string; code?: string; params?: Record<string, unknown> } = {
      name: uniqueColName(`${col.name} copy`),
      type: col.type,
      params: col.params,
    };
    if (col.fn === "code") body.code = col.code ?? undefined;
    else if (col.fn) body.fn = col.fn;
    const id = await addColumn(tableId, body);
    if (col.condition) {
      await updateColumn(tableId, id as Id<"columns">, { condition: col.condition });
    }
  };

  const controller: GridController = {
    table,
    rowHeight,
    columnWidth: () => CLOUD_COL_W,
    minColWidth: 80,
    runProgress: null,
    runningColId,
    runningCells,
    fnColCount,
    canRun: session !== null,
    runDisabledReason: session === null ? "Sign in to run cloud columns" : undefined,
    canAddRow: true,
    toolbarLeftExtras: (
      <button
        className="autorun-toggle"
        onClick={() => setDedupeOpen(true)}
        title="Deduplicate rows on a column"
      >
        <span className="autorun-label">Dedupe</span>
        {table.dedupe && <span className="dedupe-on-dot" title="Auto-dedupe is on" />}
      </button>
    ),
    toolbarExtras: (
      <>
        <span className="free-badge" title="Live multiplayer">LIVE</span>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => setShowWebhook(true)}
          title="Configure this table's inbound webhook"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17a4 4 0 0 1 3.6-3.98" /><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" /></svg>{" "}
          Webhook
        </button>
      </>
    ),
    columnMeta,
    addRow: () => void guard(() => addRow(tableId), "add row"),
    runAll: async () => {
      // Run every function column in DEPENDENCY order (independent columns in
      // parallel, dependents after their sources) — the ordering IS the cascade.
      const fnCols = table.columns.filter((c) => c.kind === "function");
      await runColumnsInDepOrder(fnCols, undefined, CASCADE_CONCURRENCY, runColumnRaw, true);
    },
    runRows,
    runColumn,
    runCell,
    runCells,
    setCell: handleSetCell,
    deleteRow: (rowId) => void guard(() => deleteRow(tableId, rowId as Id<"rows">), "delete row"),
    deleteColumn: (colId) => void guard(() => deleteColumn(tableId, colId as Id<"columns">), "delete column"),
    clearCell: handleClearCell,
    // One right rail at a time: the edit panel overlaps the details drawer.
    editColumn: (col) => { setDetail(null); setEditCol(col); },
    renameColumn: (colId, name) =>
      void guard(() => updateColumn(tableId, colId as Id<"columns">, { name }), "rename column"),
    duplicateColumn: (col) => void guard(() => duplicateColumn(col), "duplicate column"),
    openAddColumn: (anchor) => { setAddColAnchor(anchor); setShowAddCol(true); },
    // Cloud columns are a fixed width (no resize) — omit `resizeColumn`.
    onScrollNearBottom: hasMore && !isLoadingMore ? loadMore : undefined,
    // Inspect a cell's full response (status-code/JSON) like the local grid;
    // the drawer supports promote-to-column (Clay-style field mapping).
    openCellDetails: handleOpenCellDetails,
    expandCell: setCellExpand,
    // ── Multiplayer presence ──
    presence: presenceView,
    onActiveCellChange: handleActiveCellChange,
    onEditingCellChange: handleEditingCellChange,
  };

  return (
    <ColumnAuthoringApiProvider value={cloudColumnApi}>
      {actionError && (
        <div className="account-menu-error" role="alert" style={{ margin: "6px 12px" }}>
          {actionError}
        </div>
      )}
      <SignalStatusStrip tableId={String(table.id)} />
      <DataGrid controller={controller} />

      {detail && (
        <CellDetails
          source={detail}
          columns={table.columns.map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => setDetail(null)}
          onCreate={(path, label) => guard(() => promoteCreate(path, label), "add column")}
          onMapTo={(path, targetId) => guard(() => promoteMap(path, targetId), "map column")}
        />
      )}

      {cellExpand && (
        <ExpandedEditor
          columnName={cellExpand.columnName}
          value={cellExpand.value}
          editable={cellExpand.editable}
          anchor={cellExpand.anchor}
          onSave={(v) =>
            void guard(
              () =>
                setCell(
                  tableId,
                  cellExpand.rowId as Id<"rows">,
                  cellExpand.colId as Id<"columns">,
                  v,
                ),
              "set cell",
            )
          }
          onClose={() => setCellExpand(null)}
        />
      )}

      {dedupeOpen && (
        <DedupePopover
          columns={table.columns.map((c) => ({ id: c.id, name: c.name }))}
          current={table.dedupe ?? null}
          setDedupe={(body) => setDedupe(table.id as Id<"tables">, body)}
          dedupeTable={() => dedupeTable(table.id as Id<"tables">)}
          onClose={() => setDedupeOpen(false)}
          onChanged={() => setDedupeOpen(false)}
        />
      )}

      {showAddCol && (
        <AddColumnPopover
          tableId={table.id}
          anchor={addColAnchor}
          onClose={() => setShowAddCol(false)}
          onAdded={() => setShowAddCol(false)}
          onUseFunction={() => { setShowAddCol(false); setShowFunctions(true); }}
        />
      )}

      {showFunctions && (
        <FunctionsModal
          tableId={table.id}
          connectors={connectors}
          onClose={() => setShowFunctions(false)}
          onAdded={(col) => {
            setShowFunctions(false);
            // Clay flow: the column was just added — configure it in the rail.
            if (col) {
              setDetail(null);
              setEditCol(col);
            }
          }}
          onOpenAiSettings={onOpenAiSettings}
        />
      )}

      {editCol && (
        <ColumnEditPanel
          column={editCol}
          columns={table.columns.map((c) => ({ id: c.id, name: c.name, type: c.type }))}
          connectors={connectors}
          // No tableId: the preview dry-run resolves rows via the LOCAL sidecar,
          // which can't see cloud tables — the panel hides Try-on-rows without it.
          rows={table.rows}
          onClose={() => setEditCol(null)}
          onSaved={(run) => {
            const colId = editCol.id;
            setEditCol(null);
            if (run) void runColumn(colId, run);
          }}
          onError={setActionError}
        />
      )}
    </ColumnAuthoringApiProvider>
  );
}
