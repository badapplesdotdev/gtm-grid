/**
 * `CellRepo.listByTableColumn` — the bounded single-column read behind the
 * dedupe sweep (perf at scale). Tested over the in-memory layer so we assert the
 * filter precisely: only the requested table's requested column, never the full
 * rows×columns matrix and never another table's cells.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeGridStore, type StoreCell } from "./grid-store.js";
import { CellRepo, cellRepoLayer, sanitizeCellValue } from "./cell-repo.js";

const cell = (
  id: string,
  tableId: string,
  rowId: string,
  columnId: string,
  value: unknown,
): StoreCell => ({
  id,
  workspaceId: "w",
  tableId,
  rowId,
  columnId,
  value,
  status: "done",
  error: null,
  updatedAt: null,
});

const run = <A>(store: ReturnType<typeof makeGridStore>, columnId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* CellRepo;
      return yield* repo.listByTableColumn("t", columnId);
    }).pipe(Effect.provide(cellRepoLayer(store))),
  );

describe("CellRepo.listByTableColumn", () => {
  const store = makeGridStore({
    cells: [
      cell("1", "t", "r1", "cA", 1),
      cell("2", "t", "r2", "cA", 2),
      cell("3", "t", "r1", "cB", 9), // other column
      cell("4", "t2", "r9", "cA", 7), // other table
    ],
  });

  it("returns ONLY the requested column's cells in this table", async () => {
    const cells = await run(store, "cA");
    expect(cells.map((c) => c.id).sort()).toEqual(["1", "2"]);
    // never the sibling column or another table's same-named column
    expect(cells.some((c) => c.columnId === "cB")).toBe(false);
    expect(cells.some((c) => c.tableId === "t2")).toBe(false);
  });

  it("returns [] for a column with no cells", async () => {
    expect(await run(store, "cZ")).toEqual([]);
  });
});

describe("sanitizeCellValue", () => {
  it("leaves ordinary strings (incl. valid emoji pairs) untouched", () => {
    expect(sanitizeCellValue("hello, world")).toBe("hello, world");
    expect(sanitizeCellValue("emoji 😀 ok")).toBe("emoji 😀 ok");
  });

  it("strips NUL bytes that Postgres jsonb rejects", () => {
    expect(sanitizeCellValue("a\u0000b\u0000c")).toBe("abc");
  });

  it("replaces lone surrogates (invalid UTF-8) with U+FFFD", () => {
    // Lone high surrogate, then lone low surrogate.
    expect(sanitizeCellValue("x\uD800y")).toBe("x\uFFFDy");
    expect(sanitizeCellValue("x\uDC00y")).toBe("x\uFFFDy");
  });

  it("recurses into arrays and object values AND keys", () => {
    expect(
      sanitizeCellValue({ ["k\u0000ey"]: ["a\u0000", { z: "b\u0000" }] }),
    ).toEqual({ key: ["a", { z: "b" }] });
  });

  it("leaves non-string primitives unchanged", () => {
    expect(sanitizeCellValue(42)).toBe(42);
    expect(sanitizeCellValue(true)).toBe(true);
    expect(sanitizeCellValue(null)).toBe(null);
    expect(sanitizeCellValue(undefined)).toBe(undefined);
  });
});
