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

import { GridService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
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
    .input(z.object({ workspaceId: z.string().min(1), name: z.string() }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.createProject({
            workspaceId: input.workspaceId,
            name: input.name,
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

  /** Create a table in a project. Members-only. Metered. */
  createTable: protectedProcedure
    .input(z.object({ projectId: z.string().min(1), name: z.string() }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.createTable({
            projectId: input.projectId,
            name: input.name,
          });
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
        // The "only run if" rule — carried so a local→cloud push preserves a
        // function column's run condition (GridService/repo already persist it).
        condition: z.string().nullish(),
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
          });
        }),
      ),
    ),

  /** Add a row to a table. Members-only. Metered. */
  addRow: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.addRow(input.tableId);
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
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.addRowsWithCells({
            tableId: input.tableId,
            rows: input.rows,
          });
        }),
      ),
    ),

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
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* GridService;
          return yield* svc.setCell({
            rowId: input.rowId,
            columnId: input.columnId,
            hasValue: "value" in input,
            ...("value" in input ? { value: input.value } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          });
        }),
      ),
    ),

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
