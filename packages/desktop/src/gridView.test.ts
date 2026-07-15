import { describe, expect, it } from "vitest";
import type { Column, FullTable, Row } from "./api";
import { applyGridView, matchesFilterGroups, type GridFilterGroup } from "./gridView";

const column = (id: string, type = "text", kind: Column["kind"] = "manual"): Column => ({
  id, name: id, type, kind, provider: null, method: null, fn: null, params: {},
});
const row = (id: string, cells: Row["cells"]): Row => ({ id, cells });
const done = (value: unknown) => ({ value, status: "done" as const, error: null });

describe("grid view filtering", () => {
  it("does not hide rows until a value-taking rule has a value", () => {
    const groups: GridFilterGroup[] = [{ id: "g", mode: "all", rules: [
      { id: "r", columnId: "name", operator: "equals", value: "" },
    ] }];
    expect(matchesFilterGroups(row("1", { name: done("Ada") }), groups)).toBe(true);
  });

  it("combines rules inside groups and groups with AND", () => {
    const groups: GridFilterGroup[] = [
      { id: "g1", mode: "any", rules: [
        { id: "r1", columnId: "name", operator: "contains", value: "ada" },
        { id: "r2", columnId: "name", operator: "contains", value: "grace" },
      ] },
      { id: "g2", mode: "all", rules: [
        { id: "r3", columnId: "score", operator: "greater_than", value: "10" },
      ] },
    ];
    expect(matchesFilterGroups(row("1", { name: done("Ada"), score: done(12) }), groups)).toBe(true);
    expect(matchesFilterGroups(row("2", { name: done("Grace"), score: done(9) }), groups)).toBe(false);
  });

  it("understands function run state", () => {
    const groups: GridFilterGroup[] = [{ id: "g", mode: "all", rules: [
      { id: "r", columnId: "enrich", operator: "has_error", value: "" },
    ] }];
    expect(matchesFilterGroups(row("1", { enrich: { value: null, status: "error", error: "boom" } }), groups)).toBe(true);
    expect(matchesFilterGroups(row("2", { enrich: done("ok") }), groups)).toBe(false);
  });

  it("compares a timestamp to a calendar date", () => {
    const groups: GridFilterGroup[] = [{ id: "g", mode: "all", rules: [
      { id: "r", columnId: "created", operator: "equals", value: "2026-07-14" },
    ] }];
    expect(matchesFilterGroups(row("1", { created: done("2026-07-14T18:30:00.000Z") }), groups)).toBe(true);
    expect(matchesFilterGroups(row("2", { created: done("2026-07-15T00:00:00.000Z") }), groups)).toBe(false);
  });

  it("pins first, hides columns, and filters rows without mutating the source", () => {
    const table: FullTable = {
      id: "t", name: "Leads", columns: [column("a"), column("b"), column("c")],
      rows: [row("1", { a: done("keep") }), row("2", { a: done("drop") })],
    };
    const result = applyGridView(table, {
      hiddenColumnIds: ["b"], pinnedColumnIds: ["c"],
      filterGroups: [{ id: "g", mode: "all", rules: [{ id: "r", columnId: "a", operator: "equals", value: "keep" }] }],
    });
    expect(result.columns.map((c) => c.id)).toEqual(["c", "a"]);
    expect(result.rows.map((r) => r.id)).toEqual(["1"]);
    expect(table.columns.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
