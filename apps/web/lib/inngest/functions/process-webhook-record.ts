import {
  CloudSchemaMapping,
  Engine,
  aiConfigFromEnv,
  cloudGridStoreShape,
  defaultRegistry,
  type Column,
  type EngineConfig,
  type GridStoreShape,
} from "@gtmgrid/engine";
import { Effect } from "effect";
import { inngest } from "../client";
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
 *  - Every `step.run` key is UNIQUE PER RECORD (`...:${recordId}`), so within-run
 *    retries are memoized — the row is inserted once and each function column is
 *    re-run at most once per record even across retries.
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

/** Build the engine AI config from the worker's environment (optional). */
function engineConfig(): EngineConfig {
  const ai = aiConfigFromEnv();
  return ai === undefined ? {} : { ai, aiProviders: [ai] };
}

/**
 * Build the cloud-store-backed {@link GridStoreShape} for one cloud table,
 * pointed at the worker HTTP endpoints and resolving the workspace's SHARED
 * connector secrets. Mirrors `cloud-run.ts` `buildCloudStore`.
 */
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
    readonly type: Column["type"];
    readonly kind: Column["kind"];
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

export const processWebhookRecord = inngest.createFunction(
  {
    id: "process-webhook-record",
    // Two-tier concurrency: a GLOBAL account-scoped cap bounds total in-flight
    // runs across ALL workspaces (per-workspace limits otherwise multiply
    // unbounded as the number of workspaces grows), while the per-workspace key
    // still prevents one busy workspace from starving others. Retries cover
    // transient worker/engine failures (step memoization makes them safe).
    concurrency: [
      { scope: "account", limit: 50 },
      { key: "event.data.workspaceId", limit: 5 },
    ],
    retries: 3,
    triggers: [{ event: "webhook/record.received" }],
  },
  async ({ event, step }) => {
    const data = event.data as WebhookRecordData;
    const webhookId = (event.data as { webhookId?: string }).webhookId ?? "";

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

    const ran = await step.run(`enrich:${data.recordId}`, async () => {
      const grid = await fetchGrid(data.tableId);
      const functionColumns = grid.columns
        .filter((c) => c.kind === "function")
        .sort((a, b) => a.position - b.position);
      if (functionColumns.length === 0) return 0;

      // Build the Db-FREE engine: store + creds are the same injected cloud
      // store, so no SQLite file is opened (better-sqlite3 stays unloaded).
      const store = await buildWorkerStore(data.tableId, data.workspaceId);
      const engine = new Engine(undefined, engineConfig(), defaultRegistry(), undefined, {
        store,
        creds: store,
      });
      let total = 0;
      for (const col of functionColumns) {
        const { ran: n } = await engine.runColumn(col._id, { rowIds: [rowId] });
        total += n;
      }
      return total;
    });

    return { rowId, enriched: true, ran };
  },
);
