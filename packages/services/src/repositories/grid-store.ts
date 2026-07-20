/**
 * `GridStore` — the SHARED in-memory backing store for the grid repositories'
 * TEST Layers (ProjectRepo / TableRepo / ColumnRepo / RowRepo / CellRepo).
 *
 * The live grid repos are independent Drizzle adapters, but their in-memory test
 * Layers must agree on ONE dataset so a test can observe cross-repo effects: a
 * row inserted via {@link RowRepo} is visible to {@link CellRepo}'s table scan,
 * and — crucially — a {@link TableRepo} delete CASCADES to its columns, rows, and
 * cells exactly like the Postgres `ON DELETE CASCADE` foreign keys (the AC's
 * "cascades delete dependent rows/cells"). Centralising the arrays + the cascade
 * here keeps every repo's Test Layer a thin view over the same mutable store,
 * mirroring the single live table the Drizzle layers share.
 *
 * Production never touches this file — each repo has its own Drizzle `*Live`
 * Layer. This is the offline-test seam ONLY.
 */

/** An in-memory project row. */
export interface StoreProject {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: number;
}

/** An in-memory table row. */
export interface StoreTable {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  position: number;
  createdAt: number;
  dedupeColumn: string | null;
  dedupeKeep: string | null;
  /** Sidebar folder the table is filed under (null = root). */
  folderId: string | null;
  /** Workspace-shared favourite/pin flag. */
  favorite: boolean;
}

/** An in-memory folder row (a sidebar table group). */
export interface StoreFolder {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  position: number;
  createdAt: number;
  /** The folder this folder nests under (null = top level). */
  parentId: string | null;
}

/** An in-memory column row (the full projection getTable returns). */
export interface StoreColumn {
  id: string;
  workspaceId: string;
  tableId: string;
  name: string;
  type: string;
  kind: "manual" | "function";
  provider: string | null;
  method: string | null;
  code: string | null;
  params: unknown;
  condition: string | null;
  position: number;
  createdAt: number;
}

/** An in-memory row row. */
export interface StoreRow {
  id: string;
  workspaceId: string;
  tableId: string;
  position: number;
  createdAt: number;
}

/** An in-memory cell row. */
export interface StoreCell {
  id: string;
  workspaceId: string;
  tableId: string;
  rowId: string;
  columnId: string;
  value: unknown;
  status: string;
  error: string | null;
  updatedAt: number | null;
}

/** The mutable dataset the grid repos' Test Layers share by reference. */
export interface GridStore {
  readonly projects: StoreProject[];
  readonly tables: StoreTable[];
  readonly folders: StoreFolder[];
  readonly columns: StoreColumn[];
  readonly rows: StoreRow[];
  readonly cells: StoreCell[];
  /** Monotonic id generator shared across all repos (stable, prefixed ids). */
  nextId: (prefix: string) => string;
}

/** Build a {@link GridStore} from optional seed arrays (shared by reference). */
export const makeGridStore = (seed: {
  projects?: StoreProject[];
  tables?: StoreTable[];
  folders?: StoreFolder[];
  columns?: StoreColumn[];
  rows?: StoreRow[];
  cells?: StoreCell[];
} = {}): GridStore => {
  let seq = 0;
  return {
    projects: seed.projects ?? [],
    tables: seed.tables ?? [],
    folders: seed.folders ?? [],
    columns: seed.columns ?? [],
    rows: seed.rows ?? [],
    cells: seed.cells ?? [],
    nextId: (prefix) => `${prefix}_${++seq}`,
  };
};

/**
 * Cascade-delete a table from the store: its cells, rows, and columns, then the
 * table itself — the in-memory mirror of the Postgres `ON DELETE CASCADE` FKs.
 */
export const cascadeDeleteTable = (store: GridStore, tableId: string): void => {
  removeWhere(store.cells, (c) => c.tableId === tableId);
  removeWhere(store.rows, (r) => r.tableId === tableId);
  removeWhere(store.columns, (c) => c.tableId === tableId);
  removeWhere(store.tables, (t) => t.id === tableId);
};

/**
 * Cascade-delete a project from the store: the cells/rows/columns of every
 * table in the project, then the tables, folders, and the project itself —
 * the in-memory mirror of the Postgres `project_id` FK cascades. Pipelines
 * are NOT here (they live in the pipeline repo's own fixtures).
 */
export const cascadeDeleteProject = (store: GridStore, projectId: string): void => {
  const tableIds = new Set(
    store.tables.filter((t) => t.projectId === projectId).map((t) => t.id),
  );
  removeWhere(store.cells, (c) => tableIds.has(c.tableId));
  removeWhere(store.rows, (r) => tableIds.has(r.tableId));
  removeWhere(store.columns, (c) => tableIds.has(c.tableId));
  removeWhere(store.tables, (t) => t.projectId === projectId);
  removeWhere(store.folders, (f) => f.projectId === projectId);
  removeWhere(store.projects, (p) => p.id === projectId);
};

/** Cascade-delete a column: every cell in that column, then the column. */
export const cascadeDeleteColumn = (
  store: GridStore,
  columnId: string,
): void => {
  removeWhere(store.cells, (c) => c.columnId === columnId);
  removeWhere(store.columns, (c) => c.id === columnId);
};

/** Cascade-delete a row: every cell in that row, then the row. */
export const cascadeDeleteRow = (store: GridStore, rowId: string): void => {
  removeWhere(store.cells, (c) => c.rowId === rowId);
  removeWhere(store.rows, (r) => r.id === rowId);
};

/** Remove every element matching `pred` from `arr` in place. */
function removeWhere<T>(arr: T[], pred: (x: T) => boolean): void {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i] as T)) arr.splice(i, 1);
  }
}
