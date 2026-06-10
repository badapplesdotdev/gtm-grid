/**
 * Tests for the pure CSV export logic (csvExport.ts): mapped-scalar-only cell
 * projection, RFC-4180 field escaping, full-table serialization, and filename
 * sanitization. No DOM (downloadCsv is the only impure part and isn't covered).
 */

import { describe, expect, it } from "vitest";
import type { Cell, Column, FullTable, Row } from "./api.js";
import {
  cellToCsvValue,
  csvFilename,
  escapeCsvField,
  tableToCsv,
} from "./csvExport.js";

function cell(value: unknown, status: Cell["status"] = "done", error: string | null = null): Cell {
  return { value, status, error };
}

function col(id: string, name: string): Column {
  return {
    id,
    name,
    type: "text",
    kind: "manual",
    provider: null,
    method: null,
    fn: null,
    params: {},
  };
}

function table(columns: Column[], rows: Row[], name = "My Table"): FullTable {
  return { id: "t1", name, columns, rows };
}

describe("cellToCsvValue", () => {
  it("emits the string form of a done scalar", () => {
    expect(cellToCsvValue(cell("hello"))).toBe("hello");
    expect(cellToCsvValue(cell(42))).toBe("42");
    expect(cellToCsvValue(cell(true))).toBe("true");
    expect(cellToCsvValue(cell(0))).toBe("0");
    expect(cellToCsvValue(cell(false))).toBe("false");
  });

  it("blanks objects and arrays (JSON / multiple items)", () => {
    expect(cellToCsvValue(cell({ a: 1 }))).toBe("");
    expect(cellToCsvValue(cell([1, 2, 3]))).toBe("");
    expect(cellToCsvValue(cell([]))).toBe("");
  });

  it("blanks null / undefined / missing cells", () => {
    expect(cellToCsvValue(cell(null))).toBe("");
    expect(cellToCsvValue(cell(undefined))).toBe("");
    expect(cellToCsvValue(undefined)).toBe("");
  });

  it("blanks non-done cells even when they carry a value", () => {
    expect(cellToCsvValue(cell("x", "error", "boom"))).toBe("");
    expect(cellToCsvValue(cell("x", "pending"))).toBe("");
    expect(cellToCsvValue(cell("x", "running"))).toBe("");
    expect(cellToCsvValue(cell("x", "empty"))).toBe("");
  });
});

describe("escapeCsvField", () => {
  it("leaves plain values untouched", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("")).toBe("");
  });

  it("quotes and doubles embedded quotes/commas/newlines", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('she said "hi"')).toBe('"she said ""hi"""');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("carriage\rreturn")).toBe('"carriage\rreturn"');
  });
});

describe("tableToCsv", () => {
  it("writes a header row plus one row per table row, mapped values only", () => {
    const cols = [col("c1", "Name"), col("c2", "Enriched"), col("c3", "Age")];
    const rows: Row[] = [
      { id: "r1", cells: { c1: cell("Ada"), c2: cell({ company: "X" }), c3: cell(36) } },
      { id: "r2", cells: { c1: cell("Grace"), c2: cell("scalar"), c3: cell(null) } },
    ];
    const csv = tableToCsv(table(cols, rows));
    expect(csv).toBe(["Name,Enriched,Age", "Ada,,36", "Grace,scalar,"].join("\r\n"));
  });

  it("escapes header and body fields", () => {
    const cols = [col("c1", "Full, Name"), col("c2", "Note")];
    const rows: Row[] = [{ id: "r1", cells: { c1: cell("Lovelace, Ada"), c2: cell('say "hi"') } }];
    const csv = tableToCsv(table(cols, rows));
    expect(csv).toBe(['"Full, Name",Note', '"Lovelace, Ada","say ""hi"""'].join("\r\n"));
  });

  it("handles a table with no rows (header only)", () => {
    const csv = tableToCsv(table([col("c1", "A"), col("c2", "B")], []));
    expect(csv).toBe("A,B");
  });

  it("respects column order and missing cells", () => {
    const cols = [col("c1", "A"), col("c2", "B")];
    const rows: Row[] = [{ id: "r1", cells: { c2: cell("only-b") } }];
    expect(tableToCsv(table(cols, rows))).toBe("A,B\r\n,only-b");
  });
});

describe("csvFilename", () => {
  it("derives a safe .csv filename from the table name", () => {
    expect(csvFilename("My Table")).toBe("My_Table.csv");
    expect(csvFilename("Leads / Q3 (2026)")).toBe("Leads_Q3_2026.csv");
    expect(csvFilename("  spaced  ")).toBe("spaced.csv");
  });

  it("falls back to 'table' for an empty/symbol-only name", () => {
    expect(csvFilename("")).toBe("table.csv");
    expect(csvFilename("///")).toBe("table.csv");
  });
});
