/**
 * Cloud run path (T9) — running a column on a CLOUD project from the sidecar.
 *
 * A LOCAL project runs through `current.engine` over SQLite, unchanged. A CLOUD
 * project's data lives in Postgres behind the apps/web API, so this module builds
 * an {@link Engine} whose GridStore is the cloud-backed {@link cloudGridStoreShape}
 * (T5): it reads the table's columns/rows/cells and writes cell status/results
 * back through the apps/web `/api/worker/*` endpoints. Status (`running` →
 * `done`/`error`) therefore streams live to every workspace member through the W3
 * Supabase realtime broadcast the server emits on each write — the same
 * `Engine.runColumn` code, only the store changes.
 *
 * DECOUPLING: the engine package never imports a backend client. The cloud store
 * is fed an injected {@link CloudClientLike} whose "function refs" are just the
 * `/api/worker/*` route paths (see {@link CLOUD_REFS}); `query`/`mutation`/
 * `action` all POST the args as JSON to the matching route. The sidecar runs on
 * trusted localhost and authenticates to the worker endpoints with the shared
 * `WEBHOOK_WORKER_SECRET` bearer (the same `isAuthorizedWorker` boundary the
 * Inngest webhook worker uses).
 */

import { Effect } from "effect";
import {
  CloudSchemaMapping,
  Engine,
  cloudGridStoreShape,
  defaultRegistry,
  fetchWithRetry,
  Registry,
  type CloudClientLike,
  type CloudFunctionRefs,
  type EngineConfig,
  type GridStoreShape,
} from "@gtmgrid/engine";

/**
 * The apps/web worker endpoints the cloud store/engine address, as opaque refs.
 * Each is a `/api/worker/*` route path the injected {@link CloudClientLike} POSTs
 * to. `getCredential` decrypts a workspace's shared connector secret for the run
 * (#18).
 */
const CLOUD_REFS: CloudFunctionRefs = {
  getTable: "/api/worker/getTable",
  setCell: "/api/worker/setCell",
  setCellStatus: "/api/worker/setCellStatus",
  // Batched cell writes: the cloud store buffers terminal writes and flushes
  // them in chunks through this route (bounded in-flight + backpressure) so a
  // large column run is not one HTTP POST per cell.
  setCells: "/api/worker/setCells",
  getCredential: "/api/worker/getCredential",
};

/**
 * The metadata-only worker ref `resolveWorkspaceId` reads the table's workspace
 * id from. Distinct from {@link CLOUD_REFS}.getTable (the full per-run grid
 * snapshot the cloud store needs): this fast path ships only `{ table.id,
 * table.workspaceId }`, never the columns/rows/cells. (TRI-3273.)
 */
const GET_TABLE_META_REF = "/api/worker/getTableMeta";

/** Inputs the desktop forwards to run a column on a cloud project. */
export interface CloudRunRequest {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token (localhost trust boundary). */
  readonly token: string;
  /** The `tables.id` the column belongs to. */
  readonly tableId: string;
  /** The `columns.id` to run. */
  readonly columnId: string;
  /** Re-run cells already marked `done`. */
  readonly force?: boolean;
  /** Restrict the run to these `rows.id`s (defaults to all rows). */
  readonly rowIds?: string[];
  /** Bounded concurrency for the row fan-out (defaults to 5). */
  readonly concurrency?: number;
}

