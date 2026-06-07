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
