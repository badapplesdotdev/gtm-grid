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
  type Table,
  TableRepo,
  type TableRepoError,
} from "../repositories/table-repo.js";
import type { WorkspaceRepoError } from "../repositories/workspace-repo.js";
import type { GridChangeEvent } from "../realtime/events.js";
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
  readonly code: string | null;
  readonly params: unknown;
  readonly condition: string | null;
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
  readonly table: { readonly _id: string; readonly name: string };
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
  readonly table: { readonly _id: string; readonly name: string };
  readonly columns: readonly GridColumn[];
  readonly rows: readonly { readonly _id: string }[];
  readonly cells: readonly GridCell[];
  readonly nextCursor: RowCursor | null;
}

/** A `{ columnId: value }` map of one bulk-imported row's cells. */
export type CellMap = Readonly<Record<string, unknown>>;

/** Project a repo `Column` onto the desktop `getTable` column shape. */
const toGridColumn = (c: Column): GridColumn => ({
  _id: c.id,
  name: c.name,
  type: c.type,
  kind: c.kind,
  provider: c.provider,
  method: c.method,
  code: c.code,
  params: c.params,
  condition: c.condition,
});

/** Project a repo `Cell` onto the desktop `getTable` cell shape. */
const toGridCell = (c: Cell): GridCell => ({
  rowId: c.rowId,
  columnId: c.columnId,
  value: c.value,
  status: c.status,
  error: c.error,
});

/**
 * Grid domain service. Defined with the `Effect.Service` pattern; the composed
 * `appLayer` wires the live repos/services, tests provide in-memory Layers and
 * get the SAME service with different behaviour.
 */
export class GridService extends Effect.Service<GridService>()("GridService", {
  effect: Effect.gen(function* () {
    const projects = yield* ProjectRepo;
    const tables = yield* TableRepo;
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
    ) => realtime.publish({ workspaceId, tableId, event });

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
    }) =>
      Effect.gen(function* () {
        yield* requireCloudMember(args.workspaceId);
        return yield* projects.insert({
          workspaceId: args.workspaceId,
          name: args.name,
          createdAt: Date.now(),
        });
      });

    // ── tables ────────────────────────────────────────────────────────────

    /** A project's tables (position order). Members-only. */
    const listTables = (projectId: string) =>
      Effect.gen(function* () {
        const project = yield* requireProject(projectId);
        yield* membership.requireMember(project.workspaceId);
        return yield* tables.listByProject(projectId);
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
        return {
          table: { _id: table.id, name: table.name },
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
          table: { _id: table.id, name: table.name },
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
    }) =>
      Effect.gen(function* () {
        const project = yield* requireProject(args.projectId);
        yield* requireCloudMember(project.workspaceId);
        const position = yield* tables.nextPosition(args.projectId);
        const id = yield* tables.insert({
          workspaceId: project.workspaceId,
          projectId: args.projectId,
          name: args.name,
          position,
          createdAt: Date.now(),
        });
        yield* meter.meterActions(project.workspaceId, 1);
        yield* publish(project.workspaceId, id, {
          type: "table.insert",
          tableId: id,
          projectId: args.projectId,
          name: args.name,
        });
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
      readonly code?: string | null;
      readonly params?: unknown;
      readonly condition?: string | null;
    }) =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);
        const position = yield* columns.nextPosition(args.tableId);
        const id = yield* columns.insert({
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
            code: args.code ?? null,
            params: args.params ?? {},
            condition: args.condition ?? null,
          },
        });
        return id;
      });

    /** Add a row to a table. Members-only. Metered ONE action. */
    const addRow = (tableId: string) =>
      Effect.gen(function* () {
        const table = yield* requireTable(tableId);
        yield* requireCloudMember(table.workspaceId);
        const position = yield* rows.nextPosition(tableId);
        const id = yield* rows.insert({
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
    }) =>
      Effect.gen(function* () {
        const table = yield* requireTable(args.tableId);
        yield* requireCloudMember(table.workspaceId);

        // Atomic quota pre-check (free tier has a hard cap; unlimited passes).
        const quota = yield* meter.readQuota(table.workspaceId);
        if (quota._tag === "Some") {
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
        yield* publish(table.workspaceId, tableId, {
          type: "table.delete",
          tableId,
        });
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
      deleteColumn,
      deleteRow,
      setCell,
      setCellStatus,
    } as const;
  }),
  dependencies: [],
}) {}
