/**
 * Cloud grid hooks — the reactive data source for CLOUD projects.
 *
 * A LOCAL project's grid loads imperatively via the sidecar (`api.table()` in
 * api.ts). A CLOUD project's grid is LIVE.
 *
 * Reads/writes go through the typed tRPC client (`apiClient`, ./client) consumed
 * DIRECTLY via `@tanstack/react-query` hooks (queryFn/mutationFn). Live
 * reactivity is provided by the W3 shared realtime module
 * (`@gtmgrid/services/realtime`): each grid view SEEDS via tRPC `grid.getTable`
 * then SUBSCRIBES via `subscribeToGrid`, patching the react-query cache with the
 * pure `applyGridEvent` reducer on every inbound event.
 *
 * These hooks deliberately produce the SAME shapes the existing grid render
 * components consume (`Column`, `Cell`, a `FullTable`-like view) so the cloud
 * grid reuses `CellContent` etc. — only the data source changes.
 */

import {
  useInfiniteQuery,
  useQuery as useRqQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { applyGridEvent, subscribeToGrid } from "@gtmgrid/services/realtime";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Id } from "./ids";
import type { Cell, CellStatus, Column, FullTable } from "../api";
import { apiClient, queryClient } from "./client";
import type { CloudSession } from "./cloud-run";
import { useApiAuthToken } from "./useApiAuth";

/**
 * The PartyKit base URL the realtime client (`subscribeToGrid`) connects with.
 * Read once from Vite's `import.meta.env`; empty strings are treated as unset.
 * The realtime CONNECTION is authorized by a server-minted, WORKSPACE-SCOPED
 * token (`realtime.token`) that the party validates against the room — all
 * reads/writes still go through tRPC.
 */
const PARTY_URL: string | undefined =
  (import.meta.env.VITE_PARTY_URL as string | undefined) || undefined;

/**
 * Whether the live-grid realtime path is configured. The grid hooks always
 * SEED via tRPC; they additionally SUBSCRIBE via PartyKit only when the party
 * URL is present, so a build without realtime config still works (it just won't
 * receive live patches). Pure boolean off module env.
 */
const realtimeConfigured: boolean = PARTY_URL !== undefined;

/**
 * The cursor-paginated result shape the deliveries panel consumes: the loaded
 * `results`, a `loadMore` trigger, and a discrete `status` for the "Load more"
 * control. (Formerly the Convex `UsePaginatedQueryResult`; redefined locally so
 * the cloud grid no longer depends on `convex/react`.)
 */
export interface PaginatedResult<T> {
  readonly results: readonly T[];
  readonly status:
    | "LoadingFirstPage"
    | "CanLoadMore"
    | "LoadingMore"
    | "Exhausted";
  readonly isLoading: boolean;
  readonly loadMore: (numItems: number) => void;
}

/** A cloud project as listed for the switcher (the `listProjects` query shape). */
export interface CloudProject {
  readonly _id: Id<"projects">;
  readonly workspaceId: Id<"workspaces">;
  readonly name: string;
  readonly createdAt: number;
}

/** A cloud table summary for the sidebar (the `listTables` query shape). */
export interface CloudTableSummary {
  readonly _id: Id<"tables">;
  readonly projectId: Id<"projects">;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
}

// ───────────────────────────── react-query keys ─────────────────────────────

/**
 * The react-query key factory for the tRPC path. Centralised so the realtime
 * cache-patch updaters and the query/invalidation calls target identical keys.
 * Pure + serialisable so it is trivially unit-testable.
 */
export const gridQueryKeys = {
  projects: (workspaceId: string) => ["grid", "projects", workspaceId] as const,
  tables: (projectId: string) => ["grid", "tables", projectId] as const,
  table: (tableId: string) => ["grid", "table", tableId] as const,
  webhooks: (tableId: string) => ["webhooks", "list", tableId] as const,
  deliveries: (webhookId: string) =>
    ["webhooks", "deliveries", webhookId] as const,
};

/**
 * The `getTable` snapshot the react-query cache holds. Equal in shape to
 * `@gtmgrid/services` `GridSnapshot` / `FullGrid`, so the tRPC result is stored
 * directly and fed back through {@link applyGridEvent} without translation.
 */
type GridCacheSnapshot = Awaited<
  ReturnType<NonNullable<typeof apiClient>["grid"]["getTable"]["query"]>
