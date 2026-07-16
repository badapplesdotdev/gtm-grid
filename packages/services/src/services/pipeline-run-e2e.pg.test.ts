/**
 * END-TO-END pipeline run over a REAL Postgres (in-process PGlite): the graph
 * runner (`@gtmgrid/pipelines`) wired to the real `PipelineRepo` exactly as the
 * cloud worker wires it — `actionSink` -> `consumeAction`, `onNodeProgress` ->
 * `recordNodeRun`, after a `startRowRun`. No test previously exercised this seam
 * (the package tests use in-memory fakes), so metering + persistence behaviour
 * across the runner ↔ repo boundary was unverified.
 *
 * Asserts, for a branched graph:
 *   - one action is charged per EXECUTED billable node; input/output nodes and
 *     the SKIPPED branch are free;
 *   - node rows persist with their terminal status (skipped branch recorded as
 *     "skipped", not executed);
 *   - a retry of the same run/row is idempotent — no extra actions are charged
 *     (the exactly-once receipt in `pipeline_action_ledger`).
 */

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@gtmgrid/db";
import {
  PIPELINE_SCHEMA_VERSION,
  compilePipeline,
  runPipelineRecord,
  type PipelineGraph,
  type PipelineNodeExecutor,
} from "@gtmgrid/pipelines";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbClient } from "../db-client.js";
import { PipelineRepo, PipelineRepoLive } from "../repositories/pipeline-repo.js";

