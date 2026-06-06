/**
 * Cloud grid hooks (T9) — the reactive data source for CLOUD projects.
 *
 * A LOCAL project's grid loads imperatively via the sidecar (`api.table()` in
 * api.ts). A CLOUD project's grid is LIVE: every hook here is a Convex
 * subscription (`useQuery`), so an edit / add row / run by any workspace member
 * updates this client without a refresh — multiplayer for free. Writes go
 * through the T4 Convex mutations.
 *
 * These hooks deliberately produce the SAME shapes the existing grid render
 * components consume (`Column`, `Cell`, a `FullTable`-like view) so the cloud
 * grid reuses `CellContent` etc. — only the data source changes. The hooks stay
 * thin React glue; the run orchestration is the Effect service in ./cloud-run.ts.
 *
 * All of this is gated on a configured Convex deployment + a chosen cloud table:
 * when either is absent the queries are `skip`ped, so a local-only / signed-out
 * app issues zero Convex calls and the local path is untouched.
 */

import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { Cell, CellStatus, Column, FullTable } from "../api";
import { CONVEX_URL, cloudEnabled } from "./convex";
import type { CloudSession } from "./cloud-run";

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

/**
 * The signed-in cloud session (deployment url + auth JWT) needed to run a cloud
 * column via the sidecar, or `null` when cloud is off / not yet authenticated.
 * `useAuthToken` is reactive: the token populates once Convex Auth resolves it.
 */
export function useCloudSession(): CloudSession | null {
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
 * Reactive list of a workspace's cloud projects. `skip`ped (returns
 * `undefined`) when cloud is off or no workspace is active.
 */
export function useCloudProjects(
  workspaceId: Id<"workspaces"> | null,
): CloudProject[] | undefined {
  return useQuery(
    api.projects.listProjects,
    cloudEnabled && workspaceId !== null ? { workspaceId } : "skip",
  ) as CloudProject[] | undefined;
}

/**
 * Reactive list of a cloud project's tables. `skip`ped when cloud is off or no
 * cloud project is active.
 */
export function useCloudTables(
  projectId: Id<"projects"> | null,
): CloudTableSummary[] | undefined {
  return useQuery(
    api.tables.listTables,
    cloudEnabled && projectId !== null ? { projectId } : "skip",
  ) as CloudTableSummary[] | undefined;
}

/**
 * Mutations for managing cloud projects + tables (create). Separate from the
 * grid-cell mutations so the switcher/sidebar can create without subscribing to
 * a table.
 */
export function useCloudProjectMutations() {
  const createProjectMut = useMutation(api.projects.createProject);
  const createTableMut = useMutation(api.tables.createTable);

  const createProject = useCallback(
    (workspaceId: Id<"workspaces">, name: string) =>
      createProjectMut({ workspaceId, name }),
    [createProjectMut],
  );
  const createTable = useCallback(
    (projectId: Id<"projects">, name: string) =>
      createTableMut({ projectId, name }),
    [createTableMut],
  );

  return { createProject, createTable };
}

/** Map a Convex column doc (from `getTable`) onto the desktop `Column` shape. */
function toColumn(c: {
  _id: string;
  name: string;
  type: string;
  kind: "manual" | "function";
  provider: string | null;
  method: string | null;
  code: string | null;
  params: Record<string, unknown>;
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
    params: c.params,
  };
}

/** Map a Convex cell doc onto the desktop `Cell` shape. */
function toCell(c: {
  value: unknown;
  status: CellStatus;
  error: string | null;
}): Cell {
  return { value: c.value, status: c.status, error: c.error };
}

/**
 * The reactive grid for a cloud table, shaped exactly like the local
 * `FullTable` (columns ordered, rows with a `cells` map keyed by column id), so
 * the same render code works. `undefined` while loading or when no cloud table
 * is selected; `null` if the table no longer exists.
 */
export function useCloudTable(
  tableId: Id<"tables"> | null,
): FullTable | null | undefined {
  const data = useQuery(
    api.tables.getTable,
    cloudEnabled && tableId !== null ? { tableId } : "skip",
  );

  return useMemo<FullTable | null | undefined>(() => {
    if (data === undefined) return undefined;
    if (data === null) return null;
    const columns = data.columns.map(toColumn);
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
        cells[col.id] = m?.get(col.id) ?? { value: null, status: "empty", error: null };
      }
      return { id: r._id, cells };
    });
    return { id: data.table._id, name: data.table.name, columns, rows };
  }, [data]);
}

/**
 * Mutation wrappers for cloud grid edits — cell edits, add row, add column,
 * plus the structural deletes. These call the T4 Convex mutations directly, so
 * the change is reflected live in every member's `useCloudTable` subscription.
 */
