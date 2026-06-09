/**
 * Unit tests for the five grid repositories' in-memory Test Layers (Project,
 * Table, Column, Row, Cell) over the shared {@link GridStore}, plus the cascade
 * helpers — all OFFLINE, no live database. Proves each repo method's behaviour
 * and the FK-cascade mirror (deleting a table/column/row removes its children).
 */

import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  cascadeDeleteColumn,
  cascadeDeleteRow,
  cascadeDeleteTable,
  makeGridStore,
  type StoreCell,
  type StoreColumn,
  type StoreRow,
  type StoreTable,
} from "./grid-store.js";
import {
  cellRepoLayer,
  CELL_INSERT_CHUNK_SIZE,
  chunk,
  type NewCell,
} from "./cell-repo.js";
import { columnRepoLayer } from "./column-repo.js";
import { projectRepoLayer } from "./project-repo.js";
import { rowRepoLayer } from "./row-repo.js";
import { tableRepoLayer } from "./table-repo.js";
import { ProjectRepo } from "./project-repo.js";
import { TableRepo } from "./table-repo.js";
import { ColumnRepo } from "./column-repo.js";
import { RowRepo } from "./row-repo.js";
import { CellRepo } from "./cell-repo.js";

const WS = "ws-1";

const seedTables = (): StoreTable[] => [
  { id: "t1", workspaceId: WS, projectId: "p1", name: "T1", position: 1, createdAt: 1 },
  { id: "t2", workspaceId: WS, projectId: "p1", name: "T2", position: 0, createdAt: 2 },
];
const seedColumns = (): StoreColumn[] => [
  {
    id: "c1", workspaceId: WS, tableId: "t1", name: "A", type: "text",
    kind: "manual", provider: null, method: null, code: null, params: {},
    position: 0, createdAt: 1,
  },
];
const seedRows = (): StoreRow[] => [
  { id: "r1", workspaceId: WS, tableId: "t1", position: 0, createdAt: 1 },
];
const seedCells = (): StoreCell[] => [
  {
    id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1",
    value: "x", status: "done", error: null, updatedAt: 1,
  },
];

const run = <A, E, R>(layer: import("effect").Layer.Layer<R>) =>
  (program: Effect.Effect<A, E, R>) =>
    Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

describe("projectRepoLayer", () => {
  it("inserts a project then lists it by workspace in creation order", async () => {
    const store = makeGridStore();
    const r = run(projectRepoLayer(store));
    await r(Effect.flatMap(ProjectRepo, (s) => s.insert({ workspaceId: WS, name: "P1", createdAt: 2 })));
    await r(Effect.flatMap(ProjectRepo, (s) => s.insert({ workspaceId: WS, name: "P0", createdAt: 1 })));
    const exit = await r(Effect.flatMap(ProjectRepo, (s) => s.listByWorkspace(WS)));
    expect(Exit.isSuccess(exit) && exit.value.map((p) => p.name)).toEqual(["P0", "P1"]);
  });

  it("findById returns None for a missing id", async () => {
    const exit = await run(projectRepoLayer(makeGridStore()))(
      Effect.flatMap(ProjectRepo, (s) => s.findById("nope")),
    );
    expect(Exit.isSuccess(exit) && Option.isNone(exit.value)).toBe(true);
  });
});