const WS = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const ROW = "33333333-3333-3333-3333-333333333333";
const BATCH = "44444444-4444-4444-4444-444444444444";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const layer = PipelineRepoLive.pipe(Layer.provide(Layer.succeed(DbClient, db)));
const run = <A, E>(program: Effect.Effect<A, E, PipelineRepo>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

// input -> condition -> (true: qualified formula -> output) | (false: rejected formula -> output)
const graph: PipelineGraph = {
  schemaVersion: PIPELINE_SCHEMA_VERSION,
  nodes: [
    { id: "input", type: "input", name: "Lead", position: { x: 0, y: 0 }, config: { key: "lead", required: true } },
    { id: "cond", type: "condition", name: "Qualified?", position: { x: 200, y: 0 }, config: { expression: "score > 50" } },
    { id: "yes", type: "formula", name: "Qualified", position: { x: 400, y: -60 }, config: { expression: "'q'" } },
    { id: "no", type: "formula", name: "Rejected", position: { x: 400, y: 60 }, config: { expression: "'r'" } },
    { id: "out-yes", type: "output", name: "Qualified out", position: { x: 600, y: -60 }, config: { key: "qualified" } },
    { id: "out-no", type: "output", name: "Rejected out", position: { x: 600, y: 60 }, config: { key: "rejected" } },
  ],
  edges: [
    { id: "e1", source: "input", target: "cond" },
    { id: "e2", source: "cond", target: "yes", sourcePort: "true" },
    { id: "e3", source: "cond", target: "no", sourcePort: "false" },
    { id: "e4", source: "yes", target: "out-yes" },
    { id: "e5", source: "no", target: "out-no" },
  ],
};

/** Executor stub: condition branches on the row's score, formulas echo a label. */
const executor: PipelineNodeExecutor = {
  execute: async ({ node, rootInput }) => {
    if (node.type === "condition") {
      const score = Number((rootInput as { score?: number }).score ?? 0);
      return { output: score > 50, branch: score > 50 ? "true" : "false" };
    }
    if (node.type === "formula") return { output: node.name };
    return { output: null };
  },
};

const usedActions = async (): Promise<number> => {
  const r = await pg.query<{ used: number | null }>("select cloud_actions_used as used from workspaces where id = $1", [WS]);
  return Number(r.rows[0]?.used ?? 0);
};

const executePipeline = async () => {
  const rowRunId = await run(Effect.flatMap(PipelineRepo, (repo) => repo.startRowRun({ workspaceId: WS, runId: RUN, batchId: BATCH, rowId: ROW, startedAt: 1 })));
  return runPipelineRecord(compilePipeline(graph), {
    runId: RUN,
    rowId: ROW,
    target: "cloud",
    input: { score: 80 },
    executor,
    now: () => 1,
    actionSink: {
      consume: (receipt) =>
        run(Effect.flatMap(PipelineRepo, (repo) => repo.consumeAction({ workspaceId: WS, runId: RUN, receiptKey: receipt.key, rowId: ROW, nodeId: receipt.nodeId, generation: 0, now: 1 }))),
    },
    onNodeProgress: (progress) =>
      run(Effect.flatMap(PipelineRepo, (repo) => repo.recordNodeRun({ workspaceId: WS, runId: RUN, rowRunId, rowId: ROW, ...progress }))),
  });
};

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE workspaces (id uuid PRIMARY KEY, cloud_actions_used bigint, cloud_actions_limit bigint);
    CREATE TABLE pipeline_runs (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, status text NOT NULL, created_at bigint NOT NULL, consumed_actions bigint NOT NULL DEFAULT 0);
    CREATE TABLE pipeline_action_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, run_id uuid NOT NULL,
      receipt_key text NOT NULL UNIQUE, row_id uuid NOT NULL, node_id text NOT NULL,
      generation integer NOT NULL DEFAULT 0, actions integer NOT NULL DEFAULT 1, created_at bigint NOT NULL
    );
    CREATE TABLE pipeline_row_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, run_id uuid NOT NULL,
      batch_id uuid, row_id uuid NOT NULL, status text NOT NULL, input_hash text, first_error text,
      trace_ref text, actions_consumed integer NOT NULL DEFAULT 0, started_at bigint NOT NULL, finished_at bigint,
      CONSTRAINT pipeline_row_runs_by_run_row UNIQUE (run_id, row_id)
    );
    CREATE TABLE pipeline_node_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, run_id uuid NOT NULL,
      row_run_id uuid NOT NULL, row_id uuid NOT NULL, node_id text NOT NULL, generation integer NOT NULL DEFAULT 0,
      status text NOT NULL, error text, input_data jsonb, output_data jsonb, duration_ms integer,
      action_consumed boolean NOT NULL DEFAULT false, started_at bigint NOT NULL, finished_at bigint,
      CONSTRAINT pipeline_node_runs_once UNIQUE (run_id, row_id, node_id, generation)
    );
  `);
}, 30_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM pipeline_node_runs; DELETE FROM pipeline_row_runs; DELETE FROM pipeline_action_ledger; DELETE FROM pipeline_runs; DELETE FROM workspaces;");
  await pg.exec(`INSERT INTO workspaces (id, cloud_actions_used, cloud_actions_limit) VALUES ('${WS}', 0, NULL);`);
  await pg.exec(`INSERT INTO pipeline_runs (id, workspace_id, status, created_at, consumed_actions) VALUES ('${RUN}', '${WS}', 'running', 1, 0);`);
});

describe("pipeline run e2e (runner ↔ real PipelineRepo, real Postgres)", () => {
  it("charges one action per executed billable node; skipped branch + i/o nodes are free", async () => {
    const result = await executePipeline();

    expect(result.status).toBe("succeeded");
    // Executed billable nodes = condition + qualified formula = 2. input/output
    // are structural (free); the rejected branch is skipped (free).
    expect(result.actionsConsumed).toBe(2);
    expect(await usedActions()).toBe(2);

    const nodes = await pg.query<{ node_id: string; status: string; action_consumed: boolean; output_data: unknown }>(
      "select node_id, status, action_consumed, output_data from pipeline_node_runs",
    );
    const byId = new Map(nodes.rows.map((n) => [n.node_id, n]));
    expect(byId.get("cond")?.status).toBe("succeeded");
    expect(byId.get("yes")?.status).toBe("succeeded");
    expect(byId.get("yes")?.action_consumed).toBe(true);
    expect(byId.get("yes")?.output_data).toBe("Qualified"); // terminal jsonb persisted
    // The false branch never ran and was never charged.
    expect(byId.get("no")?.status).toBe("skipped");
    expect(byId.get("no")?.action_consumed).toBe(false);
    expect(byId.get("no")?.output_data).toBeNull();

    const ledger = await pg.query<{ c: number }>("select count(*)::int as c from pipeline_action_ledger");
    expect(ledger.rows[0].c).toBe(2);
  });

  it("is idempotent on retry — re-running the same run/row charges no extra actions", async () => {
    await executePipeline();
    expect(await usedActions()).toBe(2);

    const retry = await executePipeline();
    // The runner still sees 2 billable nodes, but every receipt already exists,
    // so consumeAction returns false and no action is charged again.
    expect(retry.status).toBe("succeeded");
    expect(retry.actionsConsumed).toBe(0);
    expect(await usedActions()).toBe(2);

    const ledger = await pg.query<{ c: number }>("select count(*)::int as c from pipeline_action_ledger");
    expect(ledger.rows[0].c).toBe(2);
  });
});
