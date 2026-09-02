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
 * `action` all POST the args as JSON to the matching route. The sidecar
 * authenticates to the worker endpoints as the SIGNED-IN MEMBER via the
 * `X-Gtmgrid-Member` session token (the dual-auth `runWorkerSecretOrMember`
 * boundary's member path) — never the server-only `WEBHOOK_WORKER_SECRET`, which
 * a packaged desktop build does not have. The secret remains the boundary for the
 * headless Inngest webhook worker only.
 */

import { Data, Effect } from "effect";
import {
  CloudSchemaMapping,
  ColumnNotFoundError,
  Engine,
  cloudGridStoreShape,
  cloudTableGateway,
  defaultRegistry,
  fetchWithRetry,
  Registry,
  type CloudClientLike,
  type CloudFunctionRefs,
  type EngineConfig,
  type GridStoreShape,
  type TableGateway,
  type TableGatewayRefs,
} from "@gtmgrid/engine";

/**
 * The apps/web worker endpoints the cloud store/engine address, as opaque refs.
 * Each is a `/api/worker/*` route path the injected {@link CloudClientLike} POSTs
 * to. `getCredential` decrypts a workspace's shared connector secret for the run
 * (#18).
 */
const CLOUD_REFS: CloudFunctionRefs = {
  getTable: "/api/worker/getTable",
  // Scoped + keyset reads so a column run never loads a whole 50k-row grid: a
  // row-scoped run fetches only its rows, a full run streams pages.
  getTableForRows: "/api/worker/getTableForRows",
  getTablePage: "/api/worker/getTablePage",
  setCell: "/api/worker/setCell",
  setCellStatus: "/api/worker/setCellStatus",
  // Batched cell writes: the cloud store buffers terminal writes and flushes
  // them in chunks through this route (bounded in-flight + backpressure) so a
  // large column run is not one HTTP POST per cell.
  setCells: "/api/worker/setCells",
  getCredential: "/api/worker/getCredential",
};

/**
 * The cross-table worker routes the {@link cloudTableGateway} drives — the
 * table.push / table.lookup surface (sibling list, schema, rows, atomic upsert,
 * column create). Every route revalidates same-project scoping server-side
 * against the `sourceTableId` the gateway bakes into each request.
 */
const TABLE_GATEWAY_REFS: TableGatewayRefs = {
  listProjectTables: "/api/worker/listProjectTables",
  getTableSchema: "/api/worker/getTableSchema",
  getTableRows: "/api/worker/getTableRows",
  upsertRowInTable: "/api/worker/upsertRowInTable",
  createColumnInTable: "/api/worker/createColumnInTable",
  pushRowIntoTable: "/api/worker/pushRowIntoTable",
};

/**
 * Build the {@link TableGateway} for one run — the cross-table surface the
 * `table` connector reaches through `ctx.grid`. Scoped to the run's SOURCE
 * table (self-push guard + server-side same-project checks key off it).
 */
export function buildTableGateway(
  client: CloudClientLike,
  sourceTableId: string,
): TableGateway {
  return cloudTableGateway({ client, refs: TABLE_GATEWAY_REFS, sourceTableId });
}

/**
 * Wrap a {@link TableGateway} so its WRITE operations refuse — the preview
 * lane's gateway. A previewed table.lookup reads normally; a previewed
 * table.push fails with an actionable message instead of silently writing rows
 * into (and metering against) the target table.
 */
export function readOnlyGateway(gateway: TableGateway): TableGateway {
  const refuse = (op: string): never => {
    throw new Error(
      `table.${op} is not available in a preview — save the column and run it to push rows.`,
    );
  };
  return {
    ...gateway,
    sourceTableId: gateway.sourceTableId,
    listTables: () => gateway.listTables(),
    getSchema: (ref) => gateway.getSchema(ref),
    readRows: (tableId) => gateway.readRows(tableId),
    upsertRow: async () => refuse("push"),
    pushRow: async () => refuse("push"),
    createColumn: async () => refuse("push"),
  };
}

/**
 * The metadata-only worker ref `resolveWorkspaceId` reads the table's workspace
 * id from. Distinct from {@link CLOUD_REFS}.getTable (the full per-run grid
 * snapshot the cloud store needs): this fast path ships only `{ table.id,
 * table.workspaceId }`, never the columns/rows/cells. (TRI-3273.)
 */
const GET_TABLE_META_REF = "/api/worker/getTableMeta";

/**
 * The worker ref the pre-flight quota gate POSTs to (TRI-3277). The server
 * computes how many cells the run would meter (candidate rows minus already-done
 * skips unless force) and rejects with a 402 when the workspace lacks the
 * remaining cloud actions, BEFORE the run fans out.
 */
const ASSERT_COLUMN_RUN_QUOTA_REF = "/api/worker/assertColumnRunQuota";

/**
 * The default row fan-out concurrency when a request omits one — matches the
 * server route's historical `?? 5`.
 */
export const DEFAULT_CLOUD_RUN_CONCURRENCY = 5;

/**
 * Process-wide safe ceiling for a single cloud run's row fan-out (M6).
 * `CloudRunRequest.concurrency` is caller-controlled (the desktop forwards it)
 * and was previously unclamped, so a too-large value multiplied worker POSTs and
 * sandboxed executions without bound. We clamp it to this max so even a hostile
 * or buggy caller cannot blow past a safe per-run ceiling; the sidecar's
 * process-wide run semaphore bounds the number of simultaneous runs on top of
 * this per-run cap.
 */
export const MAX_CLOUD_RUN_CONCURRENCY = 10;

/**
 * Clamp a requested row-fan-out concurrency into `[1, MAX_CLOUD_RUN_CONCURRENCY]`,
 * defaulting an absent/invalid value to {@link DEFAULT_CLOUD_RUN_CONCURRENCY}.
 * A non-finite or sub-1 value falls back to the default rather than 0 (which
 * would stall the run); anything above the ceiling is capped.
 */
export function clampConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return DEFAULT_CLOUD_RUN_CONCURRENCY;
  }
  return Math.min(Math.floor(requested), MAX_CLOUD_RUN_CONCURRENCY);
}

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
  /**
   * Bounded concurrency for the row fan-out (defaults to
   * {@link DEFAULT_CLOUD_RUN_CONCURRENCY}). Clamped to
   * `[1, MAX_CLOUD_RUN_CONCURRENCY]` before use (M6): caller-controlled, so an
   * out-of-range value can never blow past the safe per-run ceiling.
   */
  readonly concurrency?: number;
}

