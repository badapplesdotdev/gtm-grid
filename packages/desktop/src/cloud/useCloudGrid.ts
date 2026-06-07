/**
 * Cloud grid hooks (T9 → W4) — the reactive data source for CLOUD projects.
 *
 * A LOCAL project's grid loads imperatively via the sidecar (`api.table()` in
 * api.ts). A CLOUD project's grid is LIVE.
 *
 * STRANGLER (TRI-3254): every hook here now has TWO implementations and
 * dispatches on the `cloudViaApi` flag (a module constant from ./client, so the
 * branch is stable across renders and the React hook order never changes):
 *
 *   - NEW path (`cloudViaApi` true) — reads/writes go through the vanilla tRPC
 *     client (`apiClient`, ./client) consumed DIRECTLY via `@tanstack/react-query`
 *     hooks (queryFn/mutationFn). Live reactivity that the Convex `useQuery`
 *     subscription used to provide is REPLACED by the W3 shared realtime module
 *     (`@gtmgrid/services/realtime`): each grid view SEEDS via tRPC `grid.getTable`
 *     then SUBSCRIBES via `subscribeToGrid`, patching the react-query cache with
 *     the pure `applyGridEvent` reducer on every inbound event.
 *
 *   - LEGACY path (`cloudViaApi` false) — the existing Convex `useQuery` /
 *     `useMutation` subscriptions, kept working unchanged.
 *
 * These hooks deliberately produce the SAME shapes the existing grid render
 * components consume (`Column`, `Cell`, a `FullTable`-like view) so the cloud
 * grid reuses `CellContent` etc. — only the data source changes.
 */

import { useAuthToken } from "@convex-dev/auth/react";
import {
  useInfiniteQuery,
  useQuery as useRqQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type UsePaginatedQueryResult,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import { applyGridEvent, subscribeToGrid } from "@gtmgrid/services/realtime";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { Cell, CellStatus, Column, FullTable } from "../api";
import { apiClient, cloudViaApi, queryClient } from "./client";
import { CONVEX_URL, cloudEnabled } from "./convex";
import type { CloudSession } from "./cloud-run";
import { useApiAuthToken } from "./useApiAuth";

/**
 * The Supabase project URL + anon (publishable) key the W3 realtime client
 * (`subscribeToGrid`) connects with. Read once from Vite's `import.meta.env`;
 * empty strings are treated as unset. The realtime CONNECTION is authorized by
 * a server-minted JWT (`realtime.token`) — these only locate the project and
 * carry the publishable key; all reads/writes still go through tRPC.
 */
const SUPABASE_URL: string | undefined =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || undefined;
const SUPABASE_ANON_KEY: string | undefined =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || undefined;

/**
 * Whether the W3 live-grid realtime path is configured. The grid hooks always
 * SEED via tRPC; they additionally SUBSCRIBE via Supabase Realtime only when
 * both the URL and key are present, so a build without realtime config still
 * works (it just won't receive live patches). Pure boolean off module env.
 */
const realtimeConfigured: boolean =
  SUPABASE_URL !== undefined && SUPABASE_ANON_KEY !== undefined;

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
 * The react-query key factory for the NEW tRPC path. Centralised so the realtime
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
 * The `getTable` snapshot the react-query cache holds on the NEW path. Equal in
 * shape to `@gtmgrid/services` `GridSnapshot` / `FullGrid`, so the tRPC result is
 * stored directly and fed back through {@link applyGridEvent} without translation.
 */
type GridCacheSnapshot = Awaited<
  ReturnType<NonNullable<typeof apiClient>["grid"]["getTable"]["query"]>
>;

/**
 * Mint the Supabase realtime JWT via the tRPC `realtime.token` MUTATION. Thrown
 * if the new path is disabled (callers guard on `cloudViaApi` first). Extracted
 * so the realtime-token plumbing is a single named seam.
 */
async function mintRealtimeToken(): Promise<string> {
  if (apiClient === null) throw new Error("API client unavailable");
  const { token } = await apiClient.realtime.token.mutate();
  return token;
}

/**
 * The signed-in cloud session (deployment url + auth JWT) needed to run a cloud
 * column via the sidecar, or `null` when cloud is off / not yet authenticated.
 *
 * STRANGLER: on the NEW path the session is the apps/web API URL + the Better
 * Auth bearer token ({@link useApiAuthToken}); on the LEGACY path it is the
 * Convex deployment URL + the Convex Auth JWT. Both `useAuthToken` and
 * `useApiAuthToken` are reactive and called behind a module-constant branch, so
 * the hook order is stable across renders.
 */
export function useCloudSession(): CloudSession | null {
  // The branch is on module constants (`cloudViaApi` / `cloudEnabled`), so a
  // build takes exactly one path and the hook count never changes mid-run.
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const token = useApiAuthToken();
    const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) || "";
    if (!token || apiUrl === "") return null;
    return { apiUrl, token };
  }
  // `useAuthToken` requires the Convex Auth provider, which only mounts when the
  // cloud layer is enabled. When it is off there is no provider, so we must not
  // call the hook — `cloudEnabled` is a module constant, so this branch is
  // stable across renders (same rule the auth hooks follow).
  if (!cloudEnabled || CONVEX_URL === undefined) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const token = useAuthToken();
  if (!token) return null;
  return { convexUrl: CONVEX_URL, token };
}

