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
import { describe, expect, it, vi } from "vitest";
import { CloudSchemaMapping } from "./cloud-schema.js";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import {
  cloudGridStoreShape,
  type CloudClientLike,
  type CloudFunctionRefs,
  type CloudGridStoreConfig,
} from "./store-cloud.js";
import type { CellPatch, GridStoreError, GridStoreShape } from "./store.js";
import type { Cell, Column, Connector, Row } from "./types.js";

// Opaque refs — the engine never interprets these; the fake client compares by
// identity to decide which "function" was called.
const REFS: CloudFunctionRefs = {
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
}): { client: CloudClientLike; calls: Call[] } {
  const calls: Call[] = [];
  const client: CloudClientLike = {
    query: async (ref, args) => {
      calls.push({ ref, args });
      if (ref === REFS.getTable) {
        return {
          columns: grid.columns ?? [],
          rows: grid.rows ?? [],
          cells: grid.cells ?? [],
        };
      }
      throw new Error("unexpected query ref");
    },
    mutation: async (ref, args) => {
      calls.push({ ref, args });
      return "cell_id";
    },
    // The T7 decrypt-for-run path is an ACTION; the credential ref routes here.
    action: async (ref, args) => {
      calls.push({ ref, args });
      if (ref === REFS.getCredential) return grid.credential ?? null;
      throw new Error("unexpected action ref");
    },
  };
  return { client, calls };
}

