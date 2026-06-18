/**
 * Sidebar table-tree view-model tests. Cover the pure tree helpers the cloud
 * sidebar composes — de-dup by name, folder partitioning, and drag-reorder
 * position math — so they run offline (no DOM, no live sidecar).
 */

import { describe, expect, it } from "vitest";
import {
  dedupeTableRowsByName,
  groupTableList,
  isCloudTableMissing,
  normalizeTableName,
  positionForMove,
  type TableListRow,
} from "./tableTree";

describe("normalizeTableName", () => {
  it("lowercases and trims for case/whitespace-insensitive de-dup", () => {
    expect(normalizeTableName("  Leads ")).toBe("leads");
    expect(normalizeTableName("LEADS")).toBe("leads");
  });
});

describe("dedupeTableRowsByName", () => {
  const row = (over: Partial<TableListRow> & { id: string; name: string }): TableListRow => ({
    kind: "cloud",
    synced: true,
    favorite: false,
    rows: 0,
    folderId: null,
    position: 0,
    ...over,
  });

  it("collapses two same-name rows, keeping the richest (real row count wins)", () => {
    const out = dedupeTableRowsByName([
      row({ id: "c1", name: "Leads", kind: "cloud", rows: 0 }),
      row({ id: "l1", name: "Leads", kind: "local", rows: 12 }),
    ]);
    expect(out).toHaveLength(1);
    // The richer candidate REPLACES the incumbent in its slot, so the kept row is
    // the one carrying the real row count.
    expect(out[0]?.id).toBe("l1");
    expect(out[0]?.rows).toBe(12);
  });

  it("prefers a local row over a cloud row when neither carries a count", () => {
    const out = dedupeTableRowsByName([
      row({ id: "c1", name: "Leads", kind: "cloud" }),
      row({ id: "l1", name: "Leads", kind: "local" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("local");
  });

  it("never collapses genuinely different names", () => {
    const out = dedupeTableRowsByName([
      row({ id: "a", name: "Leads" }),
      row({ id: "b", name: "Accounts" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("groupTableList (sidebar folder partitioning)", () => {
  const row = (id: string, folderId: string | null = null, position = 0): TableListRow => ({
    kind: "local", id, name: id, synced: false, favorite: false, rows: 0, folderId, position,
  });
  const folder = (id: string, position = 0) => ({ id, name: id, position });

  it("partitions rows into folder sections and the root, preserving order", () => {
    const grouped = groupTableList(
      [row("a", "f1"), row("b"), row("c", "f1"), row("d", "f2")],
      [folder("f1", 0), folder("f2", 1)],
    );
    expect(grouped.folders.map((s) => s.folder.id)).toEqual(["f1", "f2"]);
    expect(grouped.folders[0]?.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(grouped.folders[1]?.rows.map((r) => r.id)).toEqual(["d"]);
    expect(grouped.root.map((r) => r.id)).toEqual(["b"]);
  });

  it("orders folder sections by folder position", () => {
    const grouped = groupTableList([], [folder("f2", 5), folder("f1", 1)]);
    expect(grouped.folders.map((s) => s.folder.id)).toEqual(["f1", "f2"]);
  });

  it("keeps an empty folder as a section (a valid drop target)", () => {
    const grouped = groupTableList([row("a")], [folder("f1")]);
    expect(grouped.folders).toHaveLength(1);
    expect(grouped.folders[0]?.rows).toEqual([]);
  });

  it("falls a row pointing at an unknown folder back to the root", () => {
    const grouped = groupTableList([row("a", "ghost")], [folder("f1")]);
    expect(grouped.root.map((r) => r.id)).toEqual(["a"]);
    expect(grouped.folders[0]?.rows).toEqual([]);
  });
});

describe("positionForMove (fractional drag-reorder positions)", () => {
  const row = (id: string, position: number, folderId: string | null = null): TableListRow => ({
    kind: "local", id, name: id, synced: false, favorite: false, rows: 0, folderId, position,
  });

  it("returns undefined for an empty target group (membership-only move)", () => {
    expect(positionForMove([row("a", 0)], "a", { folderId: "f1" })).toBeUndefined();
  });

  it("files at the tail of a folder when dropped on its head", () => {
    const rows = [row("a", 1, "f1"), row("b", 4, "f1"), row("m", 0)];
    expect(positionForMove(rows, "m", { folderId: "f1" })).toBe(5);
  });

  it("takes the midpoint when dropped between two rows", () => {
    const rows = [row("a", 1), row("b", 3), row("m", 9)];
    expect(positionForMove(rows, "m", { folderId: null, beforeId: "b" })).toBe(2);
    expect(positionForMove(rows, "m", { folderId: null, afterId: "a" })).toBe(2);
  });

  it("steps past the edge when dropped before the first / after the last row", () => {
    const rows = [row("a", 1), row("b", 3), row("m", 9)];
    expect(positionForMove(rows, "m", { folderId: null, beforeId: "a" })).toBe(0);
    expect(positionForMove(rows, "m", { folderId: null, afterId: "b" })).toBe(4);
  });

  it("ignores the moved row itself when finding neighbours", () => {
    const rows = [row("a", 1), row("m", 2), row("b", 3)];
    // Moving m after a: its old position is excluded, so the midpoint is with b.
    expect(positionForMove(rows, "m", { folderId: null, afterId: "a" })).toBe(2);
  });
});

describe("isCloudTableMissing (404 detection)", () => {
  it("treats null (404 / not-found) as missing", () => {
    expect(isCloudTableMissing(null)).toBe(true);
  });

  it("treats undefined (still loading) as NOT missing", () => {
    expect(isCloudTableMissing(undefined)).toBe(false);
  });

  it("treats a loaded table as NOT missing", () => {
    expect(isCloudTableMissing({ id: "t", name: "T", columns: [], rows: [] })).toBe(false);
  });
});
