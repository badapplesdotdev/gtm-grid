/**
 * `sheets` tRPC router — bind a Google Sheet to a table, and manage the sync.
 *
 * SEPARATE from the `google` router on purpose. `google` owns the ACCOUNT
 * (connect, disconnect, which files are authorised) and is shared by every
 * Google connector. This owns IMPORT BINDINGS, which are a property of a
 * table. Folding them together would mean "disconnect Google" and "stop syncing
 * this table" living on the same object, and a future Docs import would have
 * nowhere sensible to go.
 *
 * Mirrors the `signals` and `crm` binding routers: every procedure is
 * membership-gated, and execution happens in Inngest rather than in the request.
 */

import { SheetImportService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { protectedProcedure, router, runEffect } from "../trpc";

const scheduleSchema = z.enum(["manual", "hourly", "daily", "weekly"]);

const columnMapping = z.object({
  header: z.string().min(1),
  columnId: z.string().min(1),
});

export const sheetsRouter = router({
  /**
   * The tabs in a spreadsheet, for the import picker. Read-only.
   */
  listTabs: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), spreadsheetId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          return yield* svc.listTabs(input);
        }),
      ),
    ),

  /**
   * Headers + a few sample rows, so the user maps columns against real data
   * rather than from memory. Bounded server-side; never pulls the whole sheet.
   */
  preview: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        spreadsheetId: z.string().min(1),
        sheetTitle: z.string().min(1),
        headerRow: z.number().int().min(1).max(50).default(1),
      }),
    )
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          return yield* svc.preview(input);
        }),
      ),
    ),

  /** Every sheet binding on a table (usually zero or one). */
  listForTable: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), tableId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          const bindings = yield* svc.listForTable(input);
          return { bindings };
        }),
      ),
    ),

  /**
   * Bind a spreadsheet tab to a table.
   *
   * `keyHeader` is nullable but the UI should fight for a value: without one,
   * rows are identified by their SHEET ROW NUMBER, which silently rewrites the
   * wrong grid rows the first time a human sorts or deletes a row upstream.
   *
   * Creating does NOT sync. The caller enqueues the first sync separately, so a
   * large sheet cannot turn a mutation into a request timeout.
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        tableId: z.string().min(1),
        spreadsheetId: z.string().min(1),
        spreadsheetName: z.string().default(""),
        sheetTitle: z.string().min(1),
        // 1-based, and not always 1: real sheets carry title banners above the
        // header. Capped so a typo cannot make the read range nonsense.
        headerRow: z.number().int().min(1).max(50).default(1),
        columns: z.array(columnMapping).min(1),
        keyHeader: z.string().nullable().default(null),
        schedule: scheduleSchema.default("daily"),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          const id = yield* svc.create(input);
          return { id };
        }),
      ),
    ),

  /** Change the schedule, pause/resume, or switch the key column. */
  update: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        bindingId: z.string().min(1),
        schedule: scheduleSchema.optional(),
        enabled: z.boolean().optional(),
        keyHeader: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          yield* svc.update(input);
          return { ok: true as const };
        }),
      ),
    ),

  /**
   * Remove the binding. The grid rows it created STAY — they may carry
   * enrichment the user paid for, and deleting them to mirror an unbind would
   * destroy work that has nothing to do with the spreadsheet.
   */
  remove: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), bindingId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          yield* svc.remove(input);
          return { ok: true as const };
        }),
      ),
    ),

  /**
   * Sync now, inline.
   *
   * Bounded by `MAX_ROWS_PER_SYNC`, so the worst case is a slow request rather
   * than an unbounded one — acceptable for an explicit user action, where
   * handing back "queued" and making them poll would be worse. The cron path
   * runs the same method inside Inngest.
   */
  syncNow: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), bindingId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SheetImportService;
          return yield* svc.syncNow(input);
        }),
      ),
    ),
});
