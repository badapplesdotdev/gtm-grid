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
  defaultRegistry,
  fetchWithRetry,
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

/** Resolve the shared worker bearer secret, failing closed when unset. */
function workerSecret(): string {
  const secret = process.env.WEBHOOK_WORKER_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("WEBHOOK_WORKER_SECRET is not configured");
  }
  return secret;
}

/**
 * Build the HTTP {@link CloudClientLike} the cloud store injects: each ref is an
 * `/api/worker/*` route path, and query/mutation/action POST the JSON args to
 * `${apiUrl}<route>` with the shared worker bearer (the spawned MCP runs on the
 * trusted localhost boundary, same as the sidecar). The member `token` is
 * forwarded so the worker attributes the run to the signed-in member. Mirrors
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
        Authorization: `Bearer ${workerSecret()}`,
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
 * only here. `get_table` and `run_column` are the read/run surface the cloud
 * worker boundary supports; the create/list-all/add-rows mutators are declared
 * so the local source serves them unchanged while the cloud source rejects them
 * with {@link CloudToolUnsupportedError}.
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
  /** List the project's tables — only the active cloud table is reachable. */
  readonly listTables: () => Promise<
    { id: string; name: string; columns: number; rows: number }[]
  >;
  /** Run a function column on the active cloud table by column name/id. */
  readonly runColumn: (
    tableRef: string,
    columnRef: string,
    opts: { force?: boolean; concurrency?: number },
  ) => Promise<{ column: string; ran: number; errors: number }>;
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
  readonly kind: string;
  readonly provider: string | null;
  readonly method: string | null;
  readonly code: string | null;
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

/**
 * Build the CLOUD {@link CloudGridSource} for the active cloud table. Reads come
 * from the table's `getTable` grid; `run_column` resolves the column by name/id
 * in that grid, then runs it through a Db-free {@link Engine} over the reused
 * {@link cloudGridStoreShape} (exactly as `cloud-run.ts` constructs it). The
 * create/list-all/add-rows tools reject with {@link CloudToolUnsupportedError}.
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
        const obj: Record<string, unknown> = {};
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
      // The worker boundary is table-scoped; only the active cloud table is
      // reachable. Report it (with live column/row counts) so the agent can
      // still orient on the table the user is viewing.
      const grid = await fetchGrid();
      return [
        {
          id: context.tableId,
          name: context.tableId,
          columns: grid.columns.length,
          rows: grid.rows.length,
        },
      ];
    },

    runColumn: async (_tableRef, columnRef, opts) => {
      const grid = await fetchGrid();
      const col = resolveColumn(grid, columnRef);
      if (!col) throw new Error(`No column "${columnRef}" in the cloud table.`);
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
      });
      return { column: col.name, ...res };
    },
  };
}
