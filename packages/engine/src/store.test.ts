/**
 * SqliteGridStore parity + GridStore service tests.
 *
 * The acceptance criterion for the GridStore refactor is byte-for-byte
 * behaviour parity for local projects. These tests prove that by:
 *
 *   1. Running a `runColumn` end-to-end over a real temp SQLite DB through the
 *      refactored Engine, asserting the exact cells/status/value/error it
 *      produces (the engine now goes through SqliteGridStore internally).
 *   2. Exercising the GridStore service directly through its `Layer` (the
 *      canonical Effect pattern) for happy path, edge cases, and the typed
 *      error channel — using a hand-written stub Layer, no mocking framework.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import {
  GridStore,
  GridStoreError,
  sqliteGridStore,
  sqliteGridStoreShape,
  type GridStoreShape,
} from "./store.js";
import type { ConnectorMethod, Connector } from "./types.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gridstore-test-"));
  dbPath = join(dir, "project.db");
  db = new Db(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A registry whose single connector echoes its input back (no network/AI). */
const echoRegistry = (): Registry => {
  const method: ConnectorMethod = {
    id: "echo",
    label: "Echo",
    description: "Returns { text } from the input.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => ({ text: String(inputs.value ?? "") }),
  };
  const connector: Connector = {
    id: "test",
    name: "Test",
    category: "test",
    auth: null,
    methods: [method],
  };
  return new Registry([connector]);
};

