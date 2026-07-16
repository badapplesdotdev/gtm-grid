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
import {
  applyGridEvent,
  subscribeToGrid,
  WORKSPACE_ROOM_TABLE_ID,
} from "@gtmgrid/services/realtime";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Id } from "./ids";
import { gridPresenceStore } from "./presenceStore";
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
export const PARTY_URL: string | undefined =
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
  /** Sidebar folder this table is filed under (null = root). */
  readonly folderId: string | null;
  /**
   * The table's row count, surfaced by `grid.listTables` so the sidebar / Tables
   * page shows a real count for cloud tables (not "—"). `null` when the server
   * did not report a count (older API), so the UI falls back to the dash.
   */
  readonly rows: number | null;
  /**
   * Whether this table is pinned to favourites. WORKSPACE-SHARED (any teammate's
   * pin shows for everyone), drives the sidebar star + favourites-first ordering,
   * mirroring local tables.
   */
  readonly favorite: boolean;
}

/** A cloud sidebar folder (the `listFolders` query shape). */
export interface CloudFolderSummary {
  readonly _id: string;
  readonly projectId: Id<"projects">;
  readonly name: string;
  readonly position: number;
  readonly createdAt: number;
  /** The folder this folder nests under (null = top level). */
  readonly parentId: string | null;
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
  folders: (projectId: string) => ["grid", "folders", projectId] as const,
  table: (tableId: string) => ["grid", "table", tableId] as const,
  /** The keyset-paginated grid (an infinite query of {@link gridRouter.getTablePage}). */
  tablePaged: (tableId: string) => ["grid", "tablePaged", tableId] as const,
  webhooks: (tableId: string) => ["webhooks", "list", tableId] as const,
  deliveries: (webhookId: string) =>
    ["webhooks", "deliveries", webhookId] as const,
  /** A table's share links (the `share.listByTable` query). */
  shares: (tableId: string) => ["shares", "list", tableId] as const,
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
 * One PAGE of the keyset-paginated grid (the `grid.getTablePage` result):
 * table + columns + only this page's rows/cells + a `nextCursor`. The infinite
 * query holds an array of these — only the LOADED pages are resident, so a 10k
 * row table never lives in memory all at once (TRI-3272).
 */
type GridPage = Awaited<
  ReturnType<NonNullable<typeof apiClient>["grid"]["getTablePage"]["query"]>
>;

/** The keyset cursor carried between pages (the `nextCursor` field's shape). */
type GridPageCursor = GridPage["nextCursor"];

/**
 * Mint the Supabase realtime JWT via the tRPC `realtime.token` MUTATION. Thrown
 * if the cloud layer is disabled (callers guard on `apiClient` first). Extracted
 * so the realtime-token plumbing is a single named seam. Exported for the agent
 * presence controller (agentPresence.ts), which opens its OWN party connection.
 */
export async function mintRealtimeToken(workspaceId: string): Promise<string> {
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
        folderId: t.folderId ?? null,
        rows: t.rows ?? null,
        favorite: t.favorite ?? false,
      })),
    [q.data],
  );
}

/**
 * Reactive list of a cloud project's sidebar folders. `undefined` while
 * loading; issues zero calls when cloud is off or no cloud project is active.
 */
export function useCloudFolders(
  projectId: Id<"projects"> | null,
): CloudFolderSummary[] | undefined {
  const q = useRqQuery({
    queryKey: gridQueryKeys.folders(projectId ?? ""),
    enabled: apiClient !== null && projectId !== null,
    queryFn: () => apiClient!.grid.listFolders.query({ projectId: projectId! }),
  });
  return useMemo<CloudFolderSummary[] | undefined>(
    () =>
      q.data?.map((f) => ({
        _id: f.id,
        projectId: f.projectId as Id<"projects">,
        name: f.name,
        position: f.position,
        createdAt: f.createdAt,
        parentId: f.parentId ?? null,
      })),
    [q.data],
  );
}

/**
 * Mutations for managing cloud projects + tables (create/delete). Separate from
 * the grid-cell mutations so the switcher/sidebar can create without subscribing
 * to a table.
 */
/** The raw `grid.listTables` cache shape (an array of table summaries). */
type TablesListCache = Awaited<
  ReturnType<NonNullable<typeof apiClient>["grid"]["listTables"]["query"]>
>;
/** The raw `grid.listFolders` cache shape. */
type FoldersListCache = Awaited<
  ReturnType<NonNullable<typeof apiClient>["grid"]["listFolders"]["query"]>
>;