>;

/**
 * Mint the Supabase realtime JWT via the tRPC `realtime.token` MUTATION. Thrown
 * if the cloud layer is disabled (callers guard on `apiClient` first). Extracted
 * so the realtime-token plumbing is a single named seam.
 */
async function mintRealtimeToken(workspaceId: string): Promise<string> {
  if (apiClient === null) throw new Error("API client unavailable");
  const { token } = await apiClient.realtime.token.mutate({ workspaceId });
  return token;
}

/**
 * The signed-in cloud session (apps/web API URL + Better Auth bearer token)
 * needed to run a cloud column via the sidecar, or `null` when cloud is off /
 * not yet authenticated. `useApiAuthToken` is reactive.
 */
export function useCloudSession(): CloudSession | null {
  const token = useApiAuthToken();
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) || "";
  if (!token || apiUrl === "") return null;
  return { apiUrl, token };
}

/**
 * Reactive list of a workspace's cloud projects. `undefined` while loading;
 * issues zero calls when cloud is off or no workspace is active.
 */
export function useCloudProjects(
  workspaceId: Id<"workspaces"> | null,
): CloudProject[] | undefined {
  // The grid realtime channel is scoped by workspace; capture the active
  // workspace here (App calls this with the active workspace) so the
  // workspace-less `getTable` snapshot can still scope its subscription.
  if (workspaceId !== null) activeWorkspaceIdRef.current = workspaceId;
  const q = useRqQuery({
    queryKey: gridQueryKeys.projects(workspaceId ?? ""),
    enabled: apiClient !== null && workspaceId !== null,
    queryFn: () =>
      apiClient!.grid.listProjects.query({ workspaceId: workspaceId! }),
  });
  return useMemo<CloudProject[] | undefined>(
    () =>
      q.data?.map((p) => ({
        _id: p.id as Id<"projects">,
        workspaceId: p.workspaceId as Id<"workspaces">,
        name: p.name,
        createdAt: p.createdAt,
      })),
    [q.data],
  );
}

/**
 * Reactive list of a cloud project's tables. `undefined` while loading; issues
 * zero calls when cloud is off or no cloud project is active.
 */
export function useCloudTables(
  projectId: Id<"projects"> | null,
): CloudTableSummary[] | undefined {
  const q = useRqQuery({
    queryKey: gridQueryKeys.tables(projectId ?? ""),
    enabled: apiClient !== null && projectId !== null,
    queryFn: () => apiClient!.grid.listTables.query({ projectId: projectId! }),
  });
  return useMemo<CloudTableSummary[] | undefined>(
    () =>
      q.data?.map((t) => ({
        _id: t.id as Id<"tables">,
        projectId: t.projectId as Id<"projects">,
        name: t.name,
        position: t.position,
        createdAt: t.createdAt,
      })),
    [q.data],
  );
}

/**
 * Mutations for managing cloud projects + tables (create/delete). Separate from
 * the grid-cell mutations so the switcher/sidebar can create without subscribing
 * to a table.
 */
export function useCloudProjectMutations() {
  const qc = useQueryClient();
  const createProject = useCallback(
    async (
      workspaceId: Id<"workspaces">,
      name: string,
    ): Promise<Id<"projects">> => {
      const id = await apiClient!.grid.createProject.mutate({
        workspaceId,
        name,
      });
      await qc.invalidateQueries({
        queryKey: gridQueryKeys.projects(workspaceId),
      });
      // The tRPC create returns the new id as a `string`; brand it to the
      // shared `Id` type the components consume.
      return id as Id<"projects">;
    },
    [qc],
  );
  const createTable = useCallback(
    async (
      projectId: Id<"projects">,
      name: string,
    ): Promise<Id<"tables">> => {
      const id = await apiClient!.grid.createTable.mutate({
        projectId,
        name,
      });
      await qc.invalidateQueries({
        queryKey: gridQueryKeys.tables(projectId),
      });
      return id as Id<"tables">;
    },
    [qc],
  );
  const deleteTable = useCallback(
    async (tableId: Id<"tables">) => {
      await apiClient!.grid.deleteTable.mutate({ tableId });
      // Refresh the sidebar list (the delete only carries the tableId, so
      // invalidate every loaded tables list by key prefix) and drop the now-gone
      // table's own query.
      await qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "grid" && query.queryKey[1] === "tables",
      });
      qc.removeQueries({ queryKey: gridQueryKeys.table(tableId) });
    },
    [qc],
  );
  return { createProject, createTable, deleteTable };
}