describe("SqliteGridStore parity (runColumn over a real temp DB)", () => {
  it("writes done cells with the simplified value for a custom-code column", async () => {
    const table = db.createTable("Leads");
    const name = db.createColumn({ tableId: table.id, name: "Name", kind: "manual" });
    const upper = db.createColumn({
      tableId: table.id,
      name: "Upper",
      kind: "function",
      code: "function(inputs, sdk){ return { text: String(inputs.name).toUpperCase() }; }",
      params: { name: "{{Name}}" },
    });
    const r1 = db.createRow(table.id);
    const r2 = db.createRow(table.id);
    db.setCell(r1.id, name.id, { value: "ada", status: "done" });
    db.setCell(r2.id, name.id, { value: "grace", status: "done" });

    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(upper.id);

    expect(res).toEqual({ ran: 2, errors: 0 });
    // simplify() unwraps a sole { text } result to the plain string.
    expect(db.getCell(r1.id, upper.id)?.value).toBe("ADA");
    expect(db.getCell(r1.id, upper.id)?.status).toBe("done");
    expect(db.getCell(r1.id, upper.id)?.error).toBeNull();
    expect(db.getCell(r2.id, upper.id)?.value).toBe("GRACE");
    expect(db.getCell(r2.id, upper.id)?.status).toBe("done");
  });

  it("dispatches a connector call, resolving the credential through the store", async () => {
    const table = db.createTable("People");
    const input = db.createColumn({ tableId: table.id, name: "Input", kind: "manual" });
    const out = db.createColumn({
      tableId: table.id,
      name: "Out",
      kind: "function",
      provider: "test",
      method: "echo",
      params: { value: "{{Input}}" },
    });
    const row = db.createRow(table.id);
    db.setCell(row.id, input.id, { value: "hello", status: "done" });

    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(out.id);

    expect(res).toEqual({ ran: 1, errors: 0 });
    // The synthesized column body returns sdk.test.echo({value}) -> { text } -> "hello".
    expect(db.getCell(row.id, out.id)?.value).toBe("hello");
    expect(db.getCell(row.id, out.id)?.status).toBe("done");
  });

  it("records error status + message when the column body throws", async () => {
    const table = db.createTable("T");
    const bad = db.createColumn({
      tableId: table.id,
      name: "Bad",
      kind: "function",
      code: "function(inputs, sdk){ throw new Error('boom'); }",
      params: {},
    });
    const row = db.createRow(table.id);

    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(bad.id);

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    // The first error message is RETURNED (so the MCP run_column tool can tell the
    // user why a run failed without a follow-up get_table read).
    expect(res.firstError).toContain("boom");
    const cell = db.getCell(row.id, bad.id);
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("boom");
    expect(cell?.value ?? null).toBeNull();
  });

  it("skips already-done cells unless force is set", async () => {
    const table = db.createTable("T");
    const col = db.createColumn({
      tableId: table.id,
      name: "C",
      kind: "function",
      code: "function(inputs, sdk){ return { text: 'fresh' }; }",
      params: {},
    });
    const row = db.createRow(table.id);
    db.setCell(row.id, col.id, { value: "stale", status: "done" });

    const engine = new Engine(db, {}, echoRegistry());

    const skipped = await engine.runColumn(col.id);
    expect(skipped).toEqual({ ran: 0, errors: 0 });
    expect(db.getCell(row.id, col.id)?.value).toBe("stale");

    const forced = await engine.runColumn(col.id, { force: true });
    expect(forced).toEqual({ ran: 1, errors: 0 });
    expect(db.getCell(row.id, col.id)?.value).toBe("fresh");
  });

  it("honours an explicit rowIds subset", async () => {
    const table = db.createTable("T");
    const col = db.createColumn({
      tableId: table.id,
      name: "C",
      kind: "function",
      code: "function(inputs, sdk){ return { text: 'x' }; }",
      params: {},
    });
    const r1 = db.createRow(table.id);
    const r2 = db.createRow(table.id);

    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(col.id, { rowIds: [r1.id] });

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(db.getCell(r1.id, col.id)?.status).toBe("done");
    expect(db.getCell(r2.id, col.id)).toBeUndefined();
  });

  it("is a no-op for non-function columns", async () => {
    const table = db.createTable("T");
    const manual = db.createColumn({ tableId: table.id, name: "M", kind: "manual" });
    db.createRow(table.id);

    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(manual.id);
    expect(res).toEqual({ ran: 0, errors: 0 });
  });

  it("throws for an unknown column id (unchanged behaviour)", async () => {
    const engine = new Engine(db, {}, echoRegistry());
    await expect(engine.runColumn("does-not-exist")).rejects.toThrow(/not found/);
  });

  it("marks a cell error (not silent done) when a param read throws (#23)", async () => {
    // A store backed by the real Db, but whose param-resolution read (`rowCells`)
    // fails. Before the fix, resolveParams swallowed this via orElseSucceed and
    // the cell was written status:"done"; now the GridStoreError propagates into
    // runColumn's per-row try/catch and the cell is recorded status:"error",
    // restoring the prior LOCAL semantics.
    const table = db.createTable("T");
    const col = db.createColumn({
      tableId: table.id,
      name: "C",
      kind: "function",
      code: "function(inputs, sdk){ return { text: inputs.value }; }",
      params: { value: "{{C}}" },
    });
    const row = db.createRow(table.id);

    const failingStore: GridStoreShape = {
      ...sqliteGridStoreShape(db),
      rowCells: () =>
        Effect.fail(
          new GridStoreError({ message: "read blew up", operation: "rowCells" }),
        ),
    };

    const engine = new Engine(db, {}, echoRegistry(), undefined, {
      store: failingStore,
    });
    const res = await engine.runColumn(col.id);

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    const cell = db.getCell(row.id, col.id);
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("read blew up");
    expect(cell?.value ?? null).toBeNull();
  });

  it("routes credentials through a separate credsDb store", async () => {
    const projectDb = db;
    const credsDir = mkdtempSync(join(tmpdir(), "gridstore-creds-"));
    const credsDb = new Db(join(credsDir, "global.db"));
    try {
      credsDb.saveCredential({ extensionId: "test", name: "k", secrets: { apiKey: "secret" } });

      const table = projectDb.createTable("T");
      const col = projectDb.createColumn({
        tableId: table.id,
        name: "C",
        kind: "function",
        // Returns whatever secret the host injected via the connector context.
        provider: "test",
        method: "needsKey",
        params: {},
      });
      const row = projectDb.createRow(table.id);

      const reg = new Registry([
        {
          id: "test",
          name: "Test",
          category: "test",
          auth: { type: "apiKey" },
          methods: [
            {
              id: "needsKey",
              label: "Needs key",
              description: "Echoes the resolved apiKey secret.",
              inputSchema: {},
              batchSize: 1,
              credits: 0,
              run: async (_inputs, ctx) => ({ text: ctx.secrets.apiKey ?? "MISSING" }),
            },
          ],
        },
      ]);

      const engine = new Engine(projectDb, {}, reg, credsDb);
      const res = await engine.runColumn(col.id);

      expect(res).toEqual({ ran: 1, errors: 0 });
      expect(projectDb.getCell(row.id, col.id)?.value).toBe("secret");
    } finally {
      credsDb.close();
      rmSync(credsDir, { recursive: true, force: true });
    }
  });
});

