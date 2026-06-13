/**
 * The CLOUD data source for the gtmgrid MCP server (TRI-3296).
 *
 * In cloud mode the agent operates on the user's CLOUD (Supabase) project, not
 * the local SQLite file. The execution model mirrors the sidecar's cloud column
 * run (packages/server/src/cloud-run.ts): we build a Db-free {@link Engine} whose
 * GridStore is the engine's own {@link cloudGridStoreShape} — the SAME cloud
 * store the column-run path uses, NOT a re-implementation — so reads come from
 * Postgres and writes/status stream back through the apps/web `/api/worker/*`
 * endpoints to every workspace member.
 *
 * SCOPE (worker boundary): the `/api/worker/*` endpoints are table-scoped and
 * expose getTable (full grid), setCell/setCellStatus/setCells and the credential
 * decrypt-for-run path. They do NOT expose listing every table in a project or
 * creating tables/columns/plain rows (those live behind the authenticated tRPC
 * API, not the worker-secret boundary the spawned MCP uses). So the cloud source
 * fully serves `get_table` and `run_column` on the ACTIVE cloud table, and the
 * read of that table for `list_tables`; the create/list-all/add-rows mutators
 * surface a clear typed {@link CloudToolUnsupportedError} rather than silently
 * writing to local SQLite (which would corrupt the "operate on the data I'm
 * looking at" contract). Wiring those needs new worker routes — tracked as a
 * follow-up.
 */

import {
  CloudSchemaMapping,
  Engine,
  cloudGridStoreShape,
  connectorFromManifest,
  defaultRegistry,
  fetchWithRetry,
  parseManifest,
  type CloudClientLike,
  type CloudFunctionRefs,
  type EngineConfig,
  type GridStoreShape,
  type Registry,
} from "@gtmgrid/engine";
import { Effect } from "effect";
import type { CloudContext } from "./cloud-context.js";

/**
 * The apps/web worker endpoints the cloud store/engine address, as opaque route
 * refs. Mirrors `packages/server/src/cloud-run.ts` `CLOUD_REFS`; the injected
 * {@link CloudClientLike} POSTs the args to each path.
 */
export const CLOUD_REFS: CloudFunctionRefs = {
  getTable: "/api/worker/getTable",
  setCell: "/api/worker/setCell",
  setCellStatus: "/api/worker/setCellStatus",
  setCells: "/api/worker/setCells",
  getCredential: "/api/worker/getCredential",
};

/** The metadata-only worker ref for resolving a table's workspace id. */
const GET_TABLE_META_REF = "/api/worker/getTableMeta";

/**
 * The member-attributed WRITE/LIST worker refs the agent's cloud table tools use
 * (TRI-3299). Unlike {@link CLOUD_REFS} (the engine cloud store's table-scoped
 * refs), these are MCP-tool-specific routes secured by the same worker bearer
 * PLUS the `X-Gtmgrid-Member` attribution, so each verifies the member belongs to
 * the target project/table workspace and meters server-side.
 */
const LIST_TABLES_REF = "/api/worker/listTables";
const CREATE_TABLE_REF = "/api/worker/createTable";
const CREATE_COLUMN_REF = "/api/worker/createColumn";
const ADD_ROWS_REF = "/api/worker/addRows";

/**
 * The member-attributed MUTATION worker refs for the agent's cloud WRITE tools
 * that mirror the local SQLite mutators (delete/update/rename/reorder/dedupe).
 * Each is secured by the same `X-Gtmgrid-Member` attribution + server-side
 * metering as the create/add refs above. `setCells` (CLOUD_REFS) backs cell
 * writes; these cover the structural mutations.
 */
const DELETE_ROW_REF = "/api/worker/deleteRow";
const DELETE_COLUMN_REF = "/api/worker/deleteColumn";
const DELETE_TABLE_REF = "/api/worker/deleteTable";
const UPDATE_COLUMN_REF = "/api/worker/updateColumn";
const RENAME_TABLE_REF = "/api/worker/renameTable";
const REORDER_COLUMN_REF = "/api/worker/reorderColumn";
const REORDER_ROW_REF = "/api/worker/reorderRow";
const SET_DEDUPE_REF = "/api/worker/setDedupe";