export function useCloudProjectMutations() {
  const qc = useQueryClient();

  /**
   * Optimistically patch EVERY loaded tables list (the sidebar lists are keyed
   * `["grid","tables",projectId]`; a structural edit carries only the tableId,
   * so patch them all by prefix). Snapshots the matched caches and returns a
   * `rollback`. The trailing `invalidate` reconciles with server truth (and the
   * realtime workspace broadcast already refreshes other members).
   */
  const patchTablesLists = useCallback(
    (update: (list: TablesListCache) => TablesListCache): (() => void) => {
      const prev = qc.getQueriesData<TablesListCache>({
        predicate: (q) =>
          q.queryKey[0] === "grid" && q.queryKey[1] === "tables",
      });
      qc.setQueriesData<TablesListCache>(
        {
          predicate: (q) =>
            q.queryKey[0] === "grid" && q.queryKey[1] === "tables",
        },
        (list) => (list ? update(list) : list),
      );
      return () => {
        for (const [key, data] of prev) qc.setQueryData(key, data);
      };
    },
    [qc],
  );

  const createProject = useCallback(
    async (
      workspaceId: Id<"workspaces">,
      name: string,
    ): Promise<Id<"projects">> => {
      // Client-supplied id: deterministic, so the caller can route to the new
      // project the instant the mutation resolves and the realtime echo converges.
      const id = crypto.randomUUID();
      await apiClient!.grid.createProject.mutate({ workspaceId, name, id });
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
      folderId?: string | null,
    ): Promise<Id<"tables">> => {
      const id = crypto.randomUUID();
      await apiClient!.grid.createTable.mutate({
        projectId,
        name,
        folderId: folderId ?? null,
        id,
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
      // Optimistic: drop the table from every loaded sidebar list instantly.
      const rollback = patchTablesLists((list) =>
        list.filter((t) => t.id !== tableId),
      );
      qc.removeQueries({ queryKey: gridQueryKeys.table(tableId) });
      try {
        await apiClient!.grid.deleteTable.mutate({ tableId });
      } catch (e) {
        rollback();
        throw e;
      } finally {
        await qc.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "grid" && query.queryKey[1] === "tables",
        });
      }
    },
    [qc, patchTablesLists],
  );
  const renameTable = useCallback(
    async (tableId: Id<"tables">, name: string) => {
      // Optimistic: relabel the sidebar list(s) and the open grid header instantly.
      const rollback = patchTablesLists((list) =>
        list.map((t) => (t.id === tableId ? { ...t, name } : t)),
      );
      try {
        await apiClient!.grid.renameTable.mutate({ tableId, name });
      } catch (e) {
        rollback();
        throw e;
      } finally {
        await qc.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "grid" && query.queryKey[1] === "tables",
        });
        await qc.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) });
      }
    },
    [qc, patchTablesLists],
  );
  const setTableFavorite = useCallback(
    async (tableId: Id<"tables">, favorite: boolean) => {
      // Optimistic: flip the pin instantly (favourites-first ordering reconciles
      // on the refetch / the workspace broadcast).
      const rollback = patchTablesLists((list) =>
        list.map((t) => (t.id === tableId ? { ...t, favorite } : t)),
      );
      try {
        await apiClient!.grid.setTableFavorite.mutate({ tableId, favorite });
      } catch (e) {
        rollback();
        throw e;
      } finally {
        await qc.invalidateQueries({
          predicate: (query) =>
            query.queryKey[0] === "grid" && query.queryKey[1] === "tables",
        });
      }
    },
    [qc, patchTablesLists],
  );
  // ── Sidebar folders ───────────────────────────────────────────────────────
  // Folder CRUD + table moves refresh BOTH the folders and tables lists for the
  // project (a move changes a table's folderId; a folder delete unfiles tables).
  const invalidateFolderLists = useCallback(
    (projectId: Id<"projects">) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: gridQueryKeys.folders(projectId) }),
        qc.invalidateQueries({ queryKey: gridQueryKeys.tables(projectId) }),
      ]),
    [qc],
  );
  /** Optimistically patch one project's folders list; returns a `rollback`. */
  const patchFoldersList = useCallback(
    (
      projectId: Id<"projects">,
      update: (list: FoldersListCache) => FoldersListCache,
    ): (() => void) => {
      const key = gridQueryKeys.folders(projectId);
      const prev = qc.getQueryData<FoldersListCache>(key);
      qc.setQueryData<FoldersListCache>(key, (list) =>
        list ? update(list) : list,
      );
      return () => qc.setQueryData(key, prev);
    },
    [qc],
  );

  const createFolder = useCallback(
    async (
      projectId: Id<"projects">,
      name: string,
      parentId: string | null = null,
    ): Promise<string> => {
      const id = crypto.randomUUID();
      await apiClient!.grid.createFolder.mutate({ projectId, name, id, parentId });
      await invalidateFolderLists(projectId);
      return id;
    },
    [invalidateFolderLists],
  );
  const renameFolder = useCallback(
    async (projectId: Id<"projects">, folderId: string, name: string) => {
      const rollback = patchFoldersList(projectId, (list) =>
        list.map((f) => (f.id === folderId ? { ...f, name } : f)),
      );
      try {
        await apiClient!.grid.renameFolder.mutate({ folderId, name });
      } catch (e) {
        rollback();
        throw e;
      } finally {
        await invalidateFolderLists(projectId);
      }
    },
    [invalidateFolderLists, patchFoldersList],
  );
  const deleteFolder = useCallback(
    async (projectId: Id<"projects">, folderId: string) => {
      // Optimistic: remove the folder AND unfile its tables to the root (the
      // server's FK is ON DELETE SET NULL), so the sidebar reshapes instantly.
      const rollbackFolders = patchFoldersList(projectId, (list) =>
        list.filter((f) => f.id !== folderId),
      );
      const rollbackTables = patchTablesLists((list) =>
        list.map((t) => (t.folderId === folderId ? { ...t, folderId: null } : t)),
      );
      try {
        await apiClient!.grid.deleteFolder.mutate({ folderId });
      } catch (e) {
        rollbackTables();
        rollbackFolders();
        throw e;
      } finally {
        await invalidateFolderLists(projectId);
      }
    },
    [invalidateFolderLists, patchFoldersList, patchTablesLists],
  );
  const moveTable = useCallback(
    async (
      projectId: Id<"projects">,
      tableId: Id<"tables">,
      folderId: string | null,
      position?: number,
    ) => {
      // Optimistic: refile the table (and reposition) in the sidebar instantly.
      const rollback = patchTablesLists((list) =>
        list.map((t) =>
          t.id === tableId
            ? { ...t, folderId, ...(position !== undefined ? { position } : {}) }
            : t,
        ),
      );
      try {
        await apiClient!.grid.moveTable.mutate({ tableId, folderId, position });
      } catch (e) {
        rollback();
        throw e;
      } finally {
        await invalidateFolderLists(projectId);
      }
    },
    [invalidateFolderLists, patchTablesLists],
  );
  const moveFolder = useCallback(
    async (
      projectId: Id<"projects">,
      folderId: string,
      parentId: string | null,
      position?: number,
    ) => {
      // Optimistic: reparent (and reposition) the folder in the sidebar instantly.
      const rollback = patchFoldersList(projectId, (list) =>
        list.map((f) =>
          f.id === folderId
            ? { ...f, parentId, ...(position !== undefined ? { position } : {}) }
            : f,
        ),
      );
      try {
        await apiClient!.grid.moveFolder.mutate({ folderId, parentId, position });
      } catch (e) {
        rollback();
        throw e;
      } finally {
        await invalidateFolderLists(projectId);
      }
    },
    [invalidateFolderLists, patchFoldersList],
  );
  return {
    createProject,
    createTable,
    deleteTable,
    renameTable,
    setTableFavorite,
    createFolder,
    renameFolder,
    deleteFolder,
    moveFolder,
    moveTable,
  };
}

