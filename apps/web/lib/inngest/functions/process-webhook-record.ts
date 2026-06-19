import {
  CloudSchemaMapping,
  Engine,
  aiConfigFromEnv,
  cloudGridStoreShape,
  connectorFromManifest,
  defaultRegistry,
  parseManifest,
  type Column,
  type EngineConfig,
  type GridStoreShape,
  type Registry,
  type RunErrorContext,
} from "@gtmgrid/engine";
import { buildColumnDeps, topoSortColumnIds } from "@gtmgrid/services/columns";
import { Effect } from "effect";
import { inngest } from "../client";
import { onFailure } from "../on-failure";
import { captureServer, captureServerException } from "../../posthog-server";
import { workerClient, WORKER_REFS } from "../worker-client";

/**
 * The durable worker that turns one received webhook record into a row and (when
 * the webhook auto-runs) recomputes that row's function columns through the
 * engine — the SAME `Engine.runColumn` cloud path the desktop sidecar uses
 * (`packages/server/src/cloud-run.ts:159-176`), only the cloud-store client
 * points at the secret-gated `/api/worker/*` endpoints instead of authed
 * function calls.
 *
 * Durability / exactly-once:
 *  - The triggering event carries `id: recordId` (a content hash), so Inngest
 *    de-dupes far-apart duplicate posts of the same payload before this runs.
 *  - Every `step.run` key is UNIQUE PER RECORD, and the enrichment uses a key
 *    UNIQUE PER COLUMN (`enrich:${recordId}:${columnId}`), so within-run retries
 *    are memoized — the row is inserted once and each function column is re-run
 *    at most once per record even across retries. A failure on column K no longer
 *    re-runs (and re-charges) the already-completed columns 0..K-1.
 *  - When `autoRun` is false the enrich step is SKIPPED entirely (the row is
 *    still inserted).
 */

/** The `webhook/record.received` event payload the receiver enqueues. */
export interface WebhookRecordData {
  readonly tableId: string;
  readonly workspaceId: string;
  /** The mapped `{ columnId: value }` cells for this record. */
  readonly mappedCells: Record<string, unknown>;
  /** When true, recompute the table's function columns over the new row. */
  readonly autoRun: boolean;
  /** "create" inserts a fresh row; "upsert" updates a row matched on upsertKey. */
  readonly mode: "create" | "upsert";
  /** The columnId to match an existing row on, when `mode === "upsert"`. */
  readonly upsertKey: string | null;
  /** The idempotent content hash for this record (also the Inngest event id). */
  readonly recordId: string;
}

/**
 * Narrow the Inngest event payload (typed loosely as `Jsonify<…>`) to a
 * {@link WebhookRecordData} without an `as` cast, validating the fields the
 * handler depends on. Throws (and lets Inngest retry) on a malformed payload.
 */
export function parseWebhookRecordData(
  raw: unknown,
): WebhookRecordData & { readonly webhookId?: string } {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("webhook record event.data is not an object");
  }
  const d: Record<string, unknown> = { ...raw };
  const str = (k: string): string => {
    const v = d[k];
    if (typeof v !== "string") {
      throw new Error(`webhook record event.data.${k} must be a string`);
    }
    return v;
  };
  const mappedCells = d.mappedCells;
  if (typeof mappedCells !== "object" || mappedCells === null) {
    throw new Error("webhook record event.data.mappedCells must be an object");
  }
  const mode = d.mode;
  if (mode !== "create" && mode !== "upsert") {
    throw new Error("webhook record event.data.mode must be create|upsert");
  }
  const upsertKey = d.upsertKey;
  if (upsertKey !== null && typeof upsertKey !== "string") {
    throw new Error("webhook record event.data.upsertKey must be string|null");
  }
  const webhookId = d.webhookId;
  if (webhookId !== undefined && typeof webhookId !== "string") {
    throw new Error("webhook record event.data.webhookId must be a string");
  }
  return {
    tableId: str("tableId"),
    workspaceId: str("workspaceId"),
    mappedCells: { ...mappedCells },
    autoRun: d.autoRun === true,
    mode,
    upsertKey,
    recordId: str("recordId"),
    ...(webhookId === undefined ? {} : { webhookId }),
  };
}

