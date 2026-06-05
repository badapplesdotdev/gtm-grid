/**
 * Cloud run path tests (T9).
 *
 * Proves the load-bearing acceptance criterion: running a column on a CLOUD
 * project executes via the LOCAL engine reading inputs from / writing results
 * back to Convex through the ConvexGridStore — without any real Convex
 * deployment. We inject a FAKE Convex client (a `ConvexClientLike`) that:
 *   - serves `tables:getTable` from an in-memory grid, and
 *   - records `cells:setCell` / `cells:setCellStatus` mutations.
 * Then we assert the engine produced the right `{ ran, errors }` and that the
 * final `setCell` carried the computed value + `done` status — i.e. the run
 * really flowed through Convex, not local SQLite.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Db,
  Registry,
  type ConnectorMethod,
  type Connector,
  type ConvexClientLike,
} from "@gtmgrid/engine";
import { runCloudColumn, type CloudRunDeps } from "./cloud-run.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cloud-run-test-"));
  // The engine constructor needs a Db for its (unused on the cloud path) fields.
  db = new Db(join(dir, "unused.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A registry whose single connector upper-cases its `value` input. */
const upperRegistry = (): Registry => {
  const method: ConnectorMethod = {
    id: "upper",
    label: "Upper",
    description: "Uppercases the input value.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => ({ text: String(inputs.value ?? "").toUpperCase() }),
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

/** A recorded mutation call against the fake Convex client. */
interface RecordedMutation {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * Build a fake {@link ConvexClientLike} backed by an in-memory grid. `getTable`
 * returns the grid (Convex camelCase shape); the cell mutations apply COALESCE
 * merge to the in-memory cells AND record the call so tests can assert ordering.
 */
function fakeConvex(grid: {
  columns: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  cells: Array<{
    rowId: string;
    columnId: string;
    value: unknown;
    status: string;
    error: string | null;
    updatedAt: number | null;
  }>;
}): { client: ConvexClientLike; mutations: RecordedMutation[] } {
  const mutations: RecordedMutation[] = [];

  const upsert = (args: Record<string, unknown>) => {
    const rowId = args.rowId as string;
    const columnId = args.columnId as string;
    let cell = grid.cells.find(
      (c) => c.rowId === rowId && c.columnId === columnId,
    );
    if (!cell) {
      cell = { rowId, columnId, value: null, status: "empty", error: null, updatedAt: null };
      grid.cells.push(cell);
    }
    if ("value" in args) cell.value = args.value;
    if (args.status !== undefined) cell.status = args.status as string;
    if (args.error !== undefined) cell.error = args.error as string | null;
    cell.updatedAt = Date.now();
  };

  const client: ConvexClientLike = {
    query: async (ref) => {
      const name = getFunctionName(ref as never);
      if (name === "tables:getTable") {
        return { columns: grid.columns, rows: grid.rows, cells: grid.cells };
      }
      throw new Error(`unexpected query ${name}`);
    },
    mutation: async (ref, args) => {
      const name = getFunctionName(ref as never);
      mutations.push({ name, args });
      if (name === "cells:setCell" || name === "cells:setCellStatus") {
        upsert(args);
        return "cell-id";
      }
      throw new Error(`unexpected mutation ${name}`);
    },
  };

  return { client, mutations };
}

/** Deps whose `makeClient` ignores url/token and returns the given fake client. */
const depsFor = (client: ConvexClientLike, registry: Registry): CloudRunDeps => ({
  makeClient: () => client,
  registry,
  config: {},
});

describe("runCloudColumn", () => {
  it("reads inputs from Convex and writes the computed value + done status back", async () => {
    const grid = {
      columns: [
        { _id: "c_name", tableId: "t1", name: "Name", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 1 },
        {
          _id: "c_upper",
          tableId: "t1",
          name: "Upper",
          type: "text",
          kind: "function",
          provider: "test",
          method: "upper",
          code: null,
          params: { value: "{{Name}}" },
          position: 1,
          createdAt: 2,
        },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 1 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 2 },
      ],
      cells: [
        { rowId: "r1", columnId: "c_name", value: "ada", status: "done", error: null, updatedAt: 1 },
        { rowId: "r2", columnId: "c_name", value: "grace", status: "done", error: null, updatedAt: 1 },
      ],
    };
    const { client, mutations } = fakeConvex(grid);

    const res = await runCloudColumn(
      { convexUrl: "https://fake.convex.cloud", token: "jwt", tableId: "t1", columnId: "c_upper" },
      depsFor(client, upperRegistry()),
      db,
    );

    expect(res).toEqual({ ran: 2, errors: 0 });

    // The final values were written back to Convex via setCell (simplify() unwraps {text}).
    const r1Upper = grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_upper");
    const r2Upper = grid.cells.find((c) => c.rowId === "r2" && c.columnId === "c_upper");
    expect(r1Upper?.value).toBe("ADA");
    expect(r1Upper?.status).toBe("done");
    expect(r2Upper?.value).toBe("GRACE");
    expect(r2Upper?.status).toBe("done");

    // Each row streamed a running status before its done write (live multiplayer).
    const statusCalls = mutations.filter((m) => m.name === "cells:setCellStatus");
    expect(statusCalls.map((m) => m.args.status)).toContain("running");
    // No local SQLite write happened — the unused db has no such table/column.
    expect(db.getCell("r1", "c_upper")).toBeUndefined();
  });

  it("records an error status back to Convex when the column body throws", async () => {
    const grid = {
      columns: [
        {
          _id: "c_bad",
          tableId: "t1",
          name: "Bad",
          type: "text",
          kind: "function",
          provider: null,
          method: null,
          code: "function(inputs, sdk){ throw new Error('boom'); }",
          params: {},
          position: 0,
          createdAt: 1,
        },
      ],
      rows: [{ _id: "r1", tableId: "t1", position: 0, createdAt: 1 }],
      cells: [] as Array<{ rowId: string; columnId: string; value: unknown; status: string; error: string | null; updatedAt: number | null }>,
    };
    const { client } = fakeConvex(grid);

    const res = await runCloudColumn(
      { convexUrl: "https://fake.convex.cloud", token: "jwt", tableId: "t1", columnId: "c_bad" },
      depsFor(client, upperRegistry()),
      db,
    );

    expect(res).toEqual({ ran: 0, errors: 1 });
    const cell = grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_bad");
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("boom");
  });

  it("honours an explicit rowIds subset (only those rows are written)", async () => {
    const grid = {
      columns: [
        {
          _id: "c_x",
          tableId: "t1",
          name: "X",
          type: "text",
          kind: "function",
          provider: null,
          method: null,
          code: "function(inputs, sdk){ return { text: 'x' }; }",
          params: {},
          position: 0,
          createdAt: 1,
        },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 1 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 2 },
      ],
      cells: [] as Array<{ rowId: string; columnId: string; value: unknown; status: string; error: string | null; updatedAt: number | null }>,
    };
    const { client } = fakeConvex(grid);

    const res = await runCloudColumn(
      { convexUrl: "https://fake.convex.cloud", token: "jwt", tableId: "t1", columnId: "c_x", rowIds: ["r1"] },
      depsFor(client, upperRegistry()),
      db,
    );

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_x")?.value).toBe("x");
    expect(grid.cells.find((c) => c.rowId === "r2" && c.columnId === "c_x")).toBeUndefined();
  });
});