/**
 * Cache-refresh helpers used after a local→cloud sync push (TRI-3309 / TRI-3310).
 *
 * A successful push mutates the cloud project OUTSIDE the tRPC mutation hooks
 * (it goes through the sidecar's push route, not `grid.createTable`), so the
 * cloud-tables react-query is never invalidated and the "TABLES (CLOUD)" list
 * stays stale ("No tables yet") until a manual reload (bug A). A re-sync also
 * SWAPS the cloud table for a new id and deletes the old one, so the open
 * table's `getTable` query must be invalidated too or the grid shows "this cloud
 * table no longer exists" (bug E). These wrappers centralise those invalidations
 * so App.tsx targets the exact same keys the hooks read.
 */
export function useCloudSyncRefresh() {
  const qc = useQueryClient();
  /**
   * Invalidate the cloud-tables list so a freshly-pushed table appears without a
   * reload. The push only knows the cloud project id; invalidate by key prefix so
   * whichever project's list is loaded refetches (mirrors `deleteTable`).
   */
  const invalidateCloudTables = useCallback(
    () =>
      qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "grid" && query.queryKey[1] === "tables",
      }),
    [qc],
  );
  /**
   * Invalidate the open cloud table's grid query (both the unpaged `getTable`
   * and the paged `tablePaged` seeds) after a re-sync repoints to a NEW cloud
   * table id, so the live grid re-seeds against the surviving table instead of
   * the deleted old one.
   */
  const invalidateCloudTable = useCallback(
    (tableId: string) =>
      qc.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "grid" &&
          (query.queryKey[1] === "table" || query.queryKey[1] === "tablePaged") &&
          query.queryKey[2] === tableId,
      }),
    [qc],
  );
  return { invalidateCloudTables, invalidateCloudTable };
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
  condition?: string | null;
  config?: unknown;
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
    condition: c.condition ?? null,
    // Behaviour flags (CRM-synced columns carry `{ synced: true, … }`), carried
    // through so the grid can render synced columns read-only.
    config: c.config ?? null,
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
  table: {
    _id: string;
    name: string;
    dedupe?: { column: string; keep: "oldest" | "newest" } | null;
  };
  columns: readonly {
    _id: string;
    name: string;
    type: string;
    kind: string;
    provider: string | null;
    method: string | null;
    code: string | null;
    params?: unknown;
    condition?: string | null;
    config?: unknown;
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
    return {
      id: data.table._id,
      name: data.table.name,
      dedupe: data.table.dedupe ?? null,
      columns,
      rows,
    };
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
 * The LAZILY-PAGED reactive grid for a cloud table (TRI-3272).
 *
 * Unlike {@link useCloudTable} (which seeds the WHOLE grid in one read), this
 * hook drives a react-query `useInfiniteQuery` over the keyset `grid.getTablePage`
 * query: it loads the first page on mount and fetches further pages ONLY when
 * `loadMore` is called (the C1 virtualization viewport ties scroll → `loadMore`).
 * Only the LOADED pages are resident, so combined with row virtualization a
 * 10k-row table's memory is bounded — never the whole grid.
 *
 * Live reactivity is preserved (TRI-3268): it subscribes to the table's W3 grid
 * channel and applies each event through {@link patchPagedGridCache}, so
 * incremental cell upserts / row + column inserts/deletes still patch the loaded
 * pages exactly as the unpaged path patches its snapshot.
 *
 * Returns the projected `FullTable` (of the loaded pages), plus `loadMore`,
 * `hasMore` and `isLoadingMore` for the viewport. `data` is `undefined` while the
 * first page loads, `null` if the table no longer exists.
 */
export function useCloudTablePaged(tableId: Id<"tables"> | null): {
  readonly data: FullTable | null | undefined;
  readonly loadMore: () => void;
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
} {
  const q = useInfiniteQuery({
    queryKey: gridQueryKeys.tablePaged(tableId ?? ""),
    enabled: apiClient !== null && tableId !== null,
    initialPageParam: null as GridPageCursor,
    queryFn: ({ pageParam }) =>
      apiClient!.grid.getTablePage.query({
        tableId: tableId!,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor,
    // Realtime is the fast path. This targeted fallback keeps local builds and
    // temporary socket outages live without polling settled tables.
    refetchInterval: (query) => {
      const cached = query.state.data as { pages?: readonly GridPage[] } | undefined;
      return cached?.pages?.some((page) => page.cells.some((cell) => cell.status === "pending" || cell.status === "running"))
        ? 750
        : false;
    },
  });

  // Subscribe once a page is loaded; patch the PAGED cache per event.
  usePagedGridRealtime(tableId, q.data ? activeWorkspaceIdRef.current : null);

  // One incremental projector per view (same identity-preserving reuse as the
  // unpaged path); reset when the table changes.
  const viewRef = useRef(createIncrementalTableView());
  const lastTableRef = useRef(tableId);
  if (lastTableRef.current !== tableId) {
    lastTableRef.current = tableId;
    viewRef.current = createIncrementalTableView();
  }

  const data = useMemo<FullTable | null | undefined>(() => {
    if (q.isLoading && q.data === undefined) return undefined;
    if (q.data === undefined) return undefined;
    const snapshot = mergePagesToSnapshot(q.data.pages);
    if (snapshot === null) return null;
    return viewRef.current.derive(snapshot);
  }, [q.data, q.isLoading]);

  const loadMore = useCallback(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);

  return {
    data,
    loadMore,
    hasMore: q.hasNextPage,
    isLoadingMore: q.isFetchingNextPage,
  };
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
        onPresence: (states) => gridPresenceStore.setRoster(states),
      });
      // Publish this client's cursor/identity through the SAME socket (no second
      // connection); CloudGrid feeds local cursor moves into the store.
      gridPresenceStore.setPublisher((state) => void sub.updatePresence(state));
      teardown = sub.unsubscribe;
      if (disposed) {
        gridPresenceStore.setPublisher(null);
        gridPresenceStore.clear();
        void sub.unsubscribe();
      }
    })();

    return () => {
      disposed = true;
      flush.cancel();
      gridPresenceStore.setPublisher(null);
      gridPresenceStore.clear();
      if (teardown) void teardown();
    };
  }, [tableId, workspaceId]);
}

