/**
 * `GridService` — the grid-data domain service composing the five grid
 * repositories (Project/Table/Column/Row/Cell) + the reused `@gtmgrid/cloud`
 * `CellMerge` (COALESCE cell merge) + the dedicated {@link MeterService}
 * cloud-actions WRITE path, behind the `MembershipService` authz gate.
 *
 * Collapses the Convex action/mutation splits of `convex/projects.ts`,
 * `convex/tables.ts`, and `convex/cells.ts` into single Effect procedures:
 *
 *   - reads: listProjects, listTables, getTable (full grid: table+columns+rows+
 *     cells in ONE read, the exact shape desktop useCloudGrid.ts:165 consumes).
 *   - structural writes (each metered ONE cloud action): createProject (NOT
 *     metered — no source meter), createTable, addColumn, addRow,
 *     deleteTable/deleteColumn/deleteRow (deletes rely on FK ON DELETE CASCADE).
 *   - bulk write: addRowsWithCells — N rows + their cells, an ATOMIC quota
 *     pre-check against cached usage, metered as N cloud actions.
 *   - cell writes (each metered ONE): setCell (COALESCE merge), setCellStatus.
 *
 * Authz: every method resolves the owning workspace from the parent doc and calls
 * `MembershipService.requireMember` BEFORE reading/writing, so a non-member is
 * rejected before any data is touched and a missing parent fails authz (no
 * leakage). Metering happens AFTER authz/validation, so only genuine cloud writes
 * are counted.
 */

import {
  CellMerge,
  type CloudCellStatus,
  type InsufficientRoleError,
  type MemberRepoError,
  MembershipService,
  type NotAMemberError,
  type UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Data, Effect } from "effect";
import {
  type MinimalColumn,
  buildColumnDeps,
  columnInCycle,
  directDependencyIds,
  stableTopoOrder,
} from "../columns/index.js";
import {
  type Cell,
  CellRepo,
  type CellRepoError,
  type NewCell,
} from "../repositories/cell-repo.js";
import {
  type Column,
  ColumnRepo,
  type ColumnRepoError,
  type ColumnKind,
  type ColumnPatch,
} from "../repositories/column-repo.js";
import {
  type Project,
  ProjectRepo,
  type ProjectRepoError,
} from "../repositories/project-repo.js";
import {
  type NewRow,
  type Row,
  type RowCursor,
  ROW_PAGE_SIZE,
  RowRepo,
  type RowRepoError,
} from "../repositories/row-repo.js";
import {
  type Folder,
  FolderRepo,
  type FolderRepoError,
} from "../repositories/folder-repo.js";
import {
  type Table,
  TableRepo,
  type TableRepoError,
} from "../repositories/table-repo.js";
import type { WorkspaceRepoError } from "../repositories/workspace-repo.js";
import { isSelfHost } from "../self-host.js";
import type { GridChangeEvent, GridDedupe } from "../realtime/events.js";
import { WORKSPACE_ROOM_TABLE_ID } from "../realtime/events.js";
import { EntitlementService, type PlanRequiredError } from "./entitlement-service.js";
import { MeterService } from "./meter-service.js";
import { RealtimePublisher } from "./realtime-publisher.js";

/** Raised when a referenced project/table/column/row does not exist. */
export class GridNotFoundError extends Data.TaggedError("GridNotFoundError")<{
  readonly message: string;
}> {}

/** Raised when a (row, column) pair span different tables. */
export class InvalidCellError extends Data.TaggedError("InvalidCellError")<{
  readonly message: string;
}> {}

/** Raised when a bulk import would exceed the plan's remaining cloud actions. */
export class CloudActionsLimitError extends Data.TaggedError(
  "CloudActionsLimitError",
)<{
  readonly message: string;
}> {}

/**
 * Raised when a column edit would create a circular `{{Name}}` reference (e.g. A
 * reads B while B reads A). The change is rejected before it is persisted so the
 * grid never enters a cyclic dependency state.
 */
export class ColumnCycleError extends Data.TaggedError("ColumnCycleError")<{
  readonly message: string;
}> {}

/**
 * Project a stored {@link Column} (whose `params` is `unknown`) onto the
 * {@link MinimalColumn} shape the dependency analysis consumes. `params` is a
 * jsonb blob; `paramStrings` walks it defensively, so coercing a non-object to
 * `{}` is safe.
 */
const toMinimalColumn = (c: Column): MinimalColumn => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  provider: c.provider,
  params: (c.params ?? {}) as Record<string, unknown>,
  condition: c.condition,
});

/**
 * The full grid `getTable` returns, shaped to match what desktop
 * useCloudGrid.ts:173-192 consumes: Convex-style `_id` keys on the table,
 * columns, and rows; cells carry `rowId`/`columnId`/`value`/`status`/`error`.
 */
/** A column projection in the desktop `getTable` shape (Convex-style `_id`). */
export interface GridColumn {
  readonly _id: string;
  readonly name: string;
  readonly type: string;
  readonly kind: ColumnKind;
  readonly provider: string | null;
  readonly method: string | null;
  /**
   * Which account on the provider (a Slack team id); null = the workspace's
   * sole account on this connector. The desktop reads it to preselect the
   * column's team in the editor.
   */
  readonly accountId: string | null;
  readonly code: string | null;
  readonly params: unknown;
  readonly condition: string | null;
  /**
   * Optional behaviour flags (jsonb). Additive — CRM-synced columns carry
   * `{ synced: true, crmBindingId, attrSlug, attrType }` so the desktop can
   * render them read-only. `null`/absent for ordinary user columns.
   */
  readonly config: unknown;
}

/** A cell projection in the desktop `getTable` shape. */
export interface GridCell {
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
}

export interface FullGrid {
  readonly table: {
    readonly _id: string;
    readonly name: string;
    readonly dedupe: GridDedupe | null;
  };
  readonly columns: readonly GridColumn[];
  readonly rows: readonly { readonly _id: string }[];
  readonly cells: readonly GridCell[];
}

/**
 * One PAGE of a table's grid: the table + columns (both bounded and needed to
 * render any page) plus only THIS page's rows + their cells, and the
 * `nextCursor` to fetch the next page (`null` on the last page).
 *
 * The shape is a {@link FullGrid} superset (same `table`/`columns`/`rows`/`cells`
 * keys) so the desktop's incremental projector + the realtime `applyGridEvent`
 * reducer operate on a page exactly as they did on the full grid — only `rows`
 * and `cells` are bounded to the page, so no single response loads the whole
 * grid. A keyset cursor by ROW POSITION makes paging stable under concurrent
 * inserts.
 */