describe("GridStore service (Layer + typed errors)", () => {
  /** Run a program against a SqliteGridStore Layer over the temp Db. */
  const run = <A>(program: Effect.Effect<A, GridStoreError, GridStore>) =>
    Effect.runPromise(program.pipe(Effect.provide(sqliteGridStore(db))));

  it("reads back exactly what the Db wrote (parity at the method level)", async () => {
    const table = db.createTable("T");
    const col = db.createColumn({ tableId: table.id, name: "C", kind: "manual" });
    const row = db.createRow(table.id);
    db.setCell(row.id, col.id, { value: { a: 1 }, status: "done" });

    const direct = db.getCell(row.id, col.id);
    const viaStore = await run(
      Effect.gen(function* () {
        const store = yield* GridStore;
        return yield* store.getCell(row.id, col.id);
      }),
    );
    expect(viaStore).toEqual(direct);

    const rowCellsViaStore = await run(
      Effect.gen(function* () {
        const store = yield* GridStore;
        return yield* store.rowCells(row.id);
      }),
    );
    expect(rowCellsViaStore.get(col.id)).toEqual(direct);
  });

  it("setCell upserts through the store identically to Db.setCell", async () => {
    const table = db.createTable("T");
    const col = db.createColumn({ tableId: table.id, name: "C", kind: "manual" });
    const row = db.createRow(table.id);

    await run(
      Effect.gen(function* () {
        const store = yield* GridStore;
        yield* store.setCell(row.id, col.id, { value: "v", status: "done", error: null });
      }),
    );

    expect(db.getCell(row.id, col.id)?.value).toBe("v");
    expect(db.getCell(row.id, col.id)?.status).toBe("done");
  });

  it("lists columns and rows in Db order", async () => {
    const table = db.createTable("T");
    const a = db.createColumn({ tableId: table.id, name: "A", kind: "manual" });
    const b = db.createColumn({ tableId: table.id, name: "B", kind: "manual" });
    const r1 = db.createRow(table.id);
    const r2 = db.createRow(table.id);

    const { columns, rows } = await run(
      Effect.gen(function* () {
        const store = yield* GridStore;
        return {
          columns: yield* store.listColumns(table.id),
          rows: yield* store.listRows(table.id),
        };
      }),
    );
    expect(columns.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(rows.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });

  it("resolves credentials with Db scope precedence (local > personal > team)", async () => {
    const read = () =>
      run(
        Effect.gen(function* () {
          const store = yield* GridStore;
          return yield* store.getCredential("x");
        }),
      );

    // Insert lowest precedence first; each higher tier must win in turn so all
    // three rungs of local > personal > team are exercised, not just the ends.
    db.saveCredential({ extensionId: "x", scope: "team", name: "t", secrets: { apiKey: "team" } });
    expect((await read())?.secrets.apiKey).toBe("team");

    db.saveCredential({ extensionId: "x", scope: "personal", name: "p", secrets: { apiKey: "personal" } });
    expect((await read())?.secrets.apiKey).toBe("personal"); // personal > team

    db.saveCredential({ extensionId: "x", scope: "local", name: "l", secrets: { apiKey: "local" } });
    expect((await read())?.secrets.apiKey).toBe("local"); // local > personal > team
  });

  it("returns undefined for a missing cell / column / credential", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* GridStore;
        return {
          cell: yield* store.getCell("nope", "nope"),
          column: yield* store.getColumn("nope"),
          cred: yield* store.getCredential("nope"),
        };
      }),
    );
    expect(result.cell).toBeUndefined();
    expect(result.column).toBeUndefined();
    expect(result.cred).toBeUndefined();
  });

  it("surfaces a typed GridStoreError from the real getCell path when the Db throws", async () => {
    // Drive a REAL SqliteGridStore over a closed Db so getCell genuinely throws
    // inside better-sqlite3. The assertion exercises the actual `fromSync`
    // wrapper (not a stub that pre-returns the answer): it must tag the failure
    // GridStoreError with operation "getCell" and capture the underlying cause,
    // proving the error channel reflects where the failure really originated.
    const tmp = new Db(join(dir, "getcell-throws.db"));
    const FailingLayer = sqliteGridStore(tmp);
    tmp.close(); // any subsequent query throws inside fromSync

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const store = yield* GridStore;
        return yield* store.getCell("r", "c");
      }).pipe(Effect.provide(FailingLayer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(GridStoreError);
        // The operation label is produced by the real getCell wrapper, and the
        // cause is the real driver error — neither is a value the test injected.
        expect(err.value.operation).toBe("getCell");
        expect(err.value.cause).toBeInstanceOf(Error);
      }
    }
  });

  it("maps a real Db throw (closed connection) into GridStoreError", async () => {
    const tmp = new Db(join(dir, "closing.db"));
    const store = sqliteGridStoreShape(tmp);
    tmp.close(); // any subsequent query throws inside fromSync

    const exit = await Effect.runPromiseExit(store.listRows("any"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag === "Some" && err.value instanceof GridStoreError).toBe(true);
    }
  });
});