/** The dependencies a cloud run is built from (injected for testing). */
export interface CloudRunDeps {
  /**
   * Build a cloud-store client for an apps/web base URL + the member token. The
   * default returns an HTTP client POSTing to `${apiUrl}/api/worker/*`
   * authenticated as the signed-in member (`X-Gtmgrid-Member`); tests inject a
   * fake.
   */
  readonly makeClient: (apiUrl: string, token: string) => CloudClientLike;
  /** The connector/AI registry the engine runs functions against. */
  readonly registry: Registry;
  /** AI config (keys/models) for AI columns — resolved by the caller. */
  readonly config: EngineConfig;
}

/**
 * Build the HTTP {@link CloudClientLike} the cloud store injects: every ref is an
 * `/api/worker/*` route path, and query/mutation/action POST the args as JSON to
 * `${apiUrl}<route>`. A non-2xx response throws so the engine maps it to a typed
 * `GridStoreError`.
 *
 * AUTH: the run authenticates as the SIGNED-IN MEMBER via the `X-Gtmgrid-Member`
 * session token — NOT the shared `WEBHOOK_WORKER_SECRET`. The worker secret is a
 * server-only secret the desktop never has (and must not ship), so the dual-auth
 * worker routes (`runWorkerSecretOrMember`) take their member path and enforce
 * workspace membership server-side. This is why a packaged prod build can run
 * cloud columns at all — it has no secret to present.
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
        "X-Gtmgrid-Member": token,
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // The apps/web worker boundary maps CloudActionsLimitError → 402 and
      // PlanRequiredError (lapsed trial / Free plan) → 403. Tag the thrown error
      // so callers/engine recognise each fatal stop and surface the right prompt
      // (out-of-credits vs upgrade-required).
      const tag =
        res.status === 402
          ? "CloudActionsLimitError: "
          : res.status === 403
            ? "PlanRequiredError: "
            : "";
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
 * Raised when a cloud column run's pre-flight quota gate rejects the run because
 * the workspace lacks the remaining cloud actions for the cells it would run
 * (TRI-3277). Surfaces the worker's 402 as a typed error so a caller can map it
 * back to a 402 for the desktop instead of treating it as a generic 5xx.
 */
