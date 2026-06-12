// Sidebar folders (local SQLite): CRUD, filing tables via moveTable, and the
// delete-unfiles invariant — removing a folder returns its tables to the root,
// never deletes them.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "folders-test-"));
  db = new Db(join(dir, "p.db"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("folders", () => {
  it("creates and lists folders in position order", () => {
    const a = db.createFolder("Pipeline");
    const b = db.createFolder("Inbound");
    expect(db.listFolders().map((f) => f.name)).toEqual(["Pipeline", "Inbound"]);
    expect(a.position).toBeLessThan(b.position);
  });

  it("renames a folder", () => {
    const f = db.createFolder("Old");
    db.renameFolder(f.id, "New");
    expect(db.listFolders()[0]?.name).toBe("New");
  });

  it("creates a table directly inside a folder", () => {
    const f = db.createFolder("Pipeline");
    const t = db.createTable("Leads", f.id);
    expect(db.getTable(t.id)?.folder_id).toBe(f.id);
  });

  it("moveTable files a table into a folder and back to the root", () => {
    const f = db.createFolder("Pipeline");
    const t = db.createTable("Leads");
    expect(db.getTable(t.id)?.folder_id).toBeNull();
    db.moveTable(t.id, f.id);
    expect(db.getTable(t.id)?.folder_id).toBe(f.id);
    db.moveTable(t.id, null);
    expect(db.getTable(t.id)?.folder_id).toBeNull();
  });

  it("moveTable can set a fractional position (drag reorder midpoint)", () => {
    const t1 = db.createTable("A");
    const t2 = db.createTable("B");
    const t3 = db.createTable("C");
    // Move C between A (pos 0) and B (pos 1).
    db.moveTable(t3.id, null, (t1.position + t2.position) / 2);
    expect(db.listTables().map((t) => t.name)).toEqual(["A", "C", "B"]);
  });

  it("deleting a folder unfiles its tables instead of deleting them", () => {
    const f = db.createFolder("Pipeline");
    const t = db.createTable("Leads", f.id);
    db.deleteFolder(f.id);
    expect(db.listFolders()).toEqual([]);
    expect(db.getTable(t.id)?.folder_id).toBeNull();
    expect(db.listTables()).toHaveLength(1);
  });
});