/** Map a column doc (from `getTable`) onto the desktop `Column`. */
function toColumn(c: {
  _id: string;
  name: string;
  type: string;
  kind: "manual" | "function";
  provider: string | null;
  method: string | null;
  code: string | null;
  params?: unknown;
}): Column {
  return {
    id: c._id,
    name: c.name,
    type: c.type,
    kind: c.kind,
    provider: c.provider,
    method: c.method,
    // `fn` mirrors the sidecar's fullTable() derivation so the header badge
    // renders identically for cloud and local columns.
    fn: c.provider ? `${c.provider}.${c.method}` : c.code ? "code" : null,
    params: (c.params ?? {}) as Record<string, unknown>,
  };
}

/** Map a cell doc onto the desktop `Cell` shape. */
function toCell(c: {
  value?: unknown;
  status: string;
  error: string | null;
}): Cell {
  return {
    value: c.value ?? null,
    status: c.status as CellStatus,
    error: c.error,
  };
}

/** The `getTable`-shaped snapshot {@link createIncrementalTableView} projects. */
type GetTableData = {
  table: { _id: string; name: string };
  columns: readonly {
    _id: string;
    name: string;
    type: string;
    kind: string;
    provider: string | null;
    method: string | null;
    code: string | null;
    params?: unknown;
  }[];
  rows: readonly { _id: string }[];
  cells: readonly {
    rowId: string;
    columnId: string;
    value?: unknown;
    status: string;
    error: string | null;
  }[];
};

/** The source cell shape, indexed per row (the reducer preserves its identity). */
type SourceCell = GetTableData["cells"][number];

/** One derived row plus the source cells it was built from (for reuse checks). */
interface DerivedRow {
  readonly row: FullTable["rows"][number];
  /** The source `SourceCell` each column was projected from (`null` = empty). */
  readonly sources: ReadonlyMap<string, SourceCell | null>;
}

/**
 * Build an INCREMENTAL `getTable` → `FullTable` projector that reuses unchanged
 * row objects across successive snapshots.
 *
 * Rebuilding the whole grid on every realtime patch is O(rows×cols) per single
 * cell change AND breaks referential identity for every row (forcing a full
 * re-render). This deriver instead keeps the previous `FullTable` plus, per row,
 * the SOURCE cell each column was projected from. Because the reducer preserves
 * the identity of untouched cell objects, a row whose every column maps to the
 * same source cell (and the same column list) is UNCHANGED — we hand back the
 * exact same row object, so `React.memo`'d rows skip re-rendering. Only the row
 * whose cell actually changed is rebuilt.
 *
 * Stateful (holds the previous derivation), so each grid view owns one instance.
 * Exported (unit-tested) so the incremental row-identity invariant is verifiable
 * without React or Supabase.
 */
export function createIncrementalTableView(): {
  derive: (data: GetTableData) => FullTable;
} {
  let prevColumns: FullTable["columns"] | null = null;
  let prevColumnsSource: GetTableData["columns"] | null = null;
  let prevByRow = new Map<string, DerivedRow>();

  const derive = (data: GetTableData): FullTable => {
    // Reuse the projected columns array (and thus its identity) when the source
    // columns array is unchanged — the common case during a cell-edit stream.
    const columns =
      prevColumnsSource === data.columns && prevColumns !== null
        ? prevColumns
        : data.columns.map((c) =>
            toColumn({ ...c, kind: c.kind as "manual" | "function" }),
          );
    const columnsChanged = columns !== prevColumns;
    prevColumns = columns;
    prevColumnsSource = data.columns;

    // Index source cells by (rowId, columnId) once.
    const byRow = new Map<string, Map<string, SourceCell>>();
    for (const cell of data.cells) {
      let m = byRow.get(cell.rowId);
      if (!m) {
        m = new Map();
        byRow.set(cell.rowId, m);
      }
      m.set(cell.columnId, cell);
    }

    const nextByRow = new Map<string, DerivedRow>();
    const rows = data.rows.map((r) => {
      const m = byRow.get(r._id);
      // Resolve each column's source cell (or `null` for a synthesized empty).
      const sources = new Map<string, SourceCell | null>();
      for (const col of columns) sources.set(col.id, m?.get(col.id) ?? null);

      // Reuse the previous row object when neither the column list nor any of
      // this row's source cells changed (all by reference — the reducer keeps
      // untouched cell identity).
      const prev = prevByRow.get(r._id);
      if (
        prev !== undefined &&
        !columnsChanged &&
        sameSources(prev.sources, sources)
      ) {
        nextByRow.set(r._id, prev);
        return prev.row;
      }

      const cells: Record<string, Cell> = {};
      for (const col of columns) {
        const src = sources.get(col.id);
        cells[col.id] = src
          ? toCell(src)
          : { value: null, status: "empty", error: null };
      }
      const row = { id: r._id, cells };
      nextByRow.set(r._id, { row, sources });
      return row;
    });

    prevByRow = nextByRow;
    return { id: data.table._id, name: data.table.name, columns, rows };
  };

  return { derive };
}

