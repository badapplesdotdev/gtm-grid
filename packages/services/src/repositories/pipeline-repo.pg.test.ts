/**
 * `PipelineRepo.consumeAction` + `deleteTerminalRunsBefore` against a REAL
 * Postgres engine (in-process PGlite), not the in-memory Test Layer.
 *
 * Two guarantees the review flagged as untested at the DB layer:
 *   - Action metering is EXACTLY-ONCE per receipt. The retry double-charge
 *     protection relies on the `pipeline_action_ledger.receipt_key` unique index
 *     + `onConflictDoNothing`; a stub sink can't prove the real dedup holds.
 *   - Retention only ever deletes TERMINAL runs — an in-flight (running/queued)
 *     run older than the cutoff must survive, or a long run could be deleted
 *     mid-execution.
 *
 * Tables are created without FK constraints (like signal-repo.pg.test.ts) so the
 * suite stays isolated to the columns these two queries actually touch.
 */

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@gtmgrid/db";
import { drizzle } from "drizzle-orm/pglite";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbClient } from "../db-client.js";
import {
  PipelineActionsLimitError,
  PipelineRepo,
  PipelineRepoLive,
} from "./pipeline-repo.js";

const WS = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const ROW = "33333333-3333-3333-3333-333333333333";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const layer = PipelineRepoLive.pipe(Layer.provide(Layer.succeed(DbClient, db)));

const run = <A, E>(program: Effect.Effect<A, E, PipelineRepo>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

const usedActions = async (workspaceId = WS): Promise<number> => {
  const rows = await pg.query<{ used: number | null }>(
    "select cloud_actions_used as used from workspaces where id = $1",
    [workspaceId],
  );
  return Number(rows.rows[0]?.used ?? 0);
};

// PGlite boots a whole Postgres in WASM (~1.5s idle, far longer under a
// parallel full-suite run). vitest's DEFAULT 10s hook timeout makes this flaky
// by construction, and 'Hook timed out' looks nothing like its cause.
beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE workspaces (
      id uuid PRIMARY KEY,
      cloud_actions_used bigint,
      cloud_actions_limit bigint
    );
    CREATE TABLE pipeline_action_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL,
      run_id uuid NOT NULL,
      receipt_key text NOT NULL UNIQUE,
      row_id uuid NOT NULL,
      node_id text NOT NULL,
      generation integer NOT NULL DEFAULT 0,
      actions integer NOT NULL DEFAULT 1,
      created_at bigint NOT NULL
    );
    CREATE TABLE pipeline_runs (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      status text NOT NULL,
      created_at bigint NOT NULL,
      consumed_actions bigint NOT NULL DEFAULT 0
    );
  `);
}, 30_000);

afterAll(async () => {
  await pg.close();
}, 60_000);

beforeEach(async () => {
  await pg.exec(
    "DELETE FROM pipeline_action_ledger; DELETE FROM pipeline_runs; DELETE FROM workspaces;",
  );
});

const consume = (receiptKey: string, nodeId: string) =>
  Effect.flatMap(PipelineRepo, (repo) =>
    repo.consumeAction({ workspaceId: WS, runId: RUN, receiptKey, rowId: ROW, nodeId, generation: 0, now: 1 }),
  );

describe("PipelineRepo.consumeAction (real Postgres — exactly-once metering)", () => {
  beforeEach(async () => {
    await pg.exec(`INSERT INTO workspaces (id, cloud_actions_used, cloud_actions_limit) VALUES ('${WS}', 0, NULL);`);
    await pg.exec(`INSERT INTO pipeline_runs (id, workspace_id, status, created_at, consumed_actions) VALUES ('${RUN}', '${WS}', 'running', 1, 0);`);
  });

  it("charges once and is idempotent for a repeated receipt key", async () => {
    const first = await run(consume("r:1", "n1"));
    expect(first).toStrictEqual(Exit.succeed(true));
    expect(await usedActions()).toBe(1);

    // Same receipt key (a retry of the same node/row) must NOT charge again.
    const retry = await run(consume("r:1", "n1"));
    expect(retry).toStrictEqual(Exit.succeed(false));
    expect(await usedActions()).toBe(1);

    // A distinct receipt key (another node) charges once more.
    const second = await run(consume("r:2", "n2"));
    expect(second).toStrictEqual(Exit.succeed(true));
    expect(await usedActions()).toBe(2);

    const ledger = await pg.query("select count(*)::int as c from pipeline_action_ledger");
    expect((ledger.rows[0] as { c: number }).c).toBe(2);
    const run_ = await pg.query("select consumed_actions::int as c from pipeline_runs where id = $1", [RUN]);
    expect((run_.rows[0] as { c: number }).c).toBe(2);
  });

  it("fails with PipelineActionsLimitError when the workspace has no remaining actions", async () => {
    await pg.exec(`UPDATE workspaces SET cloud_actions_used = 1, cloud_actions_limit = 1 WHERE id = '${WS}';`);
    const exit = await run(consume("r:over", "n1"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") expect(error.value).toBeInstanceOf(PipelineActionsLimitError);
    }
    // The over-limit attempt must leave no receipt behind (transaction rolled back).
    const ledger = await pg.query("select count(*)::int as c from pipeline_action_ledger");
    expect((ledger.rows[0] as { c: number }).c).toBe(0);
    expect(await usedActions()).toBe(1);
  });
});

describe("PipelineRepo.deleteTerminalRunsBefore (real Postgres — in-flight safety)", () => {
  const CUTOFF = 1_000;
  const seedRun = (id: string, status: string, createdAt: number) =>
    pg.exec(`INSERT INTO pipeline_runs (id, workspace_id, status, created_at) VALUES ('${id}', '${WS}', '${status}', ${createdAt});`);

  it("removes only expired terminal runs and never touches in-flight ones", async () => {
    await seedRun("aaaaaaaa-0000-0000-0000-000000000001", "succeeded", CUTOFF - 100); // old terminal → delete
    await seedRun("aaaaaaaa-0000-0000-0000-000000000002", "failed", CUTOFF - 100); // old terminal → delete
    await seedRun("aaaaaaaa-0000-0000-0000-000000000003", "succeeded", CUTOFF + 100); // recent terminal → keep
    await seedRun("aaaaaaaa-0000-0000-0000-000000000004", "running", CUTOFF - 100); // old but in-flight → keep
    await seedRun("aaaaaaaa-0000-0000-0000-000000000005", "queued", CUTOFF - 100); // old but in-flight → keep

    const exit = await run(Effect.flatMap(PipelineRepo, (repo) => repo.deleteTerminalRunsBefore(CUTOFF, 1_000)));
    expect(exit).toStrictEqual(Exit.succeed(2));

    const remaining = await pg.query<{ id: string; status: string }>("select status from pipeline_runs order by created_at");
    const statuses = remaining.rows.map((r) => r.status).sort();
    expect(statuses).toEqual(["queued", "running", "succeeded"]); // recent-terminal + both in-flight survive
  });
});
