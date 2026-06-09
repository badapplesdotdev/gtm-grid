/**
 * Db.listCloudTableLinks (TRI-3311).
 *
 * The one-way local→cloud push records the cloud `tables.id` a local table was
 * pushed to under a `cloud_table_link:<localTableId>` meta key. `getCloudTableLink`
 * reads one; `listCloudTableLinks` returns ALL of them as a `{ [localTableId]:
 * cloudTableId }` map so the sidecar can expose them for server-backed hydration.
 * These tests prove the list returns exactly the persisted links (and survives a
 * reopen), against a real temp SQLite Db.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-cloud-links-test-"));
  db = new Db(join(dir, "project.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Db.listCloudTableLinks", () => {
  it("is empty when no links have been recorded", () => {
    expect(db.listCloudTableLinks()).toEqual({});
  });

  it("returns every persisted local→cloud link", () => {
    db.setCloudTableLink("local-a", "cloud-a");
    db.setCloudTableLink("local-b", "cloud-b");
    db.setCloudTableLink("local-c", "cloud-c");
    expect(db.listCloudTableLinks()).toEqual({
      "local-a": "cloud-a",
      "local-b": "cloud-b",
      "local-c": "cloud-c",
    });
  });

  it("reflects the latest cloud id after a re-push (swap) overwrites a link", () => {
    db.setCloudTableLink("local-a", "cloud-old");
    db.setCloudTableLink("local-a", "cloud-new");
    expect(db.listCloudTableLinks()).toEqual({ "local-a": "cloud-new" });
    // Single-link read agrees with the listed value.
    expect(db.getCloudTableLink("local-a")).toBe("cloud-new");
  });

  it("includes ONLY the cloud-link meta rows, not other meta (favorites etc.)", () => {
    db.setCloudTableLink("local-a", "cloud-a");
    db.setMeta("favorite_tables", JSON.stringify(["local-a"]));
    db.setMeta("current_project", "default");
    expect(db.listCloudTableLinks()).toEqual({ "local-a": "cloud-a" });
  });

  it("persists across a reopen of the project db", () => {
    db.setCloudTableLink("local-a", "cloud-a");
    db.setCloudTableLink("local-b", "cloud-b");
    const reopened = new Db(join(dir, "project.db"));
    expect(reopened.listCloudTableLinks()).toEqual({
      "local-a": "cloud-a",
      "local-b": "cloud-b",
    });
  });
});
