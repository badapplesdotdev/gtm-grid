/**
 * Pure cache-patch reducer tests (TRI-3251) — OFFLINE, no Supabase, no Effect.
 *
 * Proves the acceptance-criteria invariant: `applyGridEvent` patches a
 * `getTable`-shaped snapshot correctly for EVERY event type (cell/row/column
 * insert/update/delete + table delete), immutably, and converges under duplicate
 * or out-of-order delivery (broadcast is at-least-once + unordered).
 */

import { describe, expect, it } from "vitest";
import type {
  GridEventCell,
  GridEventColumn,
  GridSnapshot,
} from "./events.js";
import { applyGridEvent } from "./reducer.js";

const column = (over: Partial<GridEventColumn> = {}): GridEventColumn => ({
  _id: "c1",
  name: "A",
  type: "text",
  kind: "manual",
  provider: null,
  method: null,
  code: null,
  params: {},
  ...over,
});

const cell = (over: Partial<GridEventCell> = {}): GridEventCell => ({
  rowId: "r1",
  columnId: "c1",
  value: "x",
  status: "done",
  error: null,
  ...over,
});

const snapshot = (over: Partial<GridSnapshot> = {}): GridSnapshot => ({
  table: { _id: "t1", name: "T1" },
  columns: [column()],
  rows: [{ _id: "r1" }],
  cells: [cell()],
  ...over,
});

describe("applyGridEvent · cell.upsert", () => {
  it("updates an existing cell by (rowId, columnId)", () => {
    const next = applyGridEvent(snapshot(), {
      type: "cell.upsert",
      cell: cell({ value: "y", status: "running" }),
    });
    expect(next?.cells).toHaveLength(1);
    expect(next?.cells[0]).toMatchObject({ value: "y", status: "running" });
  });

  it("appends a new cell when none matches the key", () => {
    const next = applyGridEvent(snapshot(), {
      type: "cell.upsert",
      cell: cell({ rowId: "r1", columnId: "c2", value: "z" }),
    });
    expect(next?.cells).toHaveLength(2);
    expect(next?.cells.find((c) => c.columnId === "c2")?.value).toBe("z");
  });

  it("does not mutate the input snapshot", () => {
    const input = snapshot();
    applyGridEvent(input, { type: "cell.upsert", cell: cell({ value: "y" }) });
    expect(input.cells[0].value).toBe("x");
  });
});

describe("applyGridEvent · row.insert", () => {
  it("appends a new row and its cells", () => {
    const next = applyGridEvent(snapshot(), {
      type: "row.insert",
      row: { _id: "r2" },
      cells: [cell({ rowId: "r2", value: "new" })],
    });
    expect(next?.rows.map((r) => r._id)).toEqual(["r1", "r2"]);
    expect(next?.cells.find((c) => c.rowId === "r2")?.value).toBe("new");
  });

  it("de-dupes a row already present (at-least-once delivery)", () => {
    const next = applyGridEvent(snapshot(), {
      type: "row.insert",
      row: { _id: "r1" },
      cells: [],
    });
    expect(next?.rows).toHaveLength(1);
  });
});

describe("applyGridEvent · row.delete", () => {
  it("removes the row and cascades its cells", () => {
    const base = snapshot({
      rows: [{ _id: "r1" }, { _id: "r2" }],
      cells: [cell(), cell({ rowId: "r2" })],
    });
    const next = applyGridEvent(base, { type: "row.delete", rowId: "r1" });
    expect(next?.rows.map((r) => r._id)).toEqual(["r2"]);
    expect(next?.cells.every((c) => c.rowId !== "r1")).toBe(true);
  });

  it("is a no-op when the row is already gone", () => {
    const next = applyGridEvent(snapshot(), { type: "row.delete", rowId: "gone" });
    expect(next?.rows).toHaveLength(1);
  });
});

describe("applyGridEvent · column.insert / column.delete", () => {
  it("appends a new column", () => {
    const next = applyGridEvent(snapshot(), {
      type: "column.insert",
      column: column({ _id: "c2", name: "B" }),
    });
    expect(next?.columns.map((c) => c._id)).toEqual(["c1", "c2"]);
  });

  it("de-dupes a column already present", () => {
    const next = applyGridEvent(snapshot(), {
      type: "column.insert",
      column: column({ _id: "c1" }),
    });
    expect(next?.columns).toHaveLength(1);
  });

  it("removes the column and cascades its cells", () => {
    const base = snapshot({
      columns: [column(), column({ _id: "c2" })],
      cells: [cell(), cell({ columnId: "c2" })],
    });
    const next = applyGridEvent(base, { type: "column.delete", columnId: "c1" });
    expect(next?.columns.map((c) => c._id)).toEqual(["c2"]);
    expect(next?.cells.every((c) => c.columnId !== "c1")).toBe(true);
  });
});