/** Two per-row source maps are equal when every column maps to the same cell ref. */
function sameSources(
  a: ReadonlyMap<string, SourceCell | null>,
  b: ReadonlyMap<string, SourceCell | null>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of b) {
    if (a.get(key) !== value) return false;
  }
  return true;
}

/**
 * The reactive grid for a cloud table, shaped exactly like the local `FullTable`,
 * so the same render code works. `undefined` while loading or when no cloud table
 * is selected; `null` if the table no longer exists.
 *
 * SEEDS via tRPC `grid.getTable` (react-query) and SUBSCRIBES via the W3 realtime
 * module, patching the cache with {@link applyGridEvent} on each event.
 */
export function useCloudTable(
  tableId: Id<"tables"> | null,
): FullTable | null | undefined {
  const q = useRqQuery({
    queryKey: gridQueryKeys.table(tableId ?? ""),
    enabled: apiClient !== null && tableId !== null,
    queryFn: () => apiClient!.grid.getTable.query({ tableId: tableId! }),
  });

  // Seed → subscribe: once a snapshot is loaded, subscribe to the table's grid
  // channel and patch the react-query cache with the pure reducer on each
  // event. The workspace the channel is scoped to comes from the active-
  // workspace handle the switcher sets (the snapshot itself omits it).
  useGridRealtime(tableId, q.data ? activeWorkspaceIdRef.current : null);

  // One incremental projector per view: a cell-edit stream then rebuilds only
  // the changed row and keeps every untouched row object's identity (so memoised
  // rows skip re-rendering). Reset when the table changes so a new table starts
  // from a clean slate rather than reusing the prior table's rows.
  const viewRef = useRef(createIncrementalTableView());
  const lastTableRef = useRef(tableId);
  if (lastTableRef.current !== tableId) {
    lastTableRef.current = tableId;
    viewRef.current = createIncrementalTableView();
  }

  return useMemo<FullTable | null | undefined>(() => {
    if (q.isLoading && q.data === undefined) return undefined;
    if (q.data === undefined) return undefined;
    if (q.data === null) return null;
    return viewRef.current.derive(q.data);
  }, [q.data, q.isLoading]);
}

/**
 * Module-level handle for the active workspace id the realtime channel is scoped
 * to. The grid view sets it via {@link setActiveWorkspaceForRealtime} (the
 * switcher already knows the active workspace), because the tRPC `getTable`
 * snapshot omits the workspace id while the channel is scoped by
 * `grid:{workspaceId}:{tableId}`. Kept off the React tree so it is readable
 * without prop-drilling.
 */
const activeWorkspaceIdRef: { current: string | null } = { current: null };

/** Set the workspace id the live-grid realtime channel scopes to. */
export function setActiveWorkspaceForRealtime(
  workspaceId: string | null,
): void {
  activeWorkspaceIdRef.current = workspaceId;
}

/**
 * Subscribe to a table's W3 grid channel and patch the react-query `getTable`
 * cache via {@link applyGridEvent} on each inbound event. A no-op (no socket)
 * when realtime is unconfigured, there is no table, or the workspace is unknown,
 * so a build without realtime config still works (seed-only). Tears the channel
 * down on table/workspace change + unmount.
 */
