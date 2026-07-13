/**
 * Sidebar table-tree view-model helpers — PURE, no DOM / React.
 *
 * The cloud sidebar renders ONE "Tables" tree: a flat list of table rows
 * (favorites first), partitioned into folder sections, drag-reorderable with
 * fractional positions. These helpers keep the de-dup, the folder partitioning,
 * and the drag-reorder position math unit-testable offline (no DOM, no live
 * sidecar). App.tsx composes them.
 */

/** One row of the sidebar Tables list. */
export interface TableListRow {
  /** Where the row's data lives / how the main grid should render it. */
  readonly kind: "local" | "cloud";
  /** The id used to select + render the row. */
  readonly id: string;
  /** The display name. */
  readonly name: string;
  /** Whether this row is cloud-backed. */
  readonly synced: boolean;
  /**
   * Whether this table is backed by a CRM sync binding (Attio). Drives the
   * sidebar icon (the Attio favicon instead of the grid glyph). Optional — the
   * pure tree helpers don't require it; App populates it from crm.listBindings.
   */
  readonly crmSynced?: boolean;
  /** Favorite flag. */
  readonly favorite: boolean;
  /** Row count (for the trailing count badge). */
  readonly rows: number;
  /** Sidebar folder the table is filed under (null = root). */
  readonly folderId: string | null;
  /** Sort position within the sidebar (fractional after drag-reorders). */
  readonly position: number;
}

/**
 * Normalize a table name for NAME-based de-dup: lowercase + trim, so two rows
 * whose names differ only in case / surrounding whitespace are treated as the
 * SAME table. Pure + testable.
 */
export function normalizeTableName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Decide which of two same-name rows is the RICHER representation to keep when
 * de-duping by name. The "richest" row is the one carrying real signal: a row
 * with a non-zero `rows` count beats a bare row (count 0); a `local`-kind row
 * beats a `cloud`-kind row (it owns the data + the favorite/folder context);
 * otherwise the FIRST row seen wins. Returns `true` when `candidate` should
 * REPLACE the `incumbent` already kept for that name. Pure + testable.
 */
function candidateIsRicher(incumbent: TableListRow, candidate: TableListRow): boolean {
  // A real row count is the strongest signal of the richer representation.
  if (candidate.rows > 0 && incumbent.rows === 0) return true;
  if (incumbent.rows > 0) return false;
  // Neither carries a count: prefer the local row (owns data + favorite/folder).
  if (candidate.kind === "local" && incumbent.kind === "cloud") return true;
  // Same richness — keep the incumbent (first by recency / input order).
  return false;
}

/**
 * Remove GENUINE duplicates from a Tables list by NORMALIZED name, keeping the
 * RICHEST representation of each name (see {@link candidateIsRicher}). Two rows
 * that share a name collapse to ONE row. Genuinely different names are never
 * collapsed. The kept rows preserve the input order (first-seen position) so
 * favorites-first / position ordering still holds. Pure + testable: NO React.
 */
export function dedupeTableRowsByName(rows: readonly TableListRow[]): TableListRow[] {
  // Map normalized name → index of the kept row in `out`, so a later, richer
  // same-name row can replace the one already kept without reordering.
  const keptIndexByName = new Map<string, number>();
  const out: TableListRow[] = [];
  for (const row of rows) {
    const key = normalizeTableName(row.name);
    const existingIndex = keptIndexByName.get(key);
    if (existingIndex === undefined) {
      keptIndexByName.set(key, out.length);
      out.push(row);
      continue;
    }
    const incumbent = out[existingIndex] as TableListRow;
    if (candidateIsRicher(incumbent, row)) out[existingIndex] = row;
  }
  return out;
}

// ── Sidebar folder grouping ─────────────────────────────────────────────────
//
// Folders partition the Tables list: every folder renders (even empty ones —
// they're valid drop targets), followed by the root rows. Pure + testable: the
// partitioning, orphan handling (a row pointing at a deleted / unknown folder
// falls back to the root), and group ordering are verifiable offline with no
// React.

/** A sidebar folder as the grouper sees it. */
export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  /** The folder this folder nests under (null = top level). */
  readonly parentId: string | null;
}

/** The grouped sidebar view-model: folder sections first, then root rows. */
export interface GroupedTableList {
  readonly folders: ReadonlyArray<{
    readonly folder: SidebarFolder;
    readonly rows: TableListRow[];
  }>;
  readonly root: TableListRow[];
}

