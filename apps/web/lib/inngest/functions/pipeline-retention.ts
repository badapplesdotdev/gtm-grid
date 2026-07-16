import { PipelineRepo } from "@gtmgrid/services";
import { Effect } from "effect";
import { inngest } from "../client";
import { onFailure } from "../on-failure";
import { workerRuntime } from "../../../app/api/worker/_lib";

export const PIPELINE_RUN_RETENTION_DAYS = 30;
export const PIPELINE_RUN_RETENTION_MS = PIPELINE_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

const DELETE_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 100;

export const pipelineRunRetentionCutoff = (now: number): number => now - PIPELINE_RUN_RETENTION_MS;

/**
 * Daily bounded retention for execution history. Deleting a pipeline_runs row
 * cascades its batches, row/node logs, action receipts and reservations. Table
 * output cells are deliberately independent and are never removed here.
 */
export const cleanupPipelineRuns = inngest.createFunction(
  { id: "cleanup-pipeline-runs", retries: 2, triggers: [{ cron: "30 3 * * *" }], onFailure },
  async ({ step }) => step.run("delete-expired-pipeline-runs", async () => {
    const runtime = await workerRuntime();
    const cutoff = pipelineRunRetentionCutoff(Date.now());
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const removed = await runtime.runPromise(
        Effect.flatMap(PipelineRepo, (repo) => repo.deleteTerminalRunsBefore(cutoff, DELETE_BATCH_SIZE)),
      );
      deleted += removed;
      if (removed < DELETE_BATCH_SIZE) break;
    }

    return { deleted, cutoff, retentionDays: PIPELINE_RUN_RETENTION_DAYS };
  }),
);
