import { describe, expect, it } from "vitest";
import {
  type MinimalColumn,
  buildColumnDeps,
  isFreeColumn,
  runColumnsWithDeps,
  topoSortColumnIds,
  transitiveDependents,
} from "./deps.js";

function col(
  id: string,
  name: string,
  params: Record<string, unknown> = {},
  extra: Partial<MinimalColumn> = {},
): MinimalColumn {
  return { id, name, kind: "function", provider: null, params, ...extra };
}

describe("columnDependsOn / buildColumnDeps", () => {
  it("returns no edges when columns are independent", () => {
    const cols = [col("a", "Alpha"), col("b", "Beta")];
    const deps = buildColumnDeps(cols);
    expect([...deps.get("a")!]).toEqual([]);
    expect([...deps.get("b")!]).toEqual([]);
  });

  it("records an edge when a column references another by {{Name}}", () => {
    const cols = [col("a", "Alpha"), col("b", "Beta", { src: "uses {{Alpha}} here" })];
    const deps = buildColumnDeps(cols);
    expect([...deps.get("b")!]).toEqual(["a"]);
    expect([...deps.get("a")!]).toEqual([]);
  });

  it("detects refs in nested params and in the run condition", () => {
    const cols = [
      col("a", "Alpha"),
      col("b", "Beta", { nested: { deep: ["x", "{{Alpha}}"] } }),
      col("c", "Gamma", {}, { condition: "{{Alpha}} != ''" }),
    ];
    const deps = buildColumnDeps(cols);
    expect([...deps.get("b")!]).toEqual(["a"]);
    expect([...deps.get("c")!]).toEqual(["a"]);
  });

  it("ignores references to columns outside the run set", () => {
    const cols = [col("a", "Alpha", { src: "needs {{Gamma}}" })];
    expect([...buildColumnDeps(cols).get("a")!]).toEqual([]);
  });
});

describe("transitiveDependents", () => {
  it("returns every downstream column, seeds excluded", () => {
    // a -> b -> c, plus b2 also reading a (parallel sibling).
    const cols = [
      col("a", "A"),
      col("b", "B", { src: "{{A}}" }),
      col("b2", "B2", { src: "{{A}}" }),
      col("c", "C", { src: "{{B}}" }),
      col("unrelated", "U"),
    ];
    expect([...transitiveDependents(["a"], cols)].sort()).toEqual(["b", "b2", "c"]);
  });

  it("returns nothing when the seed has no dependents", () => {
    const cols = [col("a", "A"), col("b", "B", { src: "{{A}}" })];
    expect([...transitiveDependents(["b"], cols)]).toEqual([]);
  });

  it("is cycle-safe", () => {
    const cols = [col("a", "A", { src: "{{B}}" }), col("b", "B", { src: "{{A}}" })];
    expect([...transitiveDependents(["a"], cols)]).toEqual(["b"]);
  });
});

describe("topoSortColumnIds", () => {
  it("orders dependents after their sources regardless of input order", () => {
    // authored out of order: C (reads B), B (reads A), A.
    const cols = [
      col("c", "C", { src: "{{B}}" }),
      col("b", "B", { src: "{{A}}" }),
      col("a", "A"),
    ];
    const order = topoSortColumnIds(cols, buildColumnDeps(cols));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
  });

  it("emits every column exactly once even with a cycle", () => {
    const cols = [col("a", "A", { src: "{{B}}" }), col("b", "B", { src: "{{A}}" })];
    expect(topoSortColumnIds(cols, buildColumnDeps(cols)).sort()).toEqual(["a", "b"]);
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
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 4, async () => {}, () => {
      settled += 1;
    });
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
    expect(maxActive).toBe(2);
  });

  it("never starts a dependent before its dependency finishes", async () => {
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
    const cols = [col("a", "A", { src: "{{B}}" }), col("b", "B", { src: "{{A}}" })];
    const ran: string[] = [];
    await runColumnsWithDeps(cols, buildColumnDeps(cols), 4, async (c) => {
      ran.push(c.id);
    });
    expect(ran.sort()).toEqual(["a", "b"]);
  });
});

describe("isFreeColumn", () => {
  it("treats a code/mapped column (no provider) as free", () => {
    expect(isFreeColumn({ kind: "function", provider: null })).toBe(true);
  });
  it("treats a formula column as free", () => {
    expect(isFreeColumn({ kind: "function", provider: "formula" })).toBe(true);
  });
  it("treats a connector enrichment as NOT free", () => {
    expect(isFreeColumn({ kind: "function", provider: "leadmagic" })).toBe(false);
  });
  it("treats a manual column as NOT free", () => {
    expect(isFreeColumn({ kind: "manual", provider: null })).toBe(false);
  });
});