/**
 * The PAGED counterpart of {@link useGridRealtime}: subscribes to the table's W3
 * grid channel and patches the `useInfiniteQuery` page list via
 * {@link patchPagedGridCache} (page-aware so a live event never duplicates a row
 * or revives an unloaded page). Same coalescing-per-frame + teardown semantics,
 * so live reactivity (TRI-3268) holds for the lazily-paged grid too. No-op when
 * realtime is unconfigured / there is no table / the workspace is unknown.
 */
function usePagedGridRealtime(
  tableId: Id<"tables"> | null,
  workspaceId: string | null,
): void {
  const qc = useQueryClient();
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

    const buffer: Array<Parameters<typeof patchPagedGridCache>[1]> = [];
    // Dropped-event backstop: events the paged cache can't place (rows past
    // the loaded tail — the norm during a large CRM pull) trigger a THROTTLED
    // refetch of the paged grid + the sidebar table list, so rows appear in
    // order and counts stay fresh without a render storm.
    let lastInvalidateAt = 0;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const INVALIDATE_EVERY_MS = 2000;
    const invalidateForDrops = () => {
      if (disposed) return;
      lastInvalidateAt = Date.now();
      void qcRef.current.invalidateQueries({ queryKey: gridQueryKeys.tablePaged(tableId) });
      void qcRef.current.invalidateQueries({ queryKey: gridQueryKeys.table(tableId) });
      void qcRef.current.invalidateQueries({ queryKey: ["grid", "tables"] });
    };
    const scheduleDropInvalidate = () => {
      if (invalidateTimer !== null) return;
      const wait = Math.max(0, INVALIDATE_EVERY_MS - (Date.now() - lastInvalidateAt));
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        invalidateForDrops();
      }, wait);
    };
    const flush = scheduleFlush(() => {
      if (disposed || buffer.length === 0) return;
      const events = buffer.splice(0, buffer.length);
      let sawDrop = false;
      qcRef.current.setQueryData<{
        pages: GridPage[];
        pageParams: unknown[];
      }>(gridQueryKeys.tablePaged(tableId), (prev) => {
        if (prev === undefined) return prev;
        let pages: readonly GridPage[] = prev.pages;
        for (const event of events) {
          if (!sawDrop && wasEventDropped(pages, event)) sawDrop = true;
          pages = patchPagedGridCache(pages, event);
        }
        return pages === prev.pages ? prev : { ...prev, pages: [...pages] };
      });
      if (sawDrop) scheduleDropInvalidate();
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
        onPresence: (states) => gridPresenceStore.setRoster(states),
      });
      // Publish this client's cursor/identity through the SAME socket (no second
      // connection); CloudGrid feeds local cursor moves into the store.
      gridPresenceStore.setPublisher((state) => void sub.updatePresence(state));
      teardown = sub.unsubscribe;
      if (disposed) {
        gridPresenceStore.setPublisher(null);
        gridPresenceStore.clear();
        void sub.unsubscribe();
      }
    })();

    return () => {
      disposed = true;
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      flush.cancel();
      gridPresenceStore.setPublisher(null);
      gridPresenceStore.clear();
      if (teardown) void teardown();
    };
  }, [tableId, workspaceId]);
}

/**
 * Subscribe to the WORKSPACE realtime room (`${workspaceId}:_workspace`) and
 * refresh the sidebar's cloud table + project lists when ANY member creates,
 * syncs, or deletes a table — so a teammate's change shows up live without an
 * app restart. We don't patch the list in place (table create/delete is rare and
 * the events don't carry the list's count metadata); we invalidate the
 * `grid/tables` + `grid/projects` queries and let them refetch. Opens its own
 * socket (separate from any open table's grid socket). No-op when realtime is
 * unconfigured or no workspace is active.
 */
