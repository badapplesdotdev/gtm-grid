/**
 * Scope + page tests for the cloud grid store (perf at scale). A FAKE client
 * records every grid read so we prove the engine NEVER loads a whole grid when
 * it doesn't have to:
 *   - a ROW-SCOPED run fetches only its rows via `getTableForRows` (zero full
 *     `getTable`),
 *   - a FULL-column run STREAMS the grid via keyset `getTablePage` (one page at
 *     a time, zero full `getTable`), writing every row exactly once,
 *   - both produce the SAME cell values as the legacy single-snapshot path, and
 *   - when a ref is absent the store falls back to the full `getTable` (graceful
 *     degradation), so an old worker still works.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CloudSchemaMapping } from "./cloud-schema.js";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import {
  cloudGridStoreShape,
  type CloudClientLike,
  type CloudFunctionRefs,
  type CloudGridStoreConfig,
} from "./store-cloud.js";
import type { GridStoreShape } from "./store.js";
import type { Connector } from "./types.js";

const TABLE_ID = "tbl_1";

const REFS: CloudFunctionRefs = {
  getTable: { kind: "getTable" },
  getTableForRows: { kind: "getTableForRows" },
  getTablePage: { kind: "getTablePage" },
  setCell: { kind: "setCell" },
  setCellStatus: { kind: "setCellStatus" },
  setCells: { kind: "setCells" },
};

/** A connector whose single method echoes its `value` input back as text. */
const echoRegistry = (): Registry =>
  new Registry([
    {
      id: "test",
      name: "Test",
      category: "test",
      auth: null,
      methods: [
        {
          id: "echo",
          label: "Echo",
          description: "Returns { text } from the input value.",
          inputSchema: {},
          batchSize: 1,
          credits: 0,
          run: async (inputs: Record<string, unknown>) => ({
            text: `echo:${String(inputs.value ?? "")}`,
          }),
        },
      ],
    } satisfies Connector,
  ]);

