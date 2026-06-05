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
        return yield* svc.planDeleteColumn("c1", ["cell1", "cell2"]);
      }),
    );
    expect(plan.ids).toEqual(["cell1", "cell2", "c1"]);
  });

  it("deletes only the column when it has no cells", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteColumn("c1", []);
      }),
    );
    expect(plan.ids).toEqual(["c1"]);
  });
});

describe("CascadePlanner.planDeleteRow", () => {
  it("deletes the row's cells then the row", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteRow("r1", ["cell1", "cell2"]);
      }),
    );
    expect(plan.ids).toEqual(["cell1", "cell2", "r1"]);
  });

  it("de-duplicates if a cell id somehow repeats", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const svc = yield* CascadePlanner;
        return yield* svc.planDeleteRow("r1", ["cell1", "cell1"]);
      }),
    );
    expect(plan.ids).toEqual(["cell1", "r1"]);
  });
});
