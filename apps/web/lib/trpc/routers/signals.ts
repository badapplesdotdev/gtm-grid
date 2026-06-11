/**
 * The `signals` tRPC router — member-gated Social Signals CRUD (the desktop
 * "From Social Signals" cloud flow). Each procedure runs a `SignalService`
 * Effect via {@link runEffect}; the service resolves the owning workspace from
 * the table doc and asserts membership + cloud entitlement inside the Effect.
 *
 * The recurring poll is NOT here — it runs behind the worker-secret bearer in
 * the Inngest cron worker (apps/web/lib/inngest/functions/poll-trigify-signals).
 */

import { SignalService, SIGNAL_SOURCES } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { inngest } from "../../inngest/client";
import { protectedProcedure, router, runEffect } from "../trpc";

/** A field-path → column id mapping entry. */
const columnEntry = z.object({
  key: z.string().min(1),
  columnId: z.string().min(1),
});

const schedule = z.enum(["manual", "hourly", "daily", "weekly"]);

export const signalsRouter = router({
  /** The static catalog of Trigify signal sources (id, label, group, columns, schema). */
  sources: protectedProcedure.query(() =>
    SIGNAL_SOURCES.map((s) => ({
      id: s.id,
      label: s.label,
      group: s.group,
      kind: s.kind,
      columns: s.columns,
      inputSchema: s.inputSchema,
    })),
  ),

  /** Signal bindings on a table (newest first). Members-only. */
  listSignalBindings: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SignalService;
          return yield* svc.listByTable(input.tableId);
        }),
      ),
    ),

  /**
   * Create a binding: creates the Trigify search, inserts the binding, and does
   * a best-effort initial pull. Members-only + requires cloud entitlement.
   */
  createSignalBinding: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        sourceId: z.string().min(1),
        name: z.string().min(1),
        config: z.record(z.string(), z.any()).optional(),
        schedule: schedule.default("daily"),
        columns: z.array(columnEntry),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SignalService;
          return yield* svc.create({
            tableId: input.tableId,
            sourceId: input.sourceId,
            name: input.name,
            config: input.config ?? {},
            schedule: input.schedule,
            columns: input.columns,
          });
        }),
      );
      // Kick off the durable post-create warm-up: a fresh Trigify search takes
      // ~10-30s to start returning, so the create-time pull above is almost
      // always 0 — the warm-up function retries until first data lands.
      // BEST-EFFORT: an enqueue failure must not fail the create (the binding
      // exists and works); the cron's always-due-while-empty predicate is the
      // fallback that still fills the table within the hour.
      try {
        await inngest.send({
          name: "signals/binding.created",
          data: { bindingId: created.bindingId, workspaceId: created.workspaceId },
        });
      } catch (err) {
        console.error(
          `[signals] warm-up enqueue failed for binding ${created.bindingId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      return created;
    }),

  /** Manual "pull now" for a binding. Members-only. */
  syncSignalBinding: protectedProcedure
    .input(z.object({ bindingId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SignalService;
          return yield* svc.sync(input.bindingId);
        }),
      ),
    ),

  /** Delete a binding. Members-only. */
  deleteSignalBinding: protectedProcedure
    .input(z.object({ bindingId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* SignalService;
          return yield* svc.remove(input.bindingId);
        }),
      ),
    ),
});