function useGridRealtime(
  tableId: Id<"tables"> | null,
  workspaceId: string | null,
): void {
  const qc = useQueryClient();
  // Latest QueryClient without re-subscribing on every render.
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (
      !realtimeConfigured ||
      tableId === null ||
      workspaceId === null ||
      PARTY_URL === undefined
    ) {
      return;
    }
    let disposed = false;
    let teardown: (() => Promise<void>) | null = null;

    // Coalescing buffer: a single enrichment cell publishes ≥2 events (running →
    // done) and a bulk run fires thousands; writing the cache per event causes a
    // full grid re-render each time. Instead we BUFFER inbound events and flush
    // them as ONE cache write per animation frame (≈60/s), merging every queued
    // event into the snapshot in arrival order via the pure reducer. This caps
    // re-renders at frame rate regardless of event throughput.
    const buffer: Array<Parameters<typeof patchGridCache>[1]> = [];
    const flush = scheduleFlush(() => {
      if (disposed || buffer.length === 0) return;
      const events = buffer.splice(0, buffer.length);
      qcRef.current.setQueryData<GridCacheSnapshot | null>(
        gridQueryKeys.table(tableId),
        (prev) => {
          let next = prev ?? null;
          for (const event of events) next = patchGridCache(next, event);
          return next;
        },
      );
    });

    void (async () => {
      const token = await mintRealtimeToken(workspaceId).catch(() => null);
      if (token === null || disposed) return;
      const sub = subscribeToGrid({
        url: PARTY_URL,
        token,
        workspaceId,
        tableId,
        onEvent: (event) => {
          buffer.push(event);
          flush.schedule();
        },
      });
      teardown = sub.unsubscribe;
      if (disposed) void sub.unsubscribe();
    })();

    return () => {
      disposed = true;
      flush.cancel();
      if (teardown) void teardown();
    };
  }, [tableId, workspaceId]);
}

/**
 * A debounced flush primitive for the realtime coalescing buffer. Coalesces
 * bursts of inbound events into ONE `run` per animation frame: the first
 * `schedule()` after a flush arms a `requestAnimationFrame` callback, and any
 * further `schedule()` calls before it fires are no-ops (the already-pending
 * frame will drain the shared buffer). Falls back to a ~100ms `setTimeout` when
 * `requestAnimationFrame` is unavailable (non-DOM / test environments), so the
 * coalescing behaviour holds everywhere. `cancel()` clears any pending flush on
 * teardown so a unmounted subscription never writes the cache.
 */
function scheduleFlush(run: () => void): {
  schedule: () => void;
  cancel: () => void;
} {
  const hasRaf = typeof requestAnimationFrame === "function";
  let rafHandle: number | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    rafHandle = null;
    timeoutHandle = null;
    run();
  };

  const schedule = () => {
    if (rafHandle !== null || timeoutHandle !== null) return;
    if (hasRaf) {
      rafHandle = requestAnimationFrame(fire);
    } else {
      timeoutHandle = setTimeout(fire, 100);
    }
  };

  const cancel = () => {
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };

  return { schedule, cancel };
}

/**
 * The PURE react-query cache updater for a live grid event — a direct wrapper
 * over the W3 `applyGridEvent` reducer. Exposed (and unit-tested) on its own so
 * the SEED→patch integration is verifiable without React or Supabase: the cache
 * holds the `getTable` snapshot, and each event maps it to the next snapshot.
 */
export function patchGridCache(
  prev: GridCacheSnapshot | null,
  event: Parameters<typeof applyGridEvent>[1],
): GridCacheSnapshot | null {
  // The cache snapshot and the reducer's `GridSnapshot` are the same runtime
  // shape; the tRPC inference makes `column.params` optional, so bridge through
  // `unknown` to satisfy the reducer's required-`params` signature.
  const next = applyGridEvent(
    prev as Parameters<typeof applyGridEvent>[0],
    event,
  );
  return next as GridCacheSnapshot | null;
}

/**
 * Mutation wrappers for cloud grid edits — cell edits, add row, add column, plus
 * the structural deletes.
 *
 * These call the tRPC `grid.*` mutations; the server broadcasts the change so
 * every OTHER subscribed client patches its cache via the realtime reducer. This
 * client invalidates its own `getTable` query so its write is reflected
 * immediately even before the broadcast round-trips.
 */