export function useWorkspaceRealtime(
  workspaceId: Id<"workspaces"> | null,
): void {
  const qc = useQueryClient();
  const qcRef = useRef(qc);
  qcRef.current = qc;

  useEffect(() => {
    if (!realtimeConfigured || workspaceId === null || PARTY_URL === undefined) {
      return;
    }
    let disposed = false;
    let teardown: (() => Promise<void>) | null = null;

    void (async () => {
      const token = await mintRealtimeToken(workspaceId).catch(() => null);
      if (token === null || disposed) return;
      const sub = subscribeToGrid({
        url: PARTY_URL,
        token,
        workspaceId,
        tableId: WORKSPACE_ROOM_TABLE_ID,
        onEvent: () => {
          qcRef.current.invalidateQueries({
            predicate: (query) =>
              query.queryKey[0] === "grid" &&
              (query.queryKey[1] === "tables" ||
                query.queryKey[1] === "folders" ||
                query.queryKey[1] === "projects"),
          });
        },
      });
      teardown = sub.unsubscribe;
      if (disposed) void sub.unsubscribe();
    })();

    return () => {
      disposed = true;
      if (teardown) void teardown();
    };
  }, [workspaceId]);
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
 * Flatten the LOADED pages of the keyset infinite query into ONE
 * `getTable`-shaped snapshot the existing {@link createIncrementalTableView}
 * projector consumes — table + columns come from the first page (identical on
 * every page), rows + cells are the concatenation of the loaded pages (in page
 * order, i.e. ascending row position). Only loaded pages contribute, so the
 * snapshot is bounded by how far the viewport has paged, never the whole grid.
 * Pure; returns `null` when no page is loaded yet. Unit-tested.
 */
export function mergePagesToSnapshot(
  pages: readonly GridPage[],
): GetTableData | null {
  const first = pages[0];
  if (first === undefined) return null;
  const rows: GetTableData["rows"][number][] = [];
  const cells: GetTableData["cells"][number][] = [];
  for (const page of pages) {
    for (const r of page.rows) rows.push(r);
    for (const c of page.cells) cells.push(c);
  }
  return { table: first.table, columns: first.columns, rows, cells };
}

/**
 * The PURE cache updater for a live grid event over the PAGED infinite query.
 *
 * Applies the SAME `applyGridEvent` reducer used by the unpaged path, but
 * page-aware so resident memory stays bounded and no event duplicates a row:
 *  - cell.upsert: patched ONLY into the loaded page that already contains the
 *    row (a cell for an unloaded row is dropped — it arrives when that page
 *    loads), so a cell never appends a phantom row to an unrelated page.
 *  - row.insert: appended ONLY to the last page AND only when that page is the
 *    final one (`nextCursor === null`); otherwise the new row belongs to an
 *    unloaded tail and surfaces when the viewport pages to it.
 *  - row.delete / column.insert / column.delete: applied to EVERY loaded page
 *    (idempotent; columns are duplicated per page so a column change must hit
 *    all of them).
 *  - table.delete: collapses the whole paged result to an empty page list.
 *
 * Returns the next pages array (new identity only for changed pages). Pure +
 * unit-tested without React or Supabase.
 */
/**
 * Whether `event` would be DROPPED by {@link patchPagedGridCache} against the
 * currently loaded pages: a `row.insert` while the loaded tail still has a
 * next page (the row belongs past what's paged in), or a `cell.upsert` for a
 * row that isn't loaded. Dropped events mean the server has rows the cache
 * can't place — the subscriber reacts by (throttled) refetching so synced
 * rows still appear live during large pulls.
 */
export function wasEventDropped(
  pages: readonly GridPage[],
  event: Parameters<typeof applyGridEvent>[1],
): boolean {
  if (pages.length === 0) return false;
  if (event.type === "row.insert") {
    const last = pages[pages.length - 1];
    return last === undefined || last.nextCursor !== null;
  }
  if (event.type === "cell.upsert") {
    return !pages.some((p) => p.rows.some((r) => r._id === event.cell.rowId));
  }
  return false;
}

export function patchPagedGridCache(
  pages: readonly GridPage[],
  event: Parameters<typeof applyGridEvent>[1],
): readonly GridPage[] {
  if (pages.length === 0) return pages;

  // A table.delete drops the entire grid → no loaded pages remain.
  if (event.type === "table.delete") {
    const first = pages[0];
    if (first !== undefined && event.tableId === first.table._id) return [];
    return pages;
  }

  // row.insert only lands on the final loaded page (the one with no next page).
  if (event.type === "row.insert") {
    const lastIdx = pages.length - 1;
    const last = pages[lastIdx];
    if (last === undefined || last.nextCursor !== null) return pages;
    const patched = applyEventToPage(last, event);
    if (patched === last) return pages;
    const next = pages.slice();
    next[lastIdx] = patched;
    return next;
  }

  // cell.upsert only patches the page that already holds the target row.
  if (event.type === "cell.upsert") {
    const idx = pages.findIndex((p) =>
      p.rows.some((r) => r._id === event.cell.rowId),
    );
    if (idx < 0) return pages; // row not loaded — the page owns it when it loads
    const patched = applyEventToPage(pages[idx]!, event);
    if (patched === pages[idx]) return pages;
    const next = pages.slice();
    next[idx] = patched;
    return next;
  }

  // row.delete / column.* — apply to every page (idempotent on pages that don't
  // hold the target). table.insert is a no-op for this table's pages.
  let changed = false;
  const next = pages.map((p) => {
    const patched = applyEventToPage(p, event);
    if (patched !== p) changed = true;
    return patched;
  });
  return changed ? next : pages;
}

/** Apply one event to a single page via the shared reducer (page = a snapshot). */
function applyEventToPage(
  page: GridPage,
  event: Parameters<typeof applyGridEvent>[1],
): GridPage {
  // A page is shaped like the reducer's `GridSnapshot` (table/columns/rows/cells)
  // plus `nextCursor`; bridge through `unknown` (tRPC makes `params` optional)
  // and re-attach the page's own cursor afterwards.
  const patched = applyGridEvent(
    page as Parameters<typeof applyGridEvent>[0],
    event,
  );
  if (patched === null) return page;
  const nextPage = patched as unknown as GridPage;
  return nextPage === (page as unknown)
    ? page
    : { ...nextPage, nextCursor: page.nextCursor };
}

/**
 * Mutation wrappers for cloud grid edits — cell edits, add row, add column, plus
 * the structural deletes.
 *
 * These call the tRPC `grid.*` mutations; the server broadcasts the change on
 * the table's W3 channel so EVERY subscribed client — including this writer —
 * patches its `getTable` cache via the realtime reducer (the writer is itself a
 * subscriber). Structural ADDs (`addRow`/`addColumn`/`addRowsWithCells`) still
 * invalidate the owning table's query because the caller already knows its
 * `tableId` and the immediate refetch keeps the just-created row/column visible
 * without waiting on the broadcast round-trip.
 *
 * `setCell`/`deleteRow`/`deleteColumn` do NOT refetch: they carry only a
 * cell/row/column id, so a refetch would have to invalidate ALL loaded tables (a
 * full network refetch of every grid). The realtime broadcast already patches
 * the exact snapshot, so the manual refetch is redundant — removed per TRI-3274
 * (C5) to keep manual writes O(1) on a large table instead of O(loaded tables).
 */
/** A tRPC "… not found" error — the row/column was already deleted server-side. */
function isNotFoundError(e: unknown): boolean {
  return e instanceof Error && /not found/i.test(e.message);
}

export function useCloudGridMutations() {
  const qc = useQueryClient();
  // Invalidate BOTH the unpaged (`grid.getTable`) and the paged
  // (`grid.getTablePage`) caches for a table. The live grid renders the PAGED
  // query, so invalidating only `table` (the old behavior) left structural
  // edits — delete/edit column, delete row — invisible until remount when the
  // realtime broadcast was unconfigured or dropped. Invalidating the paged key
  // too makes every mutation authoritatively reflect, broadcast or not.
  const refresh = useCallback(
    (tableId: string, opts?: { refetchType?: "active" | "none" }) =>
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "grid" &&
          (q.queryKey[1] === "table" || q.queryKey[1] === "tablePaged") &&
          q.queryKey[2] === tableId,
        // `refetchType: "none"` marks the cache stale WITHOUT an immediate
        // refetch — used after an optimistic column save so a slow background
        // refetch can't land a pre-run snapshot that clobbers the cells a
        // just-started run is streaming in via realtime. A natural refetch
        // (window focus / staleTime) reconciles later.
        ...(opts?.refetchType ? { refetchType: opts.refetchType } : {}),
      }),
    [qc],
  );
  const refreshTable = useCallback((tableId: string) => refresh(tableId), [refresh]);

  // Optimistically apply a structural event to both caches so the change shows
  // INSTANTLY (no waiting on the refetch round-trip), then `refresh` reconciles
  // with server truth. Reuses the same pure reducers the realtime path uses.
  const applyOptimistic = useCallback(
    (tableId: string, event: Parameters<typeof patchGridCache>[1]) => {
      // The unpaged snapshot is usually ABSENT (the grid loads paged) — an
      // undefined cache entry must stay undefined, not be patched into being
      // (and the reducer must never see undefined.columns).
      qc.setQueryData(gridQueryKeys.table(tableId), (prev) =>
        prev == null
          ? prev
          : patchGridCache(prev as Parameters<typeof patchGridCache>[0], event),
      );
      qc.setQueryData<{ pages: GridPage[]; pageParams: unknown[] }>(
        gridQueryKeys.tablePaged(tableId),
        (prev) =>
          prev === undefined
            ? prev
            : { ...prev, pages: [...patchPagedGridCache(prev.pages, event)] },
      );
    },
    [qc],
  );

  /**
   * Read a column's CURRENT cached projection (for building an optimistic
   * `column.update`, which carries the FULL column, not just the patch). Prefers
   * the paged cache the live grid renders; falls back to the unpaged snapshot.
   */
  const currentColumn = useCallback(
    (
      tableId: string,
      columnId: string,
    ): GridPage["columns"][number] | undefined => {
      const paged = qc.getQueryData<{ pages: GridPage[] }>(
        gridQueryKeys.tablePaged(tableId),
      );
      const fromPaged = paged?.pages[0]?.columns.find((c) => c._id === columnId);
      if (fromPaged) return fromPaged;
      const unpaged = qc.getQueryData<GridCacheSnapshot>(
        gridQueryKeys.table(tableId),
      );
      return unpaged?.columns.find((c) => c._id === columnId);
    },
    [qc],
  );

  /**
   * Begin an optimistic mutation: cancel any in-flight refetch for this table (so
   * a late response can't clobber the patch), SNAPSHOT both caches, then apply the
   * event(s) immediately. Returns a `rollback` to restore the snapshot if the
   * server write fails.
   *
   * Because the writer is itself a realtime subscriber, the server's broadcast
   * echoes the SAME id-keyed event back ~1 RTT later; `applyGridEvent` is
   * idempotent (de-dupes inserts by `_id`, keys cells by `rowId:columnId`), so a
   * successful optimistic write and its echo CONVERGE rather than duplicate —
   * which is exactly why inserts carry a CLIENT-supplied id (the optimistic id IS
   * the persisted id).
   */
  const beginOptimistic = useCallback(
    (
      tableId: string,
      events: ReadonlyArray<Parameters<typeof patchGridCache>[1]>,
    ): (() => void) => {
      void qc.cancelQueries({
        predicate: (q) =>
          q.queryKey[0] === "grid" &&
          (q.queryKey[1] === "table" || q.queryKey[1] === "tablePaged") &&
          q.queryKey[2] === tableId,
      });
      const prevTable = qc.getQueryData(gridQueryKeys.table(tableId));
      const prevPaged = qc.getQueryData(gridQueryKeys.tablePaged(tableId));
      for (const event of events) applyOptimistic(tableId, event);
      return () => {
        qc.setQueryData(gridQueryKeys.table(tableId), prevTable);
        qc.setQueryData(gridQueryKeys.tablePaged(tableId), prevPaged);
      };
    },
    [qc, applyOptimistic],
  );

  const setCell = useCallback(
    async (
      tableId: Id<"tables">,
      rowId: Id<"rows">,
      columnId: Id<"columns">,
      value: unknown,
    ) => {
      // Optimistic: cells are keyed by (rowId, columnId), so the patch needs no
      // new id and the realtime echo of the SAME cell converges. No refetch — a
      // cell edit is the hottest path and the echo already reconciles (TRI-3274).
      const rollback = beginOptimistic(tableId, [
        { type: "cell.upsert", cell: { rowId, columnId, value, status: "done", error: null } },
      ]);
      try {
        return await apiClient!.grid.setCell.mutate({
          rowId,
          columnId,
          value,
          status: "done",
          error: null,
        });
      } catch (e) {
        rollback();
        throw e;
      }
    },
    [beginOptimistic],
  );
  const addRow = useCallback(
    async (tableId: Id<"tables">) => {
      // Client-supplied id → the optimistic row IS the persisted row (the echo
      // converges). The new row appears instantly when the final page is loaded;
      // the trailing refetch reconciles server-derived fields (position) and the
      // tail-page case.
      const id = crypto.randomUUID();
      const rollback = beginOptimistic(tableId, [
        { type: "row.insert", row: { _id: id }, cells: [] },
      ]);
      try {
        const res = await apiClient!.grid.addRow.mutate({ tableId, id });
        await refresh(tableId);
        return res;
      } catch (e) {
        rollback();
        throw e;
      }
    },
    [beginOptimistic, refresh],
  );
  /**
   * Bulk insert rows + cells for CSV import. Each row is a `{ columnId: value }`
   * map; metered as one cloud action per row. Throws when the import would
   * exceed the plan's quota. Client-supplied row ids make the import optimistic
   * and echo-convergent.
   */
  const addRowsWithCells = useCallback(
    async (tableId: Id<"tables">, rows: Array<Record<string, unknown>>) => {
      const rowIds = rows.map(() => crypto.randomUUID());
      const events = rows.map((cellMap, i) => ({
        type: "row.insert" as const,
        row: { _id: rowIds[i]! },
        // Mirror the server's filter (drop empty values) so the optimistic cells
        // match what gets persisted.
        cells: Object.entries(cellMap)
          .filter(([, v]) => v !== "" && v !== null && v !== undefined)
          .map(([columnId, value]) => ({
            rowId: rowIds[i]!,
            columnId,
            value,
            status: "done",
            error: null,
          })),
      }));
      const rollback = beginOptimistic(tableId, events);
      try {
        const res = await apiClient!.grid.addRowsWithCells.mutate({
          tableId,
          rows,
          rowIds,
        });
        await refresh(tableId);
        return res;
      } catch (e) {
        rollback();
        throw e;
      }
    },
    [beginOptimistic, refresh],
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
      const type = (body.type ?? "text") as
        | "text"
        | "number"
        | "boolean"
        | "date"
        | "json";
      const id = crypto.randomUUID();
      const rollback = beginOptimistic(tableId, [
        {
          type: "column.insert",
          column: {
            _id: id,
            name: body.name,
            type,
            kind,
            provider,
            method,
            code: body.code ?? null,
            params: body.params ?? {},
            condition: null,
          },
        },
      ]);
      try {
        const res = await apiClient!.grid.addColumn.mutate({
          tableId,
          name: body.name,
          type,
          kind,
          provider,
          method,
          code: body.code ?? null,
          params: body.params ?? {},
          id,
        });
        // The optimistic patch (client id == persisted id) AND the realtime
        // `column.insert` echo already show the column instantly. Reconcile in the
        // BACKGROUND so the save resolves immediately instead of blocking on a
        // full multi-page refetch (the bulk of the "add column takes 20–30s").
        void refresh(tableId, { refetchType: "none" });
        return res;
      } catch (e) {
        rollback();
        throw e;
      }
    },
    [beginOptimistic, refresh],
  );
  const deleteRow = useCallback(
    async (tableId: Id<"tables">, rowId: Id<"rows">) => {
      const rollback = beginOptimistic(tableId, [{ type: "row.delete", rowId }]);
      try {
        await apiClient!.grid.deleteRow.mutate({ rowId });
      } catch (e) {
        if (!isNotFoundError(e)) {
          rollback(); // real failure → restore the row
          throw e;
        }
        // already gone → optimistic delete is right; keep it
      } finally {
        await refresh(tableId);
      }
    },
    [beginOptimistic, refresh],
  );
  const deleteColumn = useCallback(
    async (tableId: Id<"tables">, columnId: Id<"columns">) => {
      const rollback = beginOptimistic(tableId, [
        { type: "column.delete", columnId },
      ]);
      try {
        await apiClient!.grid.deleteColumn.mutate({ columnId });
      } catch (e) {
        if (!isNotFoundError(e)) {
          rollback(); // real failure → restore the column
          throw e;
        }
        // already gone → optimistic delete is right; keep it
      } finally {
        await refresh(tableId);
      }
    },
    [beginOptimistic, refresh],
  );
  /**
   * Patch a column's definition (rename / type / function config). Invalidates
   * the table's grid queries so the edit reflects even when the realtime
   * `column.update` broadcast is unconfigured or dropped.
   */
  const updateColumn = useCallback(
    async (
      tableId: Id<"tables">,
      columnId: Id<"columns">,
      patch: {
        name?: string;
        type?: "text" | "number" | "boolean" | "date" | "json";
        kind?: "manual" | "function";
        provider?: string | null;
        method?: string | null;
        code?: string | null;
        params?: Record<string, unknown>;
        condition?: string | null;
      },
    ) => {
      // Optimistic: a `column.update` carries the FULL column, so merge the patch
      // onto the current cached projection and patch instantly. Skip if the
      // column isn't cached (the refetch still reflects the edit).
      const current = currentColumn(tableId, columnId);
      const rollback = current
        ? beginOptimistic(tableId, [
            {
              type: "column.update",
              column: {
                _id: columnId,
                name: patch.name ?? current.name,
                type: patch.type ?? current.type,
                kind: patch.kind ?? current.kind,
                provider:
                  patch.provider !== undefined ? patch.provider : current.provider,
                method: patch.method !== undefined ? patch.method : current.method,
                code: patch.code !== undefined ? patch.code : current.code,
                params: patch.params !== undefined ? patch.params : current.params,
                condition:
                  patch.condition !== undefined
                    ? patch.condition
                    : current.condition,
              },
            },
          ])
        : null;
      try {
        return await apiClient!.grid.updateColumn.mutate({ columnId, ...patch });
      } catch (e) {
        rollback?.();
        throw e;
      } finally {
        // Optimistic `column.update` + the realtime echo already reflect the edit;
        // reconcile in the BACKGROUND so saving a mapped field returns instantly
        // instead of blocking on a full multi-page refetch.
        void refresh(tableId, { refetchType: "none" });
      }
    },
    [beginOptimistic, currentColumn, refresh],
  );

  /** Set (or clear) the table's dedupe config; the server sweeps immediately. */
  const setDedupe = useCallback(
    async (
      tableId: Id<"tables">,
      body: { column: string | null; keep?: "oldest" | "newest" },
    ) => {
      try {
        return await apiClient!.grid.setDedupe.mutate({
          tableId,
          column: body.column,
          ...(body.keep ? { keep: body.keep } : {}),
        });
      } finally {
        await refresh(tableId);
      }
    },
    [refresh],
  );
  /** Run a one-shot dedup sweep using the table's saved config. */
  const dedupeTable = useCallback(
    async (tableId: Id<"tables">) => {
      try {
        return await apiClient!.grid.dedupe.mutate({ tableId });
      } finally {
        await refresh(tableId);
      }
    },
    [refresh],
  );

  return {
    setCell,
    refreshTable,
    addRow,
    addRowsWithCells,
    addColumn,
    updateColumn,
    deleteRow,
    deleteColumn,
    setDedupe,
    dedupeTable,
  };
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
  /** What feeds this connection: undefined/"http" = a classic webhook (third
   *  party POSTs to the token URL); "push" = a sibling table's `table.push`
   *  column delivers rows through the engine (no public HTTP ingress). */
  readonly source?: string;
  /** The sibling table whose push column feeds this connection ("push" only). */
  readonly sourceTableId?: Id<"tables"> | null;
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
  source?: string | null;
  sourceTableId?: string | null;
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
    ...(w.source != null ? { source: w.source } : {}),
    ...(w.sourceTableId != null
      ? { sourceTableId: w.sourceTableId as Id<"tables"> }
      : {}),
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