describe("tableRepoLayer", () => {
  it("lists a project's tables ordered by position then creation", async () => {
    const store = makeGridStore({ tables: seedTables() });
    const exit = await run(tableRepoLayer(store))(
      Effect.flatMap(TableRepo, (s) => s.listByProject("p1")),
    );
    expect(Exit.isSuccess(exit) && exit.value.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("remove cascades to the table's columns, rows, and cells", async () => {
    const store = makeGridStore({
      tables: seedTables(), columns: seedColumns(), rows: seedRows(), cells: seedCells(),
    });
    await run(tableRepoLayer(store))(Effect.flatMap(TableRepo, (s) => s.remove("t1")));
    expect(store.tables.find((t) => t.id === "t1")).toBeUndefined();
    expect(store.columns).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    expect(store.cells).toHaveLength(0);
    // t2 (a sibling table) is untouched.
    expect(store.tables.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("columnRepoLayer", () => {
  it("remove cascades to only that column's cells", async () => {
    const cells = [
      ...seedCells(),
      { id: "cell2", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c2", value: "y", status: "done", error: null, updatedAt: 1 },
    ];
    const store = makeGridStore({ columns: seedColumns(), rows: seedRows(), cells });
    await run(columnRepoLayer(store))(Effect.flatMap(ColumnRepo, (s) => s.remove("c1")));
    expect(store.columns).toHaveLength(0);
    // Only c1's cell removed; c2's cell remains.
    expect(store.cells.map((c) => c.columnId)).toEqual(["c2"]);
  });
});

describe("rowRepoLayer", () => {
  it("insertMany returns ids in input order and appends to the store", async () => {
    const store = makeGridStore();
    const exit = await run(rowRepoLayer(store))(
      Effect.flatMap(RowRepo, (s) =>
        s.insertMany([
          { workspaceId: WS, tableId: "t1", position: 0, createdAt: 1 },
          { workspaceId: WS, tableId: "t1", position: 1, createdAt: 1 },
        ]),
      ),
    );
    expect(Exit.isSuccess(exit) && exit.value).toHaveLength(2);
    expect(store.rows).toHaveLength(2);
  });

  it("remove cascades to only that row's cells", async () => {
    const cells = [
      ...seedCells(),
      { id: "cell2", workspaceId: WS, tableId: "t1", rowId: "r2", columnId: "c1", value: "y", status: "done", error: null, updatedAt: 1 },
    ];
    const rows = [...seedRows(), { id: "r2", workspaceId: WS, tableId: "t1", position: 1, createdAt: 1 }];
    const store = makeGridStore({ rows, cells });
    await run(rowRepoLayer(store))(Effect.flatMap(RowRepo, (s) => s.remove("r1")));
    expect(store.rows.map((r) => r.id)).toEqual(["r2"]);
    expect(store.cells.map((c) => c.rowId)).toEqual(["r2"]);
  });

  // TRI-3272: keyset paging by row position — a page never loads the whole
  // table, and walking the cursor returns the SAME rows in the SAME order an
  // unbounded listByTable would, with the last page reporting nextCursor=null.
  describe("listKeysetByTable (TRI-3272)", () => {
    const pageStore = () =>
      makeGridStore({
        rows: [
          { id: "r1", workspaceId: WS, tableId: "t1", position: 0, createdAt: 1 },
          { id: "r2", workspaceId: WS, tableId: "t1", position: 1, createdAt: 1 },
          { id: "r3", workspaceId: WS, tableId: "t1", position: 2, createdAt: 1 },
          { id: "r4", workspaceId: WS, tableId: "t1", position: 3, createdAt: 1 },
          { id: "r5", workspaceId: WS, tableId: "t1", position: 4, createdAt: 1 },
          // A different table's row must never leak into a page.
          { id: "x1", workspaceId: WS, tableId: "t2", position: 0, createdAt: 1 },
        ],
      });

    it("returns the first page in position order with a nextCursor", async () => {
      const exit = await run(rowRepoLayer(pageStore()))(
        Effect.flatMap(RowRepo, (s) =>
          s.listKeysetByTable({ tableId: "t1", limit: 2, cursor: null }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.rows.map((r) => r.id)).toEqual(["r1", "r2"]);
        expect(exit.value.nextCursor).toEqual({ position: 1, createdAt: 1, id: "r2" });
      }
    });

    it("walks every page exactly once across the table and stops at a null cursor on the last page", async () => {
      const r = run(rowRepoLayer(pageStore()));
      const seen: string[] = [];
      let cursor: import("./row-repo.js").RowCursor | null = null;
      // Bound the loop so a paging bug can't spin forever.
      for (let i = 0; i < 10; i++) {
        const exit = await r(
          Effect.flatMap(RowRepo, (s) =>
            s.listKeysetByTable({ tableId: "t1", limit: 2, cursor }),
          ),
        );
        if (!Exit.isSuccess(exit)) throw new Error("page read failed");
        seen.push(...exit.value.rows.map((row) => row.id));
        if (exit.value.nextCursor === null) break;
        cursor = exit.value.nextCursor;
      }
      // 5 rows over pages of 2 → [r1,r2][r3,r4][r5], no duplicates, no t2 leak.
      expect(seen).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    });

    it("returns nextCursor=null when the page is exactly the last (no extra row)", async () => {
      const exit = await run(rowRepoLayer(pageStore()))(
        Effect.flatMap(RowRepo, (s) =>
          s.listKeysetByTable({ tableId: "t1", limit: 5, cursor: null }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value.rows).toHaveLength(5);
        expect(exit.value.nextCursor).toBeNull();
      }
    });

    it("tie-breaks rows sharing a position by createdAt then id (stable order)", async () => {
      const store = makeGridStore({
        rows: [
          { id: "rb", workspaceId: WS, tableId: "t1", position: 0, createdAt: 5 },
          { id: "ra", workspaceId: WS, tableId: "t1", position: 0, createdAt: 5 },
          { id: "rc", workspaceId: WS, tableId: "t1", position: 0, createdAt: 9 },
        ],
      });
      const exit = await run(rowRepoLayer(store))(
        Effect.flatMap(RowRepo, (s) =>
          s.listKeysetByTable({ tableId: "t1", limit: 10, cursor: null }),
        ),
      );
      // Equal position → by createdAt asc (5 before 9), ties by id asc (ra<rb).
      expect(Exit.isSuccess(exit) && exit.value.rows.map((r) => r.id)).toEqual([
        "ra",
        "rb",
        "rc",
      ]);
    });
  });

  // TRI-3271: addRowsWithCells now uses the atomic bulkImport (one bulk row
  // insert + cells + meter in one transaction) instead of N per-row INSERTs.
  it("bulkImport inserts a multi-row payload via ONE bulk path (rows + cells + meter), ids in input order", async () => {
    const store = makeGridStore();
    let metered = 0;
    const r = run(rowRepoLayer(store, (_ws, n) => (metered += n)));
    const exit = await r(
      Effect.flatMap(RowRepo, (s) =>
        s.bulkImport({
          rows: [
            { workspaceId: WS, tableId: "t1", position: 0, createdAt: 1 },
            { workspaceId: WS, tableId: "t1", position: 1, createdAt: 1 },
            { workspaceId: WS, tableId: "t1", position: 2, createdAt: 1 },
          ],
          // Cells reference rows by their returned id (input order), so the
          // mapping below proves ids came back aligned to the input rows.
          buildCells: (ids) =>
            ids.map((rowId, i) => ({
              workspaceId: WS, tableId: "t1", rowId, columnId: "c1",
              value: `v${i}`, status: "done", error: null, updatedAt: 1,
            })),
          meter: { workspaceId: WS, n: 3 },
        }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const ids = Exit.isSuccess(exit) ? exit.value : [];
    // All 3 rows + 3 cells committed in one go; meter bumped once by N.
    expect(store.rows).toHaveLength(3);
    expect(store.cells).toHaveLength(3);
    expect(metered).toBe(3);
    // Cells point at the row ids in input order.
    expect(store.cells.map((c) => c.rowId)).toEqual([...ids]);
    expect(store.cells.map((c) => c.value)).toEqual(["v0", "v1", "v2"]);
  });

  it("bulkImport is atomic: a mid-import failure leaves ZERO rows, cells and no meter bump", async () => {
    const store = makeGridStore({ rows: seedRows() });
    let metered = 0;
    const r = run(rowRepoLayer(store, (_ws, n) => (metered += n)));
    const exit = await r(
      Effect.flatMap(RowRepo, (s) =>
        s.bulkImport({
          rows: [
            { workspaceId: WS, tableId: "t1", position: 1, createdAt: 1 },
            { workspaceId: WS, tableId: "t1", position: 2, createdAt: 1 },
          ],
          // Simulate a failure mid-import (e.g. a bad cell status / DB error).
          buildCells: () => {
            throw new Error("boom mid-import");
          },
          meter: { workspaceId: WS, n: 2 },
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    // Nothing from THIS import committed: only the pre-seeded row remains, no
    // new cells, and the meter was never bumped — no orphaned rows.
    expect(store.rows.map((row) => row.id)).toEqual(["r1"]);
    expect(store.cells).toHaveLength(0);
    expect(metered).toBe(0);
  });
});

describe("cellRepoLayer", () => {
  it("findByRowColumn resolves the single cell at (rowId, columnId)", async () => {
    const store = makeGridStore({ cells: seedCells() });
    const exit = await run(cellRepoLayer(store))(
      Effect.flatMap(CellRepo, (s) => s.findByRowColumn("r1", "c1")),
    );
    expect(Exit.isSuccess(exit) && Option.isSome(exit.value)).toBe(true);
  });

  it("patch updates the merged fields of an existing cell", async () => {
    const store = makeGridStore({ cells: seedCells() });
    await run(cellRepoLayer(store))(
      Effect.flatMap(CellRepo, (s) =>
        s.patch("cell1", { value: "z", status: "running", error: "boom", updatedAt: 9 }),
      ),
    );
    expect(store.cells[0]).toMatchObject({ value: "z", status: "running", error: "boom", updatedAt: 9 });
  });

  it("listByTable returns only that table's cells", async () => {
    const cells = [
      ...seedCells(),
      { id: "cell2", workspaceId: WS, tableId: "t2", rowId: "r9", columnId: "c9", value: "y", status: "done", error: null, updatedAt: 1 },
    ];
    const store = makeGridStore({ cells });
    const exit = await run(cellRepoLayer(store))(
      Effect.flatMap(CellRepo, (s) => s.listByTable("t1")),
    );
    expect(Exit.isSuccess(exit) && exit.value.map((c) => c.id)).toEqual(["cell1"]);
  });

  // TRI-3272: the PAGED getTable reads only the cells of a page's rows, never
  // the whole table's cells.
  it("listByRowIds returns only the cells of the given rows (a page's cells)", async () => {
    const cells = [
      ...seedCells(), // rowId r1
      { id: "cell2", workspaceId: WS, tableId: "t1", rowId: "r2", columnId: "c1", value: "y", status: "done", error: null, updatedAt: 1 },
      { id: "cell3", workspaceId: WS, tableId: "t1", rowId: "r3", columnId: "c1", value: "z", status: "done", error: null, updatedAt: 1 },
    ];
    const store = makeGridStore({ cells });
    const exit = await run(cellRepoLayer(store))(
      Effect.flatMap(CellRepo, (s) => s.listByRowIds(["r1", "r3"])),
    );
    expect(Exit.isSuccess(exit) && exit.value.map((c) => c.id).sort()).toEqual([
      "cell1",
      "cell3",
    ]);
  });

  it("listByRowIds returns [] for an empty row set", async () => {
    const store = makeGridStore({ cells: seedCells() });
    const exit = await run(cellRepoLayer(store))(
      Effect.flatMap(CellRepo, (s) => s.listByRowIds([])),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual([]);
  });

  // TRI-3266 regression: a wide CSV (>8191 cells) must insert across multiple
  // statements without hitting Postgres' 65535 bind-parameter cap, and every
  // cell must land.
  it("insertMany lands all cells when the count exceeds the 8191/statement cap", async () => {
    const store = makeGridStore();
    const total = 8500; // > 65535 / 8 cols ≈ 8191, the single-statement ceiling
    const cells: NewCell[] = Array.from({ length: total }, (_, i) => ({
      workspaceId: WS,
      tableId: "t1",
      rowId: `r${i}`,
      columnId: "c1",
      value: i,
      status: "done",
      error: null,
      updatedAt: 1,
    }));
    const exit = await run(cellRepoLayer(store))(
      Effect.flatMap(CellRepo, (s) => s.insertMany(cells)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(store.cells).toHaveLength(total);
    // No cell was dropped or duplicated across the chunked batches.
    expect(new Set(store.cells.map((c) => c.value)).size).toBe(total);
  });
});

describe("chunk (cell-repo bulk-insert batching)", () => {
  it("splits >8191 cells into batches of at most CELL_INSERT_CHUNK_SIZE", () => {
    const total = 8500;
    const items = Array.from({ length: total }, (_, i) => i);
    const batches = chunk(items, CELL_INSERT_CHUNK_SIZE);
    // Multiple statements, none over the bind-parameter-safe chunk size.
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) {
      expect(b.length).toBeLessThanOrEqual(CELL_INSERT_CHUNK_SIZE);
    }
    // Every item is covered exactly once, in order.
    expect(batches.flat()).toEqual(items);
    // Chosen chunk size stays well under the ~8191 cells/statement ceiling.
    expect(CELL_INSERT_CHUNK_SIZE).toBeLessThanOrEqual(8000);
  });

  it("returns no batches for an empty input and rejects a non-positive size", () => {
    expect(chunk([], CELL_INSERT_CHUNK_SIZE)).toEqual([]);
    expect(() => chunk([1, 2, 3], 0)).toThrow();
  });
});

describe("cascade helpers", () => {
  it("cascadeDeleteTable removes the table and all descendants", () => {
    const store = makeGridStore({
      tables: seedTables(), columns: seedColumns(), rows: seedRows(), cells: seedCells(),
    });
    cascadeDeleteTable(store, "t1");
    expect(store.tables.map((t) => t.id)).toEqual(["t2"]);
    expect(store.columns.concat(store.rows as never[], store.cells as never[])).toHaveLength(0);
  });

  it("cascadeDeleteColumn and cascadeDeleteRow remove only matching cells", () => {
    const store = makeGridStore({ columns: seedColumns(), rows: seedRows(), cells: seedCells() });
    cascadeDeleteColumn(store, "c1");
    expect(store.cells).toHaveLength(0);
    expect(store.columns).toHaveLength(0);
    const store2 = makeGridStore({ rows: seedRows(), cells: seedCells() });
    cascadeDeleteRow(store2, "r1");
    expect(store2.cells).toHaveLength(0);
    expect(store2.rows).toHaveLength(0);
  });
});