/** Build an N-row grid: a manual `Name` column + a function `Out` = echo({{Name}}). */
const buildGrid = (n: number) => {
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

interface Call {
  readonly ref: unknown;
  readonly args: Record<string, unknown>;
}

/**
 * A fake client serving one table's grid, with a tunable set of WIRED read refs
 * so a test can prove fallback when a ref is absent. Records every call and
 * collects the terminal `setCells` writes so we can assert what was written.
 */
function fakeClient(
  n: number,
  opts?: { pageSize?: number; wired?: Partial<Record<string, boolean>> },
): { client: CloudClientLike; calls: Call[]; written: Map<string, unknown> } {
  const grid = buildGrid(n);
  const pageSize = opts?.pageSize ?? 200;
  const calls: Call[] = [];
  const written = new Map<string, unknown>();
  const cellsForRows = (rowIds: ReadonlySet<string>) =>
    grid.cells.filter((c) => rowIds.has(c.rowId));

  const client: CloudClientLike = {
    query: async (ref, args) => {
      calls.push({ ref, args });
      if (ref === REFS.getTable) {
        return { columns: grid.columns, rows: grid.rows, cells: grid.cells };
      }
      if (ref === REFS.getTableForRows) {
        const ids = new Set((args.rowIds as string[]) ?? []);
        return {
          columns: grid.columns,
          rows: grid.rows.filter((r) => ids.has(r._id)),
          cells: cellsForRows(ids),
        };
      }
      if (ref === REFS.getTablePage) {
        const start = (args.cursor as number | null) ?? 0;
        const limit = (args.limit as number) ?? pageSize;
        const pageRows = grid.rows.slice(start, start + limit);
        const nextStart = start + limit;
        const ids = new Set(pageRows.map((r) => r._id));
        return {
          columns: grid.columns,
          rows: pageRows,
          cells: cellsForRows(ids),
          nextCursor: nextStart < grid.rows.length ? nextStart : null,
        };
      }
      throw new Error(`unexpected query ref: ${JSON.stringify(ref)}`);
    },
    mutation: async (ref, args) => {
      calls.push({ ref, args });
      if (ref === REFS.setCells) {
        for (const c of (args.cells as { rowId: string; value: unknown }[]) ?? []) {
          written.set(c.rowId, c.value);
        }
      }
      return "ok";
    },
  };
  return { client, calls, written };
}

const buildStore = (config: CloudGridStoreConfig): Promise<GridStoreShape> =>
  Effect.runPromise(
    cloudGridStoreShape(config).pipe(Effect.provide(CloudSchemaMapping.Default)),
  );

const countRef = (calls: Call[], ref: unknown) =>
  calls.filter((c) => c.ref === ref).length;

const runFn = async (
  client: CloudClientLike,
  refs: CloudFunctionRefs,
  rowIds?: string[],
) => {
  const store = await buildStore({ client, refs, tableId: TABLE_ID });
  const engine = new Engine({ defaultRateLimit: {} }, echoRegistry(), {
    store,
    creds: store,
  });
  return engine.runColumn("col_fn", rowIds ? { rowIds, force: true } : { force: true });
};

describe("cloud store — row-scoped run (getTableForRows)", () => {
  it("fetches ONLY the scoped rows via getTableForRows, never the full getTable", async () => {
    const { client, calls, written } = fakeClient(50);
    const res = await runFn(client, REFS, ["row_3", "row_7"]);

    expect(res.ran).toBe(2);
    expect(res.errors).toBe(0);
    // The scoped read was used; the full-grid read was never touched.
    expect(countRef(calls, REFS.getTableForRows)).toBe(1);
    expect(countRef(calls, REFS.getTable)).toBe(0);
    expect(countRef(calls, REFS.getTablePage)).toBe(0);
    // The scope passed through is exactly the requested rows.
    const scoped = calls.find((c) => c.ref === REFS.getTableForRows);
    expect(scoped?.args.rowIds).toEqual(["row_3", "row_7"]);
    // Correct values written for just those rows (engine `simplify` unwraps the
    // single-key { text } response to the bare string).
    expect(written.get("row_3")).toBe("echo:v3");
    expect(written.get("row_7")).toBe("echo:v7");
    expect(written.size).toBe(2);
  });

  it("falls back to the full getTable when getTableForRows is not wired", async () => {
    const refs: CloudFunctionRefs = { ...REFS, getTableForRows: undefined };
    const { client, calls } = fakeClient(10);
    await runFn(client, refs, ["row_1"]);
    expect(countRef(calls, REFS.getTable)).toBe(1);
  });
});

describe("cloud store — full-column run (keyset getTablePage)", () => {
  it("STREAMS the grid one keyset page at a time, never the full getTable", async () => {
    // 450 rows at page size 200 → 3 pages (200 / 200 / 50).
    const { client, calls, written } = fakeClient(450, { pageSize: 200 });
    const res = await runFn(client, REFS);

    expect(res.ran).toBe(450); // summary accumulates across pages
    expect(res.errors).toBe(0);
    expect(countRef(calls, REFS.getTablePage)).toBe(3);
    expect(countRef(calls, REFS.getTable)).toBe(0);
    // Every row written exactly once with its echoed value.
    expect(written.size).toBe(450);
    expect(written.get("row_0")).toBe("echo:v0");
    expect(written.get("row_449")).toBe("echo:v449");
    // Generous timeout: runs the QuickJS sandbox per row (×450) and can exceed
    // the 5s default under full-suite concurrency — the assertions are about the
    // read SHAPE (page count, no full getTable), not speed.
  }, 30000);

  it("matches the legacy full-snapshot values (golden equivalence)", async () => {
    // Paged path.
    const paged = fakeClient(120, { pageSize: 50 });
    await runFn(paged.client, REFS);

    // Legacy single-snapshot path (no getTablePage ref → one getTable).
    const legacyRefs: CloudFunctionRefs = { ...REFS, getTablePage: undefined };
    const legacy = fakeClient(120, { pageSize: 50 });
    await runFn(legacy.client, legacyRefs);

    expect(countRef(legacy.calls, REFS.getTable)).toBe(1);
    expect(countRef(legacy.calls, REFS.getTablePage)).toBe(0);
    // Same cells written by both paths.
    expect([...paged.written.entries()].sort()).toEqual(
      [...legacy.written.entries()].sort(),
    );
  }, 30000);

  it("falls back to a single getTable snapshot when getTablePage is not wired", async () => {
    const refs: CloudFunctionRefs = { ...REFS, getTablePage: undefined };
    const { client, calls } = fakeClient(30);
    const res = await runFn(client, refs);
    expect(res.ran).toBe(30);
    expect(countRef(calls, REFS.getTable)).toBe(1);
    expect(countRef(calls, REFS.getTablePage)).toBe(0);
  });
});