// ── Table shares (share-a-table-via-URL) ─────────────────────────────────────

/**
 * One share link as returned by `share.listByTable` (the `ShareSummary` shape:
 * id/token/name/enabled/expiresAt/createdAt/revokedAt/shareUrl). Metadata only —
 * the heavy snapshot payload is never shipped to the list.
 */
export type CloudShare = Awaited<
  ReturnType<NonNullable<typeof apiClient>["share"]["listByTable"]["query"]>
>[number];

/** The result of `share.create` (`{ id, token, shareUrl }`). */
export type CreatedShare = Awaited<
  ReturnType<NonNullable<typeof apiClient>["share"]["create"]["mutate"]>
>;

/**
 * Reactive list of a table's share links (newest first). Issues zero calls when
 * cloud is off or no table is selected. Mirrors {@link useWebhooks}.
 */
export function useTableShares(
  tableId: Id<"tables"> | null,
): CloudShare[] | undefined {
  const q = useRqQuery({
    queryKey: gridQueryKeys.shares(tableId ?? ""),
    enabled: apiClient !== null && tableId !== null,
    queryFn: () => apiClient!.share.listByTable.query({ tableId: tableId! }),
  });
  return q.data;
}

/**
 * Mutation wrappers for the share panel — create a link, revoke a link, and
 * clone a shared table into a project. Each invalidates the affected query so
 * the UI reflects the change. Mirrors {@link useWebhookMutations}.
 */