/**
 * Build the engine config for the worker. `guardSsrf: true` is ALWAYS set here:
 * this engine runs connector HTTP on SHARED Vercel infrastructure with a
 * workspace member's custom manifest `baseUrl`, so the SSRF guard must block any
 * URL that targets a private/reserved/metadata address. (The desktop sidecar runs
 * on the user's own machine and intentionally leaves this off.)
 */
function engineConfig(): EngineConfig {
  const ai = aiConfigFromEnv();
  return ai === undefined
    ? { guardSsrf: true }
    : { ai, aiProviders: [ai], guardSsrf: true };
}

/**
 * Build the cloud-store-backed {@link GridStoreShape} for one cloud table,
 * pointed at the worker HTTP endpoints and resolving the workspace's SHARED
 * connector secrets. Mirrors `cloud-run.ts` `buildCloudStore`.
 */
/**
 * The engine registry for a workspace: the built-in connectors PLUS the
 * workspace's installed manifest connectors. A connector column with no custom
 * code runs `sdk[provider][method](inputs)` in the sandbox (execute.ts), so the
 * provider MUST be registered or `sdk[provider]` is undefined and the run throws
 * "cannot read property <method>". The desktop sidecar registers manifests at
 * startup; the cloud worker has to fetch them per workspace.
 *
 * Cached per workspace with a short TTL so a newly-installed connector becomes
 * available within ~a minute without a DB round-trip on every column run. A fetch
 * failure falls back to the built-ins (the run still works for built-in/formula
 * columns rather than failing wholesale).
 */
const REGISTRY_TTL_MS = 60_000;
const registryCache = new Map<string, { reg: Promise<Registry>; at: number }>();

export function workspaceRegistry(workspaceId: string): Promise<Registry> {
  const now = Date.now();
  const cached = registryCache.get(workspaceId);
  if (cached && now - cached.at < REGISTRY_TTL_MS) return cached.reg;
  const reg = (async (): Promise<Registry> => {
    const registry = defaultRegistry();
    try {
      const manifests = (await workerClient.query("/api/worker/getExtensions", {
        workspaceId,
      })) as unknown[];
      for (const manifest of manifests) {
        try {
          registry.add(connectorFromManifest(parseManifest(manifest)));
        } catch {
          /* skip a single malformed manifest — never fail the whole registry */
        }
      }
    } catch {
      /* extensions unavailable — fall back to the built-in connectors */
    }
    return registry;
  })();
  registryCache.set(workspaceId, { reg, at: now });
  return reg;
}

function buildWorkerStore(
  tableId: string,
  workspaceId: string,
): Promise<GridStoreShape> {
  return Effect.runPromise(
    cloudGridStoreShape({
      client: workerClient,
      refs: WORKER_REFS,
      tableId,
      credentials: { workspaceId, scope: "workspace" },
    }).pipe(Effect.provide(CloudSchemaMapping.Default)),
  );
}

/** The grid shape `/webhook/getTable` returns (table + columns/rows/cells). */
interface WorkerGrid {
  readonly columns: ReadonlyArray<{
    readonly _id: string;
    readonly name: string;
    readonly type: Column["type"];
    readonly kind: Column["kind"];
    // Carried so enrichment can order columns by their {{ref}} dependency graph
    // (the worker `getTable` projection already returns these — grid-service).
    readonly provider: string | null;
    readonly params: Record<string, unknown>;
    readonly condition: string | null;
    readonly position: number;
  }>;
  readonly rows: ReadonlyArray<{ readonly _id: string }>;
  readonly cells: ReadonlyArray<{
    readonly rowId: string;
    readonly columnId: string;
    readonly value: unknown;
  }>;
}

/** Fetch the table grid directly through the worker endpoint (for upsert + columns). */
export async function fetchGrid(tableId: string): Promise<WorkerGrid> {
  return (await workerClient.query(WORKER_REFS.getTable, {
    tableId,
  })) as WorkerGrid;
}