export function useCloudGridMutations() {
  const setCellMut = useMutation(api.cells.setCell);
  const addRowMut = useMutation(api.tables.addRow);
  const addRowsWithCellsMut = useMutation(api.tables.addRowsWithCells);
  const addColumnMut = useMutation(api.tables.addColumn);
  const deleteRowMut = useMutation(api.tables.deleteRow);
  const deleteColumnMut = useMutation(api.tables.deleteColumn);

  const setCell = useCallback(
    (rowId: Id<"rows">, columnId: Id<"columns">, value: unknown) =>
      // Manual edits are authored values → status "done", mirroring the local
      // sidecar's POST /api/cells behaviour.
      setCellMut({ rowId, columnId, value, status: "done", error: null }),
    [setCellMut],
  );

  const addRow = useCallback(
    (tableId: Id<"tables">) => addRowMut({ tableId }),
    [addRowMut],
  );

  /**
   * Bulk insert rows + cells for CSV import. Each row is a `{ columnId: value }`
   * map; metered as one cloud action per row. Throws a ConvexError with code
   * "CloudActionsLimitError" if the import would exceed the plan's quota.
   */
  const addRowsWithCells = useCallback(
    (tableId: Id<"tables">, rows: Array<Record<string, unknown>>) =>
      addRowsWithCellsMut({ tableId, rows }),
    [addRowsWithCellsMut],
  );

  /**
   * Add a column. `fn` ("provider.method") maps onto provider/method/kind the
   * same way the sidecar's POST /api/tables/:id/columns route does.
   */
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
      const provider = body.fn ? (body.fn.split(".")[0] ?? null) : null;
      const method = body.fn ? (body.fn.split(".")[1] ?? null) : null;
      const kind: "manual" | "function" = provider || body.code ? "function" : "manual";
      return addColumnMut({
        tableId,
        name: body.name,
        type: (body.type ?? "text") as "text" | "number" | "boolean" | "date" | "json",
        kind,
        provider,
        method,
        code: body.code ?? null,
        params: body.params ?? {},
      });
    },
    [addColumnMut],
  );

  const deleteRow = useCallback(
    (rowId: Id<"rows">) => deleteRowMut({ rowId }),
    [deleteRowMut],
  );

  const deleteColumn = useCallback(
    (columnId: Id<"columns">) => deleteColumnMut({ columnId }),
    [deleteColumnMut],
  );

  return { setCell, addRow, addRowsWithCells, addColumn, deleteRow, deleteColumn };
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
 * Reactive list of a table's webhooks (newest first). `skip`ped when cloud is
 * off or no table is selected, so a local-only / signed-out app issues zero
 * webhook queries. Mirrors {@link useCloudTables}.
 */
export function useWebhooks(
  tableId: Id<"tables"> | null,
): CloudWebhook[] | undefined {
  return useQuery(
    api.webhooks.listWebhooks,
    cloudEnabled && tableId !== null ? { tableId } : "skip",
  ) as CloudWebhook[] | undefined;
}

/**
 * Mutation wrappers for the webhook config panel — create, enable/disable,
 * rotate secrets, edit the field mapping, and patch receive behaviour. Each
 * calls the member-gated Convex mutation directly so the change is reflected
 * live in every member's {@link useWebhooks} subscription. Mirrors
 * {@link useCloudGridMutations}.
 */
export function useWebhookMutations() {
  const createMut = useMutation(api.webhooks.createWebhook);
  const updateMappingMut = useMutation(api.webhooks.updateWebhookMapping);
  const updateConfigMut = useMutation(api.webhooks.updateWebhookConfig);
  const toggleEnabledMut = useMutation(api.webhooks.toggleEnabled);
  const rotateSecretMut = useMutation(api.webhooks.rotateSecret);
  const deleteWebhookMut = useMutation(api.webhooks.deleteWebhook);

  const createWebhook = useCallback(
    (tableId: Id<"tables">, name?: string) =>
      createMut({ tableId, ...(name !== undefined ? { name } : {}) }),
    [createMut],
  );
  const updateMapping = useCallback(
    (webhookId: Id<"webhooks">, mapping: WebhookMappingEntry[]) =>
      updateMappingMut({ webhookId, mapping }),
    [updateMappingMut],
  );
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
  const toggleEnabled = useCallback(
    (webhookId: Id<"webhooks">, enabled: boolean) =>
      toggleEnabledMut({ webhookId, enabled }),
    [toggleEnabledMut],
  );
  const rotateSecret = useCallback(
    (webhookId: Id<"webhooks">) => rotateSecretMut({ webhookId }),
    [rotateSecretMut],
  );
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