export function useShareMutations() {
  const qc = useQueryClient();

  const createShare = useCallback(
    async (
      tableId: Id<"tables">,
      opts?: { name?: string; expiresAt?: number | null },
    ): Promise<CreatedShare> => {
      const res = await apiClient!.share.create.mutate({
        tableId,
        ...(opts?.name ? { name: opts.name } : {}),
        ...(opts?.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      });
      await qc.invalidateQueries({ queryKey: gridQueryKeys.shares(tableId) });
      return res;
    },
    [qc],
  );

  const revokeShare = useCallback(
    async (shareId: string, tableId: Id<"tables">) => {
      await apiClient!.share.revoke.mutate({ shareId });
      await qc.invalidateQueries({ queryKey: gridQueryKeys.shares(tableId) });
    },
    [qc],
  );

  const cloneShare = useCallback(
    async (args: {
      token: string;
      targetProjectId: string;
      includeData: boolean;
    }) => {
      const res = await apiClient!.share.clone.mutate(args);
      // The cloned table lands in the target project — refresh its table list.
      await qc.invalidateQueries({
        queryKey: gridQueryKeys.tables(args.targetProjectId),
      });
      return res;
    },
    [qc],
  );

  return { createShare, revokeShare, cloneShare };
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
  const setAuth = useCallback(
    async (webhookId: Id<"webhooks">, enabled: boolean) => {
      const res = await apiClient!.webhooks.setAuth.mutate({
        webhookId,
        enabled,
      });
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
    setAuth,
    deleteWebhook,
  };
}

// `queryClient` is exported by ./client; re-exported here so realtime patches in
// tests/consumers can target the same cache the hooks use.
export { queryClient };
