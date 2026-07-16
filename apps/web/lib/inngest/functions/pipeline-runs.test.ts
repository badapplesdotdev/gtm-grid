/**
 * `planPipelineRun` orchestration — the batching + event-dispatch glue that sits
 * ABOVE the runner/repo primitives (covered elsewhere). Exercises the durable
 * Inngest handler against the in-memory `PipelineRepo`, with a fake `step` so
 * `step.run` executes inline and `step.sendEvent` is captured.
 *
 * Verifies: an explicit row selection is split into DEFAULT_PIPELINE_BATCH_SIZE
 * windows, one `pipeline/batch.ready` event fires per batch (carrying that
 * window's rowIds), the run is marked started, and the plan is finalized with
 * the full record count.
 */

import type { PipelineRunRecord } from "@gtmgrid/services";
import { pipelineRepoLayer, recordingRealtimePublisherLayer } from "@gtmgrid/services";
import { DEFAULT_PIPELINE_BATCH_SIZE } from "@gtmgrid/pipelines";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock the module singletons the handler reaches for ───────────────────────
// The inngest client: capture the handler instead of registering a function.
vi.mock("../client", () => ({
  inngest: { createFunction: (_cfg: unknown, handler: unknown) => ({ handler }) },
}));
vi.mock("../on-failure", () => ({ onFailure: undefined }));
// Unused by the plan path — stub so the module import stays light.
vi.mock("../worker-client", () => ({ workerClient: { query: vi.fn() }, WORKER_REFS: {} }));
vi.mock("./process-webhook-record", () => ({
  buildWorkerStore: vi.fn(),
  engineConfig: vi.fn(),
  workspaceRegistry: vi.fn(),
}));

// The worker runtime runs an Effect against a per-test in-memory service layer.
let runtimeLayer: Layer.Layer<never, never, never>;
vi.mock("../../../app/api/worker/_lib", () => ({
  workerRuntime: async () => ({
    runPromise: <A,>(effect: Effect.Effect<A, unknown, never>) =>
      Effect.runPromise(Effect.provide(effect, runtimeLayer as never)),
  }),
}));

import { planPipelineRun } from "./pipeline-runs";

const WS = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

const run = (selection: unknown): PipelineRunRecord => ({
  id: RUN, workspaceId: WS, pipelineId: "pl-1", versionId: "ver-1", bindingId: "bind-1",
  tableId: "tbl-1", executionTarget: "cloud", status: "queued", trigger: "manual",
  selection, requestedBy: null, totalRecords: 0, estimatedActions: 0, consumedActions: 0,
  processedRecords: 0, succeededRecords: 0, failedRecords: 0, skippedRecords: 0,
  firstError: null, startedAt: null, finishedAt: null, createdAt: 1,
});

/** A fake Inngest `step`: `run` executes inline; `sendEvent` is recorded. */
function fakeStep() {
  const events: { name: string; data: Record<string, unknown> }[] = [];
  return {
    events,
    step: {
      run: (_id: string, fn: () => unknown) => Promise.resolve(fn()),
      sendEvent: (_id: string, ev: { name: string; data: Record<string, unknown> }) => {
        events.push(ev);
        return Promise.resolve();
      },
    },
  };
}

const invoke = (runs: PipelineRunRecord[]) => {
  runtimeLayer = Layer.mergeAll(
    pipelineRepoLayer({ runs }),
    recordingRealtimePublisherLayer([]),
  ) as unknown as Layer.Layer<never, never, never>;
  const { step, events } = fakeStep();
  return { events, result: (planPipelineRun as unknown as { handler: (a: unknown) => Promise<unknown> }).handler({ event: { id: "evt-1", data: { runId: RUN, workspaceId: WS } }, step }) };
};

describe("planPipelineRun — explicit selection batching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("splits a selection into bounded batches and dispatches one event each", async () => {
    const total = DEFAULT_PIPELINE_BATCH_SIZE * 2 + 10; // → 3 batches: full, full, remainder
    const rowIds = Array.from({ length: total }, (_, i) => `row-${i}`);
    const runs = [run({ rowIds })];
    const { events, result } = invoke(runs);
    const summary = (await result) as { batches: number; records: number };

    expect(summary).toEqual({ batches: 3, records: total });

    const batchEvents = events.filter((e) => e.name === "pipeline/batch.ready");
    expect(batchEvents).toHaveLength(3);
    expect((batchEvents[0].data.rowIds as string[]).length).toBe(DEFAULT_PIPELINE_BATCH_SIZE);
    expect((batchEvents[2].data.rowIds as string[]).length).toBe(10);
    // Every selected row is dispatched exactly once, in order.
    expect(batchEvents.flatMap((e) => e.data.rowIds as string[])).toEqual(rowIds);

    // The run was marked started and its plan finalized with the full count.
    expect(runs[0].status).toBe("running");
    expect(runs[0].totalRecords).toBe(total);
  });

  it("takes the paged path (no batch events) when there is no explicit selection", async () => {
    const { events, result } = invoke([run({})]);
    const summary = (await result) as { paged: boolean };
    expect(summary).toEqual({ paged: true });
    expect(events.filter((e) => e.name === "pipeline/batch.ready")).toHaveLength(0);
    expect(events.some((e) => e.name === "pipeline/run.page")).toBe(true);
  });
});
