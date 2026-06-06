/**
 * Tests for cascade-delete planning (CascadePlanner).
 *
 * Outcome-focused (docs/effect-conventions.md): we assert the full set and
 * ORDER of document ids a delete cascades to — children before parents, parent
 * included, de-duplicated — covering the table / column / row delete paths the
 * acceptance criteria require.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CascadePlanner, type DeletePlan } from "./cascade.js";

const run = <A>(effect: Effect.Effect<A, never, CascadePlanner>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(CascadePlanner.Default)));

const indexOf = (plan: DeletePlan, id: string) => plan.ids.indexOf(id);

describe("CascadePlanner.planDeleteTable", () => {
  it("includes all cells, rows, columns AND the table itself", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteTable("t1", {
          columnIds: ["c1", "c2"],
          rowIds: ["r1", "r2"],
          cellIds: ["cell1", "cell2", "cell3"],
        });
      }),
    );
    expect(new Set(plan.ids)).toEqual(
      new Set(["c1", "c2", "r1", "r2", "cell1", "cell2", "cell3", "t1"]),
    );
  });

  it("orders children before the parent table (no orphan mid-cascade)", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteTable("t1", {
          columnIds: ["c1"],
          rowIds: ["r1"],
          cellIds: ["cell1"],
        });
      }),
    );
    // cells, rows, columns all precede the table id
    expect(indexOf(plan, "cell1")).toBeLessThan(indexOf(plan, "t1"));
    expect(indexOf(plan, "r1")).toBeLessThan(indexOf(plan, "t1"));
    expect(indexOf(plan, "c1")).toBeLessThan(indexOf(plan, "t1"));
  });

  it("handles an empty table (only the table id)", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteTable("t1", {
          columnIds: [],
          rowIds: [],
          cellIds: [],
        });
      }),
    );
    expect(plan.ids).toEqual(["t1"]);
  });
});

describe("CascadePlanner.planDeleteColumn", () => {
  it("deletes the column's cells then the column", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteColumn("col", ["cellA", "cellB"]);
      }),
    );
    // Spec (cascade.ts): deleteColumn → every cell in that column, THEN the
    // column itself (children-first). The expected order is written from that
    // contract — distinct id names from the input so it cannot simply mirror the
    // implementation's `[...cellIds, columnId]` literal.
    expect(plan.ids).toEqual(["cellA", "cellB", "col"]);
    // Re-assert the underlying spec invariants independent of the literal:
    expect(plan.ids.at(-1)).toBe("col"); // parent deleted last
    expect(plan.ids.indexOf("cellA")).toBeLessThan(plan.ids.indexOf("col"));
    expect(plan.ids.indexOf("cellB")).toBeLessThan(plan.ids.indexOf("col"));
  });

  it("deletes only the column when it has no cells", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteColumn("col", []);
      }),
    );
    expect(plan.ids).toEqual(["col"]);
  });
});

describe("CascadePlanner.planDeleteRow", () => {
  it("deletes the row's cells then the row", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteRow("row", ["cellA", "cellB"]);
      }),
    );
    // Spec (cascade.ts): deleteRow → every cell in that row, THEN the row itself
    // (children-first). Expected order hardcoded from that contract.
    expect(plan.ids).toEqual(["cellA", "cellB", "row"]);
    expect(plan.ids.at(-1)).toBe("row"); // parent deleted last
    expect(plan.ids.indexOf("cellA")).toBeLessThan(plan.ids.indexOf("row"));
    expect(plan.ids.indexOf("cellB")).toBeLessThan(plan.ids.indexOf("row"));
  });

  it("de-duplicates if a cell id somehow repeats", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteRow("row", ["cellA", "cellA"]);
      }),
    );
    expect(plan.ids).toEqual(["cellA", "row"]);
  });
});
