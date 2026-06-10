/**
 * Tests for CloudPushService — the local→cloud one-way table push orchestrator
 * (TRI-3295).
 *
 * Offline, no live DB/Supabase: a real in-memory {@link Db} (`:memory:`) backs
 * the local reads/link-meta, and a hand-written fake {@link CloudPushTransport}
 * substitutes the cloud API (no mocking framework, per docs/effect-conventions.md).
 * We assert OUTCOMES + typed error tags via `Effect.runPromiseExit` +
 * `Cause.failureOption` — never implementation details.
 *
 * Coverage (the AC's regression set):
 *   - First push of an UNLINKED table CREATES a cloud table + stores the link.
 *   - Re-push of a LINKED table is detected via the link and OVERWRITES (with
 *     explicit confirmation); without confirmation it fails LinkConflictError.
 *   - A stale link (cloud table gone) fails LinkConflictError.
 *   - Mapping rejects an unpushable (`local`-scoped) credential column (FatalPush).
 *   - The retry predicate retries TransientPushError but NOT FatalPushError, and a
 *     transient failure that recovers within budget succeeds.
 *   - The structured result distinguishes created vs overwritten + row/column count.
 */

import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";
import {
  CloudActionsLimitError,
  CloudPushService,
  FatalPushError,
  TransientPushError,
  type CloudCellMap,
  type CloudPushConfig,
  type CloudPushError,
  type CloudPushTransport,
  type PushResult,
  type PushTableInput,
} from "./cloud-push.js";

/** A scriptable in-memory fake of the thin cloud transport. */
class FakeTransport implements CloudPushTransport {
  tables = new Map<string, { columns: string[]; rows: CloudCellMap[] }>();
  /** Every column spec passed to addColumn, so tests can assert the full
   *  function config (kind/provider/method/code/params/condition) is forwarded. */
  columnSpecs: Array<Record<string, unknown>> = [];
  createdCount = 0;
  private seq = 0;
  /** operation -> number of times to fail before succeeding (transient). */
  transientBudget = new Map<string, number>();
  /** operation -> a FATAL error to raise instead of succeeding. */
  fatalOn = new Map<string, CloudPushError>();
  /** Per-operation attempt counters (to assert retry behaviour). */
  attempts = new Map<string, number>();

  private bump(op: string): number {
    const n = (this.attempts.get(op) ?? 0) + 1;
    this.attempts.set(op, n);
    return n;
  }

  /**
   * Apply scripted failures for `op`, else run `ok`. Deferred via
   * `Effect.suspend` so each (re)execution by `Effect.retry` re-evaluates the
   * attempt counter + budget — a static `Effect.fail` built once would NOT
   * decrement per retry.
   */
  private guarded<A>(
    op: string,
    ok: () => A,
  ): Effect.Effect<A, CloudPushError> {
    return Effect.suspend(() => {
      this.bump(op);
      const fatal = this.fatalOn.get(op);
      if (fatal !== undefined) return Effect.fail(fatal);
      const budget = this.transientBudget.get(op) ?? 0;
      if (budget > 0) {
        this.transientBudget.set(op, budget - 1);
        return Effect.fail(
          new TransientPushError({ message: `transient ${op}`, operation: op }),
        );
      }
      return Effect.sync(ok);
    });
  }

  createTable(name: string): Effect.Effect<string, CloudPushError> {
    return this.guarded("createTable", () => {
      this.createdCount += 1;
      const id = `cloud-table-${this.seq++}`;
      this.tables.set(id, { columns: [], rows: [] });
      void name;
      return id;
    });
  }

  addColumn(
    cloudTableId: string,
    col: {
      name: string;
      type: string;
      kind: string;
      provider: string | null;
      method: string | null;
      code: string | null;
      params: Record<string, unknown>;
      condition: string | null;
    },
  ): Effect.Effect<string, CloudPushError> {
    return this.guarded("addColumn", () => {
      const id = `cloud-col-${this.seq++}`;
      this.tables.get(cloudTableId)?.columns.push(id);
      this.columnSpecs.push({ ...col });
      return id;
    });
  }

  addRowsWithCells(
    cloudTableId: string,
    rows: readonly CloudCellMap[],
  ): Effect.Effect<void, CloudPushError> {
    return this.guarded("addRowsWithCells", () => {
      const t = this.tables.get(cloudTableId);
      if (t) t.rows.push(...rows);
    });
  }

