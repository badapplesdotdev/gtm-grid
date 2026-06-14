import { describe, expect, it } from "vitest";
import {
  CreateColumnSchema,
  GetTableSchema,
  SetCellSchema,
  SetDedupeSchema,
} from "./_schemas";

describe("worker schemas — validation", () => {
  it("GetTableSchema accepts a valid body and rejects missing/empty/wrong id", () => {
    expect(GetTableSchema.safeParse({ tableId: "t1" }).success).toBe(true);
    expect(GetTableSchema.safeParse({}).success).toBe(false);
    expect(GetTableSchema.safeParse({ tableId: "" }).success).toBe(false);
    expect(GetTableSchema.safeParse({ tableId: 123 }).success).toBe(false);
  });

  it("CreateColumnSchema accepts nullable optional function fields", () => {
    const ok = CreateColumnSchema.safeParse({
      tableId: "t1",
      name: "Email",
      type: "text",
      kind: "function",
      provider: null,
      method: null,
      code: null,
      condition: null,
    });
    expect(ok.success).toBe(true);
    // kind must be one of the known column kinds.
    expect(
      CreateColumnSchema.safeParse({ tableId: "t1", name: "x", type: "text", kind: "bogus" }).success,
    ).toBe(false);
  });

  it("SetDedupeSchema allows column: null (disable) and rejects a bad keep", () => {
    expect(SetDedupeSchema.safeParse({ tableId: "t1", column: null }).success).toBe(true);
    expect(SetDedupeSchema.safeParse({ tableId: "t1", column: "c1", keep: "newest" }).success).toBe(true);
    expect(SetDedupeSchema.safeParse({ tableId: "t1", column: "c1", keep: "sideways" }).success).toBe(false);
  });
});

describe("SetCellSchema — `value` presence (COALESCE) semantics", () => {
  // The route distinguishes value:null (overwrite) from an OMITTED value (keep)
  // via `"value" in body`. zod validation MUST preserve that key-presence.
  it("keeps the `value` key when present, even as null", () => {
    const a = SetCellSchema.parse({ rowId: "r", columnId: "c", value: null });
    expect("value" in a).toBe(true);
    expect(a.value).toBeNull();

    const b = SetCellSchema.parse({ rowId: "r", columnId: "c", value: 42 });
    expect("value" in b).toBe(true);
    expect(b.value).toBe(42);
  });

  it("OMITS the `value` key when the caller omitted it", () => {
    const parsed = SetCellSchema.parse({ rowId: "r", columnId: "c" });
    expect("value" in parsed).toBe(false);
  });

  it("validates status against the cloud cell-status enum", () => {
    expect(SetCellSchema.safeParse({ rowId: "r", columnId: "c", status: "done" }).success).toBe(true);
    expect(SetCellSchema.safeParse({ rowId: "r", columnId: "c", status: "bogus" }).success).toBe(false);
  });
});
