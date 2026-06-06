/**
 * Regression tests for the webhook UPSERT match kernel.
 *
 * These lock in the scalar-equality rule the server-side `upsertWebhookRow`
 * mutation relies on to decide create-vs-update. They guard the over-metering
 * bugfix indirectly: the match runs in ONE mutation that meters exactly once, so
 * the match correctness (not a per-cell loop) is the contract that matters.
 */

import { describe, expect, it } from "vitest";
import {
  findUpsertRowId,
  isValidUpsertKeyValue,
  matchesUpsertKey,
} from "./webhook-upsert.js";

describe("isValidUpsertKeyValue", () => {
  it("accepts non-empty strings, numbers, and booleans", () => {
    expect(isValidUpsertKeyValue("a@b.com")).toBe(true);
    expect(isValidUpsertKeyValue(0)).toBe(true);
    expect(isValidUpsertKeyValue(42)).toBe(true);
    expect(isValidUpsertKeyValue(false)).toBe(true);
    expect(isValidUpsertKeyValue(true)).toBe(true);
  });

  it("rejects empty string, null, undefined, objects, and arrays", () => {
    expect(isValidUpsertKeyValue("")).toBe(false);
    expect(isValidUpsertKeyValue(null)).toBe(false);
    expect(isValidUpsertKeyValue(undefined)).toBe(false);
    expect(isValidUpsertKeyValue({ a: 1 })).toBe(false);
    expect(isValidUpsertKeyValue([1, 2])).toBe(false);
  });
});

describe("matchesUpsertKey — scalar strict equality", () => {
  it("matches equal scalars of the same type", () => {
    expect(matchesUpsertKey("a@b.com", "a@b.com")).toBe(true);
    expect(matchesUpsertKey(7, 7)).toBe(true);
    expect(matchesUpsertKey(true, true)).toBe(true);
  });

  it("does NOT coerce types (1 !== '1', true !== 'true')", () => {
    expect(matchesUpsertKey(1, "1")).toBe(false);
    expect(matchesUpsertKey("1", 1)).toBe(false);
    expect(matchesUpsertKey(true, "true")).toBe(false);
  });

  it("never matches when either side is a non-scalar / empty / nullish", () => {
    expect(matchesUpsertKey({ id: 1 }, { id: 1 })).toBe(false);
    expect(matchesUpsertKey([1], [1])).toBe(false);
    expect(matchesUpsertKey("", "")).toBe(false);
    expect(matchesUpsertKey(null, "x")).toBe(false);
    expect(matchesUpsertKey("x", null)).toBe(false);
  });
});

describe("findUpsertRowId — first-match over the key column", () => {
  it("returns the first matching row's id", () => {
    const cells = [
      { rowId: "r1", value: "x@x.com" },
      { rowId: "r2", value: "a@b.com" },
      { rowId: "r3", value: "a@b.com" },
    ] as const;
    expect(findUpsertRowId(cells, "a@b.com")).toBe("r2");
  });

  it("returns null when no stored cell matches (→ caller inserts)", () => {
    const cells = [{ rowId: "r1", value: "x@x.com" }] as const;
    expect(findUpsertRowId(cells, "missing@b.com")).toBeNull();
  });

  it("returns null for an unsupported incoming key without scanning", () => {
    const cells = [{ rowId: "r1", value: "x@x.com" }] as const;
    expect(findUpsertRowId(cells, { id: 1 })).toBeNull();
    expect(findUpsertRowId(cells, "")).toBeNull();
    expect(findUpsertRowId(cells, null)).toBeNull();
  });

  it("matches numeric keys strictly (no string coercion)", () => {
    const cells = [
      { rowId: "r1", value: 1 },
      { rowId: "r2", value: 2 },
    ] as const;
    expect(findUpsertRowId(cells, 2)).toBe("r2");
    expect(findUpsertRowId(cells, "2")).toBeNull();
  });
});