/**
 * Reactive list of a workspace's cloud projects. `undefined` while loading;
 * issues zero calls when cloud is off or no workspace is active.
 */
export function useCloudProjects(
  workspaceId: Id<"workspaces"> | null,
): CloudProject[] | undefined {
  if (cloudViaApi) {
    // The grid realtime channel is scoped by workspace; capture the active
    // workspace here (App calls this with the active workspace) so the
    // workspace-less `getTable` snapshot can still scope its subscription.
    if (workspaceId !== null) activeWorkspaceIdRef.current = workspaceId;
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const q = useRqQuery({
      queryKey: gridQueryKeys.projects(workspaceId ?? ""),
      enabled: apiClient !== null && workspaceId !== null,
      queryFn: () =>
        apiClient!.grid.listProjects.query({ workspaceId: workspaceId! }),
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  return useQuery(
    api.projects.listProjects,
    cloudEnabled && workspaceId !== null ? { workspaceId } : "skip",
  ) as CloudProject[] | undefined;
}

/**
 * Reactive list of a cloud project's tables. `undefined` while loading; issues
 * zero calls when cloud is off or no cloud project is active.
 */
export function useCloudTables(
  projectId: Id<"projects"> | null,
): CloudTableSummary[] | undefined {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const q = useRqQuery({
      queryKey: gridQueryKeys.tables(projectId ?? ""),
      enabled: apiClient !== null && projectId !== null,
      queryFn: () =>
        apiClient!.grid.listTables.query({ projectId: projectId! }),
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  return useQuery(
    api.tables.listTables,
    cloudEnabled && projectId !== null ? { projectId } : "skip",
  ) as CloudTableSummary[] | undefined;
}

/**
 * Mutations for managing cloud projects + tables (create/delete). Separate from
 * the grid-cell mutations so the switcher/sidebar can create without subscribing
 * to a table.
 */
export function useCloudProjectMutations() {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const qc = useQueryClient();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
        // shared `Id` type the components consume (the only cross-path coercion).
        return id as Id<"projects">;
      },
      [qc],
    );
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const deleteTable = useCallback(
      (tableId: Id<"tables">) =>
        apiClient!.grid.deleteTable.mutate({ tableId }),
      [],
    );
    return { createProject, createTable, deleteTable };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const createProjectMut = useMutation(api.projects.createProject);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const createTableMut = useMutation(api.tables.createTable);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteTableMut = useMutation(api.tables.deleteTable);

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const createProject = useCallback(
    (workspaceId: Id<"workspaces">, name: string) =>
      createProjectMut({ workspaceId, name }),
    [createProjectMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const createTable = useCallback(
    (projectId: Id<"projects">, name: string) =>
      createTableMut({ projectId, name }),
    [createTableMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteTable = useCallback(
    (tableId: Id<"tables">) => deleteTableMut({ tableId }),
    [deleteTableMut],
  );

  return { createProject, createTable, deleteTable };
}

/** Map a Convex/Postgres column doc (from `getTable`) onto the desktop `Column`. */
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

/**
 * Project a `getTable`-shaped snapshot onto the desktop `FullTable` (columns
 * ordered, rows with a `cells` map keyed by column id). Shared by both paths so
 * the render shape is identical regardless of data source. Pure.
 */
function toFullTable(data: {
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
}): FullTable {
  const columns = data.columns.map((c) =>
    toColumn({ ...c, kind: c.kind as "manual" | "function" }),
  );
  // Index cells by (rowId, columnId) once, then build each row's cell map.
  const byRow = new Map<string, Map<string, Cell>>();
  for (const cell of data.cells) {
    let m = byRow.get(cell.rowId);
    if (!m) {
      m = new Map();
      byRow.set(cell.rowId, m);
    }
    m.set(cell.columnId, toCell(cell));
  }
  const rows = data.rows.map((r) => {
    const m = byRow.get(r._id);
    const cells: Record<string, Cell> = {};
    for (const col of columns) {
      cells[col.id] = m?.get(col.id) ?? {
        value: null,
        status: "empty",
        error: null,
      };
    }
    return { id: r._id, cells };
  });
  return { id: data.table._id, name: data.table.name, columns, rows };
}

/**
 * The reactive grid for a cloud table, shaped exactly like the local `FullTable`,
 * so the same render code works. `undefined` while loading or when no cloud table
 * is selected; `null` if the table no longer exists.
 *
 * STRANGLER: on the NEW path this SEEDS via tRPC `grid.getTable` (react-query)
 * and SUBSCRIBES via the W3 realtime module, patching the cache with
 * {@link applyGridEvent} on each event (the Convex `useQuery` reactivity
 * replacement). On the LEGACY path it is the Convex `getTable` subscription.
 */
export function useCloudTable(
  tableId: Id<"tables"> | null,
): FullTable | null | undefined {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const q = useRqQuery({
      queryKey: gridQueryKeys.table(tableId ?? ""),
      enabled: apiClient !== null && tableId !== null,
      queryFn: () => apiClient!.grid.getTable.query({ tableId: tableId! }),
    });

    // Seed → subscribe: once a snapshot is loaded, subscribe to the table's grid
    // channel and patch the react-query cache with the pure reducer on each
    // event. The workspace the channel is scoped to comes from the active-
    // workspace handle the switcher sets (the snapshot itself omits it).
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    useGridRealtime(tableId, q.data ? activeWorkspaceIdRef.current : null);

    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    return useMemo<FullTable | null | undefined>(() => {
      if (q.isLoading && q.data === undefined) return undefined;
      if (q.data === undefined) return undefined;
      if (q.data === null) return null;
      return toFullTable(q.data);
    }, [q.data, q.isLoading]);
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const data = useQuery(
    api.tables.getTable,
    cloudEnabled && tableId !== null ? { tableId } : "skip",
  );

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  return useMemo<FullTable | null | undefined>(() => {
    if (data === undefined) return undefined;
    if (data === null) return null;
    return toFullTable(data);
  }, [data]);
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
      SUPABASE_URL === undefined ||
      SUPABASE_ANON_KEY === undefined
    ) {
      return;
    }
    let disposed = false;
    let teardown: (() => Promise<void>) | null = null;

    void (async () => {
      const token = await mintRealtimeToken().catch(() => null);
      if (token === null || disposed) return;
      const sub = subscribeToGrid({
        url: SUPABASE_URL,
        anonKey: SUPABASE_ANON_KEY,
        token,
        workspaceId,
        tableId,
        onEvent: (event) => {
          qcRef.current.setQueryData<GridCacheSnapshot | null>(
            gridQueryKeys.table(tableId),
            (prev) => patchGridCache(prev ?? null, event),
          );
        },
      });
      teardown = sub.unsubscribe;
      if (disposed) void sub.unsubscribe();
    })();

    return () => {
      disposed = true;
      if (teardown) void teardown();
    };
  }, [tableId, workspaceId]);
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
 * STRANGLER: on the NEW path these call the tRPC `grid.*` mutations; the server
 * broadcasts the change so every OTHER subscribed client patches its cache via
 * the realtime reducer. This client invalidates its own `getTable` query so its
 * write is reflected immediately even before the broadcast round-trips. On the
 * LEGACY path they call the Convex mutations (Convex reactivity reflects live).
 */
export function useCloudGridMutations() {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const qc = useQueryClient();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const refresh = useCallback(
      (tableId: string) =>
        qc.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) }),
      [qc],
    );

    // setCell/deleteRow/deleteColumn carry only the cell/row/column id (matching
    // the component API), not the owning table, so they invalidate ALL loaded
    // `getTable` queries by key prefix — the live realtime broadcast patches the
    // exact snapshot; this just guarantees the writer sees its own change.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const refreshAllTables = useCallback(
      () =>
        qc.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "grid" && query.queryKey[1] === "table",
        }),
      [qc],
    );
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const addRow = useCallback(
      async (tableId: Id<"tables">) => {
        const res = await apiClient!.grid.addRow.mutate({ tableId });
        await refresh(tableId);
        return res;
      },
      [refresh],
    );
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const deleteRow = useCallback(
      async (rowId: Id<"rows">) => {
        const res = await apiClient!.grid.deleteRow.mutate({ rowId });
        await refreshAllTables();
        return res;
      },
      [refreshAllTables],
    );
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const setCellMut = useMutation(api.cells.setCell);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const addRowMut = useMutation(api.tables.addRow);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const addRowsWithCellsMut = useMutation(api.tables.addRowsWithCells);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const addColumnMut = useMutation(api.tables.addColumn);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteRowMut = useMutation(api.tables.deleteRow);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteColumnMut = useMutation(api.tables.deleteColumn);

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const setCell = useCallback(
    (rowId: Id<"rows">, columnId: Id<"columns">, value: unknown) =>
      // Manual edits are authored values → status "done", mirroring the local
      // sidecar's POST /api/cells behaviour.
      setCellMut({ rowId, columnId, value, status: "done", error: null }),
    [setCellMut],
  );

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const addRow = useCallback(
    (tableId: Id<"tables">) => addRowMut({ tableId }),
    [addRowMut],
  );

  /**
   * Bulk insert rows + cells for CSV import. Each row is a `{ columnId: value }`
   * map; metered as one cloud action per row. Throws when the import would
   * exceed the plan's quota.
   */
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const addRowsWithCells = useCallback(
    (tableId: Id<"tables">, rows: Array<Record<string, unknown>>) =>
      addRowsWithCellsMut({ tableId, rows }),
    [addRowsWithCellsMut],
  );

  /**
   * Add a column. `fn` ("provider.method") maps onto provider/method/kind the
   * same way the sidecar's POST /api/tables/:id/columns route does.
   */
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const addColumn = useCallback(
    (
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
      return addColumnMut({
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
    },
    [addColumnMut],
  );

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteRow = useCallback(
    (rowId: Id<"rows">) => deleteRowMut({ rowId }),
    [deleteRowMut],
  );

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteColumn = useCallback(
    (columnId: Id<"columns">) => deleteColumnMut({ columnId }),
    [deleteColumnMut],
  );

  return { setCell, addRow, addRowsWithCells, addColumn, deleteRow, deleteColumn };
}

/**
 * Derive `{ provider, method, kind }` from an addColumn body. `fn` is
 * "provider.method"; a function column has either a provider or code. Pure +
 * shared by both paths so the mapping is identical. Unit-tested directly.
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
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const q = useRqQuery({
      queryKey: gridQueryKeys.webhooks(tableId ?? ""),
      enabled: apiClient !== null && tableId !== null,
      queryFn: () =>
        apiClient!.webhooks.listWebhooks.query({ tableId: tableId! }),
    });
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    return useMemo<CloudWebhook[] | undefined>(
      () => q.data?.map(toCloudWebhook),
      [q.data],
    );
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  return useQuery(
    api.webhooks.listWebhooks,
    cloudEnabled && tableId !== null ? { tableId } : "skip",
  ) as CloudWebhook[] | undefined;
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
 * member-gated). Returns the SAME {@link UsePaginatedQueryResult} shape both
 * paths satisfy (`results` / `status` / `loadMore`), so {@link WebhookModal}'s
 * "Load more" control is path-agnostic. Issues zero calls when cloud is off or
 * there is no webhook yet. Mirrors {@link useWebhooks}.
 *
 * STRANGLER: on the NEW path it wraps react-query `useInfiniteQuery` over the
 * tRPC keyset `listDeliveriesPaged` (20/page); on the LEGACY path it is the
 * Convex `usePaginatedQuery`.
 */
export function useWebhookDeliveries(
  webhookId: Id<"webhooks"> | null | undefined,
): UsePaginatedQueryResult<CloudDelivery> {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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

    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    return useMemo<UsePaginatedQueryResult<CloudDelivery>>(() => {
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

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  return usePaginatedQuery(
    api.webhooks.listDeliveriesPaged,
    cloudEnabled && webhookId != null ? { webhookId } : "skip",
    { initialNumItems: 20 },
  ) as UsePaginatedQueryResult<CloudDelivery>;
}

/**
 * Mutation wrappers for the webhook config panel — create, enable/disable,
 * rotate secrets, edit the field mapping, and patch receive behaviour.
 *
 * STRANGLER: on the NEW path they call the tRPC `webhooks.*` mutations and
 * invalidate the table's `listWebhooks` query so the panel reflects the change;
 * on the LEGACY path they call the member-gated Convex mutations (Convex
 * reactivity reflects live). Mirrors {@link useCloudGridMutations}.
 */
export function useWebhookMutations() {
  if (cloudViaApi) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const qc = useQueryClient();
    // Config mutations carry only the webhook id, not the owning table, so they
    // invalidate ALL loaded webhook-list queries by key prefix.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const refresh = useCallback(
      () =>
        qc.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "webhooks" && query.queryKey[1] === "list",
        }),
      [qc],
    );

    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
    const rotateSecret = useCallback(
      async (webhookId: Id<"webhooks">) => {
        const res = await apiClient!.webhooks.rotateSecret.mutate({ webhookId });
        await refresh();
        return res;
      },
      [refresh],
    );
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
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

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const createMut = useMutation(api.webhooks.createWebhook);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const updateMappingMut = useMutation(api.webhooks.updateWebhookMapping);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const updateConfigMut = useMutation(api.webhooks.updateWebhookConfig);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const toggleEnabledMut = useMutation(api.webhooks.toggleEnabled);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const rotateSecretMut = useMutation(api.webhooks.rotateSecret);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteWebhookMut = useMutation(api.webhooks.deleteWebhook);

  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const createWebhook = useCallback(
    (tableId: Id<"tables">, name?: string) =>
      createMut({ tableId, ...(name !== undefined ? { name } : {}) }),
    [createMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const updateMapping = useCallback(
    (webhookId: Id<"webhooks">, mapping: WebhookMappingEntry[]) =>
      updateMappingMut({ webhookId, mapping }),
    [updateMappingMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const updateConfig = useCallback(
    (
      webhookId: Id<"webhooks">,
      patch: {
        autoRun?: boolean;
        mode?: "create" | "upsert";
        upsertKey?: Id<"columns"> | null;
      },
    ) => updateConfigMut({ webhookId, ...patch }),
    [updateConfigMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const toggleEnabled = useCallback(
    (webhookId: Id<"webhooks">, enabled: boolean) =>
      toggleEnabledMut({ webhookId, enabled }),
    [toggleEnabledMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const rotateSecret = useCallback(
    (webhookId: Id<"webhooks">) => rotateSecretMut({ webhookId }),
    [rotateSecretMut],
  );
  // eslint-disable-next-line react-hooks/rules-of-hooks -- stable per build.
  const deleteWebhook = useCallback(
    (webhookId: Id<"webhooks">) => deleteWebhookMut({ webhookId }),
    [deleteWebhookMut],
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
