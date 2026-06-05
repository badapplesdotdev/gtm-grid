/**
 * ConvexGridStore tests — prove the store's read/write/run-status mapping against
 * a FAKE Convex client (no deployment, no network). The fake records every
 * mutation call and serves reads from an in-memory grid, so we assert OUTCOMES:
 *   - reads map Convex docs (camelCase, `_id`) → engine domain (snake_case),
 *   - writes route to the correct mutation (status-only → setCellStatus, value →
 *     setCell) with the cloud-validated status (reusing CloudSchemaMapping),
 *   - an invalid status fails with the typed GridStoreError, and
 *   - the credential ref maps cloud scope back onto the engine scope (or is a
 *     no-op when no ref is wired).
 */

import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { CloudSchemaMapping } from "./cloud-schema.js";
import {
  convexGridStoreShape,
  type ConvexClientLike,
  type ConvexFunctionRefs,
  type ConvexGridStoreConfig,
} from "./store-convex.js";
import type { GridStoreError, GridStoreShape } from "./store.js";

// Opaque refs — the engine never interprets these; the fake client compares by
// identity to decide which "function" was called.
const REFS: ConvexFunctionRefs = {
  getTable: { kind: "getTable" },
  setCell: { kind: "setCell" },
  setCellStatus: { kind: "setCellStatus" },
  getCredential: { kind: "getCredential" },
};

const TABLE_ID = "tbl_1";

/** A recorded mutation/query call against the fake client. */
interface Call {
  readonly ref: unknown;
  readonly args: Record<string, unknown>;
}

/** A fake Convex client serving one table's grid and recording writes. */
function fakeClient(grid: {
  columns?: unknown[];
  rows?: unknown[];
  cells?: unknown[];
  credential?: unknown;
}): { client: ConvexClientLike; calls: Call[] } {
  const calls: Call[] = [];
  const client: ConvexClientLike = {
    query: async (ref, args) => {
      calls.push({ ref, args });
      if (ref === REFS.getTable) {
        return {
          columns: grid.columns ?? [],
          rows: grid.rows ?? [],
          cells: grid.cells ?? [],
        };
      }
      if (ref === REFS.getCredential) return grid.credential ?? null;
      throw new Error("unexpected query ref");
    },
    mutation: async (ref, args) => {
      calls.push({ ref, args });
      return "cell_id";
    },
  };
  return { client, calls };
}

/** Build the store shape, providing the real CloudSchemaMapping layer. */
const buildStore = (config: ConvexGridStoreConfig): Promise<GridStoreShape> =>
  Effect.runPromise(
    convexGridStoreShape(config).pipe(
      Effect.provide(CloudSchemaMapping.Default),
    ),
  );

const COLUMN_DOC = {
  _id: "col_1",
  tableId: TABLE_ID,
  name: "Email",
  type: "text",
  kind: "function",
  provider: "ai",
  method: "generate",
  code: null,
  params: { prompt: "hi {{Name}}" },
  position: 0,
  createdAt: 100,
};

const ROW_DOC = { _id: "row_1", tableId: TABLE_ID, position: 0, createdAt: 50 };

const CELL_DOC = {
  rowId: "row_1",
  columnId: "col_1",
  value: "hello",
  status: "done",
  error: null,
  updatedAt: 200,
};

describe("ConvexGridStore — reads", () => {
  it("maps a Convex column doc onto the engine Column (snake_case ids)", async () => {
    const { client } = fakeClient({ columns: [COLUMN_DOC] });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const col = await Effect.runPromise(store.getColumn("col_1"));
    expect(col).toEqual({
      id: "col_1",
      table_id: TABLE_ID,
      name: "Email",
      type: "text",
      kind: "function",
      provider: "ai",
      method: "generate",
      code: null,
      params: { prompt: "hi {{Name}}" },
      position: 0,
      created_at: 100,
    });
  });

  it("returns undefined for a column not in the grid", async () => {
    const { client } = fakeClient({ columns: [COLUMN_DOC] });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });
    expect(await Effect.runPromise(store.getColumn("nope"))).toBeUndefined();
  });

  it("listColumns / listRows map every doc", async () => {
    const { client } = fakeClient({ columns: [COLUMN_DOC], rows: [ROW_DOC] });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const cols = await Effect.runPromise(store.listColumns(TABLE_ID));
    const rows = await Effect.runPromise(store.listRows(TABLE_ID));
    expect(cols.map((c) => c.id)).toEqual(["col_1"]);
    expect(rows).toEqual([
      { id: "row_1", table_id: TABLE_ID, position: 0, created_at: 50 },
    ]);
  });

  it("rowCells keys cells by columnId for the requested row only", async () => {
    const otherRowCell = { ...CELL_DOC, rowId: "row_2", columnId: "col_1" };
    const { client } = fakeClient({ cells: [CELL_DOC, otherRowCell] });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const cells = await Effect.runPromise(store.rowCells("row_1"));
    expect(cells.size).toBe(1);
    expect(cells.get("col_1")).toEqual({
      row_id: "row_1",
      column_id: "col_1",
      value: "hello",
      status: "done",
      error: null,
      updated_at: 200,
    });
  });

  it("getCell finds the (row, column) cell and maps it", async () => {
    const { client } = fakeClient({ cells: [CELL_DOC] });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const cell = await Effect.runPromise(store.getCell("row_1", "col_1"));
    expect(cell?.status).toBe("done");
    expect(cell?.value).toBe("hello");
    expect(
      await Effect.runPromise(store.getCell("row_1", "missing")),
    ).toBeUndefined();
  });
});