export function useCloudGridMutations() {
  const qc = useQueryClient();
  const refresh = useCallback(
    (tableId: string) =>
      qc.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) }),
    [qc],
  );

  // setCell/deleteRow/deleteColumn carry only the cell/row/column id (matching
  // the component API), not the owning table, so they invalidate ALL loaded
  // `getTable` queries by key prefix — the live realtime broadcast patches the
  // exact snapshot; this just guarantees the writer sees its own change.
  const refreshAllTables = useCallback(
    () =>
      qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "grid" && query.queryKey[1] === "table",
      }),
    [qc],
  );
  const setCell = useCallback(
    async (rowId: Id<"rows">, columnId: Id<"columns">, value: unknown) => {
      const res = await apiClient!.grid.setCell.mutate({
        rowId,
        columnId,
        value,
        status: "done",
        error: null,
      });
      await refreshAllTables();
      return res;
    },
    [refreshAllTables],
  );
  const addRow = useCallback(
    async (tableId: Id<"tables">) => {
      const res = await apiClient!.grid.addRow.mutate({ tableId });
      await refresh(tableId);
      return res;
    },
    [refresh],
  );
  /**
   * Bulk insert rows + cells for CSV import. Each row is a `{ columnId: value }`
   * map; metered as one cloud action per row. Throws when the import would
   * exceed the plan's quota.
   */
  const addRowsWithCells = useCallback(
    async (tableId: Id<"tables">, rows: Array<Record<string, unknown>>) => {
      const res = await apiClient!.grid.addRowsWithCells.mutate({
        tableId,
        rows,
      });
      await refresh(tableId);
      return res;
    },
    [refresh],
  );
  /**
   * Add a column. `fn` ("provider.method") maps onto provider/method/kind the
   * same way the sidecar's POST /api/tables/:id/columns route does.
   */
  const addColumn = useCallback(
    async (
      tableId: Id<"tables">,
      body: {
        name: string;
        type?: string;
        fn?: string;
        code?: string;
        params?: Record<string, unknown>;
      },
    ) => {
      const { provider, method, kind } = deriveColumnKind(body);
      const res = await apiClient!.grid.addColumn.mutate({
        tableId,
        name: body.name,
        type: (body.type ?? "text") as
          | "text"
          | "number"
          | "boolean"
          | "date"
          | "json",
        kind,
        provider,
        method,
        code: body.code ?? null,
        params: body.params ?? {},
      });
      await refresh(tableId);
      return res;
    },
    [refresh],
  );
  const deleteRow = useCallback(
    async (rowId: Id<"rows">) => {
      const res = await apiClient!.grid.deleteRow.mutate({ rowId });
      await refreshAllTables();
      return res;
    },
    [refreshAllTables],
  );
  const deleteColumn = useCallback(
    async (columnId: Id<"columns">) => {
      const res = await apiClient!.grid.deleteColumn.mutate({ columnId });
      await refreshAllTables();
      return res;
    },
    [refreshAllTables],
  );

  return { setCell, addRow, addRowsWithCells, addColumn, deleteRow, deleteColumn };
}

/**
 * Derive `{ provider, method, kind }` from an addColumn body. `fn` is
 * "provider.method"; a function column has either a provider or code. Pure.
 * Unit-tested directly.
 */
export function deriveColumnKind(body: {
  fn?: string;
  code?: string;
}): {
  provider: string | null;
  method: string | null;
  kind: "manual" | "function";
} {
  const provider = body.fn ? (body.fn.split(".")[0] ?? null) : null;
  const method = body.fn ? (body.fn.split(".")[1] ?? null) : null;
  const kind: "manual" | "function" =
    provider || body.code ? "function" : "manual";
  return { provider, method, kind };
}

// ───────────────────────────── Webhooks (cloud-only) ────────────────────────

/** One payload-path → column mapping entry, as persisted on the webhook. */
export interface WebhookMappingEntry {
  readonly path: string;
  readonly columnId: Id<"columns">;
}

/** A webhook config doc as returned by `listWebhooks` (the panel's data shape). */
export interface CloudWebhook {
  readonly _id: Id<"webhooks">;
  readonly workspaceId: Id<"workspaces">;
  readonly tableId: Id<"tables">;
  readonly name?: string;
  readonly token: string;
  readonly signingSecret?: string;
  readonly mapping: WebhookMappingEntry[];
  readonly enabled: boolean;
  readonly autoRun?: boolean;
  readonly mode?: "create" | "upsert";
  readonly upsertKey?: Id<"columns"> | null;
  readonly createdAt: number;
  readonly lastReceivedAt?: number | null;
  readonly receivedCount?: number;
}

