/**
 * Auto-sync setting persistence (TRI-3298).
 *
 * The sidecar's `/api/settings/auto-sync` routes read/write a GLOBAL meta flag
 * (`auto_sync_offline_tables`) via `globalDb.getMeta/setMeta`, exactly like the
 * existing `custom_skills` setting. The flag DEFAULTS OFF: only the canonical
 * string "true" enables it, so an unset or non-"true" value can never silently
 * turn auto-sync on.
 *
 * `index.ts` binds a port on import (side effects), so rather than import it we
 * exercise the SAME meta contract the routes use against a real engine `Db` in a
 * temp dir — proving the default-off + persistence behaviour offline.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "@gtmgrid/engine";

const AUTO_SYNC_META_KEY = "auto_sync_offline_tables";
// Mirrors index.ts getAutoSync/setAutoSync exactly.
const getAutoSync = (db: Db): boolean => db.getMeta(AUTO_SYNC_META_KEY) === "true";
const setAutoSync = (db: Db, on: boolean): void =>
  db.setMeta(AUTO_SYNC_META_KEY, on ? "true" : "false");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auto-sync-test-"));
  db = new Db(join(dir, "global.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("auto-sync setting (global meta)", () => {
  it("defaults OFF when never set", () => {
    expect(getAutoSync(db)).toBe(false);
  });

  it("persists ON across a reopen of the global db", () => {
    setAutoSync(db, true);
    expect(getAutoSync(db)).toBe(true);
    const reopened = new Db(join(dir, "global.db"));
    expect(getAutoSync(reopened)).toBe(true);
  });

  it("toggling OFF persists immediately", () => {
    setAutoSync(db, true);
    setAutoSync(db, false);
    expect(getAutoSync(db)).toBe(false);
  });

  it("a non-'true' stored value reads as OFF (never silently on)", () => {
    db.setMeta(AUTO_SYNC_META_KEY, "1");
    expect(getAutoSync(db)).toBe(false);
    db.setMeta(AUTO_SYNC_META_KEY, "yes");
    expect(getAutoSync(db)).toBe(false);
  });
});