/**
 * Resolve the row this record targets, honouring `mode`. Both paths write the
 * row + cells in ONE server-side worker mutation that meters EXACTLY ONCE per
 * record (never per cell), returning the resolved `rowId`.
 *
 *  - "upsert": POST `/api/worker/upsertRow` with the upsert key. The server
 *    matches an existing row (atomic — no client read-then-write race) and
 *    patches its cells, or inserts a fresh row when nothing matches. The worker
 *    no longer fetches the grid or loops `setCell` per cell.
 *  - "create" (or upsert with no key): POST `/api/worker/insertRow` (unchanged).
 *
 * Idempotency is provided by the event id de-dupe + the unique step key wrapping
 * this call, identically for both modes.
 */
export async function resolveRow(
  data: WebhookRecordData,
  webhookId: string,
): Promise<string> {
  if (data.mode === "upsert" && data.upsertKey !== null) {
    // Server-side upsert: match + patch-or-insert in one metered-once mutation.
    const result = (await workerClient.mutation("/api/worker/upsertRow", {
      webhookId,
      upsertKey: data.upsertKey,
      cells: data.mappedCells,
      recordId: data.recordId,
    })) as { rowId: string };
    return result.rowId;
  }
  // Create path: insert one row + its cells (metered once per record).
  const result = (await workerClient.mutation("/api/worker/insertRow", {
    webhookId,
    cells: data.mappedCells,
    recordId: data.recordId,
  })) as { rowId: string };
  return result.rowId;
}

/**
 * Recompute ONE function column over a single row through the engine cloud path.
 * Exported so it can be wrapped in its own per-column `step.run` (TRI-3280) and
 * exercised directly in tests. Builds the Db-FREE engine: store + creds are the
 * same injected cloud store, so no SQLite file is opened (better-sqlite3 stays
 * unloaded). Returns the number of cells the engine ran.
 */
export async function runEnrichColumn(
  ctx: { tableId: string; workspaceId: string },
  columnId: string,
  rowId: string,
): Promise<number> {
  const [store, registry] = await Promise.all([
    buildWorkerStore(ctx.tableId, ctx.workspaceId),
    // Built-ins + the workspace's installed manifest connectors, so a column that
    // calls e.g. `sdk["leadmagic"]["emailfinder"](…)` resolves instead of throwing.
    workspaceRegistry(ctx.workspaceId),
  ]);
  // Systemic run failures (connector/AI bugs) → PostHog Error Tracking, deduped by
  // the engine. There's no user identity in the worker, so group under the workspace.
  const reportError = (error: unknown, c: RunErrorContext): void =>
    captureServerException(error, {
      distinctId: ctx.workspaceId,
      properties: { source: "engine-run", surface: "cloud", table_id: ctx.tableId, ...c },
    });
  const engine = new Engine(
    { ...engineConfig(), reportError },
    registry,
    { store, creds: store },
  );
  const { ran, errors, firstError } = await engine.runColumn(columnId, { rowIds: [rowId] });
  // Failure-rate signal for dashboards/alerts (complements the deduped exceptions).
  if (errors > 0) {
    captureServer("column_run_failed", {
      distinctId: ctx.workspaceId,
      properties: {
        column_id: columnId,
        provider: null,
        method: null,
        ran,
        errors,
        first_error: firstError,
        surface: "cloud",
      },
      groups: { workspace: ctx.workspaceId },
    });
  }
  return ran;
}

/**
 * The subset of the Inngest `step` API this handler relies on. The handler only
 * ever stores JSON-safe step results (string, string[], number), so the simple
 * `Promise<T>` return faithfully models Inngest's durable `step.run` for these
 * payloads. The real `step` is adapted to this shape at the `createFunction`
 * boundary; tests supply a fake that models retry memoization.
 */
export interface StepRunner {
  run<T>(id: string, handler: () => Promise<T>): Promise<T>;
}

/**
 * Adapt Inngest's `step` to the handler's {@link StepRunner}. Inngest types
 * `step.run` results as `Jsonify<…>`; this handler only ever stores JSON-safe
 * values (string, string[], number) for which `Jsonify` is the identity, so the
 * runtime value is unchanged. This adapter is the SINGLE, deliberate place the
 * two type worlds meet — everything downstream is fully typed.
 */
