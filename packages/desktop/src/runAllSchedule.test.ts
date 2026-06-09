/**
 * Run-all scheduler tests (TRI-3279).
 *
 * `runAll` previously looped function columns strictly sequentially. These tests
 * pin the behaviour of the extracted scheduler used by the new implementation:
 *   - buildColumnDeps maps each column to the OTHER columns it references via
 *     {{Name}} placeholders (intra-set edges only).
 *   - runColumnsWithDeps runs independent columns concurrently (up to a bound),
 *     serializes true dependents (a column never starts before its deps finish),
 *     attempts every column exactly once, swallows per-column failures, and
 *     fires the settled callback once per column.
 */

import { describe, expect, it } from "vitest";
import { buildColumnDeps, runColumnsWithDeps } from "./App";
import type { Column } from "./api";

function col(id: string, name: string, params: Record<string, unknown> = {}): Column {
  return { id, name, type: "text", kind: "function", provider: null, method: null, fn: null, params };
}

describe("buildColumnDeps", () => {
  it("returns no edges when columns are independent", () => {
    const cols = [col("a", "Alpha"), col("b", "Beta")];
    const deps = buildColumnDeps(cols);
    expect([...deps.get("a")!]).toEqual([]);
    expect([...deps.get("b")!]).toEqual([]);
  });

  it("records an edge when a column references another by {{Name}}", () => {
    const cols = [
      col("a", "Alpha"),
      col("b", "Beta", { src: "uses {{Alpha}} here" }),
    ];
    const deps = buildColumnDeps(cols);
    expect([...deps.get("b")!]).toEqual(["a"]);
    expect([...deps.get("a")!]).toEqual([]);
  });

  it("ignores references to columns outside the run set", () => {
    // {{Gamma}} is not in `cols`, so it imposes no intra-set ordering.
    const cols = [col("a", "Alpha", { src: "needs {{Gamma}}" })];
    const deps = buildColumnDeps(cols);
    expect([...deps.get("a")!]).toEqual([]);
  });
});

describe("runColumnsWithDeps", () => {
  it("runs every column exactly once", async () => {
    const cols = [col("a", "A"), col("b", "B"), col("c", "C")];
    const ran: string[] = [];
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 4, async (c) => {
      ran.push(c.id);
    });
    expect(ran.sort()).toEqual(["a", "b", "c"]);
  });

  it("fires the settled callback once per column", async () => {
    const cols = [col("a", "A"), col("b", "B")];
    let settled = 0;
    await runColumnsWithDeps(
      cols,
      buildColumnDeps(cols),
      4,
      async () => {},
      () => { settled += 1; },
    );
    expect(settled).toBe(2);
  });

  it("runs independent columns concurrently (bounded)", async () => {
    const cols = [col("a", "A"), col("b", "B"), col("c", "C"), col("d", "D")];
    let active = 0;
    let maxActive = 0;
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 2, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    // With 4 independent columns and a bound of 2, two must overlap, never more.
    expect(maxActive).toBe(2);
  });

  it("never starts a dependent before its dependency finishes", async () => {
    // b depends on a; c depends on b. Must observe strict a -> b -> c order.
    const cols = [
      col("a", "A"),
      col("b", "B", { src: "{{A}}" }),
      col("c", "C", { src: "{{B}}" }),
    ];
    const finished = new Set<string>();
    const startOrder: string[] = [];
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 4, async (c) => {
      startOrder.push(c.id);
      if (c.id === "b") expect(finished.has("a")).toBe(true);
      if (c.id === "c") expect(finished.has("b")).toBe(true);
      await new Promise((r) => setTimeout(r, 2));
      finished.add(c.id);
    });
    expect(startOrder).toEqual(["a", "b", "c"]);
  });

  it("a failing column does not abort the rest of the run", async () => {
    const cols = [col("a", "A"), col("b", "B"), col("c", "C")];
    const ran: string[] = [];
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 4, async (c) => {
      ran.push(c.id);
      if (c.id === "b") throw new Error("boom");
    });
    expect(ran.sort()).toEqual(["a", "b", "c"]);
  });

  it("still attempts every column when there is a dependency cycle", async () => {
    // a <-> b cycle: neither is ever "ready", but both must still be attempted.
    const cols = [
      col("a", "A", { src: "{{B}}" }),
      col("b", "B", { src: "{{A}}" }),
    ];
    const ran: string[] = [];
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 4, async (c) => {
      ran.push(c.id);
    });
    expect(ran.sort()).toEqual(["a", "b"]);
  });
});
