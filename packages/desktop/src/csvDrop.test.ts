import { describe, expect, it } from "vitest";
import { dragHasFiles, firstCsvFile, isCsvFile } from "./csvDrop";

describe("isCsvFile — what counts as a droppable CSV", () => {
  it("accepts the text/csv MIME type", () => {
    expect(isCsvFile({ name: "leads", type: "text/csv" })).toBe(true);
  });
  it("accepts the Excel-reported CSV MIME (browser quirk)", () => {
    expect(isCsvFile({ name: "leads", type: "application/vnd.ms-excel" })).toBe(true);
  });
  it("accepts a .csv extension regardless of (missing) MIME", () => {
    expect(isCsvFile({ name: "Q3 Prospects.CSV", type: "" })).toBe(true);
  });
  it("rejects non-CSV files", () => {
    expect(isCsvFile({ name: "photo.png", type: "image/png" })).toBe(false);
    expect(isCsvFile({ name: "report.xlsx", type: "" })).toBe(false);
    expect(isCsvFile({ name: "notes.csv.txt", type: "text/plain" })).toBe(false);
  });
});

describe("firstCsvFile — pick the first CSV out of a drop", () => {
  const f = (name: string, type = "") => ({ name, type }) as unknown as File;

  it("returns the first CSV, skipping non-CSV files before it", () => {
    const list = [f("a.png", "image/png"), f("b.csv"), f("c.csv")];
    expect(firstCsvFile(list)?.name).toBe("b.csv");
  });
  it("returns null when no file is a CSV", () => {
    expect(firstCsvFile([f("a.png", "image/png"), f("b.pdf")])).toBeNull();
  });
  it("returns null for an empty / missing list", () => {
    expect(firstCsvFile([])).toBeNull();
    expect(firstCsvFile(null)).toBeNull();
    expect(firstCsvFile(undefined)).toBeNull();
  });
});

describe("dragHasFiles — only engage the overlay for OS file drags", () => {
  it("true when the drag carries Files", () => {
    expect(dragHasFiles(["Files"])).toBe(true);
    expect(dragHasFiles(["text/plain", "Files"])).toBe(true);
  });
  it("false for text/element drags or no types", () => {
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles([])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});