describe("ConvexGridStore — writes (run-status mapping)", () => {
  it("routes a status-only patch to setCellStatus (run lifecycle running→done)", async () => {
    const { client, calls } = fakeClient({});
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    await Effect.runPromise(
      store.setCell("row_1", "col_1", { status: "running", error: null }),
    );

    const write = calls.find((c) => c.ref === REFS.setCellStatus);
    expect(write).toBeDefined();
    expect(write?.args).toEqual({
      rowId: "row_1",
      columnId: "col_1",
      status: "running",
      error: null,
    });
    // It must NOT also call setCell for a status-only patch.
    expect(calls.some((c) => c.ref === REFS.setCell)).toBe(false);
  });

  it("routes a value-bearing patch to setCell with value+status+error", async () => {
    const { client, calls } = fakeClient({});
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    await Effect.runPromise(
      store.setCell("row_1", "col_1", {
        value: { text: "done" },
        status: "done",
        error: null,
      }),
    );

    const write = calls.find((c) => c.ref === REFS.setCell);
    expect(write?.args).toEqual({
      rowId: "row_1",
      columnId: "col_1",
      value: { text: "done" },
      status: "done",
      error: null,
    });
    expect(calls.some((c) => c.ref === REFS.setCellStatus)).toBe(false);
  });

  it("forwards an error-only patch as a status-less setCell update", async () => {
    const { client, calls } = fakeClient({});
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    await Effect.runPromise(
      store.setCell("row_1", "col_1", { error: "boom" }),
    );

    const write = calls.find((c) => c.ref === REFS.setCell);
    expect(write?.args).toEqual({
      rowId: "row_1",
      columnId: "col_1",
      error: "boom",
    });
  });

  it("fails with a typed GridStoreError when the status is not a cloud literal", async () => {
    const { client, calls } = fakeClient({});
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const exit = await Effect.runPromiseExit(
      store.setCell("row_1", "col_1", {
        // Not a valid CellStatus — proves CloudSchemaMapping validation runs.
        status: "bogus" as never,
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        const gridErr = err.value as GridStoreError;
        expect(gridErr._tag).toBe("GridStoreError");
        expect(gridErr.operation).toBe("setCell");
      }
    }
    // No write reached the client when validation failed.
    expect(calls.length).toBe(0);
  });

  it("surfaces a Convex mutation rejection as a typed GridStoreError", async () => {
    const client: ConvexClientLike = {
      query: async () => ({ columns: [], rows: [], cells: [] }),
      mutation: async () => {
        throw new Error("network down");
      },
    };
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const exit = await Effect.runPromiseExit(
      store.setCell("row_1", "col_1", { status: "running" }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      if (err._tag === "Some") {
        expect((err.value as GridStoreError).message).toContain("network down");
      }
    }
  });
});

describe("ConvexGridStore — credentials", () => {
  it("maps a workspace credential doc back onto the engine team scope", async () => {
    const { client } = fakeClient({
      credential: {
        _id: "cred_1",
        extensionId: "ai:openai",
        scope: "workspace",
        name: "OpenAI",
        secrets: { apiKey: "sk-test" },
        createdAt: 10,
      },
    });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });

    const cred = await Effect.runPromise(store.getCredential("ai:openai"));
    expect(cred).toEqual({
      id: "cred_1",
      extension_id: "ai:openai",
      scope: "team",
      name: "OpenAI",
      secrets: { apiKey: "sk-test" },
      created_at: 10,
    });
  });

  it("maps a personal credential scope through unchanged", async () => {
    const { client } = fakeClient({
      credential: {
        _id: "cred_2",
        extensionId: "apollo",
        scope: "personal",
        name: "Apollo",
        secrets: { apiKey: "k" },
        createdAt: 20,
      },
    });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });
    const cred = await Effect.runPromise(store.getCredential("apollo"));
    expect(cred?.scope).toBe("personal");
  });

  it("is a no-op (undefined) when no credential ref is wired", async () => {
    const refsNoCred: ConvexFunctionRefs = { ...REFS, getCredential: undefined };
    const { client } = fakeClient({});
    const store = await buildStore({
      client,
      refs: refsNoCred,
      tableId: TABLE_ID,
    });
    expect(
      await Effect.runPromise(store.getCredential("ai")),
    ).toBeUndefined();
  });
});