/**
 * Map a tRPC `webhooks.listWebhooks` row (Postgres `id`/nullable fields) onto the
 * desktop {@link CloudWebhook} (`_id`/optional fields). Pure + unit-tested.
 */
export function toCloudWebhook(w: {
  id: string;
  workspaceId: string;
  tableId: string;
  name: string | null;
  token: string;
  signingSecret: string | null;
  mapping: readonly { path: string; columnId: string }[];
  enabled: boolean;
  autoRun: boolean | null;
  mode: "create" | "upsert" | null;
  upsertKey: string | null;
  createdAt: number;
  lastReceivedAt: number | null;
  receivedCount: number | null;
}): CloudWebhook {
  return {
    _id: w.id as Id<"webhooks">,
    workspaceId: w.workspaceId as Id<"workspaces">,
    tableId: w.tableId as Id<"tables">,
    ...(w.name !== null ? { name: w.name } : {}),
    token: w.token,
    ...(w.signingSecret !== null ? { signingSecret: w.signingSecret } : {}),
    mapping: w.mapping.map((m) => ({
      path: m.path,
      columnId: m.columnId as Id<"columns">,
    })),
    enabled: w.enabled,
    ...(w.autoRun !== null ? { autoRun: w.autoRun } : {}),
    ...(w.mode !== null ? { mode: w.mode } : {}),
    upsertKey: (w.upsertKey as Id<"columns"> | null) ?? null,
    createdAt: w.createdAt,
    lastReceivedAt: w.lastReceivedAt,
    ...(w.receivedCount !== null ? { receivedCount: w.receivedCount } : {}),
  };
}

/**
 * Reactive list of a table's webhooks (newest first). Issues zero calls when
 * cloud is off or no table is selected. Mirrors {@link useCloudTables}.
 */
export function useWebhooks(
  tableId: Id<"tables"> | null,
): CloudWebhook[] | undefined {
  const q = useRqQuery({
    queryKey: gridQueryKeys.webhooks(tableId ?? ""),
    enabled: apiClient !== null && tableId !== null,
    queryFn: () =>
      apiClient!.webhooks.listWebhooks.query({ tableId: tableId! }),
  });
  return useMemo<CloudWebhook[] | undefined>(
    () => q.data?.map(toCloudWebhook),
    [q.data],
  );
}

/** One per-event delivery as returned by `listDeliveriesPaged` (newest first). */
export interface CloudDelivery {
  readonly _id: Id<"webhookDeliveries">;
  readonly webhookId: Id<"webhooks">;
  readonly tableId: Id<"tables">;
  readonly status: number;
  readonly rowsAffected: number;
  readonly mode: "create" | "upsert";
  readonly recordId?: string;
  readonly error?: string | null;
  readonly receivedAt: number;
}

/**
 * Map a tRPC `webhooks.listDeliveriesPaged` item (Postgres `id`) onto the desktop
 * {@link CloudDelivery} (`_id`). Pure + unit-tested.
 */
export function toCloudDelivery(d: {
  id: string;
  webhookId: string;
  tableId: string;
  status: number;
  rowsAffected: number;
  mode: "create" | "upsert";
  recordId: string | null;
  error: string | null;
  receivedAt: number;
}): CloudDelivery {
  return {
    _id: d.id as Id<"webhookDeliveries">,
    webhookId: d.webhookId as Id<"webhooks">,
    tableId: d.tableId as Id<"tables">,
    status: d.status,
    rowsAffected: d.rowsAffected,
    mode: d.mode,
    ...(d.recordId !== null ? { recordId: d.recordId } : {}),
    error: d.error,
    receivedAt: d.receivedAt,
  };
}

/**
 * Cursor-paginated, reactive list of a webhook's deliveries (newest first,
 * member-gated). Returns the {@link PaginatedResult} shape {@link WebhookModal}'s
 * "Load more" control consumes. Issues zero calls when cloud is off or there is
 * no webhook yet. Wraps react-query `useInfiniteQuery` over the tRPC keyset
 * `listDeliveriesPaged` (20/page).
 */