export class CloudActionsLimitError extends Data.TaggedError(
  "CloudActionsLimitError",
)<{ readonly message: string }> {}

/**
 * Raised when a cloud column run is rejected because the workspace has no active
 * cloud plan — its trial has lapsed (by date or sync) or it is on Free. Surfaces
 * the worker's 403 as a typed error so the desktop shows an UPGRADE prompt rather
 * than a generic failure (distinct from {@link CloudActionsLimitError}, which is
 * "out of cloud actions"). Both abort the run; this one means "add a plan".
 */
export class PlanRequiredError extends Data.TaggedError(
  "PlanRequiredError",
)<{ readonly message: string }> {}

/**
 * Pre-flight quota gate (TRI-3277). POSTs the run shape to the server's
 * `/api/worker/assertColumnRunQuota` route, which computes how many cells the run
 * would meter (candidate rows minus already-`done` skips unless `force`) and
 * rejects over-quota runs with a 402. The HTTP worker client throws on any
 * non-2xx; a 402 is re-raised as a typed {@link CloudActionsLimitError} so the
 * over-quota case is distinguishable from a transport failure. A run within
 * quota resolves and the caller proceeds to fan out unchanged.
 */
export async function assertColumnRunQuota(
  client: CloudClientLike,
  req: Pick<CloudRunRequest, "tableId" | "columnId" | "rowIds" | "force">,
): Promise<void> {
  try {
    await client.query(ASSERT_COLUMN_RUN_QUOTA_REF, {
      tableId: req.tableId,
      columnId: req.columnId,
      ...(req.rowIds !== undefined ? { rowIds: req.rowIds } : {}),
      ...(req.force !== undefined ? { force: req.force } : {}),
    });
  } catch (e) {
    if (e instanceof CloudActionsLimitError || e instanceof PlanRequiredError) {
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    // The worker boundary returns 402 for CloudActionsLimitError (out of cloud
    // actions) and 403 for PlanRequiredError (lapsed trial / Free plan); the HTTP
    // client folds the status + tag into the thrown message. Re-raise each as its
    // typed error so the run aborts and the desktop shows the right prompt.
    if (message.includes("402") || message.includes("CloudActionsLimitError")) {
      throw new CloudActionsLimitError({ message });
    }
    if (message.includes("403") || message.includes("PlanRequiredError")) {
      throw new PlanRequiredError({ message });
    }
    throw e;
  }
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
 *
 * Before any fan-out, a pre-flight quota gate ({@link assertColumnRunQuota})
 * rejects an over-quota run with a 402 so a thousands-row run on a near-empty
 * plan no longer executes and over-meters silently (TRI-3277). The check runs
 * before {@link buildCloudStore} so a rejected run never ships the full grid.
 */
export async function runCloudColumn(
  req: CloudRunRequest,
  deps: CloudRunDeps,
): Promise<{ ran: number; errors: number }> {
  const client = deps.makeClient(req.apiUrl, req.token);
  await assertColumnRunQuota(client, req);
  const workspaceId = await resolveWorkspaceId(client, req.tableId);
  const store = await buildCloudStore(client, req.tableId, workspaceId);
  // Cross-table access for table.push / table.lookup, scoped to this run's
  // source table (the worker routes enforce same-project server-side).
  const grid = buildTableGateway(client, req.tableId);
  const engine = new Engine({ ...deps.config, grid }, deps.registry, {
    store,
    creds: store,
  });
  try {
    return await engine.runColumn(req.columnId, {
      force: req.force,
      rowIds: req.rowIds,
      // Clamp the caller-controlled fan-out to a safe ceiling (M6) so a too-large
      // `req.concurrency` cannot multiply worker POSTs / sandboxed executions.
      concurrency: clampConcurrency(req.concurrency),
    });
  } catch (e) {
    // A column deleted mid-run is normal, not a systemic bug: resolve it as a
    // no-op so it never surfaces as a reported exception (see ColumnNotFoundError).
    if (e instanceof ColumnNotFoundError) return { ran: 0, errors: 0 };
    throw e;
  }
}

/** Inputs the desktop forwards to preview a not-yet-saved function column. */
export interface CloudPreviewRequest {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token (localhost trust boundary). */
  readonly token: string;
  /** The `tables.id` to preview against. */
  readonly tableId: string;
  /** The connector/AI provider the previewed method belongs to. */
  readonly provider: string;
  /** The method to dry-run. */
  readonly method: string;
  /** The (unsaved) column params, with {{Column}} templates resolved per row. */
  readonly params: Record<string, unknown>;
  /** How many rows to preview (defaults to the engine's own default). */
  readonly limit?: number;
}

/** Inputs for resolving a live option list (a picker) on a CLOUD table. */
export interface CloudOptionsRequest {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token (localhost trust boundary). */
  readonly token: string;
  /** The `tables.id` the column editor is open on — resolves the workspace. */
  readonly tableId: string;
  /** The connector the option SOURCE method belongs to. */
  readonly provider: string;
  /** The source method that lists the options (e.g. `listChannels`). */
  readonly method: string;
  readonly args: Record<string, unknown>;
}

/**
 * Dispatch an option-source method against a CLOUD project's credentials.
 *
 * WHY THIS EXISTS: `/api/options` used to dispatch through the sidecar's LOCAL
 * engine, whose creds port reads the local SQLite store. A cloud workspace's
 * connector credential lives in Postgres, so every picker on a cloud project
 * resolved no credential and reported the connector "not connected" — while the
 * Tools panel, reading the cloud state, said Connected. Slack made it obvious
 * because it is OAuth-only: there is no local key to paste as a workaround, so
 * the channel picker was permanently empty on a connection that worked fine.
 *
 * Mirrors {@link previewCloudColumn}: a worker-backed client, the cloud store as
 * the creds port, and NOTHING persisted or metered — an option list is a read.
 * No grid gateway is wired in: an option source lists remote records (channels,
 * campaigns), never the user's own tables, so handing it a cross-table surface
 * would widen what a picker can reach for no gain.
 */
export async function dispatchCloudOptions(
  req: CloudOptionsRequest,
  deps: CloudRunDeps,
): Promise<unknown> {
  const client = deps.makeClient(req.apiUrl, req.token);
  const workspaceId = await resolveWorkspaceId(client, req.tableId);
  const store = await buildCloudStore(client, req.tableId, workspaceId);
  const engine = new Engine(deps.config, deps.registry, { store, creds: store });
  return engine.dispatch(req.provider, req.method, req.args);
}

/**
 * Dry-run a not-yet-saved function column on a CLOUD table (the "Try on N rows"
 * preview). Mirrors {@link runCloudColumn} — a worker-backed client, the
 * cloud-backed GridStore + an Engine over it — but persists/meters NOTHING, so
 * there is NO quota gate: `Engine.previewColumn` only reads the first `limit`
 * rows and returns per-row results without writing a column or any cell.
 */
export async function previewCloudColumn(
  req: CloudPreviewRequest,
  deps: CloudRunDeps,
): Promise<Array<{ rowId: string; value?: unknown; error?: string }>> {
  const client = deps.makeClient(req.apiUrl, req.token);
  const workspaceId = await resolveWorkspaceId(client, req.tableId);
  const store = await buildCloudStore(client, req.tableId, workspaceId);
  // Previews get a READ-ONLY cross-table surface: a table.lookup previews
  // faithfully, while a table.push preview is refused with a clear message —
  // "Try on N rows" must never write rows into (or meter against) the target.
  const grid = readOnlyGateway(buildTableGateway(client, req.tableId));
  const engine = new Engine({ ...deps.config, grid }, deps.registry, { store, creds: store });
  return engine.previewColumn(
    { provider: req.provider, method: req.method, params: req.params, table_id: req.tableId },
    req.limit ?? 5,
  );
}
