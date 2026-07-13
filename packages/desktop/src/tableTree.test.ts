/**
 * Sidebar table-tree view-model tests. Cover the pure tree helpers the cloud
 * sidebar composes — de-dup by name, folder partitioning, and drag-reorder
 * position math — so they run offline (no DOM, no live sidecar).
 */

import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  canMoveFolderInto,
  dedupeTableRowsByName,
  folderHasAncestor,
  folderTailPosition,
  groupTableList,
  isCloudTableMissing,
  normalizeTableName,
  positionForMove,
  type SidebarFolder,
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
  const folder = (id: string, position = 0): SidebarFolder => ({ id, name: id, position, parentId: null });

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

describe("buildFolderTree (nested sub-folders)", () => {
  const row = (id: string, folderId: string | null = null, position = 0): TableListRow => ({
    kind: "local", id, name: id, synced: false, favorite: false, rows: 0, folderId, position,
  });
  const folder = (id: string, parentId: string | null = null, position = 0): SidebarFolder => ({
    id, name: id, position, parentId,
  });

  it("nests child folders under their parent", () => {
    const tree = buildFolderTree(
      [row("t1", "parent"), row("t2", "child")],
      [folder("parent"), folder("child", "parent")],
    );
    expect(tree.roots.map((n) => n.folder.id)).toEqual(["parent"]);
    expect(tree.roots[0]?.children.map((n) => n.folder.id)).toEqual(["child"]);
    expect(tree.roots[0]?.rows.map((r) => r.id)).toEqual(["t1"]);
    expect(tree.roots[0]?.children[0]?.rows.map((r) => r.id)).toEqual(["t2"]);
  });

  it("orders sibling folders (root and nested) by position", () => {
    const tree = buildFolderTree(
      [],
      [folder("b", null, 5), folder("a", null, 1), folder("a2", "a", 2), folder("a1", "a", 1)],
    );
    expect(tree.roots.map((n) => n.folder.id)).toEqual(["a", "b"]);
    expect(tree.roots[0]?.children.map((n) => n.folder.id)).toEqual(["a1", "a2"]);
  });

  it("promotes a folder with an unknown parent to the top level", () => {
    const tree = buildFolderTree([], [folder("orphan", "ghost")]);
    expect(tree.roots.map((n) => n.folder.id)).toEqual(["orphan"]);
  });

  it("falls a row pointing at an unknown folder back to root rows", () => {
    const tree = buildFolderTree([row("t", "ghost")], [folder("real")]);
    expect(tree.rootRows.map((r) => r.id)).toEqual(["t"]);
  });

  it("is cycle-safe: a parent loop surfaces members without recursing forever", () => {
    // f1 → f2 → f1 (malformed). The builder must not hang; it breaks the loop by
    // surfacing one member at the top level and nesting the other under it, so
    // BOTH stay reachable (nothing vanishes) and neither recurses forever.
    const tree = buildFolderTree([], [folder("f1", "f2"), folder("f2", "f1")]);
    const seen: string[] = [];
    const walk = (nodes: typeof tree.roots) => {
      for (const n of nodes) { seen.push(n.folder.id); walk(n.children); }
    };
    walk(tree.roots);
    expect(seen.sort()).toEqual(["f1", "f2"]);
  });
});

describe("folderHasAncestor / canMoveFolderInto (cycle guard)", () => {
  const folder = (id: string, parentId: string | null = null): SidebarFolder => ({
    id, name: id, position: 0, parentId,
  });
  // a → b → c (c nested under b nested under a)
  const folders = [folder("a"), folder("b", "a"), folder("c", "b")];

  it("detects an ancestor on the parent chain (inclusive)", () => {
    expect(folderHasAncestor(folders, "c", "a")).toBe(true);
    expect(folderHasAncestor(folders, "c", "c")).toBe(true);
    expect(folderHasAncestor(folders, "a", "c")).toBe(false);
  });

  it("forbids moving a folder into itself or a descendant", () => {
    expect(canMoveFolderInto(folders, "a", "a")).toBe(false); // into itself
    expect(canMoveFolderInto(folders, "a", "c")).toBe(false); // into its descendant
    expect(canMoveFolderInto(folders, "b", "c")).toBe(false);
  });

  it("allows moving to the top level or into an unrelated folder", () => {
    expect(canMoveFolderInto(folders, "c", null)).toBe(true);
    expect(canMoveFolderInto([...folders, folder("x")], "x", "c")).toBe(true);
  });
});

describe("folderTailPosition", () => {
  const folder = (id: string, parentId: string | null, position: number): SidebarFolder => ({
    id, name: id, position, parentId,
  });

  it("returns max sibling position + 1 within the destination group", () => {
    const folders = [folder("p", null, 0), folder("a", "p", 0), folder("b", "p", 3), folder("m", null, 9)];
    expect(folderTailPosition(folders, "p", "m")).toBe(4);
  });

  it("returns 0 for an empty destination group", () => {
    expect(folderTailPosition([folder("p", null, 0), folder("m", null, 9)], "p", "m")).toBe(0);
  });

  it("excludes the moved folder from its own sibling group", () => {
    const folders = [folder("p", null, 0), folder("a", "p", 0), folder("m", "p", 5)];
    // Re-filing m into p ignores m's own position → tail is a's position + 1.
    expect(folderTailPosition(folders, "p", "m")).toBe(1);
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