/**
 * Partition the Tables list by folder. Folder sections come in folder
 * `position` order; each section's rows (and the root rows) PRESERVE the input
 * list's order, so the caller's favorites-first / position ordering holds within
 * every group. A row whose `folderId` matches no known folder (deleted
 * out-of-band / not yet synced) falls back to the root rather than vanishing.
 */
export function groupTableList(
  rows: readonly TableListRow[],
  folders: readonly SidebarFolder[],
): GroupedTableList {
  const ordered = [...folders].sort((a, b) => a.position - b.position);
  const byFolder = new Map<string, TableListRow[]>(
    ordered.map((f) => [f.id, []]),
  );
  const root: TableListRow[] = [];
  for (const row of rows) {
    const bucket = row.folderId !== null ? byFolder.get(row.folderId) : undefined;
    if (bucket) bucket.push(row);
    else root.push(row);
  }
  return {
    folders: ordered.map((folder) => ({
      folder,
      rows: byFolder.get(folder.id) ?? [],
    })),
    root,
  };
}

// ── Nested folders (sub-folders) ────────────────────────────────────────────
//
// Folders NEST: a folder may sit inside another folder (`SidebarFolder.parentId`).
// The sidebar renders a TREE — each folder node carries its own table rows plus
// its child folder nodes. The builder is pure + testable: it tolerates orphans
// (a `parentId` pointing at a missing folder falls back to the top level) and is
// cycle-safe (malformed parent loops can't recurse forever; the unreachable
// members surface at the top level instead of vanishing).

/** A folder node in the sidebar tree: its rows plus nested child folders. */
export interface FolderTreeNode {
  readonly folder: SidebarFolder;
  readonly rows: TableListRow[];
  readonly children: FolderTreeNode[];
}

/** The nested sidebar view-model: top-level folder nodes, then root rows. */
export interface FolderTree {
  readonly roots: FolderTreeNode[];
  readonly rootRows: TableListRow[];
}

/**
 * Build the nested sidebar folder tree. Each folder's child folders come in
 * `position` order; each folder's rows (and the root rows) PRESERVE the input
 * list order, so favourites-first / position ordering holds within every group.
 * A folder whose `parentId` matches no known folder is treated as top-level, and
 * a row whose `folderId` matches no known folder falls back to the root — neither
 * vanishes. Cycle-safe: folders only reachable through a parent loop are surfaced
 * at the top level rather than recursing forever.
 */
export function buildFolderTree(
  rows: readonly TableListRow[],
  folders: readonly SidebarFolder[],
): FolderTree {
  const known = new Set(folders.map((f) => f.id));

  // Partition rows by their (known) folder; unknown / null folderId → root.
  const rowsByFolder = new Map<string, TableListRow[]>();
  const rootRows: TableListRow[] = [];
  for (const row of rows) {
    if (row.folderId !== null && known.has(row.folderId)) {
      const bucket = rowsByFolder.get(row.folderId) ?? [];
      bucket.push(row);
      rowsByFolder.set(row.folderId, bucket);
    } else {
      rootRows.push(row);
    }
  }

  // Group folders under their EFFECTIVE parent: a parentId pointing at a missing
  // folder is treated as top-level (null), so orphans don't disappear.
  const childrenOf = new Map<string | null, SidebarFolder[]>();
  for (const folder of folders) {
    const parent =
      folder.parentId !== null && known.has(folder.parentId)
        ? folder.parentId
        : null;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(folder);
    childrenOf.set(parent, bucket);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.position - b.position);
  }

  const visited = new Set<string>();
  const build = (folder: SidebarFolder): FolderTreeNode => {
    visited.add(folder.id);
    // Skip already-visited children so a parent cycle can't recurse forever.
    const kids = (childrenOf.get(folder.id) ?? []).filter(
      (c) => !visited.has(c.id),
    );
    return {
      folder,
      rows: rowsByFolder.get(folder.id) ?? [],
      children: kids.map(build),
    };
  };

  const roots = (childrenOf.get(null) ?? []).map(build);
  // Any folder unreachable from the top level is in a parent cycle — surface it
  // at the top level (position-ordered) so it stays usable instead of vanishing.
  const stranded = folders
    .filter((f) => !visited.has(f.id))
    .sort((a, b) => a.position - b.position);
  for (const folder of stranded) {
    if (!visited.has(folder.id)) roots.push(build(folder));
  }
  return { roots, rootRows };
}

