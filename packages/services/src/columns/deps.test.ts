import { describe, expect, it } from "vitest";
import {
  type MinimalColumn,
  buildColumnDeps,
  columnInCycle,
  directDependencyIds,
  isFreeColumn,
  runColumnsWithDeps,
  stableTopoOrder,
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

describe("directDependencyIds", () => {
  it("returns the ids of existing columns the column references", () => {
    const others = [col("a", "Alpha"), col("b", "Beta")];
    const newCol = col("c", "Gamma", { src: "{{Alpha}} and {{Beta}}" });
    expect([...directDependencyIds(newCol, others)].sort()).toEqual(["a", "b"]);
  });

  it("returns empty when the column references nothing in the set", () => {
    const others = [col("a", "Alpha")];
    expect([...directDependencyIds(col("b", "Beta", { src: "plain" }), others)]).toEqual([]);
  });

  it("skips the column itself if present in the set", () => {
    const cols = [col("a", "Alpha", { src: "{{Alpha}}" })];
    expect([...directDependencyIds(cols[0]!, cols)]).toEqual([]);
  });

  it("detects a reference that lives only in the run condition", () => {
    const others = [col("a", "Alpha")];
    const newCol = col("c", "Gamma", {}, { condition: "{{Alpha}} != ''" });
    expect([...directDependencyIds(newCol, others)]).toEqual(["a"]);
  });

  it("detects a reference nested deep inside params", () => {
    const others = [col("a", "Alpha")];
    const newCol = col("c", "Gamma", { cfg: { items: ["x", "{{Alpha}}"] } });
    expect([...directDependencyIds(newCol, others)]).toEqual(["a"]);
  });

  it("matches a column name containing regex-special characters literally", () => {
    const others = [col("a", "Price ($)"), col("b", "Other")];
    const newCol = col("c", "Gamma", { src: "{{Price ($)}}" });
    expect([...directDependencyIds(newCol, others)]).toEqual(["a"]);
  });

  it("records only DIRECT references, not transitive ones", () => {
    // new col reads B; B reads A. directDependencyIds returns only B.
    const others = [col("a", "Alpha"), col("b", "Beta", { src: "{{Alpha}}" })];
    const newCol = col("c", "Gamma", { src: "{{Beta}}" });
    expect([...directDependencyIds(newCol, others)]).toEqual(["b"]);
  });
});

describe("columnInCycle", () => {
  it("is false for an acyclic chain", () => {
    const cols = [
      col("a", "A"),
      col("b", "B", { src: "{{A}}" }),
      col("c", "C", { src: "{{B}}" }),
    ];
    const deps = buildColumnDeps(cols);
    expect(columnInCycle("c", deps)).toBe(false);
    expect(columnInCycle("a", deps)).toBe(false);
  });

  it("detects a two-column cycle (A reads B, B reads A)", () => {
    const cols = [col("a", "A", { src: "{{B}}" }), col("b", "B", { src: "{{A}}" })];
    const deps = buildColumnDeps(cols);
    expect(columnInCycle("a", deps)).toBe(true);
    expect(columnInCycle("b", deps)).toBe(true);
  });

  it("ignores a pure self-reference (buildColumnDeps excludes self-edges)", () => {
    // A column reading its own {{Name}} imposes no ordering and is not a cycle in
    // the dependency graph — buildColumnDeps never records a self-edge.
    const cols = [col("a", "A", { src: "{{A}}" })];
    expect(columnInCycle("a", buildColumnDeps(cols))).toBe(false);
  });

  it("detects a longer cycle (A->B->C->A) for every node in it", () => {
    const cols = [
      col("a", "A", { src: "{{C}}" }),
      col("b", "B", { src: "{{A}}" }),
      col("c", "C", { src: "{{B}}" }),
    ];
    const deps = buildColumnDeps(cols);
    expect(columnInCycle("a", deps)).toBe(true);
    expect(columnInCycle("b", deps)).toBe(true);
    expect(columnInCycle("c", deps)).toBe(true);
  });

  it("does not flag a diamond (shared dependency is not a cycle)", () => {
    // d reads b and c; both read a. No back-edge → acyclic.
    const cols = [
      col("a", "A"),
      col("b", "B", { src: "{{A}}" }),
      col("c", "C", { src: "{{A}}" }),
      col("d", "D", { src: "{{B}} {{C}}" }),
    ];
    const deps = buildColumnDeps(cols);
    for (const id of ["a", "b", "c", "d"]) expect(columnInCycle(id, deps)).toBe(false);
  });

  it("does not flag a node that merely points INTO a cycle without being part of it", () => {
    // b<->c is a cycle; a reads b but nothing reads a, so a is not in the cycle.
    const cols = [
      col("a", "A", { src: "{{B}}" }),
      col("b", "B", { src: "{{C}}" }),
      col("c", "C", { src: "{{B}}" }),
    ];
    const deps = buildColumnDeps(cols);
    expect(columnInCycle("a", deps)).toBe(false);
    expect(columnInCycle("b", deps)).toBe(true);
    expect(columnInCycle("c", deps)).toBe(true);
  });
});

describe("stableTopoOrder", () => {
  it("leaves an already-valid order untouched", () => {
    const cols = [col("a", "A"), col("b", "B", { src: "{{A}}" }), col("c", "C")];
    const ids = cols.map((c) => c.id);
    expect(stableTopoOrder(ids, buildColumnDeps(cols))).toEqual(ids);
  });

  it("moves a column to just after its dependency, minimally", () => {
    // current order [b, a, c]; b reads a, so b must move after a. c is unrelated.
    const cols = [col("b", "B", { src: "{{A}}" }), col("a", "A"), col("c", "C")];
    const order = stableTopoOrder(["b", "a", "c"], buildColumnDeps(cols));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    // c stays last (unrelated, not dragged around).
    expect(order[order.length - 1]).toBe("c");
  });

  it("preserves unrelated columns' relative order", () => {
    const cols = [
      col("x", "X"),
      col("c", "C", { src: "{{A}}" }),
      col("a", "A"),
      col("y", "Y"),
    ];
    const order = stableTopoOrder(["x", "c", "a", "y"], buildColumnDeps(cols));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("x")).toBeLessThan(order.indexOf("y"));
  });

  it("emits every column exactly once even with a cycle", () => {
    const cols = [col("a", "A", { src: "{{B}}" }), col("b", "B", { src: "{{A}}" })];
    expect(stableTopoOrder(["a", "b"], buildColumnDeps(cols)).sort()).toEqual(["a", "b"]);
  });

  it("returns a permutation of the input (no drops, no dupes)", () => {
    const cols = [
      col("c", "C", { src: "{{A}}" }),
      col("a", "A"),
      col("b", "B", { src: "{{C}}" }),
      col("d", "D"),
    ];
    const ids = ["c", "a", "b", "d"];
    expect(stableTopoOrder(ids, buildColumnDeps(cols)).sort()).toEqual([...ids].sort());
  });

  it("handles empty and single-column inputs", () => {
    expect(stableTopoOrder([], new Map())).toEqual([]);
    const one = [col("a", "A")];
    expect(stableTopoOrder(["a"], buildColumnDeps(one))).toEqual(["a"]);
  });

  it("orders a diamond so both sources precede the sink", () => {
    const cols = [
      col("d", "D", { src: "{{B}} {{C}}" }),
      col("b", "B", { src: "{{A}}" }),
      col("c", "C", { src: "{{A}}" }),
      col("a", "A"),
    ];
    const order = stableTopoOrder(["d", "b", "c", "a"], buildColumnDeps(cols));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("cascades: moving a column drags its dependents to stay in order", () => {
    // current [x, z, y]; z reads x (valid). x now reads y → x must follow y, and
    // z must still follow x. Correct order is [y, x, z].
    const cols = [
      col("x", "X", { src: "{{Y}}" }),
      col("z", "Z", { src: "{{X}}" }),
      col("y", "Y"),
    ];
    expect(stableTopoOrder(["x", "z", "y"], buildColumnDeps(cols))).toEqual(["y", "x", "z"]);
  });

  it("repairs two independent violations without touching unrelated columns", () => {
    // [b, a, u, d, c] where b reads a and d reads c. u is unrelated and central.
    const cols = [
      col("b", "B", { src: "{{A}}" }),
      col("a", "A"),
      col("u", "U"),
      col("d", "D", { src: "{{C}}" }),
      col("c", "C"),
    ];
    const order = stableTopoOrder(["b", "a", "u", "d", "c"], buildColumnDeps(cols));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
    // u keeps its relative place ahead of the second cluster.
    expect(order.indexOf("u")).toBeLessThan(order.indexOf("d"));
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