export interface TablePage {
  readonly table: {
    readonly _id: string;
    readonly name: string;
    readonly dedupe: GridDedupe | null;
  };
  readonly columns: readonly GridColumn[];
  readonly rows: readonly { readonly _id: string }[];
  readonly cells: readonly GridCell[];
  readonly nextCursor: RowCursor | null;
}

/** A `{ columnId: value }` map of one bulk-imported row's cells. */
export type CellMap = Readonly<Record<string, unknown>>;

/**
 * Soft ceiling above which the UNPAGED full-grid `getTable` logs a warning. The
 * grid is paginated (`getTablePage`), so a full-grid read at this size signals a
 * caller that should be using the paged path — the warning surfaces it without
 * breaking the (still-served) response.
 */
export const FULL_GRID_ROW_WARN_CAP = 20_000;

/** Project a repo `Column` onto the desktop `getTable` column shape. */
const toGridColumn = (c: Column): GridColumn => ({
  _id: c.id,
  name: c.name,
  type: c.type,
  kind: c.kind,
  provider: c.provider,
  method: c.method,
  accountId: c.accountId ?? null,
  code: c.code,
  params: c.params,
  condition: c.condition,
  config: c.config ?? null,
});

/** Project a repo `Cell` onto the desktop `getTable` cell shape. */
const toGridCell = (c: Cell): GridCell => ({
  rowId: c.rowId,
  columnId: c.columnId,
  value: c.value,
  status: c.status,
  error: c.error,
});

/** Project a table record's stored dedupe config onto the snapshot shape (null = off). */
const toDedupe = (table: {
  readonly dedupeColumn?: string | null;
  readonly dedupeKeep?: string | null;
}): GridDedupe | null =>
  table.dedupeColumn == null
    ? null
    : {
        column: table.dedupeColumn,
        keep: table.dedupeKeep === "newest" ? "newest" : "oldest",
      };

/**
 * The dedup grouping key for a cell value (mirrors the local engine,
 * packages/engine/src/db.ts): trimmed; a blank or >200-char value is NEVER
 * merged (returns null so the row is left untouched).
 */
const dedupeKeyOf = (value: unknown): string | null => {
  if (value == null) return null;
  const s = (typeof value === "string" ? value : String(value)).trim();
  if (s === "" || s.length > 200) return null;
  return s;
};

/**
 * Grid domain service. Defined with the `Effect.Service` pattern; the composed
 * `appLayer` wires the live repos/services, tests provide in-memory Layers and
 * get the SAME service with different behaviour.
 */
