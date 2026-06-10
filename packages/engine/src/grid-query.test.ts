// findRows / countRows — the agent's "search inside a sheet" primitives — plus a
// check that deleteColumn cascades its cells away.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";

let dir: string;
let db: Db;
let tableId: string;
let tierCol: string;
let nameCol: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grid-query-"));
  db = new Db(join(dir, "p.db"));
  const t = db.createTable("Leads");
  tableId = t.id;
  nameCol = db.createColumn({ tableId, name: "Name", kind: "manual" }).id;
  tierCol = db.createColumn({ tableId, name: "Tier", kind: "manual" }).id;
  for (const [name, tier] of [["A", "T1"], ["B", "T1"], ["C", "T2"], ["D", "T1"]] as const) {
    const r = db.createRow(tableId);
    db.setCell(r.id, nameCol, { value: name, status: "done" });
    db.setCell(r.id, tierCol, { value: tier, status: "done" });
  }
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("countRows", () => {
  it("counts without fetching rows", () => {
    expect(db.countRows(tableId)).toBe(4);
  });
});

describe("findRows", () => {
  it("matches a single column (returns all rows for that value)", () => {
    const t1 = db.findRows(tableId, { [tierCol]: "T1" });
    expect(t1.map((r) => db.getCell(r.id, nameCol)?.value)).toEqual(["A", "B", "D"]);
  });

  it("ANDs across multiple columns", () => {
    expect(db.findRows(tableId, { [tierCol]: "T1", [nameCol]: "B" })).toHaveLength(1);
    expect(db.findRows(tableId, { [tierCol]: "T2", [nameCol]: "B" })).toHaveLength(0);
  });

  it("trims whitespace on string matches", () => {
    expect(db.findRows(tableId, { [nameCol]: "  A  " })).toHaveLength(1);
  });

  it("respects the limit", () => {
    expect(db.findRows(tableId, { [tierCol]: "T1" }, 2)).toHaveLength(2);
  });

  it("empty match returns all rows (bounded)", () => {
    expect(db.findRows(tableId, {})).toHaveLength(4);
    expect(db.findRows(tableId, {}, 1)).toHaveLength(1);
  });
});

describe("deleteColumn", () => {
  it("removes the column and its cells from every row", () => {
    const someRow = db.listRows(tableId)[0].id;
    expect(db.getCell(someRow, tierCol)).toBeDefined();
    db.deleteColumn(tierCol);
    expect(db.listColumns(tableId).map((c) => c.id)).not.toContain(tierCol);
    expect(db.getCell(someRow, tierCol)).toBeUndefined(); // cascaded
    expect(db.countRows(tableId)).toBe(4); // rows untouched
  });
});
