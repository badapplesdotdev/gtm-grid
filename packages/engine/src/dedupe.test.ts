// Table deduplication (Clay-style): exact-match on one column, keep oldest/newest,
// applied on insert (addRowsDeduped) and as a one-shot sweep (dedupeTable). Blank
// and over-long key cells are never merged.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";

let dir: string;
let db: Db;
let tableId: string;
let urlCol: string;
let nameCol: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dedupe-test-"));
  db = new Db(join(dir, "p.db"));
  const t = db.createTable("Leads");
  tableId = t.id;
  urlCol = db.createColumn({ tableId, name: "URL", kind: "manual" }).id;
  nameCol = db.createColumn({ tableId, name: "Name", kind: "manual" }).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const urlsInTable = () =>
  db.listRows(tableId).map((r) => db.getCell(r.id, urlCol)?.value);

describe("addRowsDeduped", () => {
  it("with no config, inserts everything (plain bulk insert)", () => {
    const res = db.addRowsDeduped(tableId, [{ [urlCol]: "a.com" }, { [urlCol]: "a.com" }]);
    expect(res).toMatchObject({ added: 2, skipped: 0, replaced: 0 });
    expect(urlsInTable()).toEqual(["a.com", "a.com"]);
  });

  it("keep oldest: skips an incoming row whose key already exists", () => {
    db.setTableDedupe(tableId, { column: urlCol, keep: "oldest" });
    db.addRowsDeduped(tableId, [{ [urlCol]: "a.com", [nameCol]: "First" }]);
    const res = db.addRowsDeduped(tableId, [
      { [urlCol]: "a.com", [nameCol]: "Dupe" },
      { [urlCol]: "b.com", [nameCol]: "New" },
    ]);
    expect(res).toMatchObject({ added: 1, skipped: 1, replaced: 0 });
    expect(urlsInTable()).toEqual(["a.com", "b.com"]);
    // the original row (First) survived, not the dupe
    const first = db.listRows(tableId)[0];
    expect(db.getCell(first.id, nameCol)?.value).toBe("First");
  });

  it("dedups WITHIN a single batch too", () => {
    db.setTableDedupe(tableId, { column: urlCol, keep: "oldest" });
    const res = db.addRowsDeduped(tableId, [
      { [urlCol]: "x.com" },
      { [urlCol]: "x.com" },
      { [urlCol]: "y.com" },
    ]);
    expect(res).toMatchObject({ added: 2, skipped: 1 });
    expect(urlsInTable()).toEqual(["x.com", "y.com"]);
  });

  it("keep newest: deletes the existing match and inserts the new row", () => {
    db.setTableDedupe(tableId, { column: urlCol, keep: "newest" });
    db.addRowsDeduped(tableId, [{ [urlCol]: "a.com", [nameCol]: "Old" }]);
    const res = db.addRowsDeduped(tableId, [{ [urlCol]: "a.com", [nameCol]: "Fresh" }]);
    expect(res).toMatchObject({ added: 1, replaced: 1, skipped: 0 });
    expect(db.listRows(tableId)).toHaveLength(1);
    const only = db.listRows(tableId)[0];
    expect(db.getCell(only.id, nameCol)?.value).toBe("Fresh");
  });

  it("never dedups on a blank or over-long key cell", () => {
    db.setTableDedupe(tableId, { column: urlCol, keep: "oldest" });
    const long = "x".repeat(201);
    const res = db.addRowsDeduped(tableId, [
      { [urlCol]: "" },
      { [urlCol]: "" },
      { [urlCol]: long },
      { [urlCol]: long },
    ]);
    expect(res).toMatchObject({ added: 4, skipped: 0 });
  });

  it("matches exactly — no normalization (case/whitespace-trim only)", () => {
    db.setTableDedupe(tableId, { column: urlCol, keep: "oldest" });
    const res = db.addRowsDeduped(tableId, [
      { [urlCol]: "Stripe.com" },
      { [urlCol]: " Stripe.com " }, // trimmed → duplicate
      { [urlCol]: "stripe.com" }, // different case → NOT a duplicate (exact match)
      { [urlCol]: "www.stripe.com" }, // not normalized → NOT a duplicate
    ]);
    expect(res).toMatchObject({ added: 3, skipped: 1 });
  });
});

describe("dedupeTable (one-shot sweep)", () => {
  it("collapses existing dupes, keeping oldest", () => {
    db.addRowsDeduped(tableId, [{ [urlCol]: "a.com" }, { [urlCol]: "a.com" }, { [urlCol]: "b.com" }]);
    db.setTableDedupe(tableId, { column: urlCol, keep: "oldest" });
    const res = db.dedupeTable(tableId);
    expect(res.deleted).toBe(1);
    expect(urlsInTable()).toEqual(["a.com", "b.com"]);
  });

  it("keeps newest when configured", () => {
    db.addRowsDeduped(tableId, [
      { [urlCol]: "a.com", [nameCol]: "1" },
      { [urlCol]: "a.com", [nameCol]: "2" },
      { [urlCol]: "a.com", [nameCol]: "3" },
    ]);
    db.setTableDedupe(tableId, { column: urlCol, keep: "newest" });
    db.dedupeTable(tableId);
    expect(db.listRows(tableId)).toHaveLength(1);
    expect(db.getCell(db.listRows(tableId)[0].id, nameCol)?.value).toBe("3");
  });

  it("is a no-op when dedup is off", () => {
    db.addRowsDeduped(tableId, [{ [urlCol]: "a.com" }, { [urlCol]: "a.com" }]);
    expect(db.dedupeTable(tableId)).toEqual({ deleted: 0 });
    expect(db.listRows(tableId)).toHaveLength(2);
  });
});

describe("dedup config round-trips", () => {
  it("get/set/clear", () => {
    expect(db.getTableDedupe(tableId)).toBeNull();
    db.setTableDedupe(tableId, { column: urlCol, keep: "newest" });
    expect(db.getTableDedupe(tableId)).toEqual({ column: urlCol, keep: "newest" });
    db.setTableDedupe(tableId, null);
    expect(db.getTableDedupe(tableId)).toBeNull();
  });
});