/** The dependencies a cloud run is built from (injected for testing). */
export interface CloudRunDeps {
  /**
   * Build a cloud-store client for an apps/web base URL + the member token. The
   * default returns an HTTP client POSTing to `${apiUrl}/api/worker/*` with the
   * shared worker secret; tests inject a fake.
   */
  readonly makeClient: (apiUrl: string, token: string) => CloudClientLike;
  /** The connector/AI registry the engine runs functions against. */
  readonly registry: Registry;
  /** AI config (keys/models) for AI columns — resolved by the caller. */
  readonly config: EngineConfig;
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
 * Build the HTTP {@link CloudClientLike} the cloud store injects: every ref is an
 * `/api/worker/*` route path, and query/mutation/action POST the args as JSON to
 * `${apiUrl}<route>` with the worker bearer. A non-2xx response throws so the
 * engine maps it to a typed `GridStoreError`. The member `token` is forwarded so
 * the worker routes can attribute the run to the signed-in member.
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
    // Retry transient worker failures (429/503/5xx) with exponential backoff +
    // jitter, honour Retry-After, and abort a hung worker via a per-attempt
    // timeout so it cannot pin this run forever. A 402 (CloudActionsLimitError —
    // see the worker boundary's `workerErrorStatus`) is FATAL: the helper does
    // not retry it, and we surface it with its tag so the run stops rather than
    // hammering an exhausted quota. Other 4xx are likewise fatal (no retry).
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
      // The apps/web worker boundary maps CloudActionsLimitError → HTTP 402.
      // Tag the thrown error so callers/engine can recognise the fatal stop.
      const tag = res.status === 402 ? "CloudActionsLimitError: " : "";
      throw new Error(
        `${tag}Worker route ${ref} failed: ${res.status} ${res.statusText} ${text}`.trim(),
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

/** Default deps: an HTTP worker client + the registry. */
export function defaultCloudRunDeps(
  registry: Registry = defaultRegistry(),
  config: EngineConfig = {},
): CloudRunDeps {
  return {
    makeClient: (apiUrl, token) => makeWorkerClient(apiUrl, token),
    registry,
    config,
  };
}

/** Narrow an unknown worker payload to its `table.workspaceId` string. */
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
 * Resolve the workspace id a table belongs to. A cloud run resolves the
 * workspace's SHARED connector credentials, so the run must know which workspace
 * to decrypt them for; that binding lives on the table doc.
 *
 * Reads the workspace id through the metadata-only `/api/worker/getTableMeta`
 * fast path ({@link GET_TABLE_META_REF}) — NOT the full-grid `getTable` — so a
 * run start no longer ships the table's columns/rows/cells just to learn one
 * UUID. (TRI-3273.)
 */
export async function resolveWorkspaceId(
  client: CloudClientLike,
  tableId: string,
): Promise<string> {
  const payload = await client.query(GET_TABLE_META_REF, { tableId });
  return readWorkspaceId(payload);
}

/**
 * Build the cloud-backed {@link GridStoreShape} for one cloud table. The store
 * needs {@link CloudSchemaMapping}; we provide its `.Default` Layer and resolve
 * the shape eagerly so the rest of the run is plain `Engine` code. When a
 * `workspaceId` is given, the store resolves the workspace's SHARED (scope
 * `workspace`) connector credentials through the decrypt-for-run route (#18).
 */
export async function buildCloudStore(
  client: CloudClientLike,
  tableId: string,
  workspaceId?: string,
): Promise<GridStoreShape> {
  return Effect.runPromise(
    cloudGridStoreShape({
      client,
      refs: CLOUD_REFS,
      tableId,
      credentials:
        workspaceId === undefined
          ? undefined
          : { workspaceId, scope: "workspace" },
    }).pipe(Effect.provide(CloudSchemaMapping.Default)),
  );
}

/**
 * Run a column on a cloud project. Builds a worker-backed client, resolves the
 * table's workspace, then a cloud-backed GridStore for the table, and an
 * {@link Engine} that uses that store for BOTH project data and credentials.
 * Workspace-shared connector credentials resolve through the same store: it calls
 * the `/api/worker/getCredential` route to decrypt the workspace's shared secret
 * for each connector the run dispatches (#18). A connector with no stored
 * credential resolves to none, matching a project with no connected keys. Returns
 * the engine's `{ ran, errors }` summary.
 *
 * The cloud path is fully Db-free: the engine is built with NO `Db` and the
 * injected cloud store backs BOTH project data and credentials, so no SQLite
 * file is opened (and the native better-sqlite3 addon is never loaded). The run
 * path reads/writes only the injected cloud store.
 */
export async function runCloudColumn(
  req: CloudRunRequest,
  deps: CloudRunDeps,
): Promise<{ ran: number; errors: number }> {
  const client = deps.makeClient(req.apiUrl, req.token);
  const workspaceId = await resolveWorkspaceId(client, req.tableId);
  const store = await buildCloudStore(client, req.tableId, workspaceId);
  const engine = new Engine(undefined, deps.config, deps.registry, undefined, {
    store,
    creds: store,
  });
  return engine.runColumn(req.columnId, {
    force: req.force,
    rowIds: req.rowIds,
    concurrency: req.concurrency,
  });
}