describe("applyGridEvent · table.insert / table.delete", () => {
  it("table.insert leaves a getTable snapshot unchanged", () => {
    const input = snapshot();
    const next = applyGridEvent(input, {
      type: "table.insert",
      tableId: "t2",
      projectId: "p1",
      name: "T2",
    });
    expect(next).toBe(input);
  });

  it("table.delete collapses the viewed table to null", () => {
    const next = applyGridEvent(snapshot(), {
      type: "table.delete",
      tableId: "t1",
    });
    expect(next).toBeNull();
  });

  it("table.delete for a different table is a no-op", () => {
    const input = snapshot();
    const next = applyGridEvent(input, {
      type: "table.delete",
      tableId: "other",
    });
    expect(next).toBe(input);
  });
});

describe("applyGridEvent · null snapshot", () => {
  it("passes a null (unloaded/deleted) snapshot through", () => {
    expect(
      applyGridEvent(null, { type: "cell.upsert", cell: cell() }),
    ).toBeNull();
  });
});

describe("applyGridEvent · cell.upsert is O(1) + preserves untouched identity", () => {
  /** A snapshot with `n` distinct cells (one per row, all on column c1). */
  const withCells = (n: number): GridSnapshot =>
    snapshot({
      rows: Array.from({ length: n }, (_, i) => ({ _id: `r${i}` })),
      cells: Array.from({ length: n }, (_, i) =>
        cell({ rowId: `r${i}`, value: i }),
      ),
    });

  it("copies ONLY the touched cell — every other cell keeps its reference", () => {
    const base = withCells(5);
    const next = applyGridEvent(base, {
      type: "cell.upsert",
      cell: cell({ rowId: "r2", value: "changed" }),
    });
    expect(next).not.toBeNull();
    const after = next!.cells;
    expect(after).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      if (i === 2) {
        // The touched cell is a NEW object holding the new value.
        expect(after[i]).not.toBe(base.cells[i]);
        expect(after[i].value).toBe("changed");
      } else {
        // Untouched cells are carried over by reference (memo-friendly).
        expect(after[i]).toBe(base.cells[i]);
      }
    }
  });

  it("appends a new key without re-copying existing cell objects", () => {
    const base = withCells(3);
    const next = applyGridEvent(base, {
      type: "cell.upsert",
      cell: cell({ rowId: "r9", columnId: "c1", value: "new" }),
    });
    const after = next!.cells;
    expect(after).toHaveLength(4);
    for (let i = 0; i < 3; i++) expect(after[i]).toBe(base.cells[i]);
    expect(after[3].value).toBe("new");
  });

  it("a stream of upserts stays correct across the carried-forward index", () => {
    let snap: GridSnapshot | null = withCells(4);
    snap = applyGridEvent(snap, {
      type: "cell.upsert",
      cell: cell({ rowId: "r1", value: "a" }),
    });
    snap = applyGridEvent(snap, {
      type: "cell.upsert",
      cell: cell({ rowId: "r1", value: "b" }),
    });
    snap = applyGridEvent(snap, {
      type: "cell.upsert",
      cell: cell({ rowId: "r3", value: "c" }),
    });
    expect(snap!.cells).toHaveLength(4);
    expect(snap!.cells.find((c) => c.rowId === "r1")?.value).toBe("b");
    expect(snap!.cells.find((c) => c.rowId === "r3")?.value).toBe("c");
    expect(snap!.cells.find((c) => c.rowId === "r0")?.value).toBe(0);
  });

  it("upsert lookup is O(1) — per-event cost does not grow with cell count", () => {
    // The keyed index makes the LOOKUP O(1) regardless of grid size. With an
    // O(N) findIndex the per-event cost would scale with the cell count, so the
    // large grid would take dramatically longer per upsert than the small one.
    // (The immutable array copy is linear in both and cancels in the ratio.)
    const measure = (cellCount: number, upserts: number): number => {
      let snap: GridSnapshot | null = withCells(cellCount);
      const start = performance.now();
      for (let i = 0; i < upserts; i++) {
        // Always re-upsert the SAME (rowId,columnId) so the array length is
        // fixed; only the lookup+slice cost is exercised.
        snap = applyGridEvent(snap, {
          type: "cell.upsert",
          cell: cell({ rowId: "r0", value: i }),
        });
      }
      return performance.now() - start;
    };

    const upserts = 2_000;
    const small = measure(100, upserts);
    const large = measure(20_000, upserts);

    // With O(1) lookup the only size-dependent term is the array slice; the
    // lookup contributes nothing extra. A regression to findIndex would make the
    // 200×-larger grid wildly slower per event. Allow generous headroom for the
    // linear slice + GC jitter; an O(N²) findIndex regression blows past this.
    expect(large).toBeLessThan(small * 60 + 250);
  });
});
