import {
  CloudSchemaMapping,
  Engine,
  aiConfigFromEnv,
  convexGridStoreShape,
  defaultRegistry,
  type Column,
  type EngineConfig,
  type GridStoreShape,
} from "@gtmgrid/engine";
import { Effect } from "effect";
import { inngest } from "../client";
import { convexWorkerClient, WORKER_REFS } from "../convex-worker-client";

/**
 * The durable worker that turns one received webhook record into a row and (when
 * the webhook auto-runs) recomputes that row's function columns through the
 * engine — the SAME `Engine.runColumn` cloud path the desktop sidecar uses
 * (`packages/server/src/cloud-run.ts:159-176`), only the Convex client points at
 * the secret-gated `/webhook/*` routes instead of authed function calls.
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
interface WebhookRecordData {
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
 * Build the Convex-backed {@link GridStoreShape} for one cloud table, pointed at
 * the worker HTTP routes and resolving the workspace's SHARED connector secrets.
 * Mirrors `cloud-run.ts` `buildConvexStore`.
 */
function buildWorkerStore(
  tableId: string,
  workspaceId: string,
): Promise<GridStoreShape> {
  return Effect.runPromise(
    convexGridStoreShape({
      client: convexWorkerClient,
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

/** Fetch the table grid directly through the worker route (for upsert + columns). */
async function fetchGrid(tableId: string): Promise<WorkerGrid> {
  return (await convexWorkerClient.query(WORKER_REFS.getTable, {
    tableId,
  })) as WorkerGrid;
}

/**
 * Resolve the row this record targets, honouring `mode`. For "upsert" it finds an
 * existing row whose cell in the `upsertKey` column equals the incoming mapped
 * value and updates that row's mapped cells through `/webhook/setCell`; otherwise
 * (or for "create") it inserts a fresh row via `/webhook/insertRow`. Returns the
 * resolved `rowId`. Idempotency for the create path is provided by the event id
 * de-dupe + the unique step key wrapping this call.
 */
async function resolveRow(
  data: WebhookRecordData,
  webhookId: string,
): Promise<string> {
  if (data.mode === "upsert" && data.upsertKey !== null) {
    const incoming = data.mappedCells[data.upsertKey];
    if (incoming !== undefined && incoming !== null && incoming !== "") {
      const grid = await fetchGrid(data.tableId);
      const match = grid.cells.find(
        (c) => c.columnId === data.upsertKey && c.value === incoming,
      );
      if (match !== undefined) {
        // Update the matched row's mapped cells in place (skip empties; the
        // worker route ignores cross-table columns).
        for (const [columnId, value] of Object.entries(data.mappedCells)) {
          if (value === undefined || value === null || value === "") continue;
          await convexWorkerClient.mutation(WORKER_REFS.setCell, {
            rowId: match.rowId,
            columnId,
            value,
            status: "done",
          });
        }
        return match.rowId;
      }
    }
  }
  // Create path: insert one row + its cells (metered once per record).
  const result = (await convexWorkerClient.mutation("/webhook/insertRow", {
    webhookId,
    cells: data.mappedCells,
  })) as { rowId: string };
  return result.rowId;
}

export const processWebhookRecord = inngest.createFunction(
  {
    id: "process-webhook-record",
    // Bound per-workspace so one busy workspace can't starve others; retries
    // cover transient Convex/engine failures (step memoization makes them safe).
    concurrency: {
      key: "event.data.workspaceId",
      limit: 5,
    },
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

      // Build the Db-FREE engine: store + creds are the same injected Convex
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
