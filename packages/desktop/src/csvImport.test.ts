/**
 * Tests for the CSV import orchestrator (csvImport.ts) using an in-memory
 * writer — asserts the column-id mapping, empty-cell skipping, chunking, and
 * progress reporting without any UI or network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  type ImportProgress,
  type ImportTableInput,
  type ImportWriter,
  importTable,
} from "./csvImport.js";

/** Records every writer call; assigns deterministic ids. */
function makeWriter() {
  const calls = {
    createTable: [] as string[],
    addColumn: [] as Array<{ tableId: string; name: string; type: string }>,
    chunks: [] as Array<Array<Record<string, unknown>>>,
  };
  let colSeq = 0;
  const writer: ImportWriter = {
    createTable: async (name) => {
      calls.createTable.push(name);
      return "table_1";
    },
    addColumn: async (tableId, col) => {
      calls.addColumn.push({ tableId, ...col });
      return `col_${++colSeq}`;
    },
    addRowsChunk: async (_tableId, rows) => {
      calls.chunks.push(rows);
    },
  };
  return { writer, calls };
}

const INPUT: ImportTableInput = {
  name: "leads",
  columns: [
    { name: "Company", type: "text" },
    { name: "Employees", type: "number" },
  ],
  rows: [
    ["Acme", "950"],
    ["Globex", ""], // empty cell should be skipped
  ],
};

describe("importTable", () => {
  it("creates the table, columns, and keys cells by returned column id", async () => {
    const { writer, calls } = makeWriter();
    const result = await importTable(INPUT, writer);

    expect(calls.createTable).toEqual(["leads"]);
    expect(calls.addColumn).toEqual([
      { tableId: "table_1", name: "Company", type: "text" },
      { tableId: "table_1", name: "Employees", type: "number" },
    ]);
    // One chunk, two rows; cells keyed by col_1 / col_2; empty cell skipped.
    expect(calls.chunks).toEqual([
      [{ col_1: "Acme", col_2: "950" }, { col_1: "Globex" }],
    ]);
    expect(result).toEqual({
      tableId: "table_1",
      rowCount: 2,
      columnCount: 2,
    });
  });

  it("chunks rows by chunkSize", async () => {
    const { writer, calls } = makeWriter();
    const rows = Array.from({ length: 5 }, (_, i) => [`r${i}`, `${i}`]);
    await importTable({ ...INPUT, rows }, writer, { chunkSize: 2 });
    expect(calls.chunks.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it("reports progress for columns then rows", async () => {
    const { writer } = makeWriter();
    const events: ImportProgress[] = [];
    await importTable(INPUT, writer, {
      chunkSize: 1,
      onProgress: (p) => events.push(p),
    });
    expect(events).toEqual([
      { phase: "columns", done: 1, total: 2 },
      { phase: "columns", done: 2, total: 2 },
      { phase: "rows", done: 1, total: 2 },
      { phase: "rows", done: 2, total: 2 },
    ]);
  });

  it("aborts when the writer throws (e.g. quota guard)", async () => {
    const { writer } = makeWriter();
    const boom = vi.spyOn(writer, "addRowsChunk").mockRejectedValueOnce(
      new Error("CloudActionsLimitError"),
    );
    await expect(importTable(INPUT, writer)).rejects.toThrow(
      "CloudActionsLimitError",
    );
    boom.mockRestore();
  });

  it("defaults to DEFAULT_CHUNK_SIZE", async () => {
    const { writer, calls } = makeWriter();
    const rows = Array.from({ length: DEFAULT_CHUNK_SIZE + 1 }, () => ["x", "1"]);
    await importTable({ ...INPUT, rows }, writer);
    expect(calls.chunks.length).toBe(2);
    expect(calls.chunks[0].length).toBe(DEFAULT_CHUNK_SIZE);
    expect(calls.chunks[1].length).toBe(1);
  });
});
