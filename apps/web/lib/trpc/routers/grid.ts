/**
 * The `grid` tRPC router — the grid-data surface (projects, tables, columns,
 * rows, cells) the cloud desktop grid drives.
 *
 * Ports the public queries/mutations of `convex/projects.ts`, `convex/tables.ts`,
 * and `convex/cells.ts`, collapsing each Convex action/mutation split into a
 * single procedure that runs a `GridService` Effect via {@link runEffect}. The
 * service resolves the owning workspace from the parent doc and asserts
 * membership inside the Effect (the typed authz failures map to UNAUTHORIZED /
 * FORBIDDEN), so reads and writes are member-gated end-to-end. The billable
 * mutations meter cloud actions on the WRITE path through the dedicated
 * MeterService inside the service.
 *
 * `getTable` returns the full grid (table + columns + rows + cells) in ONE read,
 * shaped exactly as desktop useCloudGrid.ts:165 consumes it.
 */

import { GridService, PipelineService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { inngest } from "../../inngest/client";
import { protectedProcedure, router, runEffect } from "../trpc";

/** The cell-status lifecycle literals (mirrors the `cellStatus` enum). */
const cellStatus = z.enum(["empty", "pending", "running", "done", "error"]);

/** A column value type (mirrors the `columnType` enum). */
const columnType = z.enum(["text", "number", "boolean", "date", "json"]);

/** A column kind — manual cell or function column (mirrors `columnKind`). */
const columnKind = z.enum(["manual", "function"]);

/**
 * A keyset page cursor for {@link gridRouter.getTablePage} — the
 * `(position, createdAt, id)` of the last row of the prior page. Mirrors the
 * service's `RowCursor`. `null`/omitted requests the first page.
 */
const rowCursor = z.object({
  position: z.number(),
  createdAt: z.number(),
  id: z.string(),
});

/**
 * Max rows accepted in one {@link gridRouter.addRowsWithCells} call. Bounds the
 * payload so a wide CSV (rows × columns cells) stays well under Postgres' 65535
 * bind-parameter cap even before cell-repo chunks each statement. The desktop
 * imports in chunks far smaller than this, so the cap only fires on abuse.
 */
const MAX_ROWS_PER_IMPORT = 5000;

async function dispatchPipelineRuns(runs: readonly { readonly id: string; readonly workspaceId: string }[]) {
  if (runs.length === 0) return;
  await inngest.send(runs.map((run) => ({
    id: `pipeline-run:${run.id}`,
    name: "pipeline/run.requested" as const,
    data: { runId: run.id, workspaceId: run.workspaceId },
  })));
}

export const gridRouter = router({
  // ── projects ────────────────────────────────────────────────────────────

  /** A workspace's projects (creation order). Members-only. */
  listProjects: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.listProjects(input.workspaceId);
        }),
      ),
    ),

  /** Create a project in a workspace. Members-only. */
  createProject: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        name: z.string(),
        // Optional client-supplied id so an optimistic create uses the same id
        // the server persists (the realtime self-echo then converges).
        id: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.createProject({
            workspaceId: input.workspaceId,
            name: input.name,
            ...(input.id !== undefined ? { id: input.id } : {}),
          });
        }),
      ),
    ),

  // ── tables ──────────────────────────────────────────────────────────────

  /** A project's tables (position order). Members-only. */
  listTables: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.listTables(input.projectId);
        }),
      ),
    ),

  /** The full grid for a table (table+columns+rows+cells). Members-only. */
  getTable: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.getTable(input.tableId);
        }),
      ),
    ),

  /**
   * One PAGE of a table's grid by ROW POSITION (keyset). Returns table +
   * columns + only this page's rows/cells + a `nextCursor` (`null` on the last
   * page). The cloud grid loads pages lazily so no single response carries the
   * whole grid. Members-only. (TRI-3272.)
   */
  getTablePage: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        cursor: rowCursor.nullish(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.getTablePage({
            tableId: input.tableId,
            cursor: input.cursor ?? null,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
        }),
      ),
    ),

  /** Create a table in a project (optionally inside a folder). Members-only. Metered. */
  createTable: protectedProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        name: z.string(),
        folderId: z.string().min(1).nullish(),
        id: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.createTable({
            projectId: input.projectId,
            name: input.name,
            folderId: input.folderId ?? null,
            ...(input.id !== undefined ? { id: input.id } : {}),
          });
        }),
      ),
    ),

  // ── folders (sidebar table groups) ────────────────────────────────────────

  /** A project's sidebar folders (position order). Members-only. */
  listFolders: protectedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.listFolders(input.projectId);
        }),
      ),
    ),

  /**
   * Create a sidebar folder in a project, optionally nested under `parentId`
   * (null/omitted = top level). Members-only. Not metered.
   */
  createFolder: protectedProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        name: z.string(),
        id: z.string().min(1).optional(),
        parentId: z.string().min(1).nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.createFolder({
            projectId: input.projectId,
            name: input.name,
            ...(input.id !== undefined ? { id: input.id } : {}),
            parentId: input.parentId ?? null,
          });
        }),
      ),
    ),

  /** Rename a sidebar folder. Members-only. Not metered. */
  renameFolder: protectedProcedure
    .input(z.object({ folderId: z.string().min(1), name: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.renameFolder({
            folderId: input.folderId,
            name: input.name,
          });
          return { ok: true as const };
        }),
      ),
    ),

  /** Delete a sidebar folder (its tables unfile to the root). Members-only. */
  deleteFolder: protectedProcedure
    .input(z.object({ folderId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.deleteFolder(input.folderId);
          return { ok: true as const };
        }),
      ),
    ),

  /**
   * Reparent a sidebar folder (`parentId: null` → top level), optionally with a
   * new fractional sort position. Rejects moves that would create a cycle (a
   * folder into its own sub-folder). Members-only. Not metered.
   */
  moveFolder: protectedProcedure
    .input(
      z.object({
        folderId: z.string().min(1),
        parentId: z.string().min(1).nullable(),
        position: z.number().finite().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.moveFolder({
            folderId: input.folderId,
            parentId: input.parentId,
            ...(input.position !== undefined ? { position: input.position } : {}),
          });
          return { ok: true as const };
        }),
      ),
    ),

  /**
   * Move a table into a folder (`folderId: null` → root), optionally with a new
   * fractional sort position (drag-reorder). Members-only. Not metered.
   */
  moveTable: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        folderId: z.string().min(1).nullable(),
        position: z.number().finite().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.moveTable({
            tableId: input.tableId,
            folderId: input.folderId,
            ...(input.position !== undefined ? { position: input.position } : {}),
          });
          return { ok: true as const };
        }),
      ),
    ),

  /** Add a column to a table. Members-only. Metered. */
  addColumn: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        name: z.string(),
        type: columnType,
        kind: columnKind,
        provider: z.string().nullish(),
        method: z.string().nullish(),
        code: z.string().nullish(),
        params: z.unknown().optional(),
        // The "only run if" rule — carried so a function column's run condition
        // round-trips (GridService/repo already persist it).
        condition: z.string().nullish(),
        id: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.addColumn({
            tableId: input.tableId,
            name: input.name,
            type: input.type,
            kind: input.kind,
            provider: input.provider ?? null,
            method: input.method ?? null,
            code: input.code ?? null,
            params: input.params,
            condition: input.condition ?? null,
            ...(input.id !== undefined ? { id: input.id } : {}),
          });
        }),
      ),
    ),

  /** Add a row to a table. Members-only. Metered. */
  addRow: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        id: z.string().min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.addRow(input.tableId, input.id);
        }),
      ),
    ),

  /** Bulk insert rows + cells (CSV import). Members-only. Atomic quota + meter. */
  addRowsWithCells: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        rows: z
          .array(z.record(z.string(), z.unknown()))
          .max(MAX_ROWS_PER_IMPORT, {
            message: `Too many rows in one import (max ${MAX_ROWS_PER_IMPORT}). Split the request into smaller chunks.`,
          }),
        // Optional client-supplied row ids aligned by index with `rows` so an
        // optimistic bulk import uses the same ids the server persists.
        rowIds: z.array(z.string().min(1)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          const added = yield* svc.addRowsWithCells({
            tableId: input.tableId,
            rows: input.rows,
            ...(input.rowIds !== undefined ? { rowIds: input.rowIds } : {}),
          });
          const pipelines = yield* PipelineService;
          const runs = yield* pipelines.createTriggeredRuns({ tableId: input.tableId, rowIds: added.rowIds, trigger: "row_created" });
          return { added, runs };
        }),
      );
      await dispatchPipelineRuns(result.runs);
      return result.added;
    }),

  /** Delete a table (FK cascade drops children). Members-only. Metered. */
  deleteTable: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.deleteTable(input.tableId);
          return { ok: true as const };
        }),
      ),
    ),

  /**
   * Rename a table. Members-only. Metered ONE. Broadcasts `table.rename` so open
   * grids relabel their header and sidebars relabel live. A blank name is
   * ignored (keeps the current name). Returns the effective name.
   */
  renameTable: protectedProcedure
    .input(z.object({ tableId: z.string().min(1), name: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.renameTable(input.tableId, input.name);
        }),
      ),
    ),

  /**
   * Pin/unpin a table (the cloud mirror of the local engine's favourite tables).
   * WORKSPACE-SHARED: the flag lives on the table row, so any member's pin is
   * visible to every teammate. Members-only. Idempotent and NOT metered — a pin
   * isn't a billable action. Returns the effective `favorite` state.
   */
  setTableFavorite: protectedProcedure
    .input(z.object({ tableId: z.string().min(1), favorite: z.boolean() }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.setTableFavorite(input.tableId, input.favorite);
        }),
      ),
    ),

  /**
   * Patch a column's definition (rename / type / function config). Members-only.
   * Metered. Only the provided fields change; broadcasts `column.update` so every
   * viewer's grid reflects the edit live. Returns the updated column.
   */
  updateColumn: protectedProcedure
    .input(
      z.object({
        columnId: z.string().min(1),
        name: z.string().optional(),
        type: columnType.optional(),
        kind: columnKind.optional(),
        provider: z.string().nullish(),
        method: z.string().nullish(),
        code: z.string().nullish(),
        params: z.unknown().optional(),
        condition: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          const { columnId, ...patch } = input;
          return yield* svc.updateColumn(columnId, patch);
        }),
      ),
    ),

  /** Delete a column (FK cascade drops its cells). Members-only. Metered. */
  deleteColumn: protectedProcedure
    .input(z.object({ columnId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.deleteColumn(input.columnId);
          return { ok: true as const };
        }),
      ),
    ),

  /** Delete a row (FK cascade drops its cells). Members-only. Metered. */
  deleteRow: protectedProcedure
    .input(z.object({ rowId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          yield* svc.deleteRow(input.rowId);
          return { ok: true as const };
        }),
      ),
    ),

  /**
   * Set (or clear) a table's row-dedup config and sweep duplicates immediately.
   * `column: null` disables dedupe. Members-only; the sweep is metered + live.
   */
  setDedupe: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        column: z.string().min(1).nullable(),
        keep: z.enum(["oldest", "newest"]).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.setDedupe({
            tableId: input.tableId,
            column: input.column,
            keep: input.keep ?? "oldest",
          });
        }),
      ),
    ),

  /** Run a one-shot dedup sweep using the table's saved config. Members-only. */
  dedupe: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.dedupeTable(input.tableId);
        }),
      ),
    ),

  // ── cells ─────────────────────────────────────────────────────────────────

  /**
   * Upsert a cell with COALESCE merge. Members-only. Metered. `value` is only
   * forwarded when the caller sent the key, so an omitted value keeps the
   * existing one (COALESCE) while an explicit `null`/`undefined` overwrites it.
   */
  setCell: protectedProcedure
    .input(
      z.object({
        rowId: z.string().min(1),
        columnId: z.string().min(1),
        value: z.unknown().optional(),
        status: cellStatus.optional(),
        error: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          const cellId = yield* svc.setCell({
            rowId: input.rowId,
            columnId: input.columnId,
            hasValue: "value" in input,
            ...("value" in input ? { value: input.value } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          });
          if (!("value" in input)) return { cellId, runs: [] as const };
          const pipelines = yield* PipelineService;
          const runs = yield* pipelines.createTriggeredRuns({ columnId: input.columnId, rowIds: [input.rowId], trigger: "row_updated" });
          return { cellId, runs };
        }),
      );
      await dispatchPipelineRuns(result.runs);
      return result.cellId;
    }),

  /** Set only a cell's status (COALESCE-preserve value). Members-only. Metered. */
  setCellStatus: protectedProcedure
    .input(
      z.object({
        rowId: z.string().min(1),
        columnId: z.string().min(1),
        status: cellStatus,
        error: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.setCellStatus({
            rowId: input.rowId,
            columnId: input.columnId,
            status: input.status,
            ...(input.error !== undefined ? { error: input.error } : {}),
          });
        }),
      ),
    ),
});