export class GridService extends Effect.Service<GridService>()("GridService", {
  effect: Effect.gen(function* () {
    const projects = yield* ProjectRepo;
    const tables = yield* TableRepo;
    const folders = yield* FolderRepo;
    const columns = yield* ColumnRepo;
    const rows = yield* RowRepo;
    const cells = yield* CellRepo;
    const cellMerge = yield* CellMerge;
    const membership = yield* MembershipService;
    const meter = yield* MeterService;
    const realtime = yield* RealtimePublisher;
    const entitlement = yield* EntitlementService;

    /**
     * Members-only AND the workspace has cloud access (paid plan / active trial).
     * The cloud-data gate: every cloud WRITE + opening a cloud table runs this so
     * a workspace whose trial lapsed (Free) is locked out — only listing existing
     * cloud tables (so the desktop can render them as "locked") stays open. Local
     * tables are wholly unaffected.
     */
    const requireCloudMember = (workspaceId: string) =>
      Effect.gen(function* () {
        yield* membership.requireMember(workspaceId);
        yield* entitlement.requireCloudAccess(workspaceId);
      });

    /**
     * Broadcast a change event on the table's channel AFTER a successful write,
     * so every other client subscribed to that table patches its cached snapshot
     * (the Convex `useQuery` reactivity replacement). Best-effort by construction:
     * the live publisher swallows transport errors, so realtime never fails a
     * write that already succeeded.
     */
    const publish = (
      workspaceId: string,
      tableId: string,
      event: GridChangeEvent,
    ) =>
      realtime
        .publish({ workspaceId, tableId, event })
        .pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void));

    /**
     * Broadcast a tables-list change on the WORKSPACE channel — the reserved
     * room `${workspaceId}:_workspace` (no real table has this id). The sidebar
     * subscribes to this one room so a member's table list refreshes live when a
     * teammate creates/syncs/deletes a table they don't currently have open
     * (the per-table channel above has no subscriber for a brand-new table).
     */
    const publishWorkspaceTablesChanged = (
      workspaceId: string,
      event: GridChangeEvent,
    ) =>
      realtime
        .publish({ workspaceId, tableId: WORKSPACE_ROOM_TABLE_ID, event })
        .pipe(Effect.catchTag("RealtimePublisherError", () => Effect.void));

    /** Load a project or fail typed. */
    const requireProject = (
      id: string,
    ): Effect.Effect<Project, ProjectRepoError | GridNotFoundError> =>
      Effect.gen(function* () {
        const found = yield* projects.findById(id);
        if (found._tag === "None") {
          return yield* Effect.fail(
            new GridNotFoundError({ message: `Project ${id} not found.` }),
          );
        }
        return found.value;
      });

    /** Load a table or fail typed. */
    const requireTable = (
      id: string,
    ): Effect.Effect<Table, TableRepoError | GridNotFoundError> =>
      Effect.gen(function* () {
        const found = yield* tables.findById(id);
        if (found._tag === "None") {
          return yield* Effect.fail(
            new GridNotFoundError({ message: `Table ${id} not found.` }),
          );
        }
        return found.value;
      });

    /** Load a folder or fail typed. */
    const requireFolder = (
      id: string,
    ): Effect.Effect<Folder, FolderRepoError | GridNotFoundError> =>
      Effect.gen(function* () {
        const found = yield* folders.findById(id);
        if (found._tag === "None") {
          return yield* Effect.fail(
            new GridNotFoundError({ message: `Folder ${id} not found.` }),
          );
        }
        return found.value;
      });

    /** Load a column or fail typed. */
    const requireColumn = (
      id: string,
    ): Effect.Effect<Column, ColumnRepoError | GridNotFoundError> =>
      Effect.gen(function* () {
        const found = yield* columns.findById(id);
        if (found._tag === "None") {
          return yield* Effect.fail(
            new GridNotFoundError({ message: `Column ${id} not found.` }),
          );
        }
        return found.value;
      });

    /** Load a row or fail typed. */
    const requireRow = (
      id: string,
    ): Effect.Effect<Row, RowRepoError | GridNotFoundError> =>
      Effect.gen(function* () {
        const found = yield* rows.findById(id);
        if (found._tag === "None") {
          return yield* Effect.fail(
            new GridNotFoundError({ message: `Row ${id} not found.` }),
          );
        }
        return found.value;
      });

    // ── projects ──────────────────────────────────────────────────────────

    /** A workspace's projects (creation order). Members-only. */
    const listProjects = (workspaceId: string) =>
      Effect.gen(function* () {
        yield* membership.requireMember(workspaceId);
        return yield* projects.listByWorkspace(workspaceId);
      });

    /** Create a project in a workspace. Members-only. NOT metered. */
    const createProject = (args: {
      readonly workspaceId: string;
      readonly name: string;
      /** Client-supplied id (optimistic create); the DB generates one if omitted. */
      readonly id?: string;
    }) =>
      Effect.gen(function* () {
        yield* requireCloudMember(args.workspaceId);
        return yield* projects.insert({
          ...(args.id !== undefined ? { id: args.id } : {}),
          workspaceId: args.workspaceId,
          name: args.name,
          createdAt: Date.now(),
        });
      });

    // ── tables ────────────────────────────────────────────────────────────

    /**
     * A project's tables (position order) WITH each table's row count, so the
     * desktop sidebar / Tables page show a real count for cloud tables instead of
     * "—". Counts come from ONE grouped `countByTableIds` query (not an N+1 per
     * table). Members-only.
     */
    const listTables = (projectId: string) =>
      Effect.gen(function* () {
        const project = yield* requireProject(projectId);
        yield* membership.requireMember(project.workspaceId);
        const projectTables = yield* tables.listByProject(projectId);
        const counts = yield* rows.countByTableIds(projectTables.map((t) => t.id));
        // `favorite` is a workspace-shared column on the table row, so every
        // member's list reflects the same pins.
        return projectTables.map((t) => ({ ...t, rows: counts[t.id] ?? 0 }));
      });

    /**
     * A project's tables WITH their column + row counts (position order).
     * Members-only. The agent's project-wide `list_tables` tool reports each
     * table with `{ id, name, columns, rows }`, so this composes the existing
     * `listByProject` read with a per-table `listColumns`/`listRows` count —
     * reusing the same repo reads {@link getTable} uses rather than adding a new
     * count primitive — and never touches a write or the meter (a pure read).
     */
    const listTablesWithCounts = (projectId: string) =>
      Effect.gen(function* () {
        const project = yield* requireProject(projectId);
        yield* membership.requireMember(project.workspaceId);
        const projectTables = yield* tables.listByProject(projectId);
        const out: {
          id: string;
          name: string;
          columns: number;
          rows: number;
        }[] = [];
        for (const t of projectTables) {
          const cols = yield* columns.listByTable(t.id);
          const rws = yield* rows.listByTable(t.id);
          out.push({
            id: t.id,
            name: t.name,
            columns: cols.length,
            rows: rws.length,
          });
        }
        return out;
      });

    /** The full grid for a table (table+columns+rows+cells). Members-only. */
    const getTable = (tableId: string): Effect.Effect<
      FullGrid,
      | TableRepoError
      | ColumnRepoError
      | RowRepoError
      | CellRepoError
      | GridNotFoundError
      | UnauthenticatedError
      | NotAMemberError
      | MemberRepoError
      | InsufficientRoleError
      | PlanRequiredError
      | WorkspaceRepoError
    > =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        const cols = yield* columns.listByTable(tableId);
        const rws = yield* rows.listByTable(tableId);
        const cls = yield* cells.listByTable(tableId);
        // Guard: a full-grid read at scale means a caller bypassed the paged
        // path. Warn (telemetry) but still serve so nothing breaks.
        if (rws.length > FULL_GRID_ROW_WARN_CAP) {
          yield* Effect.logWarning(
            `GridService.getTable loaded ${rws.length} rows for table ${tableId} — full-grid read above ${FULL_GRID_ROW_WARN_CAP}; prefer getTablePage at scale.`,
          );
        }
        return {
          table: { _id: table.id, name: table.name, dedupe: toDedupe(table) },
          columns: cols.map(toGridColumn),
          rows: rws.map((r) => ({ _id: r.id })),
          cells: cls.map(toGridCell),
        } satisfies FullGrid;
      });

    /**
     * One PAGE of a table's grid by ROW POSITION (keyset). Returns the table +
     * columns plus ONLY this page's rows and their cells, and a `nextCursor`
     * (`null` on the last page). No single response loads the whole grid, so a
     * 10k-row table is read one bounded page at a time. Members-only + the cloud
     * gate, exactly like {@link getTable}.
     */
    const getTablePage = (args: {
      readonly tableId: string;
      readonly cursor?: RowCursor | null;
      readonly limit?: number;
    }): Effect.Effect<
      TablePage,
      | TableRepoError
      | ColumnRepoError
      | RowRepoError
      | CellRepoError
      | GridNotFoundError
      | UnauthenticatedError
      | NotAMemberError
      | MemberRepoError
      | InsufficientRoleError
      | PlanRequiredError
      | WorkspaceRepoError
    > =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);
        const cols = yield* columns.listByTable(args.tableId);
        const page = yield* rows.listKeysetByTable({
          tableId: args.tableId,
          limit: args.limit ?? ROW_PAGE_SIZE,
          cursor: args.cursor ?? null,
        });
        // Read only THIS page's cells (by the page's row ids), never the whole
        // table's cells.
        const pageCells = yield* cells.listByRowIds(page.rows.map((r) => r.id));
        return {
          table: { _id: table.id, name: table.name, dedupe: toDedupe(table) },
          columns: cols.map(toGridColumn),
          rows: page.rows.map((r) => ({ _id: r.id })),
          cells: pageCells.map(toGridCell),
          nextCursor: page.nextCursor,
        } satisfies TablePage;
      });

    /** Create a table in a project. Members-only. Metered ONE action. */
    const createTable = (args: {
      readonly projectId: string;
      readonly name: string;
      /** Sidebar folder to file the new table under (omitted/null = root). */
      readonly folderId?: string | null;
      /** Client-supplied id (optimistic create); the DB generates one if omitted. */
      readonly id?: string;
    }) =>
      Effect.gen(function* () {
        const project = yield* requireProject(args.projectId);
        yield* requireCloudMember(project.workspaceId);
        // A target folder must exist and live in the SAME project (no cross-
        // project filing); a vanished folder fails typed rather than silently
        // creating at the root.
        let folderId: string | null = null;
        if (args.folderId != null) {
          const folder = yield* requireFolder(args.folderId);
          if (folder.projectId !== args.projectId) {
            return yield* Effect.fail(
              new GridNotFoundError({
                message: `Folder ${args.folderId} is not in project ${args.projectId}.`,
              }),
            );
          }
          folderId = folder.id;
        }
        const position = yield* tables.nextPosition(args.projectId);
        const id = yield* tables.insert({
          ...(args.id !== undefined ? { id: args.id } : {}),
          workspaceId: project.workspaceId,
          projectId: args.projectId,
          name: args.name,
          position,
          createdAt: Date.now(),
          folderId,
        });
        yield* meter.meterActions(project.workspaceId, 1);
        const insertEvent = {
          type: "table.insert" as const,
          tableId: id,
          projectId: args.projectId,
          name: args.name,
        };
        yield* publish(project.workspaceId, id, insertEvent);
        yield* publishWorkspaceTablesChanged(project.workspaceId, insertEvent);
        return id;
      });

    /** Add a column to a table. Members-only. Metered ONE action. */
    const addColumn = (args: {
      readonly tableId: string;
      readonly name: string;
      readonly type: string;
      readonly kind: ColumnKind;
      readonly provider?: string | null;
      readonly method?: string | null;
      /** Which account on the provider (Slack team id); null = the sole account. */
      readonly accountId?: string | null;
      readonly code?: string | null;
      readonly params?: unknown;
      readonly condition?: string | null;
      /** Client-supplied id (optimistic create); the DB generates one if omitted. */
      readonly id?: string;
    }) =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);

        // DAG-aware placement: slot the new column to the RIGHT of every existing
        // column it references via `{{Name}}` (in params/condition), so the table
        // reads left-to-right in dependency order. A brand-new column can't be a
        // cycle (nothing references its name yet), so no cycle check is needed here.
        const ordered = yield* columns.listByTable(args.tableId);
        const depIds = directDependencyIds(
          {
            id: "",
            name: args.name,
            kind: args.kind,
            provider: args.provider ?? null,
            params: (args.params ?? {}) as Record<string, unknown>,
            condition: args.condition ?? null,
          },
          ordered.map(toMinimalColumn),
        );
        // Rightmost dependency index; -1 when the column depends on nothing.
        let depIdx = -1;
        for (let k = 0; k < ordered.length; k++) {
          if (depIds.has(ordered[k]!.id)) depIdx = k;
        }
        // Independent → append to the tail (unchanged behavior). Otherwise take a
        // FRACTIONAL slot just after the rightmost dependency, so only the new
        // column's position is written and unrelated columns never move.
        let position: number;
        if (depIdx === -1) {
          position = yield* columns.nextPosition(args.tableId);
        } else if (depIdx === ordered.length - 1) {
          position = ordered[depIdx]!.position + 1;
        } else {
          position = (ordered[depIdx]!.position + ordered[depIdx + 1]!.position) / 2;
        }

        const id = yield* columns.insert({
          ...(args.id !== undefined ? { id: args.id } : {}),
          workspaceId: table.workspaceId,
          tableId: args.tableId,
          name: args.name,
          type: args.type,
          kind: args.kind,
          provider: args.provider ?? null,
          method: args.method ?? null,
          code: args.code ?? null,
          params: args.params ?? {},
          condition: args.condition ?? null,
          position,
          createdAt: Date.now(),
        });
        yield* meter.meterActions(table.workspaceId, 1);
        yield* publish(table.workspaceId, args.tableId, {
          type: "column.insert",
          column: {
            _id: id,
            name: args.name,
            type: args.type,
            kind: args.kind,
            provider: args.provider ?? null,
            method: args.method ?? null,
            accountId: args.accountId ?? null,
            code: args.code ?? null,
            params: args.params ?? {},
            condition: args.condition ?? null,
          },
        });
        // Placed BEFORE the tail (a column exists after the rightmost dependency)
        // → broadcast the full new id order so every viewer splices the column into
        // the right slot (the reducer appends inserts to the end; this reorder
        // corrects placement without a refetch). When the rightmost dependency is
        // the last column the insert naturally lands at the tail, so no reorder.
        if (depIdx !== -1 && depIdx < ordered.length - 1) {
          const columnIds = ordered.map((c) => c.id);
          columnIds.splice(depIdx + 1, 0, id);
          yield* publish(table.workspaceId, args.tableId, {
            type: "column.reorder",
            columnIds,
          });
        }
        return id;
      });

    /** Add a row to a table. Members-only. Metered ONE action. */
    const addRow = (tableId: string, rowId?: string) =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        const position = yield* rows.nextPosition(tableId);
        const id = yield* rows.insert({
          ...(rowId !== undefined ? { id: rowId } : {}),
          workspaceId: table.workspaceId,
          tableId,
          position,
          createdAt: Date.now(),
        });
        yield* meter.meterActions(table.workspaceId, 1);
        yield* publish(table.workspaceId, tableId, {
          type: "row.insert",
          row: { _id: id },
          cells: [],
        });
        return id;
      });

    /**
     * Bulk insert rows + their cells (CSV import). Members-only. Atomic quota
     * pre-check against cached usage rejects an import that would exceed the
     * plan limit BEFORE writing anything; metered as ONE action PER ROW.
     */
    const addRowsWithCells = (args: {
      readonly tableId: string;
      readonly rows: readonly CellMap[];
      /**
       * Client-supplied row ids aligned by index with `rows` (optimistic bulk
       * import). When omitted the DB generates each id. The returned `rowIds`
       * preserve input order either way, so the cells built from them stay
       * correctly keyed.
       */
      readonly rowIds?: readonly string[];
    }) =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);

        // Atomic quota pre-check (free tier has a hard cap; unlimited passes).
        // Self-host is never metered (no billing backend), so skip it entirely —
        // a stray `cloud_actions_limit` value must not cap a self-hoster.
        const quota = isSelfHost()
          ? undefined
          : yield* meter.readQuota(table.workspaceId);
        if (quota !== undefined && quota._tag === "Some") {
          const limit = quota.value.cloudActionsLimit;
          if (typeof limit === "number") {
            const used = quota.value.cloudActionsUsed ?? 0;
            if (used + args.rows.length > limit) {
              return yield* Effect.fail(
                new CloudActionsLimitError({
                  message:
                    "This import would exceed your plan's remaining cloud actions. Upgrade your plan or import fewer rows.",
                }),
              );
            }
          }
        }

        const valid = new Set(
          (yield* columns.listByTable(args.tableId)).map((c) => c.id),
        );
        const basePosition = yield* rows.nextPosition(args.tableId);
        const now = Date.now();

        // Build ALL row values up front (one bulk insert, not N), plus the
        // per-row filtered cell payloads (keyed by input index — the row id is
        // not known until insertMany returns it in input order).
        const newRows: NewRow[] = args.rows.map((_, i) => ({
          ...(args.rowIds?.[i] !== undefined ? { id: args.rowIds[i] } : {}),
          workspaceId: table.workspaceId,
          tableId: args.tableId,
          position: basePosition + i,
          createdAt: now,
        }));
        const perRowCells = args.rows.map((cellMap) =>
          Object.entries(cellMap).flatMap(([columnId, value]) =>
            value === "" ||
            value === null ||
            value === undefined ||
            !valid.has(columnId)
              ? []
              : [{ columnId, value }],
          ),
        );

        // Atomic write: row insert + cell insert + meter increment in ONE
        // transaction. A mid-import failure rolls back — no orphaned rows.
        const rowIds = yield* rows.bulkImport({
          rows: newRows,
          buildCells: (ids) =>
            ids.flatMap((rowId, i) =>
              (perRowCells[i] ?? []).map(
                ({ columnId, value }): NewCell => ({
                  workspaceId: table.workspaceId,
                  tableId: args.tableId,
                  rowId,
                  columnId,
                  value,
                  status: "done",
                  error: null,
                  updatedAt: now,
                }),
              ),
            ),
          // ONE billable cloud action per imported row (cells are not metered).
          meter: { workspaceId: table.workspaceId, n: args.rows.length },
        });

        // The DB counter was bumped inside the import transaction; only the
        // best-effort external Autumn usage track remains, AFTER the commit.
        yield* meter.trackActions(table.workspaceId, args.rows.length);

        // Per-row broadcast events (row + its cells), emitted AFTER the commit
        // so each subscriber splices the imported rows in.
        const rowEvents: GridChangeEvent[] = rowIds.map((rowId, i) => ({
          type: "row.insert",
          row: { _id: rowId },
          cells: (perRowCells[i] ?? []).map(({ columnId, value }) => ({
            rowId,
            columnId,
            value,
            status: "done",
            error: null,
          })),
        }));
        for (const event of rowEvents) {
          yield* publish(table.workspaceId, args.tableId, event);
        }
        return { rowIds: [...rowIds] };
      });

    /** Delete a table (FK cascade drops children). Members-only. Metered ONE. */
    const deleteTable = (tableId: string) =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        yield* tables.remove(tableId);
        yield* meter.meterActions(table.workspaceId, 1);
        const deleteEvent = { type: "table.delete" as const, tableId };
        yield* publish(table.workspaceId, tableId, deleteEvent);
        yield* publishWorkspaceTablesChanged(table.workspaceId, deleteEvent);
      });

    // ── folders (sidebar table groups) ──────────────────────────────────────
    //
    // Organizational metadata only — folder ops are NOT metered (mirroring
    // createProject: no data is computed or stored beyond a name), but they ARE
    // cloud-gated writes so a lapsed-trial workspace can't reorganize either.
    // Every write broadcasts `folders.changed` on the workspace room so other
    // members' sidebars refetch live.

    /** A project's folders (position order). Members-only. */
    const listFolders = (projectId: string) =>
      Effect.gen(function* () {
        const project = yield* requireProject(projectId);
        yield* membership.requireMember(project.workspaceId);
        return yield* folders.listByProject(projectId);
      });

    /**
     * Create a folder in a project, optionally nested under `parentId`
     * (null/omitted = top level). The parent, when given, must live in the same
     * project. Members-only. NOT metered.
     */
    const createFolder = (args: {
      readonly projectId: string;
      readonly name: string;
      /** Client-supplied id (optimistic create); the DB generates one if omitted. */
      readonly id?: string;
      /** Parent folder to nest under (null/omitted = top level). */
      readonly parentId?: string | null;
    }) =>
      Effect.gen(function* () {
        const project = yield* requireProject(args.projectId);
        yield* requireCloudMember(project.workspaceId);
        const parentId = args.parentId ?? null;
        if (parentId !== null) {
          const parent = yield* requireFolder(parentId);
          if (parent.projectId !== args.projectId) {
            return yield* Effect.fail(
              new GridNotFoundError({
                message: `Parent folder ${parentId} is not in project ${args.projectId}.`,
              }),
            );
          }
        }
        const position = yield* folders.nextPosition(args.projectId, parentId);
        const id = yield* folders.insert({
          ...(args.id !== undefined ? { id: args.id } : {}),
          workspaceId: project.workspaceId,
          projectId: args.projectId,
          name: args.name,
          position,
          createdAt: Date.now(),
          parentId,
        });
        yield* publishWorkspaceTablesChanged(project.workspaceId, {
          type: "folders.changed",
          projectId: args.projectId,
        });
        return id;
      });

    /** Rename a folder. Members-only. NOT metered. */
    const renameFolder = (args: {
      readonly folderId: string;
      readonly name: string;
    }) =>
      Effect.gen(function* () {
        const folder = yield* requireFolder(args.folderId);
        yield* requireCloudMember(folder.workspaceId);
        yield* folders.rename(args.folderId, args.name);
        yield* publishWorkspaceTablesChanged(folder.workspaceId, {
          type: "folders.changed",
          projectId: folder.projectId,
        });
      });

    /**
     * Delete a folder. Its tables are unfiled back to the root (the
     * `tables.folder_id` FK is ON DELETE SET NULL) — never deleted. Members-only.
     * NOT metered.
     */
    const deleteFolder = (folderId: string) =>
      Effect.gen(function* () {
        const folder = yield* requireFolder(folderId);
        yield* requireCloudMember(folder.workspaceId);
        yield* folders.remove(folderId);
        yield* publishWorkspaceTablesChanged(folder.workspaceId, {
          type: "folders.changed",
          projectId: folder.projectId,
        });
      });

    /**
     * Reparent a folder (`parentId: null` → top level), optionally with a new
     * sort position within the destination sibling group. Rejects a move that
     * would create a cycle (a folder cannot become its own descendant) — the
     * proposed parent must not be the folder itself nor any folder reachable by
     * walking parents up from it. Members-only. NOT metered.
     */
    const moveFolder = (args: {
      readonly folderId: string;
      readonly parentId: string | null;
      readonly position?: number;
    }) =>
      Effect.gen(function* () {
        const folder = yield* requireFolder(args.folderId);
        yield* requireCloudMember(folder.workspaceId);
        if (args.parentId !== null) {
          if (args.parentId === args.folderId) {
            return yield* Effect.fail(
              new GridNotFoundError({
                message: `A folder cannot be moved into itself.`,
              }),
            );
          }
          const parent = yield* requireFolder(args.parentId);
          if (parent.projectId !== folder.projectId) {
            return yield* Effect.fail(
              new GridNotFoundError({
                message: `Folder ${args.parentId} is not in folder ${args.folderId}'s project.`,
              }),
            );
          }
          // Cycle guard: walk up from the proposed parent; if we reach the
          // folder being moved, this move would nest it under its own subtree.
          const all = yield* folders.listByProject(folder.projectId);
          const byId = new Map(all.map((f) => [f.id, f]));
          let cursor: string | null = args.parentId;
          const seen = new Set<string>();
          while (cursor !== null) {
            if (cursor === args.folderId) {
              return yield* Effect.fail(
                new GridNotFoundError({
                  message: `Cannot move a folder into one of its own sub-folders.`,
                }),
              );
            }
            if (seen.has(cursor)) break; // defensive: pre-existing cycle
            seen.add(cursor);
            cursor = byId.get(cursor)?.parentId ?? null;
          }
        }
        yield* folders.setParent(args.folderId, args.parentId, args.position);
        yield* publishWorkspaceTablesChanged(folder.workspaceId, {
          type: "folders.changed",
          projectId: folder.projectId,
        });
      });

    /**
     * Move a table into a folder (`folderId: null` → root), optionally with a
     * new sort position (drag-reorder passes a fractional midpoint between the
     * drop neighbours). Members-only. NOT metered (organizational only).
     */
    const moveTable = (args: {
      readonly tableId: string;
      readonly folderId: string | null;
      readonly position?: number;
    }) =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);
        if (args.folderId !== null) {
          const folder = yield* requireFolder(args.folderId);
          if (folder.projectId !== table.projectId) {
            return yield* Effect.fail(
              new GridNotFoundError({
                message: `Folder ${args.folderId} is not in table ${args.tableId}'s project.`,
              }),
            );
          }
        }
        yield* tables.setFolder(args.tableId, args.folderId, args.position);
        yield* publishWorkspaceTablesChanged(table.workspaceId, {
          type: "folders.changed",
          projectId: table.projectId,
        });
      });

    /**
     * Rename a table. Members-only. Metered ONE. Broadcasts a `table.rename` on
     * BOTH the table's channel (open grids relabel their header) and the
     * workspace room (sidebars relabel without that table open). An empty/blank
     * name is ignored (keeps the current name). Returns the effective name.
     */
    const renameTable = (tableId: string, name: string) =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        const next = name.trim() === "" ? table.name : name.trim();
        yield* tables.rename(tableId, next);
        yield* meter.meterActions(table.workspaceId, 1);
        const event = {
          type: "table.rename" as const,
          tableId,
          name: next,
        };
        yield* publish(table.workspaceId, tableId, event);
        yield* publishWorkspaceTablesChanged(table.workspaceId, event);
        return { name: next };
      });

    /**
     * Pin/unpin a table (the cloud mirror of the local engine's favourites).
     * WORKSPACE-SHARED: the flag lives on the table row, so any member's pin is
     * visible to every teammate. Members-only + cloud-gated (a shared write).
     * Idempotent and NOT metered (a pin isn't a billable action). Broadcasts
     * `table.favorite` on the workspace room so every member's sidebar restyles
     * + reorders live. Returns the effective `favorite` state.
     */
    const setTableFavorite = (tableId: string, favorite: boolean) =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        yield* tables.setFavorite(tableId, favorite);
        yield* publishWorkspaceTablesChanged(table.workspaceId, {
          type: "table.favorite",
          tableId,
          favorite,
        });
        return { favorite };
      });

    /**
     * Move a column to a new display index within its table (0-based, clamped to
     * the column count). Members-only. Metered ONE. Reindexes the affected
     * columns to a contiguous 0..N-1 order — writing ONLY the columns whose
     * position actually changes — then broadcasts a `column.reorder` carrying the
     * FULL new id order so every viewer's grid splices identically. Returns the
     * new column-id order.
     */
    /**
     * Reindex columns to a contiguous 0..N-1 order, writing ONLY the columns whose
     * slot actually changed vs `currentOrdered`, then broadcast a `column.reorder`
     * carrying the FULL new id order so every viewer splices identically. Shared by
     * `reorderColumn` (manual drag) and `updateColumn` (dependency repair). Does NOT
     * meter — the caller meters its single action.
     */
    const applyColumnOrder = (
      workspaceId: string,
      tableId: string,
      currentOrdered: readonly Column[],
      desiredIds: readonly string[],
    ) =>
      Effect.gen(function* () {
        for (let i = 0; i < desiredIds.length; i++) {
          if (currentOrdered[i]?.id !== desiredIds[i]) {
            yield* columns.setPosition(desiredIds[i]!, i);
          }
        }
        yield* publish(workspaceId, tableId, {
          type: "column.reorder",
          columnIds: [...desiredIds],
        });
      });

    const reorderColumn = (columnId: string, toIndex: number) =>
      Effect.gen(function* () {
        const col = yield* requireColumn(columnId);
        yield* requireCloudMember(col.workspaceId);
        const ordered = yield* columns.listByTable(col.tableId);
        const from = ordered.findIndex((c) => c.id === columnId);
        const dest = Math.max(0, Math.min(toIndex, ordered.length - 1));
        const next = ordered.map((c) => c.id);
        if (from !== -1 && from !== dest) {
          const [moved] = next.splice(from, 1);
          next.splice(dest, 0, moved!);
        }
        yield* meter.meterActions(col.workspaceId, 1);
        yield* applyColumnOrder(col.workspaceId, col.tableId, ordered, next);
        return { columnIds: next };
      });

    /**
     * Move a row to a new display index within its table (0-based, clamped).
     * Members-only. Metered ONE. Reindexes to a contiguous order, writing ONLY
     * the rows whose position changes (so moving one row touches just the rows
     * between its old and new slot, not the whole table), then broadcasts a
     * `row.reorder` with the full new id order. Returns the new row-id order.
     */
    const reorderRow = (rowId: string, toIndex: number) =>
      Effect.gen(function* () {
        const row = yield* requireRow(rowId);
        yield* requireCloudMember(row.workspaceId);
        const ordered = yield* rows.listByTable(row.tableId);
        const from = ordered.findIndex((r) => r.id === rowId);
        const dest = Math.max(0, Math.min(toIndex, ordered.length - 1));
        const next = ordered.map((r) => r.id);
        if (from !== -1 && from !== dest) {
          const [moved] = next.splice(from, 1);
          next.splice(dest, 0, moved!);
        }
        for (let i = 0; i < next.length; i++) {
          if (ordered[i]?.id !== next[i]) {
            yield* rows.setPosition(next[i]!, i);
          }
        }
        yield* meter.meterActions(row.workspaceId, 1);
        yield* publish(row.workspaceId, row.tableId, {
          type: "row.reorder",
          rowIds: next,
        });
        return { rowIds: next };
      });

    /**
     * Patch a column's definition (rename / type / function provider-method-
     * code-params-condition). Members-only. Metered ONE. Broadcasts a
     * `column.update` with the full updated projection so every viewer's grid
     * reflects the change live. Returns the updated column.
     *
     * DAG upkeep: a patch to `params`/`condition` can change which columns this one
     * references via `{{Name}}`. We (1) REJECT a change that would create a circular
     * dependency BEFORE persisting it (`ColumnCycleError`), and (2) after the write,
     * reposition the column — and any dependents now out of order — so every column
     * still sits to the right of everything it reads (minimal-movement repair).
     */
    const updateColumn = (columnId: string, patch: ColumnPatch) =>
      Effect.gen(function* () {
        const existing = yield* requireColumn(columnId);
        yield* requireCloudMember(existing.workspaceId);

        // Only params/condition carry `{{Name}}` refs, so only those can change the
        // dependency graph; renames/type changes skip the extra reads entirely.
        const touchesRefs =
          patch.params !== undefined || patch.condition !== undefined;

        if (touchesRefs) {
          // Cycle guard: build the graph with the patch applied IN-MEMORY and reject
          // before writing if the edited column would transitively depend on itself.
          const current = yield* columns.listByTable(existing.tableId);
          const projected = current.map((c) => {
            const m = toMinimalColumn(c);
            if (c.id !== columnId) return m;
            return {
              ...m,
              params:
                patch.params !== undefined
                  ? ((patch.params ?? {}) as Record<string, unknown>)
                  : m.params,
              condition:
                patch.condition !== undefined ? patch.condition : m.condition,
            };
          });
          if (columnInCycle(columnId, buildColumnDeps(projected))) {
            return yield* Effect.fail(
              new ColumnCycleError({
                message:
                  "This change creates a circular dependency between columns. " +
                  "Remove the conflicting {{column}} reference and try again.",
              }),
            );
          }
        }

        const updated = yield* columns.update(columnId, patch);
        const col = updated._tag === "Some" ? updated.value : existing;
        yield* meter.meterActions(existing.workspaceId, 1);
        yield* publish(existing.workspaceId, existing.tableId, {
          type: "column.update",
          column: {
            _id: col.id,
            name: col.name,
            type: col.type,
            kind: col.kind,
            provider: col.provider,
            method: col.method,
            accountId: col.accountId ?? null,
            code: col.code,
            params: col.params,
            condition: col.condition,
          },
        });

        if (touchesRefs) {
          // Reposition: stable topo order moves only the columns whose dependency
          // order is now violated; unrelated columns keep their slots.
          const ordered = yield* columns.listByTable(existing.tableId);
          const desired = stableTopoOrder(
            ordered.map((c) => c.id),
            buildColumnDeps(ordered.map(toMinimalColumn)),
          );
          const changed = desired.some((id, i) => ordered[i]?.id !== id);
          if (changed) {
            yield* applyColumnOrder(
              existing.workspaceId,
              existing.tableId,
              ordered,
              desired,
            );
          }
        }
        return col;
      });

    /** Delete a column (FK cascade drops its cells). Members-only. Metered ONE. */
    const deleteColumn = (columnId: string) =>
      Effect.gen(function* () {
        const column = yield* requireColumn(columnId);
        yield* requireCloudMember(column.workspaceId);
        yield* columns.remove(columnId);
        yield* meter.meterActions(column.workspaceId, 1);
        yield* publish(column.workspaceId, column.tableId, {
          type: "column.delete",
          columnId,
        });
      });

    /** Delete a row (FK cascade drops its cells). Members-only. Metered ONE. */
    const deleteRow = (rowId: string) =>
      Effect.gen(function* () {
        const row = yield* requireRow(rowId);
        yield* requireCloudMember(row.workspaceId);
        yield* rows.remove(rowId);
        yield* meter.meterActions(row.workspaceId, 1);
        yield* publish(row.workspaceId, row.tableId, {
          type: "row.delete",
          rowId,
        });
      });

    /**
     * One-shot dedup sweep (mirrors the local engine, packages/engine/src/db.ts):
     * group rows by the dedupe column's value IN TABLE ORDER, keep the first
     * (oldest) or last (newest) per group, delete the rest. Each delete is
     * metered + broadcast as a `row.delete` so every other client live-updates.
     * Members-only. No-op when dedupe is off.
     */
    const dedupeTable = (tableId: string) =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        const cfg = toDedupe(table);
        if (cfg === null) return { deleted: 0 };
        const rws = yield* rows.listByTable(tableId); // position, createdAt order
        // Read ONLY the dedupe column's cells (the only value this sweep
        // inspects), served by the `cells_by_table_column` index — ~one cell per
        // row instead of the full rows×columns matrix.
        const cls = yield* cells.listByTableColumn(tableId, cfg.column);
        const valueByRow = new Map<string, unknown>();
        for (const c of cls) {
          valueByRow.set(c.rowId, c.value);
        }
        const groups = new Map<string, string[]>();
        for (const r of rws) {
          const key = dedupeKeyOf(valueByRow.get(r.id));
          if (key === null) continue;
          const g = groups.get(key);
          if (g === undefined) groups.set(key, [r.id]);
          else g.push(r.id);
        }
        const victims: string[] = [];
        for (const ids of groups.values()) {
          if (ids.length <= 1) continue;
          const keepIdx = cfg.keep === "newest" ? ids.length - 1 : 0;
          ids.forEach((id, i) => {
            if (i !== keepIdx) victims.push(id);
          });
        }
        for (const id of victims) {
          yield* rows.remove(id);
          yield* publish(table.workspaceId, tableId, {
            type: "row.delete",
            rowId: id,
          });
        }
        if (victims.length > 0) {
          yield* meter.meterActions(table.workspaceId, victims.length);
        }
        return { deleted: victims.length };
      });

    /**
     * Set (or clear) a table's row-dedup config, then immediately sweep so the
     * existing rows reflect the new rule. `column: null` disables dedupe (no
     * sweep). Members-only.
     */
    const setDedupe = (args: {
      readonly tableId: string;
      readonly column: string | null;
      readonly keep: "oldest" | "newest";
    }) =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);
        yield* tables.setDedupe(args.tableId, {
          column: args.column,
          keep: args.keep,
        });
        const swept =
          args.column === null
            ? { deleted: 0 }
            : yield* dedupeTable(args.tableId);
        const dedupe: GridDedupe | null =
          args.column === null
            ? null
            : { column: args.column, keep: args.keep };
        return { dedupe, deleted: swept.deleted };
      });

    // ── cells ─────────────────────────────────────────────────────────────

    /**
     * Resolve + authorize a (row, column) pair, returning the row + the existing
     * cell (or null). Asserts both belong to the same table so a cell can't be
     * written across tables. Members-only.
     */
    const resolveCell = (rowId: string, columnId: string) =>
      Effect.gen(function* () {
        const row = yield* rows.findById(rowId);
        const column = yield* columns.findById(columnId);
        if (row._tag === "None" || column._tag === "None") {
          return yield* Effect.fail(
            new GridNotFoundError({ message: "Row or column not found." }),
          );
        }
        if (row.value.tableId !== column.value.tableId) {
          return yield* Effect.fail(
            new InvalidCellError({
              message: "Row and column belong to different tables.",
            }),
          );
        }
        yield* requireCloudMember(row.value.workspaceId);
        // Server-side backstop for CRM-synced columns: they are owned by the
        // sync worker (WebhookRepo write path) — a member edit through any
        // client would be silently overwritten on the next sync, or permanently
        // corrupt pull-only data in skip/create modes. The desktop hides these
        // edit affordances; this makes the guarantee hold for every client.
        const cfg: unknown = column.value.config;
        if (typeof cfg === "object" && cfg !== null && "synced" in cfg && cfg.synced === true) {
          return yield* Effect.fail(
            new InvalidCellError({
              message: "This column is synced from your CRM and can't be edited.",
            }),
          );
        }
        const existing = yield* cells.findByRowColumn(rowId, columnId);
        return {
          row: row.value,
          existing: existing._tag === "None" ? null : existing.value,
        };
      });

    /** Persist a merged cell (insert when none, else patch). Returns its id. */
    const persistCell = (
      row: Row,
      columnId: string,
      existing: Cell | null,
      merged: {
        value: unknown;
        status: CloudCellStatus;
        error: string | null;
        updatedAt: number | null;
      },
    ) =>
      existing === null
        ? cells.insert({
            workspaceId: row.workspaceId,
            tableId: row.tableId,
            rowId: row.id,
            columnId,
            value: merged.value,
            status: merged.status,
            error: merged.error,
            updatedAt: merged.updatedAt,
          })
        : cells
            .patch(existing.id, {
              value: merged.value,
              status: merged.status,
              error: merged.error,
              updatedAt: merged.updatedAt,
            })
            .pipe(Effect.as(existing.id));

    /** Upsert a cell with COALESCE merge. Members-only. Metered ONE action. */
    const setCell = (args: {
      readonly rowId: string;
      readonly columnId: string;
      readonly value?: unknown;
      readonly hasValue: boolean;
      readonly status?: CloudCellStatus;
      readonly error?: string | null;
    }) =>
      Effect.gen(function* () {
        const { row, existing } = yield* resolveCell(args.rowId, args.columnId);
        const merged = yield* cellMerge.mergeCellPatch(
          existing === null
            ? null
            : {
                value: existing.value,
                status: existing.status as CloudCellStatus,
                error: existing.error,
                updatedAt: existing.updatedAt,
              },
          {
            ...(args.hasValue ? { value: args.value } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.error !== undefined ? { error: args.error } : {}),
          },
          Date.now(),
        );
        const id = yield* persistCell(row, args.columnId, existing, merged);
        yield* meter.meterActions(row.workspaceId, 1);
        yield* publish(row.workspaceId, row.tableId, {
          type: "cell.upsert",
          cell: {
            rowId: row.id,
            columnId: args.columnId,
            value: merged.value,
            status: merged.status,
            error: merged.error,
          },
        });
        return id;
      });

    /** Set only a cell's status (COALESCE-preserve value). Metered ONE action. */
    const setCellStatus = (args: {
      readonly rowId: string;
      readonly columnId: string;
      readonly status: CloudCellStatus;
      readonly error?: string | null;
    }) =>
      Effect.gen(function* () {
        const { row, existing } = yield* resolveCell(args.rowId, args.columnId);
        const merged = yield* cellMerge.mergeCellPatch(
          existing === null
            ? null
            : {
                value: existing.value,
                status: existing.status as CloudCellStatus,
                error: existing.error,
                updatedAt: existing.updatedAt,
              },
          {
            status: args.status,
            ...(args.error !== undefined ? { error: args.error } : {}),
          },
          Date.now(),
        );
        const id = yield* persistCell(row, args.columnId, existing, merged);
        yield* meter.meterActions(row.workspaceId, 1);
        yield* publish(row.workspaceId, row.tableId, {
          type: "cell.upsert",
          cell: {
            rowId: row.id,
            columnId: args.columnId,
            value: merged.value,
            status: merged.status,
            error: merged.error,
          },
        });
        return id;
      });

    return {
      listProjects,
      createProject,
      listTables,
      listTablesWithCounts,
      getTable,
      getTablePage,
      createTable,
      addColumn,
      addRow,
      addRowsWithCells,
      deleteTable,
      renameTable,
      setTableFavorite,
      reorderColumn,
      reorderRow,
      listFolders,
      createFolder,
      renameFolder,
      deleteFolder,
      moveFolder,
      moveTable,
      updateColumn,
      deleteColumn,
      deleteRow,
      setDedupe,
      dedupeTable,
      setCell,
      setCellStatus,
    } as const;
  }),
  dependencies: [],
}) {}