  deleteTable(cloudTableId: string): Effect.Effect<void, CloudPushError> {
    return this.guarded("deleteTable", () => {
      this.tables.delete(cloudTableId);
    });
  }

  tableExists(cloudTableId: string): Effect.Effect<boolean, CloudPushError> {
    return this.guarded("tableExists", () => this.tables.has(cloudTableId));
  }
}

/** Fast config: tiny chunks, instant rate limit, near-zero retry delay budget. */
const FAST: CloudPushConfig = {
  rowChunkSize: 2,
  concurrency: 4,
  rateLimitPerSecond: 1000,
  timeout: "5 seconds",
  maxRetries: 3,
};

let db: Db;

const seedTable = (opts?: {
  rows?: number;
  functionColumnScope?: "local" | "team" | "personal";
}): string => {
  const table = db.createTable("People");
  const name = db.createColumn({ tableId: table.id, name: "Name", type: "text" });
  const email = db.createColumn({ tableId: table.id, name: "Email", type: "text" });
  if (opts?.functionColumnScope !== undefined) {
    // A function column whose connector has a stored credential at the given
    // scope — `local` is unpushable.
    db.saveCredential({
      extensionId: "apollo",
      scope: opts.functionColumnScope,
      name: "k",
      secrets: { apiKey: "x" },
    });
    db.createColumn({
      tableId: table.id,
      name: "Enriched",
      type: "text",
      kind: "function",
      provider: "apollo",
      method: "enrich",
    });
  }
  const rowCount = opts?.rows ?? 3;
  for (let i = 0; i < rowCount; i++) {
    const row = db.createRow(table.id);
    db.setCell(row.id, name.id, { value: `Person ${i}`, status: "done" });
    db.setCell(row.id, email.id, { value: `p${i}@x.com`, status: "done" });
  }
  return table.id;
};

const runPush = (
  transport: CloudPushTransport,
  input: PushTableInput,
  config: CloudPushConfig = FAST,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* CloudPushService;
      return yield* svc.pushTable(db, transport, input, config);
    }).pipe(Effect.provide(CloudPushService.Default)),
  );

const expectFailureTag = <A>(
  exit: Exit.Exit<A, CloudPushError>,
  tag: CloudPushError["_tag"],
): CloudPushError => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected failure value");
  expect(failure.value._tag).toBe(tag);
  return failure.value;
};

beforeEach(() => {
  db = new Db(":memory:");
});

afterEach(() => {
  db.close();
});

