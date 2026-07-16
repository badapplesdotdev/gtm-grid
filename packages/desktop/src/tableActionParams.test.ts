import { describe, it, expect } from "vitest";
import { buildTablePushParams, buildTableLookupParams } from "./tableActionParams";
import type { TablePushDraft, TableLookupDraft } from "./tableActionParams";

const pushDraft = (over: Partial<TablePushDraft> = {}): TablePushDraft => ({
  targetTable: "tbl_1",
  mode: "upsert",
  keyColumn: "Email",
  keyValue: "{{Email}}",
  autoRunTarget: false,
  ...over,
});

describe("buildTablePushParams", () => {
  it("assembles upsert params with the key fields", () => {
    expect(buildTablePushParams({}, pushDraft())).toEqual({
      targetTable: "tbl_1",
      mode: "upsert",
      keyColumn: "Email",
      keyValue: "{{Email}}",
    });
  });

  it("scrubs legacy v1 keys (mapping / createMissingColumns) from the base", () => {
    const p = buildTablePushParams(
      {
        mapping: { Email: "{{Email}}" },
        createMissingColumns: true,
      },
      pushDraft(),
    );
    expect(p).not.toHaveProperty("mapping");
    expect(p).not.toHaveProperty("createMissingColumns");
  });

  it("append mode omits keyColumn/keyValue (even stale ones from the base)", () => {
    const p = buildTablePushParams(
      { keyColumn: "Email", keyValue: "{{Email}}" },
      pushDraft({ mode: "append" }),
    );
    expect(p.mode).toBe("append");
    expect(p).not.toHaveProperty("keyColumn");
    expect(p).not.toHaveProperty("keyValue");
  });

  it("omits unset key fields rather than storing empty strings", () => {
    const p = buildTablePushParams({}, pushDraft({ keyColumn: "  ", keyValue: "" }));
    expect(p).not.toHaveProperty("keyColumn");
    expect(p).not.toHaveProperty("keyValue");
  });

  it("omits a false autoRunTarget and includes a true one", () => {
    const off = buildTablePushParams({ autoRunTarget: true }, pushDraft());
    expect(off).not.toHaveProperty("autoRunTarget");

    const on = buildTablePushParams({}, pushDraft({ autoRunTarget: true }));
    expect(on.autoRunTarget).toBe(true);
  });

  it("preserves unknown keys from the original params", () => {
    const p = buildTablePushParams({ agentNote: "keep me" }, pushDraft());
    expect(p.agentNote).toBe("keep me");
  });
});

const lookupDraft = (over: Partial<TableLookupDraft> = {}): TableLookupDraft => ({
  targetTable: "tbl_2",
  matchColumn: "Email",
  matchValue: "{{Email}}",
  returnColumns: [],
  allColumnNames: ["Email", "Company", "Score"],
  multiple: "first",
  caseInsensitive: false,
  notFound: "null",
  ...over,
});

describe("buildTableLookupParams", () => {
  it("omits every engine default (first / case-sensitive / null / all columns)", () => {
    expect(buildTableLookupParams({}, lookupDraft())).toEqual({
      targetTable: "tbl_2",
      matchColumn: "Email",
      matchValue: "{{Email}}",
    });
  });

  it("keeps a partial return selection", () => {
    const p = buildTableLookupParams({}, lookupDraft({ returnColumns: ["Email", "Score"] }));
    expect(p.return).toEqual(["Email", "Score"]);
  });

  it("treats a selection covering every column as 'all' and omits return", () => {
    const p = buildTableLookupParams(
      { return: ["Email"] },
      lookupDraft({ returnColumns: ["Score", "Company", "Email"] }),
    );
    expect(p).not.toHaveProperty("return");
  });

  it("keeps an explicit selection when the schema is unknown", () => {
    const p = buildTableLookupParams(
      {},
      lookupDraft({ returnColumns: ["Email"], allColumnNames: [] }),
    );
    expect(p.return).toEqual(["Email"]);
  });

  it("includes non-default options and clears stale base values", () => {
    const p = buildTableLookupParams(
      {},
      lookupDraft({ multiple: "all", caseInsensitive: true, notFound: "error" }),
    );
    expect(p.multiple).toBe("all");
    expect(p.caseInsensitive).toBe(true);
    expect(p.notFound).toBe("error");

    const cleared = buildTableLookupParams(
      { multiple: "all", caseInsensitive: true, notFound: "error" },
      lookupDraft(),
    );
    expect(cleared).not.toHaveProperty("multiple");
    expect(cleared).not.toHaveProperty("caseInsensitive");
    expect(cleared).not.toHaveProperty("notFound");
  });

  it("preserves unknown keys from the original params", () => {
    const p = buildTableLookupParams({ agentNote: "keep me" }, lookupDraft());
    expect(p.agentNote).toBe("keep me");
  });
});
