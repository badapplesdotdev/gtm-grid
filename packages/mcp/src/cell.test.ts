import { describe, expect, it } from "vitest";
import { CELL_CAP, capCellValue } from "./cell.js";

describe("capCellValue — cap one huge cell so it can't blow the agent response budget", () => {
  it("passes null/undefined/number/boolean through untouched", () => {
    expect(capCellValue(null)).toBe(null);
    expect(capCellValue(undefined)).toBe(undefined);
    expect(capCellValue(42)).toBe(42);
    expect(capCellValue(0)).toBe(0);
    expect(capCellValue(true)).toBe(true);
    expect(capCellValue(false)).toBe(false);
  });

  it("keeps a string at or under the cap unchanged (boundary = CELL_CAP)", () => {
    expect(capCellValue("hello")).toBe("hello");
    const exact = "x".repeat(CELL_CAP);
    expect(capCellValue(exact)).toBe(exact);
  });

  it("caps an over-long string with an accurate '…[+N chars]' marker", () => {
    const s = "a".repeat(CELL_CAP + 123);
    const out = capCellValue(s) as string;
    expect(out).toBe(`${"a".repeat(CELL_CAP)}…[+123 chars]`);
  });

  it("keeps a small object/array structured (not stringified)", () => {
    const obj = { a: 1, b: "two" };
    expect(capCellValue(obj)).toBe(obj);
    const arr = [1, 2, 3];
    expect(capCellValue(arr)).toBe(arr);
  });

  it("caps a large object to a marked string noting the full value stays in the cell", () => {
    const big = { blob: "z".repeat(CELL_CAP * 2) };
    const out = capCellValue(big) as string;
    expect(typeof out).toBe("string");
    expect(out).toContain("chars, full value in the cell]");
    expect(out.length).toBeLessThan(JSON.stringify(big).length);
  });

  it("CELL_CAP is 500", () => {
    expect(CELL_CAP).toBe(500);
  });
});