describe("CloudPushService.pushTable", () => {
  describe("first push (unlinked → create)", () => {
    it("CREATES a cloud table, writes rows, and stores the local↔cloud link", async () => {
      const tableId = seedTable({ rows: 3 });
      const transport = new FakeTransport();

      const exit = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      const result: PushResult = exit.value;

      expect(result.outcome).toBe("created");
      expect(result.rowCount).toBe(3);
      expect(result.columnCount).toBe(2);
      expect(transport.createdCount).toBe(1);
      // Link persisted in local meta, pointing at the created cloud table.
      expect(db.getCloudTableLink(tableId)).toBe(result.cloudTableId);
      // Rows landed in the fake cloud (batched in chunks of 2 → still 3 rows).
      expect(transport.tables.get(result.cloudTableId)?.rows.length).toBe(3);
    });

    it("fails NOT-FOUND-shaped FatalPushError for a missing local table", async () => {
      const transport = new FakeTransport();
      const exit = await runPush(transport, { localTableId: "nope" });
      const err = expectFailureTag(exit, "FatalPushError");
      expect(err.message).toMatch(/not found/i);
    });
  });

  describe("re-push (linked → overwrite)", () => {
    it("detects the link and OVERWRITES with explicit confirmation (create-new-then-swap)", async () => {
      const tableId = seedTable({ rows: 3 });
      const transport = new FakeTransport();

      // First push creates + links.
      const first = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(first)).toBe(true);
      if (!Exit.isSuccess(first)) return;
      const firstCloudTableId = first.value.cloudTableId;

      // Add a local row so the overwrite reflects the new local state.
      const cols = db.listColumns(tableId);
      const newRow = db.createRow(tableId);
      db.setCell(newRow.id, cols[0].id, { value: "Person 3", status: "done" });

      const second = await runPush(transport, {
        localTableId: tableId,
        confirmOverwrite: true,
      });
      expect(Exit.isSuccess(second)).toBe(true);
      if (!Exit.isSuccess(second)) return;

      expect(second.value.outcome).toBe("overwritten");
      expect(second.value.rowCount).toBe(4);
      // Create-new-then-swap: the re-push built a NEW table (2 created total) and
      // repointed the link to it, then deleted the OLD table.
      expect(transport.createdCount).toBe(2);
      expect(second.value.cloudTableId).not.toBe(firstCloudTableId);
      // The link resolves the NEW table, which holds exactly 4 rows.
      expect(db.getCloudTableLink(tableId)).toBe(second.value.cloudTableId);
      expect(transport.tables.get(second.value.cloudTableId)?.rows.length).toBe(
        4,
      );
      // The OLD table was deleted (no orphan left behind on success).
      expect(transport.tables.has(firstCloudTableId)).toBe(false);
    });

    it("FAILS LinkConflictError when a re-push is not confirmed (destructive)", async () => {
      const tableId = seedTable({ rows: 2 });
      const transport = new FakeTransport();
      const first = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(first)).toBe(true);

      const second = await runPush(transport, { localTableId: tableId });
      const err = expectFailureTag(second, "LinkConflictError");
      expect(err.message).toMatch(/overwrite/i);
      // No clearing happened (we never touched the existing cloud data).
      if (Exit.isSuccess(first)) {
        expect(transport.tables.get(first.value.cloudTableId)?.rows.length).toBe(2);
      }
    });

    it("REGRESSION (TRI-3302): a fatal failure mid re-push leaves PRIOR cloud data intact (no data loss)", async () => {
      // Seed + first push: the cloud table now holds the table's prior data.
      const tableId = seedTable({ rows: 3 });
      const transport = new FakeTransport();
      const first = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(first)).toBe(true);
      if (!Exit.isSuccess(first)) return;
      const priorCloudTableId = first.value.cloudTableId;
      const priorRowCount =
        transport.tables.get(priorCloudTableId)?.rows.length;
      expect(priorRowCount).toBe(3);

      // Simulate the exact failure from the bug: a 402 quota raised INSIDE
      // addRowsWithCells on a CONFIRMED re-push — i.e. a fatal failure at the
      // point where the OLD clear-then-rebuild design would already have wiped
      // the cloud table.
      transport.fatalOn.set(
        "addRowsWithCells",
        new CloudActionsLimitError({ message: "quota exhausted" }),
      );

      const second = await runPush(transport, {
        localTableId: tableId,
        confirmOverwrite: true,
      });

      // The push fails with the quota error (surfaced unchanged for the 402 route).
      const err = expectFailureTag(second, "CloudActionsLimitError");
      expect(err.message).toMatch(/quota/i);

      // THE INVARIANT: the PRIOR cloud table still exists with all 3 rows — the
      // failure destroyed NOTHING. (Old design: clearTable ran first → 0 rows.)
      expect(transport.tables.has(priorCloudTableId)).toBe(true);
      expect(transport.tables.get(priorCloudTableId)?.rows.length).toBe(3);

      // The link still resolves the table that actually has the data, so a retry
      // (or the user) sees the intact prior table — not an emptied one.
      expect(db.getCloudTableLink(tableId)).toBe(priorCloudTableId);

      // The OLD table was never cleared/deleted on the failed attempt.
      expect(transport.attempts.get("deleteTable") ?? 0).toBe(0);
    });

    it("FAILS LinkConflictError when the linked cloud table no longer exists", async () => {
      const tableId = seedTable({ rows: 1 });
      const transport = new FakeTransport();
      const first = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(first)).toBe(true);
      if (!Exit.isSuccess(first)) return;
      // Simulate the cloud table being deleted out from under the link.
      transport.tables.delete(first.value.cloudTableId);

      const second = await runPush(transport, {
        localTableId: tableId,
        confirmOverwrite: true,
      });
      const err = expectFailureTag(second, "LinkConflictError");
      expect(err.message).toMatch(/no longer exists|re-link/i);
    });
  });

  describe("schema mapping rejection", () => {
    it("FAILS FatalPushError for a column backed by a `local`-scoped credential", async () => {
      const tableId = seedTable({ rows: 1, functionColumnScope: "local" });
      const transport = new FakeTransport();
      const exit = await runPush(transport, { localTableId: tableId });
      const err = expectFailureTag(exit, "FatalPushError");
      expect(err.message).toMatch(/unpushable credential scope/i);
      // Nothing was created in the cloud (validation runs before any write).
      expect(transport.createdCount).toBe(0);
    });

    it("ALLOWS a function column backed by a `team`/`personal` credential", async () => {
      const tableId = seedTable({ rows: 1, functionColumnScope: "team" });
      const transport = new FakeTransport();
      const exit = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.outcome).toBe("created");
        expect(exit.value.columnCount).toBe(3);
      }
    });

    it("CARRIES the function-column config to the cloud (stays runnable, not flattened to manual)", async () => {
      const tableId = seedTable({ rows: 1, functionColumnScope: "team" });
      const transport = new FakeTransport();
      const exit = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(exit)).toBe(true);
      // The pushed "Enriched" column keeps kind:function + provider/method, so the
      // cloud cell can be run/enriched (the bug was it landing as a manual column).
      const enriched = transport.columnSpecs.find((c) => c.name === "Enriched");
      expect(enriched).toMatchObject({
        kind: "function",
        provider: "apollo",
        method: "enrich",
      });
      // A plain manual column is still pushed as manual.
      const nameCol = transport.columnSpecs.find((c) => c.name === "Name");
      expect(nameCol).toMatchObject({ kind: "manual", provider: null, method: null });
    });
  });

  describe("resilience — retry predicate", () => {
    it("RETRIES a TransientPushError and succeeds within budget", async () => {
      const tableId = seedTable({ rows: 1 });
      const transport = new FakeTransport();
      // createTable fails transiently twice, then succeeds (within maxRetries=3).
      transport.transientBudget.set("createTable", 2);

      const exit = await runPush(transport, { localTableId: tableId });
      expect(Exit.isSuccess(exit)).toBe(true);
      // 2 failed attempts + 1 success = 3 attempts.
      expect(transport.attempts.get("createTable")).toBe(3);
    });

    it("does NOT retry a FatalPushError (one attempt, then fails)", async () => {
      const tableId = seedTable({ rows: 1 });
      const transport = new FakeTransport();
      transport.fatalOn.set(
        "createTable",
        new FatalPushError({ message: "bad request", operation: "createTable" }),
      );

      const exit = await runPush(transport, { localTableId: tableId });
      expectFailureTag(exit, "FatalPushError");
      // Fatal is not retried: exactly one attempt.
      expect(transport.attempts.get("createTable")).toBe(1);
    });

    it("gives up after the retry budget is exhausted (transient stays failing)", async () => {
      const tableId = seedTable({ rows: 1 });
      const transport = new FakeTransport();
      // Always fail transiently → exhausts maxRetries and surfaces transient.
      transport.transientBudget.set("createTable", 999);

      const exit = await runPush(
        transport,
        { localTableId: tableId },
        { ...FAST, maxRetries: 2 },
      );
      expectFailureTag(exit, "TransientPushError");
      // 1 initial + 2 retries = 3 attempts.
      expect(transport.attempts.get("createTable")).toBe(3);
    });

    it("surfaces CloudActionsLimitError (quota) unchanged — no retry", async () => {
      const tableId = seedTable({ rows: 1 });
      const transport = new FakeTransport();
      transport.fatalOn.set(
        "addRowsWithCells",
        new CloudActionsLimitError({ message: "quota exhausted" }),
      );

      const exit = await runPush(transport, { localTableId: tableId });
      expectFailureTag(exit, "CloudActionsLimitError");
      // Quota is fatal-stop: not retried.
      expect(transport.attempts.get("addRowsWithCells")).toBe(1);
    });
  });

  describe("batching", () => {
    it("chunks rows by rowChunkSize across multiple addRowsWithCells calls", async () => {
      const tableId = seedTable({ rows: 5 });
      const transport = new FakeTransport();
      const exit = await runPush(
        transport,
        { localTableId: tableId },
        { ...FAST, rowChunkSize: 2 },
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // 5 rows / chunk 2 → 3 chunks (2 + 2 + 1).
      expect(transport.attempts.get("addRowsWithCells")).toBe(3);
      if (Exit.isSuccess(exit)) {
        expect(transport.tables.get(exit.value.cloudTableId)?.rows.length).toBe(5);
      }
    });
  });
});
