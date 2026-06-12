/**
 * Local-engine column/row reorder tests — the SQLite primitives backing the
 * agent's `reorder_columns` / `reorder_rows` MCP tools. Each `moveX` reindexes
 * the table to a contiguous 0..N-1 order and returns the new id order; an
 * unknown id is a no-op (empty result).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reorder-test-"));
  db = new Db(join(dir, "project.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seedColumns = (n: number) => {
  const t = db.createTable("T");
  const ids = Array.from({ length: n }, (_, i) =>
    db.createColumn({ tableId: t.id, name: `C${i}` }).id,
  );
  return { tableId: t.id, ids };
};

describe("Db.moveColumn", () => {
  it("moves a column to the front and reindexes positions contiguously", () => {
    const { tableId, ids } = seedColumns(3);
    const order = db.moveColumn(ids[2]!, 0);
    expect(order).toEqual([ids[2], ids[0], ids[1]]);
    expect(db.listColumns(tableId).map((c) => c.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(db.listColumns(tableId).map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it("clamps an out-of-range index to the last slot", () => {
    const { tableId, ids } = seedColumns(3);
    db.moveColumn(ids[0]!, 99);
    expect(db.listColumns(tableId).map((c) => c.id)).toEqual([ids[1], ids[2], ids[0]]);
  });

  it("returns [] for an unknown column id (no-op)", () => {
    seedColumns(2);
    expect(db.moveColumn("missing", 0)).toEqual([]);
  });
});

describe("Db.moveRow", () => {
  const seedRows = (n: number) => {
    const t = db.createTable("T");
    const ids = Array.from({ length: n }, () => db.createRow(t.id).id);
    return { tableId: t.id, ids };
  };

  it("moves a row and reindexes positions", () => {
    const { tableId, ids } = seedRows(3);
    const order = db.moveRow(ids[0]!, 2);
    expect(order).toEqual([ids[1], ids[2], ids[0]]);
    expect(db.listRows(tableId).map((r) => r.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(db.listRows(tableId).map((r) => r.position)).toEqual([0, 1, 2]);
  });

  it("returns [] for an unknown row id (no-op)", () => {
    seedRows(2);
    expect(db.moveRow("missing", 0)).toEqual([]);
  });
});