export function useWebhookDeliveries(
  webhookId: Id<"webhooks"> | null | undefined,
): PaginatedResult<CloudDelivery> {
  const q = useInfiniteQuery({
    queryKey: gridQueryKeys.deliveries(webhookId ?? ""),
    enabled: apiClient !== null && webhookId != null,
    initialPageParam: null as { receivedAt: number; id: string } | null,
    queryFn: ({ pageParam }) =>
      apiClient!.webhooks.listDeliveriesPaged.query({
        webhookId: webhookId!,
        limit: 20,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor,
  });

  return useMemo<PaginatedResult<CloudDelivery>>(() => {
    const results = (q.data?.pages ?? [])
      .flatMap((p) => p.items)
      .map(toCloudDelivery);
    const loadMore = (_n: number) => {
      if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    };
    if (q.isLoading && results.length === 0) {
      return { results, loadMore, status: "LoadingFirstPage", isLoading: true };
    }
    if (q.isFetchingNextPage) {
      return { results, loadMore, status: "LoadingMore", isLoading: true };
    }
    if (q.hasNextPage) {
      return { results, loadMore, status: "CanLoadMore", isLoading: false };
    }
    return { results, loadMore, status: "Exhausted", isLoading: false };
  }, [
    q.data,
    q.isLoading,
    q.isFetchingNextPage,
    q.hasNextPage,
    q.fetchNextPage,
  ]);
}

/**
 * Mutation wrappers for the webhook config panel — create, enable/disable,
 * rotate secrets, edit the field mapping, and patch receive behaviour.
 *
 * These call the tRPC `webhooks.*` mutations and invalidate the table's
 * `listWebhooks` query so the panel reflects the change. Mirrors
 * {@link useCloudGridMutations}.
 */
export function useWebhookMutations() {
  const qc = useQueryClient();
  // Config mutations carry only the webhook id, not the owning table, so they
  // invalidate ALL loaded webhook-list queries by key prefix.
  const refresh = useCallback(
    () =>
      qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "webhooks" && query.queryKey[1] === "list",
      }),
    [qc],
  );

  const createWebhook = useCallback(
    async (tableId: Id<"tables">, name?: string) => {
      const res = await apiClient!.webhooks.createWebhook.mutate({
        tableId,
        ...(name !== undefined ? { name } : {}),
      });
      await qc.invalidateQueries({
        queryKey: gridQueryKeys.webhooks(tableId),
      });
      return res;
    },
    [qc],
  );
  const updateMapping = useCallback(
    async (webhookId: Id<"webhooks">, mapping: WebhookMappingEntry[]) => {
      const res = await apiClient!.webhooks.updateWebhookMapping.mutate({
        webhookId,
        mapping: mapping.map((m) => ({ path: m.path, columnId: m.columnId })),
      });
      await refresh();
      return res;
    },
    [refresh],
  );
  const updateConfig = useCallback(
    async (
      webhookId: Id<"webhooks">,
      patch: {
        autoRun?: boolean;
        mode?: "create" | "upsert";
        upsertKey?: Id<"columns"> | null;
      },
    ) => {
      const res = await apiClient!.webhooks.updateWebhookConfig.mutate({
        webhookId,
        ...patch,
      });
      await refresh();
      return res;
    },
    [refresh],
  );
  const toggleEnabled = useCallback(
    async (webhookId: Id<"webhooks">, enabled: boolean) => {
      const res = await apiClient!.webhooks.toggleEnabled.mutate({
        webhookId,
        enabled,
      });
      await refresh();
      return res;
    },
    [refresh],
  );
  const rotateSecret = useCallback(
    async (webhookId: Id<"webhooks">) => {
      const res = await apiClient!.webhooks.rotateSecret.mutate({ webhookId });
      await refresh();
      return res;
    },
    [refresh],
  );
  const deleteWebhook = useCallback(
    async (webhookId: Id<"webhooks">) => {
      const res = await apiClient!.webhooks.deleteWebhook.mutate({
        webhookId,
      });
      await refresh();
      return res;
    },
    [refresh],
  );

  return {
    createWebhook,
    updateMapping,
    updateConfig,
    toggleEnabled,
    rotateSecret,
    deleteWebhook,
  };
}

// `queryClient` is exported by ./client; re-exported here so realtime patches in
// tests/consumers can target the same cache the hooks use.
export { queryClient };