/**
 * Whether `folderId` has `possibleAncestorId` somewhere on its parent chain
 * (inclusive of itself). Walks parents up to the top, guarding against malformed
 * cycles. Pure + testable.
 */
export function folderHasAncestor(
  folders: readonly SidebarFolder[],
  folderId: string,
  possibleAncestorId: string,
): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const seen = new Set<string>();
  let cursor: string | null = folderId;
  while (cursor !== null) {
    if (cursor === possibleAncestorId) return true;
    if (seen.has(cursor)) break; // defensive: pre-existing cycle
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * Whether the folder `movedId` may be reparented INTO `targetId` (null = top
 * level). Illegal when the target is the folder itself or any of its
 * descendants (that would create a cycle). Moving to the top level is always
 * allowed. Pure + testable — the UI uses this to reject the drop.
 */
export function canMoveFolderInto(
  folders: readonly SidebarFolder[],
  movedId: string,
  targetId: string | null,
): boolean {
  if (targetId === null) return true;
  // Illegal if `movedId` is an ancestor of (or equal to) the target.
  return !folderHasAncestor(folders, targetId, movedId);
}

/**
 * The `position` a folder reparented under `parentId` (null = top level) should
 * take: the tail of that destination sibling group (`max position + 1`), or 0
 * when empty. Excludes `movedId` itself so re-dropping into the same group is a
 * no-op tail. Pure + testable.
 */
export function folderTailPosition(
  folders: readonly SidebarFolder[],
  parentId: string | null,
  movedId: string,
): number {
  const known = new Set(folders.map((f) => f.id));
  const siblings = folders.filter((f) => {
    if (f.id === movedId) return false;
    const parent = f.parentId !== null && known.has(f.parentId) ? f.parentId : null;
    return parent === parentId;
  });
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((f) => f.position)) + 1;
}

/**
 * The drop target of a sidebar drag, as the UI reports it:
 *   - onto a folder head / its empty body → `{ folderId }` (file at the tail)
 *   - between two rows → `{ folderId, beforeId | afterId }` (reorder)
 *   - onto the root zone → `{ folderId: null }`
 */
export interface MoveTarget {
  readonly folderId: string | null;
  readonly beforeId?: string;
  readonly afterId?: string;
}

/**
 * Compute the fractional `position` a moved table should take for a
 * {@link MoveTarget}, from the CURRENT list. Dropping before/after an anchor row
 * takes the midpoint between the anchor and its same-group neighbour (so only the
 * moved row's position changes); dropping onto a folder or the root files at the
 * group's tail (`max position + 1`). Returns `undefined` when no position change
 * is needed (empty group — keep the current position; membership alone changes).
 */
export function positionForMove(
  rows: readonly TableListRow[],
  movedId: string,
  target: MoveTarget,
): number | undefined {
  // The target group's rows in display order, excluding the row being moved.
  const group = rows.filter(
    (r) => r.folderId === target.folderId && r.id !== movedId,
  );
  if (group.length === 0) return undefined;
  const anchorId = target.beforeId ?? target.afterId;
  const i = anchorId !== undefined ? group.findIndex((r) => r.id === anchorId) : -1;
  if (i < 0) {
    // No (valid) anchor — file at the tail of the group.
    return Math.max(...group.map((r) => r.position)) + 1;
  }
  const anchor = group[i] as TableListRow;
  if (target.beforeId !== undefined) {
    const prev = group[i - 1];
    return prev === undefined ? anchor.position - 1 : (prev.position + anchor.position) / 2;
  }
  const next = group[i + 1];
  return next === undefined ? anchor.position + 1 : (anchor.position + next.position) / 2;
}

/**
 * Whether a cloud `getTable` result indicates the open table no longer exists.
 * The cloud grid hook surfaces a missing table as `null` (vs `undefined` while
 * loading), mirroring a 404 / not-found from `grid.getTable`. Pure so the 404
 * detection is unit-testable without React or the network.
 */
export function isCloudTableMissing(
  data: unknown | null | undefined,
): data is null {
  return data === null;
}
