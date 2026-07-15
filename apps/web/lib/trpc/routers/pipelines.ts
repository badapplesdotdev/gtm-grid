/** Pipeline authoring, deployment, table binding and run-preflight API. */
import {
  pipelineGraphPatchSchema,
  pipelineGraphSchema,
  type PipelineGraphPatch,
} from "@gtmgrid/pipelines";
import { PipelineService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { protectedProcedure, router, runEffect } from "../trpc";
import { inngest } from "../../inngest/client";

const id = z.string().min(1);

export const pipelinesRouter = router({
  tableBindings: protectedProcedure
    .input(z.object({ tableId: id }))
    .query(({ ctx, input }) =>
      runEffect(ctx.runtime, Effect.gen(function* () {
        const service = yield* PipelineService;
        return yield* service.listTableBindings(input.tableId);
      })),
    ),

  list: protectedProcedure
    .input(z.object({ projectId: id }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.list(input.projectId);
        }),
      ),
    ),

  get: protectedProcedure
    .input(z.object({ pipelineId: id }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.get(input.pipelineId);
        }),
      ),
    ),

  remove: protectedProcedure
    .input(z.object({ pipelineId: id }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.remove(input.pipelineId);
        }),
      ),
    ),

  create: protectedProcedure
    .input(
      z.object({
        projectId: id,
        name: z.string().trim().min(1).max(160),
        description: z.string().max(2_000).nullable().optional(),
        graph: pipelineGraphSchema.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.create(input);
        }),
      ),
    ),

  patchDraft: protectedProcedure
    .input(
      z.object({
        pipelineId: id,
        patches: z.array(pipelineGraphPatchSchema).min(1).max(100),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.patchDraft(
            input.pipelineId,
            input.patches as readonly PipelineGraphPatch[],
          );
        }),
      ),
    ),

  deploy: protectedProcedure
    .input(z.object({ pipelineId: id }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.deploy(input.pipelineId);
        }),
      ),
    ),

  attach: protectedProcedure
    .input(
      z.object({
        pipelineId: id,
        versionId: id,
        tableId: id,
        inputMapping: z.record(z.string().min(1)),
        outputMapping: z.record(z.string().min(1)),
        executionTarget: z.enum(["local", "cloud"]),
        autoRun: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.attach(input);
        }),
      ),
    ),

  estimateRun: protectedProcedure
    .input(
      z.object({
        pipelineId: id,
        versionId: id,
        totalRecords: z.number().int().min(0).max(10_000_000),
      }),
    )
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.estimateRun(input);
        }),
      ),
    ),

  createRun: protectedProcedure
    .input(
      z.object({
        pipelineId: id,
        versionId: id,
        bindingId: id.nullable().optional(),
        tableId: id.nullable().optional(),
        executionTarget: z.enum(["local", "cloud"]),
        trigger: z.enum(["manual", "row_created", "row_updated", "schedule", "webhook", "api", "crm", "signal"]),
        selection: z.record(z.unknown()).default({}),
        totalRecords: z.number().int().min(0).max(10_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const run = await runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const service = yield* PipelineService;
          return yield* service.createRun(input);
        }),
      );
      if (run.executionTarget === "cloud") {
        await inngest.send({
          id: `pipeline-run:${run.id}`,
          name: "pipeline/run.requested",
          data: { runId: run.id, workspaceId: run.workspaceId },
        });
      }
      return run;
    }),

  runOutputCell: protectedProcedure
    .input(z.object({ rowId: id, columnId: id }))
    .mutation(async ({ ctx, input }) => {
      const runs = await runEffect(ctx.runtime, Effect.gen(function* () {
        const service = yield* PipelineService;
        return yield* service.createManualRunsForOutputCell(input);
      }));
      await inngest.send(runs.map((run) => ({
        id: `pipeline-run:${run.id}`,
        name: "pipeline/run.requested" as const,
        data: { runId: run.id, workspaceId: run.workspaceId },
      })));
      return runs;
    }),

  listRuns: protectedProcedure
    .input(z.object({ pipelineId: id, limit: z.number().int().min(1).max(100).optional() }))
    .query(({ ctx, input }) => runEffect(ctx.runtime, Effect.gen(function* () {
      const service = yield* PipelineService;
      return yield* service.listRuns(input.pipelineId, input.limit);
    }))),

  getRun: protectedProcedure
    .input(z.object({ runId: id }))
    .query(({ ctx, input }) => runEffect(ctx.runtime, Effect.gen(function* () {
      const service = yield* PipelineService;
      return yield* service.getRun(input.runId);
    }))),
});
