/**
 * Integration tests for the cascade orchestration CloudGrid actually runs
 * (`cascadeDependents` / `runColumnsInDepOrder`). A recording `runOne` captures
 * the EXACT calls — which columns ran, in what order, over which rows, with which
 * `force` flag — so we verify the cascade behaves precisely as specified.
 */

import { describe, expect, it } from "vitest";
import type { MinimalColumn } from "@gtmgrid/services/columns";
import { cascadeDependents, cellIsRunning, runColumnsInDepOrder, type RunOne } from "./gridRun";

function col(id: string, name: string, params: Record<string, unknown> = {}): MinimalColumn {
  return { id, name, kind: "function", provider: null, params };
}

/** A `runOne` that records each call and serializes after a microtask tick. */
function recorder() {
  const calls: Array<{ id: string; force: boolean; rowIds?: string[] }> = [];
  const startOrder: string[] = [];
  const finished = new Set<string>();
  const runOne: RunOne = async (id, opts) => {
    startOrder.push(id);
    calls.push({ id, force: opts.force, rowIds: opts.rowIds });
    await new Promise((r) => setTimeout(r, 2));
    finished.add(id);
  };
  return { calls, startOrder, finished, runOne };
}

// The canonical chain from the feature: A (API) → B (map {{A}}) → C (compute
// {{B}}), plus B2 (a parallel sibling that also reads {{A}}), and an unrelated U.
const CHAIN: MinimalColumn[] = [
  col("a", "A"),
  col("b", "B", { src: "{{A}}" }),
  col("b2", "B2", { src: "{{A}}" }),
  col("c", "C", { src: "{{B}}" }),
  col("u", "U"),
];

describe("cascadeDependents", () => {
  it("runs every transitive dependent for the seed's rows, force=true, in dep order", async () => {
    const { calls, startOrder } = recorder();
    await cascadeDependents(["a"], CHAIN, ["r1", "r2"], 4, runFrom(calls, startOrder));

    const ran = calls.map((c) => c.id).sort();
    expect(ran).toEqual(["b", "b2", "c"]); // A (seed) and U (unrelated) excluded
    // Source before its dependent: B (and B2) must start before C.
    expect(startOrder.indexOf("c")).toBeGreaterThan(startOrder.indexOf("b"));
    expect(startOrder.indexOf("c")).toBeGreaterThan(startOrder.indexOf("b2"));
    // Every cascaded run is force=true and scoped to the seed's rows.
    for (const c of calls) {
      expect(c.force).toBe(true);
      expect(c.rowIds).toEqual(["r1", "r2"]);
    }
  });

  it("scopes a single-cell cascade to that one row", async () => {
    const rec = recorder();
    await cascadeDependents(["a"], CHAIN, ["r7"], 4, rec.runOne);
    expect(rec.calls.every((c) => c.rowIds?.length === 1 && c.rowIds[0] === "r7")).toBe(true);
  });

  it("never starts a dependent before its source finishes", async () => {
    const finished = new Set<string>();
    const order: string[] = [];
    const runOne: RunOne = async (id) => {
      order.push(id);
      if (id === "c") expect(finished.has("b")).toBe(true);
      await new Promise((r) => setTimeout(r, 2));
      finished.add(id);
    };
    await cascadeDependents(["a"], CHAIN, undefined, 4, runOne);
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
  });

  it("is a no-op when the seed has no dependents", async () => {
    const rec = recorder();
    await cascadeDependents(["c"], CHAIN, ["r1"], 4, rec.runOne);
    expect(rec.calls).toEqual([]);
  });

  it("attempts every dependent exactly once even with a dependency cycle", async () => {
    const cyclic = [col("a", "A"), col("x", "X", { src: "{{Y}}" }), col("y", "Y", { src: "{{X}} {{A}}" })];
    const rec = recorder();
    await cascadeDependents(["a"], cyclic, undefined, 4, rec.runOne);
    expect(rec.calls.map((c) => c.id).sort()).toEqual(["x", "y"]);
  });
});

describe("runColumnsInDepOrder (Run all / Run rows)", () => {
  it("runs ALL function columns in dependency order with the given force + rows", async () => {
    const fnCols = CHAIN.filter((c) => c.name !== "U" || true); // all are functions here
    const { calls, startOrder } = recorder2();
    await runColumnsInDepOrder(fnCols, undefined, 4, runFrom(calls, startOrder), true);

    expect(calls.map((c) => c.id).sort()).toEqual(["a", "b", "b2", "c", "u"]);
    expect(startOrder.indexOf("b")).toBeGreaterThan(startOrder.indexOf("a"));
    expect(startOrder.indexOf("c")).toBeGreaterThan(startOrder.indexOf("b"));
    expect(calls.every((c) => c.force === true)).toBe(true);
  });

  it("passes force=false + the row scope (Run selected rows)", async () => {
    const { calls } = recorder2();
    await runColumnsInDepOrder(CHAIN, ["r1"], 4, (id, opts) => {
      calls.push({ id, force: opts.force, rowIds: opts.rowIds });
      return Promise.resolve();
    }, false);
    expect(calls.every((c) => c.force === false && c.rowIds?.[0] === "r1")).toBe(true);
  });
});

// Small helpers so each test can build a fresh recorder inline.
function runFrom(calls: Array<{ id: string; force: boolean; rowIds?: string[] }>, startOrder: string[]): RunOne {
  const finished = new Set<string>();
  return async (id, opts) => {
    startOrder.push(id);
    calls.push({ id, force: opts.force, rowIds: opts.rowIds });
    await new Promise((r) => setTimeout(r, 2));
    finished.add(id);
  };
}
function recorder2() {
  return { calls: [] as Array<{ id: string; force: boolean; rowIds?: string[] }>, startOrder: [] as string[] };
}

describe("cellIsRunning (column-run loading state)", () => {
  const NONE = new Set<string>();

  it("is true when a per-cell run is in flight (regardless of column run)", () => {
    expect(cellIsRunning(new Set(["r1:c1"]), null, "r1", "c1", "done")).toBe(true);
  });

  it("during a column run, shows loading for every UNRESOLVED cell in that column", () => {
    for (const status of [undefined, "empty", "pending", "running"]) {
      expect(cellIsRunning(NONE, "c1", "r1", "c1", status)).toBe(true);
    }
  });

  it("during a column run, KEEPS done/error cells (no flicker back to a spinner)", () => {
    expect(cellIsRunning(NONE, "c1", "r1", "c1", "done")).toBe(false);
    expect(cellIsRunning(NONE, "c1", "r1", "c1", "error")).toBe(false);
  });

  it("does not touch cells in OTHER columns", () => {
    expect(cellIsRunning(NONE, "c1", "r1", "c2", undefined)).toBe(false);
  });

  it("is false when nothing is running", () => {
    expect(cellIsRunning(NONE, null, "r1", "c1", undefined)).toBe(false);
  });
});