/** Build the store shape, providing the real CloudSchemaMapping layer. */
const buildStore = (config: CloudGridStoreConfig): Promise<GridStoreShape> =>
  Effect.runPromise(
    cloudGridStoreShape(config).pipe(
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

describe("ConvexGridStore — batched writes (setCells)", () => {
  const REFS_BATCHED: CloudFunctionRefs = {
    ...REFS,
    setCells: { kind: "setCells" },
  };

  it("buffers writes and flushes them through setCells on drain", async () => {
    const { client, calls } = fakeClient({});
    const store = await buildStore({
      client,
      refs: REFS_BATCHED,
      tableId: TABLE_ID,
    });

    // Two terminal writes — neither hits setCell/setCellStatus directly; they
    // buffer until drain flushes them in one setCells POST.
    await Effect.runPromise(
      store.setCell("row_1", "col_1", {
        value: { text: "a" },
        status: "done",
        error: null,
      }),
    );
    await Effect.runPromise(
      store.setCell("row_2", "col_1", {
        value: { text: "b" },
        status: "done",
        error: null,
      }),
    );
    expect(calls.some((c) => c.ref === REFS_BATCHED.setCells)).toBe(false);

    if (store.drain === undefined) throw new Error("expected drain");
    await Effect.runPromise(store.drain());

    const batch = calls.find((c) => c.ref === REFS_BATCHED.setCells);
    expect(batch).toBeDefined();
    expect(batch?.args.cells).toEqual([
      { rowId: "row_1", columnId: "col_1", value: { text: "a" }, status: "done", error: null },
      { rowId: "row_2", columnId: "col_1", value: { text: "b" }, status: "done", error: null },
    ]);
    // No per-cell setCell/setCellStatus writes on the batched path.
    expect(calls.some((c) => c.ref === REFS_BATCHED.setCell)).toBe(false);
    expect(calls.some((c) => c.ref === REFS_BATCHED.setCellStatus)).toBe(false);
  });

  it("streams a sub-chunk buffer on the idle timer WITHOUT an explicit drain", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = fakeClient({});
      const store = await buildStore({
        client,
        refs: REFS_BATCHED,
        tableId: TABLE_ID,
      });

      // Two terminal writes — well under FLUSH_CHUNK, so the size threshold never
      // fires. Pre-timer this would buffer until drainAll at run end (the grid
      // stuck on spinners); the idle timer must flush them in a tranche instead.
      await Effect.runPromise(
        store.setCell("row_1", "col_1", { value: { text: "a" }, status: "done", error: null }),
      );
      await Effect.runPromise(
        store.setCell("row_2", "col_1", { value: { text: "b" }, status: "done", error: null }),
      );
      expect(calls.some((c) => c.ref === REFS_BATCHED.setCells)).toBe(false);

      // Advancing past the idle interval flushes the buffered tranche — no drain.
      await vi.advanceTimersByTimeAsync(600);

      const batches = calls.filter((c) => c.ref === REFS_BATCHED.setCells);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.args.cells).toEqual([
        { rowId: "row_1", columnId: "col_1", value: { text: "a" }, status: "done", error: null },
        { rowId: "row_2", columnId: "col_1", value: { text: "b" }, status: "done", error: null },
      ]);

      // Buffer is empty, so the timer self-stops: no further flushes accumulate.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls.filter((c) => c.ref === REFS_BATCHED.setCells)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signals coalesceRunningWrites + drain when batching is wired", async () => {
    const { client } = fakeClient({});
    const store = await buildStore({
      client,
      refs: REFS_BATCHED,
      tableId: TABLE_ID,
    });
    expect(store.coalesceRunningWrites).toBe(true);
    expect(store.drain).toBeDefined();
  });

  it("does NOT signal coalesce/drain without a setCells ref", async () => {
    const { client } = fakeClient({});
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });
    expect(store.coalesceRunningWrites).toBeUndefined();
    expect(store.drain).toBeUndefined();
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
    const client: CloudClientLike = {
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

describe("ConvexGridStore — credentials (T7 decrypt-for-run, #18)", () => {
  const WORKSPACE_ID = "wks_1";

  it("resolves the workspace-shared secret via the getCredentialForRun action", async () => {
    // The action returns ONLY the decrypted secret map (no doc metadata).
    const { client, calls } = fakeClient({
      credential: { secrets: { apiKey: "sk-test" } },
    });
    const store = await buildStore({
      client,
      refs: REFS,
      tableId: TABLE_ID,
      credentials: { workspaceId: WORKSPACE_ID, scope: "workspace" },
    });

    const cred = await Effect.runPromise(store.getCredential("ai:openai"));
    // The engine consumes `secrets`; cloud `workspace` maps to engine `team`.
    expect(cred?.secrets).toEqual({ apiKey: "sk-test" });
    expect(cred?.scope).toBe("team");
    expect(cred?.extension_id).toBe("ai:openai");

    // It went through the ACTION channel (not query) with the decrypt-for-run
    // args: workspace + connector + the workspace (shared) scope.
    const credCall = calls.find((c) => c.ref === REFS.getCredential);
    expect(credCall?.args).toEqual({
      workspaceId: WORKSPACE_ID,
      extensionId: "ai:openai",
      scope: "workspace",
    });
  });

  it("returns undefined when the connector has no stored credential (action → null)", async () => {
    const { client } = fakeClient({ credential: null });
    const store = await buildStore({
      client,
      refs: REFS,
      tableId: TABLE_ID,
      credentials: { workspaceId: WORKSPACE_ID, scope: "workspace" },
    });
    expect(
      await Effect.runPromise(store.getCredential("apollo")),
    ).toBeUndefined();
  });

  it("is a no-op (undefined) when no credential resolution is configured", async () => {
    // A data-only store (reads/writes) must never reach for secrets, even though
    // the ref is wired — proving secrets resolve only on an explicit cloud run.
    const { client, calls } = fakeClient({
      credential: { secrets: { apiKey: "leak" } },
    });
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });
    expect(
      await Effect.runPromise(store.getCredential("ai")),
    ).toBeUndefined();
    expect(calls.some((c) => c.ref === REFS.getCredential)).toBe(false);
  });

  it("is a no-op (undefined) when no credential ref is wired", async () => {
    const refsNoCred: CloudFunctionRefs = { ...REFS, getCredential: undefined };
    const { client } = fakeClient({});
    const store = await buildStore({
      client,
      refs: refsNoCred,
      tableId: TABLE_ID,
      credentials: { workspaceId: WORKSPACE_ID, scope: "workspace" },
    });
    expect(
      await Effect.runPromise(store.getCredential("ai")),
    ).toBeUndefined();
  });
});

describe("ConvexGridStore — read scaling (#24)", () => {
  /** A registry whose single connector echoes its input back (no network/AI). */
  const echoRegistry = (): Registry => {
    const connector: Connector = {
      id: "test",
      name: "Test",
      category: "test",
      auth: null,
      methods: [
        {
          id: "echo",
          label: "Echo",
          description: "Returns { text } from the input.",
          inputSchema: {},
          batchSize: 1,
          credits: 0,
          run: async (inputs) => ({ text: String(inputs.value ?? "") }),
        },
      ],
    };
    return new Registry([connector]);
  };

  /** Build a grid of N rows with one function column referencing a manual one. */
  const grid = (n: number) => {
    const manual = {
      _id: "col_manual",
      tableId: TABLE_ID,
      name: "Name",
      type: "text",
      kind: "manual",
      provider: null,
      method: null,
      code: null,
      params: {},
      position: 0,
      createdAt: 1,
    };
    const fn = {
      _id: "col_fn",
      tableId: TABLE_ID,
      name: "Out",
      type: "text",
      kind: "function",
      provider: "test",
      method: "echo",
      code: null,
      params: { value: "{{Name}}" },
      position: 1,
      createdAt: 2,
    };
    const rows = Array.from({ length: n }, (_, i) => ({
      _id: `row_${i}`,
      tableId: TABLE_ID,
      position: i,
      createdAt: 10 + i,
    }));
    const cells = rows.map((r) => ({
      rowId: r._id,
      columnId: manual._id,
      value: `v${r.position}`,
      status: "done" as const,
      error: null,
      updatedAt: 100,
    }));
    return { columns: [manual, fn], rows, cells };
  };

  /** Run `col_fn` over an N-row grid; return the getTable query count. */
  const getTableCallsFor = async (n: number): Promise<number> => {
    const { client, calls } = fakeClient(grid(n));
    const store = await buildStore({ client, refs: REFS, tableId: TABLE_ID });
    const engine = new Engine(
      // Opt out of the safety-default throttle: this test measures read scaling
      // over 30 rows, not rate limiting, so it must run at full speed.
      { defaultRateLimit: {} },
      echoRegistry(),
      { store, creds: store },
    );
    const res = await engine.runColumn("col_fn");
    expect(res).toEqual({ ran: n, errors: 0 });
    return calls.filter((c) => c.ref === REFS.getTable).length;
  };

  it("issues O(N) getTable reads (a per-run snapshot), not O(N^2)", async () => {
    const small = await getTableCallsFor(3);
    const large = await getTableCallsFor(30);

    // The snapshot fetches the grid once per run regardless of row count, so the
    // count is flat. The load-bearing guarantee is sub-quadratic: doubling rows
    // 10x must NOT multiply reads ~100x (the old per-read refetch did exactly
    // that). Assert the count does not grow with N at all (constant per run).
    expect(small).toBe(1);
    expect(large).toBe(1);
    // Hard upper bound that the pre-fix O(N^2) behaviour would blow through:
    // 30 rows × (getColumn + listRows + per-row getCell/rowCells/listColumns)
    // was well over 100 getTable queries.
    expect(large).toBeLessThan(30);
    // Generous timeout: this runs the QuickJS sandbox per row (×30) and can
    // exceed the 5s default under full-suite concurrency — the assertion is
    // about read COUNT, not speed, so a flake here is purely a timing artifact.
  }, 30000);
});

/**
 * Engine Db-free construction (no better-sqlite3, no Convex) — the load-bearing
 * acceptance criterion for the cloud path. We build an `Engine` with NO `Db` and
 * a hand-written in-memory {@link GridStoreShape} (not even the Convex store) and
 * prove `runColumn` runs end-to-end and writes a cell THROUGH the injected store.
 * This guards the contract independently of Convex: the engine only needs a
 * GridStore, never a Db.
 */
describe("Engine — Db-free construction over an injected fake store", () => {
  /** A registry whose single connector upper-cases its `value` input. */
  const upperRegistry = (): Registry => {
    const connector: Connector = {
      id: "test",
      name: "Test",
      category: "test",
      auth: null,
      methods: [
        {
          id: "upper",
          label: "Upper",
          description: "Uppercases the input value.",
          inputSchema: {},
          batchSize: 1,
          credits: 0,
          run: async (inputs) => ({ text: String(inputs.value ?? "").toUpperCase() }),
        },
      ],
    };
    return new Registry([connector]);
  };

  /**
   * A minimal in-memory {@link GridStoreShape} over plain Maps. No SQLite, no
   * Convex — purely the engine's storage contract, so a passing run proves the
   * engine reads/writes only through the injected store.
   */
  function memoryStore(columns: Column[], rows: Row[]): {
    store: GridStoreShape;
    cells: Map<string, Cell>;
  } {
    const key = (rowId: string, columnId: string) => `${rowId}::${columnId}`;
    const cells = new Map<string, Cell>();
    const ok = <A>(value: A): Effect.Effect<A, GridStoreError> =>
      Effect.succeed(value);
    const store: GridStoreShape = {
      getColumn: (id) => ok(columns.find((c) => c.id === id)),
      listColumns: (tableId) =>
        ok(columns.filter((c) => c.table_id === tableId)),
      listRows: (tableId) => ok(rows.filter((r) => r.table_id === tableId)),
      rowCells: (rowId) =>
        ok(
          new Map(
            [...cells.values()]
              .filter((c) => c.row_id === rowId)
              .map((c) => [c.column_id, c]),
          ),
        ),
      getCell: (rowId, columnId) => ok(cells.get(key(rowId, columnId))),
      setCell: (rowId, columnId, patch: CellPatch) => {
        const prev = cells.get(key(rowId, columnId));
        cells.set(key(rowId, columnId), {
          row_id: rowId,
          column_id: columnId,
          value: "value" in patch ? patch.value : prev?.value ?? null,
          status: patch.status ?? prev?.status ?? "empty",
          error: patch.error ?? null,
          updated_at: Date.now(),
        });
        return ok(undefined);
      },
      getCredential: () => ok(undefined),
    };
    return { store, cells };
  }

  it("constructs with no Db and runColumn writes a cell via the injected store", async () => {
    const nameCol: Column = {
      id: "c_name", table_id: "t1", name: "Name", type: "text", kind: "manual",
      provider: null, method: null, code: null, params: {}, position: 0, created_at: 1,
    };
    const upperCol: Column = {
      id: "c_upper", table_id: "t1", name: "Upper", type: "text", kind: "function",
      provider: "test", method: "upper", code: null, params: { value: "{{Name}}" },
      position: 1, created_at: 2,
    };
    const row: Row = { id: "r1", table_id: "t1", position: 0, created_at: 1 };
    const { store, cells } = memoryStore([nameCol, upperCol], [row]);
    cells.set("r1::c_name", {
      row_id: "r1", column_id: "c_name", value: "ada", status: "done", error: null, updated_at: 1,
    });

    // The injected store backs BOTH project data and credentials — no Db exists.
    const engine = new Engine({}, upperRegistry(), {
      store,
      creds: store,
    });

    const res = await engine.runColumn("c_upper");
    expect(res).toEqual({ ran: 1, errors: 0 });

    const written = cells.get("r1::c_upper");
    expect(written?.value).toBe("ADA");
    expect(written?.status).toBe("done");
  });
});