/** Raised when a cloud MCP tool needs a worker route that does not exist yet. */
export class CloudToolUnsupportedError extends Error {
  readonly _tag = "CloudToolUnsupportedError";
  constructor(tool: string) {
    super(
      `"${tool}" is not available on a cloud project yet — the cloud worker API does not expose it. Use the gtm grid UI for this action, or run it on a local project.`,
    );
    this.name = "CloudToolUnsupportedError";
  }
}

/**
 * Build the HTTP {@link CloudClientLike} the cloud store injects: each ref is an
 * `/api/worker/*` route path, and query/mutation/action POST the JSON args to
 * `${apiUrl}<route>`.
 *
 * AUTH: the spawned MCP authenticates as the SIGNED-IN MEMBER via the
 * `X-Gtmgrid-Member` session token — NOT the shared `WEBHOOK_WORKER_SECRET`. The
 * worker secret is a server-only secret the desktop (and therefore the MCP it
 * spawns) never has, so the dual-auth worker routes take their member path and
 * enforce workspace membership server-side. Mirrors
 * `packages/server/src/cloud-run.ts` `makeWorkerClient`.
 */
export function makeWorkerClient(
  apiUrl: string,
  token: string,
): CloudClientLike {
  const base = apiUrl.replace(/\/+$/, "");
  const call = async (
    ref: unknown,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    if (typeof ref !== "string") {
      throw new Error(`Unsupported worker function ref: ${String(ref)}`);
    }
    const res = await fetchWithRetry(`${base}${ref}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gtmgrid-Member": token,
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Worker route ${ref} failed: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }
    const text = await res.text();
    return text === "" ? null : JSON.parse(text);
  };
  return {
    query: (ref, args) => call(ref, args),
    mutation: (ref, args) => call(ref, args),
    action: (ref, args) => call(ref, args),
  };
}

/** Narrow an unknown getTableMeta payload to its `table.workspaceId`. */
function readWorkspaceId(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "table" in payload &&
    typeof payload.table === "object" &&
    payload.table !== null &&
    "workspaceId" in payload.table &&
    typeof payload.table.workspaceId === "string"
  ) {
    return payload.table.workspaceId;
  }
  throw new Error("getTableMeta payload missing table.workspaceId");
}

/**
 * Build the cloud-backed {@link GridStoreShape} for one cloud table, resolving
 * {@link CloudSchemaMapping} eagerly so the rest is plain `Engine` code. The
 * `workspaceId` lets the store decrypt the workspace's SHARED connector
 * credentials for a run. Reuses the engine's `cloudGridStoreShape` — no
 * re-implementation of the store.
 */
export async function buildCloudStore(
  client: CloudClientLike,
  tableId: string,
  workspaceId: string,
): Promise<GridStoreShape> {
  return Effect.runPromise(
    cloudGridStoreShape({
      client,
      refs: CLOUD_REFS,
      tableId,
      credentials: { workspaceId, scope: "workspace" },
    }).pipe(Effect.provide(CloudSchemaMapping.Default)),
  );
}

/**
 * The subset of grid operations the MCP table tools call, so the tool handlers
 * are written ONCE against this interface and the local/cloud sources differ
 * only here. `get_table`/`run_column` are the read/run surface and
 * `create_table`/`add_column`/`add_rows`/project-wide `list_tables` the
 * write/list surface — ALL now served on cloud through the member-attributed
 * worker routes (TRI-3299), so the cloud source no longer rejects the mutators.
 */
export interface CloudGridSource {
  /** Columns of the active cloud table, mapped to MCP `get_table`'s shape. */
  readonly getTable: (
    tableRef: string,
  ) => Promise<{
    table: string;
    columns: { name: string; kind: string; fn: string | null }[];
    rows: Record<string, unknown>[];
  }>;
  /**
   * List ALL of the cloud PROJECT's tables (not just the active one) with their
   * column + row counts, via the project-scoped `listTables` worker route.
   */
  readonly listTables: () => Promise<
    { id: string; name: string; columns: number; rows: number }[]
  >;
  /** Create a new table in the active cloud project. Returns its id + name. */
  readonly createTable: (
    name: string,
  ) => Promise<{ id: string; name: string }>;
  /**
   * Add a column to a cloud table. `fn` ('provider.method') and/or `code`
   * determine the column kind; `fn` is validated against the registry exactly as
   * the local source does. Returns the new column id, name, kind, and resolved
   * `fn`.
   */
  readonly addColumn: (
    tableRef: string,
    spec: {
      name: string;
      formula?: string;
      fn?: string;
      code?: string;
      type?: string;
      params?: Record<string, unknown>;
      condition?: string;
    },
  ) => Promise<{ id: string; name: string; kind: string; fn: string | null }>;
  /**
   * Add rows to a cloud table. Each row is `{ ColumnName: value }`; the column
   * NAMES are resolved to ids against the table's grid before the worker write.
   * Returns how many rows were added.
   */
  readonly addRows: (
    tableRef: string,
    rows: Record<string, unknown>[],
  ) => Promise<{ added: number }>;
  /**
   * Run a function column on the active cloud table by column name/id. `limit`
   * scopes the run to the next N rows in grid order whose cell isn't yet `done`
   * (with `offset` to skip the first matches); omitting it runs every pending row.
   */
  readonly runColumn: (
    tableRef: string,
    columnRef: string,
    opts: { force?: boolean; concurrency?: number; limit?: number; offset?: number },
  ) => Promise<{ column: string; ran: number; errors: number }>;
  /**
   * Call a connector function DIRECTLY (no table) on the cloud project — the
   * cloud twin of the local `engine.dispatch`. Resolves the workspace's shared
   * connector credentials through the worker `getCredential` route (the same
   * machinery cloud {@link runColumn} uses), so the `run_function` tool can
   * SOURCE data (searches, enrichment) on cloud exactly as it does locally.
   */
  readonly runFunction: (
    provider: string,
    method: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  /**
   * The function columns of the active cloud table in grid (left-to-right) order,
   * each with whether it still has pending (not-`done`) cells. The `run_table`
   * tool drives a full-table run off this, calling {@link runColumn} per column.
   */
  readonly functionColumns: (
    tableRef: string,
  ) => Promise<{ name: string; pending: number }[]>;
  /** Set or clear specific cells (value null/''/undefined clears). Returns how many wrote. */
  readonly updateCells: (
    tableRef: string,
    updates: { row: string; column: string; value?: unknown }[],
  ) => Promise<{ updated: number }>;
  /** Row + column counts for the active cloud table (one grid read). */
  readonly tableStats: (
    tableRef: string,
  ) => Promise<{ rows: number; columns: number }>;
  /**
   * Delete rows by _id and/or a `where` match. With `dryRun`, resolves the target
   * set and returns its size WITHOUT deleting (the confirm-gate preview). Returns
   * how many were (or would be) deleted.
   */
  readonly deleteRows: (
    tableRef: string,
    opts: { ids?: string[]; where?: Record<string, unknown>; dryRun?: boolean },
  ) => Promise<{ deleted: number }>;
  /** Delete a column (and its cells). */
  readonly deleteColumn: (
    tableRef: string,
    columnRef: string,
  ) => Promise<{ deleted: string }>;
  /** Delete the active cloud table entirely. */
  readonly deleteTable: (tableRef: string) => Promise<{ deleted: string }>;
  /** Patch a column's config (name/type/condition/function). */
  readonly updateColumn: (
    tableRef: string,
    columnRef: string,
    patch: Record<string, unknown>,
  ) => Promise<{ column: string }>;
  /** Rename the active cloud table. */
  readonly renameTable: (
    tableRef: string,
    name: string,
  ) => Promise<{ renamed: string }>;
  /** Set or clear the table's dedup config (column NAME, or null to disable). */
  readonly setDedupe: (
    tableRef: string,
    column: string | null,
    keep: "oldest" | "newest",
  ) => Promise<{
    dedupe: { column: string; keep: string } | null;
    removedExistingDuplicates: number;
  }>;
  /** Search rows by an exact `where` match across columns (client-side). */
  readonly findRows: (
    tableRef: string,
    where: Record<string, unknown>,
    columns: string[] | undefined,
    limit: number | undefined,
  ) => Promise<{ matched: number; rows: Record<string, unknown>[] }>;
  /** Read one column's values (each with its row _id). */
  readonly getColumn: (
    tableRef: string,
    columnRef: string,
    limit: number | undefined,
  ) => Promise<{
    column: string;
    total: number;
    returned: number;
    values: { _id: string; value: unknown }[];
  }>;
  /** Describe how a column computes (fn/params/condition/code). */
  readonly describeColumn: (
    tableRef: string,
    columnRef: string,
  ) => Promise<Record<string, unknown>>;
  /** Move a column to a new display index. Returns the new column-id order. */
  readonly reorderColumn: (
    tableRef: string,
    columnRef: string,
    toIndex: number,
  ) => Promise<{ columnIds: string[] }>;
  /** Move a row to a new display index. Returns the new row-id order. */
  readonly reorderRow: (
    tableRef: string,
    rowId: string,
    toIndex: number,
  ) => Promise<{ rowIds: string[] }>;
}

/** The engine config + registry a cloud run dispatches functions against. */
export interface CloudSourceDeps {
  readonly registry: Registry;
  readonly config: EngineConfig;
  /** Build a worker client (injected for tests; defaults to the HTTP client). */
  readonly makeClient: (apiUrl: string, token: string) => CloudClientLike;
  /**
   * Resolve a table's workspace id (injected for tests). Defaults to the
   * metadata-only `/api/worker/getTableMeta` fast path.
   */
  readonly resolveWorkspaceId: (
    client: CloudClientLike,
    tableId: string,
  ) => Promise<string>;
}

/**
 * Build a registry with the user's JSON-manifest extensions loaded on top of the
 * built-in connectors — the SAME set the engine's `openProject` loads for a LOCAL
 * project (`registry.add(connectorFromManifest(parseManifest(m)))` per stored
 * manifest). The cloud agent MUST use this so `list_functions` / `run_column` see
 * the enrichment/social connectors (Trigify, Apollo, …) exactly as local does —
 * otherwise cloud only exposes the built-ins (ai/formatting/formula/github/http)
 * and the agent reports those connectors as "not available", diverging from local.
 *
 * `manifests` are raw manifests — objects (e.g. `globalDb.listExtensions()`) or
 * JSON strings; `parseManifest` accepts either. Decoupled from any Db so it is
 * unit-testable. Best-effort per manifest: a single malformed entry is skipped,
 * never failing the whole registry.
 */
export function registryWithExtensions(
  manifests: Iterable<unknown>,
  base: Registry = defaultRegistry(),
): Registry {
  for (const manifest of manifests) {
    try {
      base.add(connectorFromManifest(parseManifest(manifest)));
    } catch {
      /* skip a single malformed manifest — keep the rest */
    }
  }
  return base;
}

/** Default deps: an HTTP worker client + the metadata workspace resolver. */
export function defaultCloudSourceDeps(
  registry: Registry = defaultRegistry(),
  config: EngineConfig = {},
): CloudSourceDeps {
  return {
    registry,
    config,
    makeClient: (apiUrl, token) => makeWorkerClient(apiUrl, token),
    resolveWorkspaceId: async (client, tableId) =>
      readWorkspaceId(await client.query(GET_TABLE_META_REF, { tableId })),
  };
}

/**
 * Map the cloud `getTable` grid payload to the MCP `get_table` tool's response
 * shape (columns + per-row cell values keyed by column name), matching the local
 * source's output so the agent sees an identical schema in either mode.
 */
interface CloudColumnDoc {
  readonly _id: string;
  readonly name: string;
  readonly type?: string;
  readonly kind: string;
  readonly provider: string | null;
  readonly method: string | null;
  readonly code: string | null;
  readonly params?: unknown;
  readonly condition?: string | null;
}
interface CloudRowDoc {
  readonly _id: string;
}
interface CloudCellDoc {
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
}
interface CloudGrid {
  readonly columns: readonly CloudColumnDoc[];
  readonly rows: readonly CloudRowDoc[];
  readonly cells: readonly CloudCellDoc[];
}

function hasArray(o: Record<string, unknown>, key: string): boolean {
  return key in o && Array.isArray(o[key]);
}

function isCloudGrid(payload: unknown): payload is CloudGrid {
  if (typeof payload !== "object" || payload === null) return false;
  const o: Record<string, unknown> = { ...payload };
  return hasArray(o, "columns") && hasArray(o, "rows") && hasArray(o, "cells");
}

function columnFn(c: CloudColumnDoc): string | null {
  if (c.provider && c.method) return `${c.provider}.${c.method}`;
  return c.code ? "code" : null;
}

/** Exact cell equality for client-side `where` matching — trims strings, JSON-compares the rest (mirrors the local engine's `findRows`). */
function cellEq(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  if (typeof a === "string" || typeof b === "string") {
    return String(a ?? "").trim() === String(b ?? "").trim();
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Read the `dedupe`/`deleted` fields off the setDedupe worker payload. */
function readDedupeResult(payload: unknown): {
  column: string | null;
  keep: string;
  deleted: number;
} {
  const o =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const dedupe =
    typeof o.dedupe === "object" && o.dedupe !== null
      ? (o.dedupe as Record<string, unknown>)
      : null;
  return {
    column: dedupe && typeof dedupe.column === "string" ? dedupe.column : null,
    keep: dedupe && typeof dedupe.keep === "string" ? dedupe.keep : "oldest",
    deleted: typeof o.deleted === "number" ? o.deleted : 0,
  };
}

/** Narrow a reorder worker payload to its id-order array under `key`. */
function readIdOrder(payload: unknown, key: string): string[] {
  if (
    typeof payload === "object" &&
    payload !== null &&
    key in payload &&
    Array.isArray((payload as Record<string, unknown>)[key])
  ) {
    return ((payload as Record<string, unknown>)[key] as unknown[]).filter(
      (x): x is string => typeof x === "string",
    );
  }
  return [];
}

/** Narrow an unknown worker payload to a `{ id, name }` create result. */
function readCreated(payload: unknown): { id: string; name: string } {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "id" in payload &&
    typeof payload.id === "string" &&
    "name" in payload &&
    typeof payload.name === "string"
  ) {
    return { id: payload.id, name: payload.name };
  }
  throw new Error("worker create payload missing id/name");
}

/** Narrow an unknown `listTables` payload to the project-wide table list. */
function readTableList(
  payload: unknown,
): { id: string; name: string; columns: number; rows: number }[] {
  if (!Array.isArray(payload)) {
    throw new Error("listTables payload was not an array");
  }
  return payload.map((t) => {
    if (
      typeof t === "object" &&
      t !== null &&
      "id" in t &&
      typeof t.id === "string" &&
      "name" in t &&
      typeof t.name === "string" &&
      "columns" in t &&
      typeof t.columns === "number" &&
      "rows" in t &&
      typeof t.rows === "number"
    ) {
      return { id: t.id, name: t.name, columns: t.columns, rows: t.rows };
    }
    throw new Error("listTables entry missing id/name/columns/rows");
  });
}

/**
 * Build the CLOUD {@link CloudGridSource} for the active cloud project/table.
 * Reads come from the table's `getTable` grid; `run_column` resolves the column
 * by name/id in that grid, then runs it through a Db-free {@link Engine} over the
 * reused {@link cloudGridStoreShape} (exactly as `cloud-run.ts` constructs it).
 * `create_table`/`add_column`/`add_rows` + project-wide `list_tables` go through
 * the member-attributed worker routes (TRI-3299) so the agent's write tools
 * operate on Supabase in cloud mode, never silently on local SQLite.
 */
export function makeCloudSource(
  context: CloudContext,
  deps: CloudSourceDeps,
): CloudGridSource {
  const client = deps.makeClient(context.apiUrl, context.token);

  const fetchGrid = async (): Promise<CloudGrid> => {
    const payload = await client.query(CLOUD_REFS.getTable, {
      tableId: context.tableId,
    });
    if (!isCloudGrid(payload)) {
      throw new Error("getTable payload was not a grid");
    }
    return payload;
  };

  const resolveColumn = (
    grid: CloudGrid,
    columnRef: string,
  ): CloudColumnDoc | undefined =>
    grid.columns.find((c) => c._id === columnRef || c.name === columnRef);

  return {
    getTable: async () => {
      const grid = await fetchGrid();
      const byCell = new Map<string, CloudCellDoc>();
      for (const cell of grid.cells) {
        byCell.set(`${cell.rowId}:${cell.columnId}`, cell);
      }
      const rows = grid.rows.map((r) => {
        // Carry the row _id (matching the LOCAL get_table) so the agent can feed
        // it back into update_cells / delete_rows / reorder_rows.
        const obj: Record<string, unknown> = { _id: r._id };
        for (const c of grid.columns) {
          const cell = byCell.get(`${r._id}:${c._id}`);
          obj[c.name] = cell
            ? cell.status === "error"
              ? { error: cell.error }
              : cell.value
            : null;
        }
        return obj;
      });
      return {
        table: context.tableId,
        columns: grid.columns.map((c) => ({
          name: c.name,
          kind: c.kind,
          fn: columnFn(c),
        })),
        rows,
      };
    },

    listTables: async () => {
      // Project-wide list via the member-attributed worker route: ALL of the
      // cloud project's tables with their column + row counts, not just the
      // active one (TRI-3299).
      const payload = await client.query(LIST_TABLES_REF, {
        projectId: context.projectId,
      });
      return readTableList(payload);
    },

    createTable: async (name) => {
      const payload = await client.mutation(CREATE_TABLE_REF, {
        projectId: context.projectId,
        name,
      });
      return readCreated(payload);
    },

    addColumn: async (_tableRef, spec) => {
      // Resolve the function reference exactly as the LOCAL source does: a
      // `fn` must be 'provider.method' and exist in the registry; `code` (or a
      // resolved provider) makes it a function column, else manual.
      let provider: string | null = null;
      let method: string | null = null;
      let colParams: Record<string, unknown> = spec.params ?? {};
      if (spec.formula !== undefined && spec.formula !== "") {
        // A formula column is a function column backed by the built-in `formula`
        // connector — same mapping the local source applies.
        provider = "formula";
        method = "eval";
        colParams = { ...colParams, expression: spec.formula };
      } else if (spec.fn !== undefined && spec.fn !== "") {
        const [p, m] = spec.fn.split(".");
        if (!p || !m) throw new Error("fn must be 'provider.method'");
        if (!deps.registry.method(p, m)) {
          throw new Error(`Unknown function ${spec.fn}. Use list_functions.`);
        }
        provider = p;
        method = m;
      }
      const kind = provider !== null || spec.code ? "function" : "manual";
      const condition =
        spec.condition !== undefined && spec.condition.trim() !== ""
          ? spec.condition.trim()
          : null;
      const created = readCreated(
        await client.mutation(CREATE_COLUMN_REF, {
          tableId: context.tableId,
          name: spec.name,
          type: spec.type ?? "text",
          kind,
          provider,
          method,
          code: spec.code ?? null,
          params: colParams,
          condition,
        }),
      );
      return {
        id: created.id,
        name: created.name,
        kind,
        fn: spec.formula ? "formula.eval" : (spec.fn ?? null),
      };
    },

    addRows: async (_tableRef, rows) => {
      // The agent sends `{ ColumnName: value }`; resolve each name to its cloud
      // column id against the active table's grid before the worker write (the
      // worker route speaks column ids, mirroring grid.addRowsWithCells). An
      // unknown column name is a hard error — the same contract as local.
      const grid = await fetchGrid();
      const idByName = new Map<string, string>();
      for (const c of grid.columns) idByName.set(c.name, c._id);
      const mapped = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [colName, value] of Object.entries(row)) {
          const columnId = idByName.get(colName);
          if (columnId === undefined) {
            throw new Error(`No column "${colName}" in the cloud table.`);
          }
          out[columnId] = value;
        }
        return out;
      });
      const payload = await client.mutation(ADD_ROWS_REF, {
        tableId: context.tableId,
        rows: mapped,
      });
      const rowIds =
        typeof payload === "object" &&
        payload !== null &&
        "rowIds" in payload &&
        Array.isArray(payload.rowIds)
          ? payload.rowIds
          : [];
      return { added: rowIds.length };
    },

    runColumn: async (_tableRef, columnRef, opts) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
      // Scope to the next N rows in grid order when `limit` is set, mirroring the
      // local source: candidates are rows whose cell for this column isn't `done`
      // (or every row under `force`), in `grid.rows` order, then sliced by
      // offset/limit. So "run 10 rows" fills the first 10 unfilled cells in the
      // order the grid displays — not a random subset.
      const cellStatus = new Map<string, string>();
      for (const cell of grid.cells) {
        if (cell.columnId === col._id) cellStatus.set(cell.rowId, cell.status);
      }
      const candidates = opts.force
        ? grid.rows
        : grid.rows.filter((r) => (cellStatus.get(r._id) ?? "empty") !== "done");
      const scoped =
        opts.limit != null
          ? candidates.slice(opts.offset ?? 0, (opts.offset ?? 0) + opts.limit)
          : candidates;
      const workspaceId = await deps.resolveWorkspaceId(
        client,
        context.tableId,
      );
      const store = await buildCloudStore(client, context.tableId, workspaceId);
      const engine = new Engine(undefined, deps.config, deps.registry, undefined, {
        store,
        creds: store,
      });
      const res = await engine.runColumn(col._id, {
        force: opts.force,
        concurrency: opts.concurrency ?? 5,
        // Only pass an explicit scope when asked; otherwise run every row.
        rowIds: opts.limit != null ? scoped.map((r) => r._id) : undefined,
      });
      return { column: col.name, ...res };
    },

    runFunction: async (provider, method, input) => {
      // `dispatch` only needs the credential resolver, not a table (see
      // Engine.dispatch → creds.getCredential). Reuse the active table's id to
      // build the same workspace-scoped cloud store cloud `runColumn` uses; the
      // connector call then runs in-process here (the MCP sidecar), resolving the
      // workspace's shared credentials through the worker — no dedicated dispatch
      // route required.
      const workspaceId = await deps.resolveWorkspaceId(client, context.tableId);
      const store = await buildCloudStore(client, context.tableId, workspaceId);
      const engine = new Engine(undefined, deps.config, deps.registry, undefined, {
        store,
        creds: store,
      });
      return engine.dispatch(provider, method, input);
    },

    functionColumns: async () => {
      const grid = await fetchGrid();
      const statusByCol = new Map<string, Map<string, string>>();
      for (const cell of grid.cells) {
        let m = statusByCol.get(cell.columnId);
        if (m === undefined) statusByCol.set(cell.columnId, (m = new Map()));
        m.set(cell.rowId, cell.status);
      }
      return grid.columns
        .filter((c) => (c.provider && c.method) || c.code) // function columns only
        .map((c) => {
          const st = statusByCol.get(c._id);
          const pending = grid.rows.filter(
            (r) => (st?.get(r._id) ?? "empty") !== "done",
          ).length;
          return { name: c.name, pending };
        });
    },

    updateCells: async (_tableRef, updates) => {
      const grid = await fetchGrid();
      const idByCol = new Map<string, string>();
      for (const c of grid.columns) idByCol.set(c.name, c._id);
      const rowIds = new Set(grid.rows.map((r) => r._id));
      const cells = updates.map((u) => {
        if (!rowIds.has(u.row)) {
          throw new Error(`Row "${u.row}" is not in the cloud table.`);
        }
        const columnId = idByCol.get(u.column);
        if (columnId === undefined) {
          throw new Error(`No column "${u.column}" in the cloud table.`);
        }
        const clear = u.value === null || u.value === undefined || u.value === "";
        return {
          rowId: u.row,
          columnId,
          value: clear ? null : u.value,
          status: clear ? "empty" : "done",
        };
      });
      await client.mutation(CLOUD_REFS.setCells, { cells });
      return { updated: cells.length };
    },

    tableStats: async () => {
      const grid = await fetchGrid();
      return { rows: grid.rows.length, columns: grid.columns.length };
    },

    deleteRows: async (_tableRef, opts) => {
      const grid = await fetchGrid();
      const rowIds = new Set(grid.rows.map((r) => r._id));
      const targets = new Set<string>();
      for (const id of opts.ids ?? []) {
        if (!rowIds.has(id)) {
          throw new Error(`Row "${id}" is not in the cloud table.`);
        }
        targets.add(id);
      }
      if (opts.where && Object.keys(opts.where).length > 0) {
        const idByCol = new Map<string, string>();
        for (const c of grid.columns) idByCol.set(c.name, c._id);
        const match: { columnId: string; value: unknown }[] = [];
        for (const [name, value] of Object.entries(opts.where)) {
          const columnId = idByCol.get(name);
          if (columnId === undefined) {
            throw new Error(`No column "${name}" in the cloud table.`);
          }
          match.push({ columnId, value });
        }
        const cellAt = new Map<string, unknown>();
        for (const cell of grid.cells) {
          cellAt.set(`${cell.rowId}:${cell.columnId}`, cell.value);
        }
        for (const r of grid.rows) {
          if (
            match.every((m) => cellEq(cellAt.get(`${r._id}:${m.columnId}`), m.value))
          ) {
            targets.add(r._id);
          }
        }
      }
      if (opts.dryRun) return { deleted: targets.size };
      for (const id of targets) {
        await client.mutation(DELETE_ROW_REF, { rowId: id });
      }
      return { deleted: targets.size };
    },

    deleteColumn: async (_tableRef, columnRef) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
      await client.mutation(DELETE_COLUMN_REF, { columnId: col._id });
      return { deleted: col.name };
    },

    deleteTable: async () => {
      await client.mutation(DELETE_TABLE_REF, { tableId: context.tableId });
      return { deleted: context.tableId };
    },

    updateColumn: async (_tableRef, columnRef, patch) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
      const updated = readCreated(
        await client.mutation(UPDATE_COLUMN_REF, { columnId: col._id, patch }),
      );
      return { column: updated.name };
    },

    renameTable: async (_tableRef, name) => {
      const payload = await client.mutation(RENAME_TABLE_REF, {
        tableId: context.tableId,
        name,
      });
      const renamed =
        typeof payload === "object" &&
        payload !== null &&
        "name" in payload &&
        typeof payload.name === "string"
          ? payload.name
          : name;
      return { renamed };
    },

    setDedupe: async (_tableRef, column, keep) => {
      const grid = await fetchGrid();
      let columnId: string | null = null;
      if (column !== null && column !== "") {
        const col = resolveColumn(grid, column);
        if (!col) throw new Error(`No column "${column}" in the cloud table.`);
        columnId = col._id;
      }
      const payload = await client.mutation(SET_DEDUPE_REF, {
        tableId: context.tableId,
        column: columnId,
        keep,
      });
      const res = readDedupeResult(payload);
      // Map the stored column ID back to its NAME for the agent's view.
      const nameById = new Map(grid.columns.map((c) => [c._id, c.name]));
      return {
        dedupe:
          res.column === null
            ? null
            : { column: nameById.get(res.column) ?? res.column, keep: res.keep },
        removedExistingDuplicates: res.deleted,
      };
    },

    findRows: async (_tableRef, where, columns, limit) => {
      const grid = await fetchGrid();
      const idByCol = new Map<string, string>();
      for (const c of grid.columns) idByCol.set(c.name, c._id);
      const match: { columnId: string; value: unknown }[] = [];
      for (const [name, value] of Object.entries(where ?? {})) {
        const columnId = idByCol.get(name);
        if (columnId === undefined) {
          throw new Error(`No column "${name}" in the cloud table.`);
        }
        match.push({ columnId, value });
      }
      const wantCols = (columns ?? grid.columns.map((c) => c.name))
        .map((n) => grid.columns.find((c) => c.name === n))
        .filter((c): c is CloudColumnDoc => !!c);
      const cellAt = new Map<string, unknown>();
      for (const cell of grid.cells) {
        cellAt.set(`${cell.rowId}:${cell.columnId}`, cell.value);
      }
      const cap = Math.min(limit ?? 100, 1000);
      const out: Record<string, unknown>[] = [];
      for (const r of grid.rows) {
        if (
          !match.every((m) => cellEq(cellAt.get(`${r._id}:${m.columnId}`), m.value))
        ) {
          continue;
        }
        const obj: Record<string, unknown> = { _id: r._id };
        for (const c of wantCols) {
          obj[c.name] = cellAt.get(`${r._id}:${c._id}`) ?? null;
        }
        out.push(obj);
        if (out.length >= cap) break;
      }
      return { matched: out.length, rows: out };
    },

    getColumn: async (_tableRef, columnRef, limit) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
      const valueAt = new Map<string, unknown>();
      for (const cell of grid.cells) {
        if (cell.columnId === col._id) valueAt.set(cell.rowId, cell.value);
      }
      const cap = Math.min(limit ?? 1000, 5000);
      const values = grid.rows.slice(0, cap).map((r) => ({
        _id: r._id,
        value: valueAt.get(r._id) ?? null,
      }));
      return {
        column: col.name,
        total: grid.rows.length,
        returned: values.length,
        values,
      };
    },

    describeColumn: async (_tableRef, columnRef) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
      return {
        name: col.name,
        kind: col.kind,
        type: col.type ?? null,
        fn: columnFn(col),
        provider: col.provider,
        method: col.method,
        params: col.params ?? {},
        condition: col.condition ?? null,
        code: col.code ?? null,
      };
    },

    reorderColumn: async (_tableRef, columnRef, toIndex) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
      const payload = await client.mutation(REORDER_COLUMN_REF, {
        columnId: col._id,
        toIndex,
      });
      return { columnIds: readIdOrder(payload, "columnIds") };
    },

    reorderRow: async (_tableRef, rowId, toIndex) => {
      const grid = await fetchGrid();
      if (!grid.rows.some((r) => r._id === rowId)) {
        throw new Error(`Row "${rowId}" is not in the cloud table.`);
      }
      const payload = await client.mutation(REORDER_ROW_REF, { rowId, toIndex });
      return { rowIds: readIdOrder(payload, "rowIds") };
    },
  };
}
