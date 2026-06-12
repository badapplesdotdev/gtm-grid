/**
 * Pure tool→presence mapping tests — no React, no socket. Proves each gtmgrid
 * tool call maps to the right cell ring / column ring / activity label for the
 * OPEN table, and that calls against other tables (or non-grid tools) map to
 * null (presence rooms are per-table).
 */

import { describe, expect, it } from "vitest";
import { mapToolToPresence, type AgentPresenceTableContext } from "./agentToolPresence.js";

const ctx: AgentPresenceTableContext = {
  tableName: "Webhook table",
  columnIdByName: new Map([
    ["email", "col-email"],
    ["name", "col-name"],
  ]),
};

const map = (name: string, input: Record<string, unknown>) =>
  mapToolToPresence({ name, input }, ctx);

describe("mapToolToPresence", () => {
  it("maps get_table on the open table to a reading activity", () => {
    expect(map("get_table", { table: "Webhook table" })).toEqual({
      cursor: null,
      editing: null,
      column: null,
      activity: "reading the table",
    });
  });

  it("matches the table name case-insensitively with whitespace trim", () => {
    expect(map("get_table", { table: "  webhook TABLE " })).not.toBeNull();
  });

  it("returns null for a DIFFERENT table (presence is per-table)", () => {
    expect(map("get_table", { table: "Other" })).toBeNull();
    expect(map("run_column", { table: "Other", column: "Email" })).toBeNull();
  });

  it("returns null for non-grid tools", () => {
    expect(map("search_functions", { query: "posts" })).toBeNull();
    expect(map("run_function", { provider: "trigify", method: "enrichProfile" })).toBeNull();
  });

  it("rings the column for run_column, resolving the name to its id", () => {
    expect(map("run_column", { table: "Webhook table", column: "Email" })).toEqual({
      cursor: null,
      editing: null,
      column: "col-email",
      activity: "running Email",
    });
  });

  it("keeps the activity label even when the column name doesn't resolve", () => {
    expect(map("run_column", { table: "Webhook table", column: "Ghost" })).toEqual({
      cursor: null,
      editing: null,
      column: null,
      activity: "running Ghost",
    });
  });

  it("marks the first update_cells target as the editing cell", () => {
    const patch = map("update_cells", {
      table: "Webhook table",
      updates: [
        { row: "row-1", column: "Email", value: "a@b.co" },
        { row: "row-2", column: "Name", value: "Ann" },
      ],
    });
    expect(patch).toEqual({
      cursor: { rowId: "row-1", columnId: "col-email" },
      editing: { rowId: "row-1", columnId: "col-email" },
      column: null,
      activity: "updating 2 cells",
    });
  });

  it("counts add_rows and pluralizes", () => {
    expect(map("add_rows", { table: "Webhook table", rows: [{}] })?.activity).toBe("adding 1 row");
    expect(map("add_rows", { table: "Webhook table", rows: [{}, {}, {}] })?.activity).toBe(
      "adding 3 rows",
    );
  });

  it("maps workspace-scoped tools without a table match", () => {
    expect(map("list_tables", {})?.activity).toBe("browsing tables");
    expect(map("create_table", { name: "Leads" })?.activity).toBe("creating a table");
  });

  it("maps column reads to a column ring", () => {
    expect(map("get_column", { table: "Webhook table", column: "Name" })).toEqual({
      cursor: null,
      editing: null,
      column: "col-name",
      activity: "reading Name",
    });
  });
});