export function toStepRunner(step: {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
}): StepRunner {
  return {
    run<T>(id: string, handler: () => Promise<T>): Promise<T> {
      return step.run(id, handler) as Promise<T>;
    },
  };
}

/** The result the handler returns. */
export type ProcessWebhookRecordResult =
  | { readonly rowId: string; readonly enriched: false }
  | { readonly rowId: string; readonly enriched: true; readonly ran: number };

/**
 * The durable handler body, extracted from `createFunction` so it can be driven
 * directly in tests with a fake {@link StepRunner} that models Inngest's retry
 * memoization (completed steps are not re-executed). This is what proves the
 * per-column step keying skips already-done columns on retry (TRI-3280).
 */
export async function processWebhookRecordHandler(
  data: WebhookRecordData,
  webhookId: string,
  step: StepRunner,
): Promise<ProcessWebhookRecordResult> {

  // 1) Insert (or upsert) the row. UNIQUE-per-record step key → memoized on
  //    retry, so the row is created at most once per record.
  const rowId = await step.run(
    `insert-row:${data.recordId}`,
    async () => resolveRow(data, webhookId),
  );

  // 2) Enrichment: only when the webhook auto-runs. Recompute every FUNCTION
  //    column over just the new row, through the engine cloud path.
  if (!data.autoRun) {
    return { rowId, enriched: false };
  }

  // 2a) Fetch the table's function columns in their OWN step so the grid read
  //     is memoized and not re-fetched on every retry attempt.
  const functionColumns = await step.run(
    `enrich-columns:${data.recordId}`,
    async () => {
      const grid = await fetchGrid(data.tableId);
      // Order by the {{ref}} DEPENDENCY graph, not authored position, so a column
      // that maps/computes off another column's output always enriches AFTER its
      // source (Get API data → map field → compute value cascades correctly even
      // when the author placed the columns out of order). Cycle-tolerant.
      const fnCols = grid.columns
        .filter((c) => c.kind === "function")
        .map((c) => ({
          id: c._id,
          name: c.name,
          kind: c.kind,
          provider: c.provider,
          params: c.params,
          condition: c.condition,
        }));
      return topoSortColumnIds(fnCols, buildColumnDeps(fnCols));
    },
  );

  // 2b) Run each function column inside its OWN step with a UNIQUE per-column
  //     step key (`enrich:${recordId}:${columnId}`). Inngest memoizes each
  //     completed step, so a retry triggered by a later column's failure SKIPS
  //     the already-completed columns — no re-POST, no re-charge (TRI-3280).
  let ran = 0;
  for (const columnId of functionColumns) {
    const n = await step.run(
      `enrich:${data.recordId}:${columnId}`,
      async () => runEnrichColumn({ tableId: data.tableId, workspaceId: data.workspaceId }, columnId, rowId),
    );
    ran += n;
  }

  return { rowId, enriched: true, ran };
}

export const processWebhookRecord = inngest.createFunction(
  {
    id: "process-webhook-record",
    // Two-tier concurrency: a GLOBAL account-scoped cap bounds total in-flight
    // runs across ALL workspaces (per-workspace limits otherwise multiply
    // unbounded as the number of workspaces grows), while the per-workspace key
    // still prevents one busy workspace from starving others. Retries cover
    // transient worker/engine failures (step memoization makes them safe).
    // Account-scoped limits REQUIRE a key (Inngest rejects the whole app sync
    // without one, leaving prod functions unregistered); a constant key makes
    // one shared account-wide pool for this function's runs.
    concurrency: [
      { scope: "account", key: '"webhook-enrich"', limit: 50 },
      { key: "event.data.workspaceId", limit: 5 },
    ],
    retries: 3,
    onFailure,
    triggers: [{ event: "webhook/record.received" }],
  },
  async ({ event, step }) => {
    const data = parseWebhookRecordData(event.data);
    return processWebhookRecordHandler(
      data,
      data.webhookId ?? "",
      toStepRunner(step),
    );
  },
);
