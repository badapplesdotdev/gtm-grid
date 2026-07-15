import { schema } from "@gtmgrid/db";
import type {
  CompiledPipeline,
  PipelineExecutionTarget,
  PipelineGraph,
} from "@gtmgrid/pipelines";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { compactPipelineLogValue } from "../pipeline-log-value.js";

export type PipelineVersionStatus = "draft" | "deployed" | "superseded";
export type PipelineRunStatus = "queued" | "running" | "pausing" | "paused" | "cancelling" | "cancelled" | "succeeded" | "partial" | "failed" | "interrupted";
export type PipelineExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface PipelineRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly archived: boolean;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PipelineVersionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly version: number;
  readonly status: PipelineVersionStatus;
  readonly graph: PipelineGraph;
  readonly compiledPlan: CompiledPipelineSnapshot;
  readonly graphHash: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly deployedAt: number | null;
}

/** JSON-safe subset persisted from the server-owned compiler output. */
export interface CompiledPipelineSnapshot {
  readonly graphHash: string;
  readonly topologicalNodeIds: readonly string[];
  readonly capabilities: CompiledPipeline["capabilities"];
  readonly actionEstimate: CompiledPipeline["actionEstimate"];
}

export interface PipelineBindingRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly versionId: string;
  readonly tableId: string;
  readonly inputMapping: Readonly<Record<string, string>>;
  readonly outputMapping: Readonly<Record<string, string>>;
  readonly executionTarget: PipelineExecutionTarget;
  readonly autoRun: boolean;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PipelineRunRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly versionId: string;
  readonly bindingId: string | null;
  readonly tableId: string | null;
  readonly executionTarget: PipelineExecutionTarget;
  readonly status: PipelineRunStatus;
  readonly trigger: string;
  readonly selection: unknown;
  readonly requestedBy: string | null;
  readonly totalRecords: number;
  readonly estimatedActions: number;
  readonly consumedActions: number;
  readonly processedRecords: number;
  readonly succeededRecords: number;
  readonly failedRecords: number;
  readonly skippedRecords: number;
  readonly firstError: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
}

export interface PipelineBatchRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly ordinal: number;
  readonly selector: unknown;
  readonly status: PipelineExecutionStatus;
  readonly totalRecords: number;
  readonly processedRecords: number;
  readonly failedRecords: number;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

export interface PipelineRepoFixtures {
  readonly pipelines?: PipelineRecord[];
  readonly versions?: PipelineVersionRecord[];
  readonly bindings?: PipelineBindingRecord[];
  readonly runs?: PipelineRunRecord[];
  readonly batches?: PipelineBatchRecord[];
  readonly tableWorkspaces?: ReadonlyMap<string, string>;
  readonly cloudActions?: Map<string, { used: number; limit: number | null }>;
  readonly actionReceipts?: Set<string>;
}

export class PipelineRepoError extends Data.TaggedError("PipelineRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PipelineActionsLimitError extends Data.TaggedError(
  "PipelineActionsLimitError",
)<{ readonly message: string }> {}

type ConsumeActionError = PipelineRepoError | PipelineActionsLimitError;

export class PipelineRepo extends Context.Tag("PipelineRepo")<
  PipelineRepo,
  {
    readonly findPipeline: (id: string) => Effect.Effect<Option.Option<PipelineRecord>, PipelineRepoError>;
    readonly listByProject: (projectId: string) => Effect.Effect<readonly PipelineRecord[], PipelineRepoError>;
    readonly deletePipeline: (id: string) => Effect.Effect<void, PipelineRepoError>;
    readonly findVersion: (id: string) => Effect.Effect<Option.Option<PipelineVersionRecord>, PipelineRepoError>;
    readonly latestVersion: (pipelineId: string, status?: PipelineVersionStatus) => Effect.Effect<Option.Option<PipelineVersionRecord>, PipelineRepoError>;
    readonly createWithDraft: (input: {
      readonly workspaceId: string;
      readonly projectId: string;
      readonly name: string;
      readonly description: string | null;
      readonly graph: PipelineGraph;
      readonly compiledPlan: CompiledPipelineSnapshot;
      readonly graphHash: string;
      readonly createdBy: string | null;
      readonly now: number;
    }) => Effect.Effect<{ readonly pipeline: PipelineRecord; readonly version: PipelineVersionRecord }, PipelineRepoError>;
    readonly createDraftFrom: (input: {
      readonly source: PipelineVersionRecord;
      readonly createdBy: string | null;
      readonly now: number;
    }) => Effect.Effect<PipelineVersionRecord, PipelineRepoError>;
    readonly updateDraft: (input: {
      readonly versionId: string;
      readonly pipelineId: string;
      readonly graph: PipelineGraph;
      readonly compiledPlan: CompiledPipelineSnapshot;
      readonly graphHash: string;
      readonly now: number;
    }) => Effect.Effect<PipelineVersionRecord, PipelineRepoError>;
    readonly deployDraft: (pipelineId: string, versionId: string, now: number) => Effect.Effect<PipelineVersionRecord, PipelineRepoError>;
    readonly tableWorkspace: (tableId: string) => Effect.Effect<Option.Option<string>, PipelineRepoError>;
    readonly upsertBinding: (input: Omit<PipelineBindingRecord, "id">) => Effect.Effect<PipelineBindingRecord, PipelineRepoError>;
    readonly listBindings: (pipelineId: string) => Effect.Effect<readonly PipelineBindingRecord[], PipelineRepoError>;
    readonly listBindingsForTable: (tableId: string) => Effect.Effect<readonly PipelineBindingRecord[], PipelineRepoError>;
    readonly listBindingsForColumn: (columnId: string) => Effect.Effect<readonly PipelineBindingRecord[], PipelineRepoError>;
    readonly findBinding: (id: string) => Effect.Effect<Option.Option<PipelineBindingRecord>, PipelineRepoError>;
    readonly createRun: (input: Omit<PipelineRunRecord, "id" | "consumedActions" | "processedRecords" | "succeededRecords" | "failedRecords" | "skippedRecords" | "firstError" | "startedAt" | "finishedAt">) => Effect.Effect<PipelineRunRecord, PipelineRepoError>;
    readonly findRun: (id: string) => Effect.Effect<Option.Option<PipelineRunRecord>, PipelineRepoError>;
    readonly listRuns: (pipelineId: string, limit: number) => Effect.Effect<readonly PipelineRunRecord[], PipelineRepoError>;
    readonly deleteTerminalRunsBefore: (cutoff: number, limit: number) => Effect.Effect<number, PipelineRepoError>;
    readonly runDetails: (runId: string, limit: number) => Effect.Effect<{ readonly rows: readonly unknown[]; readonly nodes: readonly unknown[] }, PipelineRepoError>;
    readonly markRunStarted: (runId: string, orchestrationId: string, now: number) => Effect.Effect<void, PipelineRepoError>;
    readonly finalizeRunPlan: (runId: string, totalRecords: number, now: number) => Effect.Effect<void, PipelineRepoError>;
    readonly createBatch: (input: Omit<PipelineBatchRecord, "id" | "processedRecords" | "failedRecords" | "finishedAt">) => Effect.Effect<PipelineBatchRecord, PipelineRepoError>;
    readonly markBatchStarted: (batchId: string) => Effect.Effect<void, PipelineRepoError>;
    readonly startRowRun: (input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly batchId: string;
      readonly rowId: string;
      readonly startedAt: number;
    }) => Effect.Effect<string, PipelineRepoError>;
    readonly recordNodeRun: (input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly rowRunId: string;
      readonly rowId: string;
      readonly nodeId: string;
      readonly status: "running" | "succeeded" | "failed" | "skipped";
      readonly error?: string;
      readonly input?: unknown;
      readonly output?: unknown;
      readonly actionConsumed: boolean;
      readonly startedAt: number | null;
      readonly finishedAt: number | null;
    }) => Effect.Effect<void, PipelineRepoError>;
    readonly recordRowResult: (input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly batchId: string;
      readonly rowId: string;
      readonly status: "succeeded" | "failed" | "skipped";
      readonly firstError?: string;
      readonly actionsConsumed: number;
      readonly startedAt: number;
      readonly finishedAt: number;
      readonly traces: readonly {
        readonly nodeId: string;
        readonly status: "succeeded" | "failed" | "skipped";
        readonly error?: string;
        readonly input?: unknown;
        readonly output?: unknown;
        readonly actionConsumed: boolean;
        readonly startedAt: number | null;
        readonly finishedAt: number | null;
      }[];
    }) => Effect.Effect<boolean, PipelineRepoError>;
    readonly completeBatch: (batchId: string, now: number) => Effect.Effect<void, PipelineRepoError>;
    /** Pipeline-owned status transitions; preserve any existing output value and
     * bypass ordinary cell metering. Returns the exact cells to broadcast. */
    readonly setOutputStatus: (input: {
      readonly workspaceId: string;
      readonly tableId: string;
      readonly rowIds: readonly string[];
      readonly columnIds: readonly string[];
      readonly status: "pending" | "running" | "error";
      readonly error?: string | null;
      readonly now: number;
    }) => Effect.Effect<readonly { readonly rowId: string; readonly columnId: string; readonly value: unknown; readonly status: string; readonly error: string | null }[], PipelineRepoError>;
    /** Internal pipeline-origin writes; deliberately bypass ordinary cell metering. */
    readonly commitOutputs: (input: {
      readonly workspaceId: string;
      readonly tableId: string;
      readonly rowId: string;
      readonly values: Readonly<Record<string, unknown>>;
      readonly now: number;
    }) => Effect.Effect<void, PipelineRepoError>;
    readonly consumeAction: (input: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly receiptKey: string;
      readonly rowId: string;
      readonly nodeId: string;
      readonly generation: number;
      readonly now: number;
    }) => Effect.Effect<boolean, ConsumeActionError>;
  }
>() {}

const fail = (op: string) => (cause: unknown) =>
  new PipelineRepoError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

const consumeFail = (cause: unknown): ConsumeActionError =>
  cause instanceof PipelineActionsLimitError
    ? cause
    : fail("pipeline action consume")(cause);

const PIPELINE_COLUMNS = {
  id: schema.pipelines.id,
  workspaceId: schema.pipelines.workspaceId,
  projectId: schema.pipelines.projectId,
  name: schema.pipelines.name,
  description: schema.pipelines.description,
  archived: schema.pipelines.archived,
  createdBy: schema.pipelines.createdBy,
  createdAt: schema.pipelines.createdAt,
  updatedAt: schema.pipelines.updatedAt,
} as const;

const VERSION_COLUMNS = {
  id: schema.pipelineVersions.id,
  workspaceId: schema.pipelineVersions.workspaceId,
  pipelineId: schema.pipelineVersions.pipelineId,
  version: schema.pipelineVersions.version,
  status: schema.pipelineVersions.status,
  graph: schema.pipelineVersions.graph,
  compiledPlan: schema.pipelineVersions.compiledPlan,
  graphHash: schema.pipelineVersions.graphHash,
  createdBy: schema.pipelineVersions.createdBy,
  createdAt: schema.pipelineVersions.createdAt,
  deployedAt: schema.pipelineVersions.deployedAt,
} as const;

const toVersion = (row: typeof schema.pipelineVersions.$inferSelect): PipelineVersionRecord => ({
  ...row,
  graph: row.graph as PipelineGraph,
  compiledPlan: row.compiledPlan as CompiledPipelineSnapshot,
});

const toRun = (row: typeof schema.pipelineRuns.$inferSelect): PipelineRunRecord => ({
  id: row.id,
  workspaceId: row.workspaceId,
  pipelineId: row.pipelineId,
  versionId: row.versionId,
  bindingId: row.bindingId,
  tableId: row.tableId,
  executionTarget: row.executionTarget,
  status: row.status,
  trigger: row.trigger,
  selection: row.selection,
  requestedBy: row.requestedBy,
  totalRecords: row.totalRecords,
  estimatedActions: row.estimatedActions,
  consumedActions: row.consumedActions,
  processedRecords: row.processedRecords,
  succeededRecords: row.succeededRecords,
  failedRecords: row.failedRecords,
  skippedRecords: row.skippedRecords,
  firstError: row.firstError,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  createdAt: row.createdAt,
});

export const PipelineRepoLive: Layer.Layer<PipelineRepo, never, DbClient> =
  Layer.effect(
    PipelineRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      return {
        findPipeline: (id) =>
          Effect.tryPromise({
            try: async () => Option.fromNullable((await db.select(PIPELINE_COLUMNS).from(schema.pipelines).where(eq(schema.pipelines.id, id)).limit(1))[0] ?? null),
            catch: fail("pipeline lookup"),
          }),
        listByProject: (projectId) =>
          Effect.tryPromise({
            try: () => db.select(PIPELINE_COLUMNS).from(schema.pipelines).where(and(eq(schema.pipelines.projectId, projectId), eq(schema.pipelines.archived, false))).orderBy(desc(schema.pipelines.updatedAt)),
            catch: fail("pipeline list"),
          }),
        findVersion: (id) =>
          Effect.tryPromise({
            try: async () => {
              const row = (await db.select(VERSION_COLUMNS).from(schema.pipelineVersions).where(eq(schema.pipelineVersions.id, id)).limit(1))[0];
              return Option.fromNullable(row === undefined ? null : toVersion(row));
            },
            catch: fail("pipeline version lookup"),
          }),
        latestVersion: (pipelineId, status) =>
          Effect.tryPromise({
            try: async () => {
              const predicate = status === undefined
                ? eq(schema.pipelineVersions.pipelineId, pipelineId)
                : and(eq(schema.pipelineVersions.pipelineId, pipelineId), eq(schema.pipelineVersions.status, status));
              const row = (await db.select(VERSION_COLUMNS).from(schema.pipelineVersions).where(predicate).orderBy(desc(schema.pipelineVersions.version)).limit(1))[0];
              return Option.fromNullable(row === undefined ? null : toVersion(row));
            },
            catch: fail("latest pipeline version"),
          }),
        createWithDraft: (input) =>
          Effect.tryPromise({
            try: () => db.transaction(async (tx) => {
              const pipeline = (await tx.insert(schema.pipelines).values({
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                name: input.name,
                description: input.description,
                archived: false,
                createdBy: input.createdBy,
                createdAt: input.now,
                updatedAt: input.now,
              }).returning(PIPELINE_COLUMNS))[0];
              if (pipeline === undefined) throw new Error("pipeline insert returned no row");
              const version = (await tx.insert(schema.pipelineVersions).values({
                workspaceId: input.workspaceId,
                pipelineId: pipeline.id,
                version: 1,
                status: "draft",
                graph: input.graph,
                compiledPlan: input.compiledPlan,
                graphHash: input.graphHash,
                createdBy: input.createdBy,
                createdAt: input.now,
              }).returning(VERSION_COLUMNS))[0];
              if (version === undefined) throw new Error("pipeline draft insert returned no row");
              return { pipeline, version: toVersion(version) };
            }),
            catch: fail("pipeline create"),
          }),
        createDraftFrom: (input) =>
          Effect.tryPromise({
            try: async () => {
              const row = (await db.insert(schema.pipelineVersions).values({
                workspaceId: input.source.workspaceId,
                pipelineId: input.source.pipelineId,
                version: input.source.version + 1,
                status: "draft",
                graph: input.source.graph,
                compiledPlan: input.source.compiledPlan,
                graphHash: input.source.graphHash,
                createdBy: input.createdBy,
                createdAt: input.now,
              }).returning(VERSION_COLUMNS))[0];
              if (row === undefined) throw new Error("pipeline draft clone returned no row");
              return toVersion(row);
            },
            catch: fail("pipeline draft clone"),
          }),
        updateDraft: (input) =>
          Effect.tryPromise({
            try: async () => {
              const row = (await db.transaction(async (tx) => {
                const updated = (await tx.update(schema.pipelineVersions).set({
                  graph: input.graph,
                  compiledPlan: input.compiledPlan,
                  graphHash: input.graphHash,
                }).where(and(eq(schema.pipelineVersions.id, input.versionId), eq(schema.pipelineVersions.pipelineId, input.pipelineId), eq(schema.pipelineVersions.status, "draft"))).returning(VERSION_COLUMNS))[0];
                if (updated === undefined) throw new Error("draft is missing or already deployed");
                await tx.update(schema.pipelines).set({ updatedAt: input.now }).where(eq(schema.pipelines.id, input.pipelineId));
                return updated;
              }));
              return toVersion(row);
            },
            catch: fail("pipeline draft update"),
          }),
        deployDraft: (pipelineId, versionId, now) =>
          Effect.tryPromise({
            try: async () => db.transaction(async (tx) => {
              await tx.update(schema.pipelineVersions).set({ status: "superseded" }).where(and(eq(schema.pipelineVersions.pipelineId, pipelineId), eq(schema.pipelineVersions.status, "deployed")));
              const row = (await tx.update(schema.pipelineVersions).set({ status: "deployed", deployedAt: now }).where(and(eq(schema.pipelineVersions.id, versionId), eq(schema.pipelineVersions.pipelineId, pipelineId), eq(schema.pipelineVersions.status, "draft"))).returning(VERSION_COLUMNS))[0];
              if (row === undefined) throw new Error("draft is missing or already deployed");
              await tx.update(schema.pipelines).set({ updatedAt: now }).where(eq(schema.pipelines.id, pipelineId));
              // A table is attached to the pipeline, not permanently to the
              // version that happened to be deployed when it was attached.
              // Advance every saved attachment atomically with deployment so
              // subsequent automatic runs use the current graph and names.
              await tx.update(schema.pipelineBindings).set({ versionId, updatedAt: now }).where(eq(schema.pipelineBindings.pipelineId, pipelineId));
              return toVersion(row);
            }),
            catch: fail("pipeline deploy"),
          }),
        deletePipeline: (pipelineId) =>
          Effect.tryPromise({
            try: async () => db.transaction(async (tx) => {
              // Version references are RESTRICTed so immutable run history can
              // never be orphaned. Remove the pipeline-owned dependants first;
              // their deeper row/node/action records cascade from pipeline_runs.
              await tx.delete(schema.pipelineRuns).where(eq(schema.pipelineRuns.pipelineId, pipelineId));
              await tx.delete(schema.pipelineTriggers).where(eq(schema.pipelineTriggers.pipelineId, pipelineId));
              await tx.delete(schema.pipelineBindings).where(eq(schema.pipelineBindings.pipelineId, pipelineId));
              await tx.delete(schema.pipelineVersions).where(eq(schema.pipelineVersions.pipelineId, pipelineId));
              await tx.delete(schema.pipelines).where(eq(schema.pipelines.id, pipelineId));
            }),
            catch: fail("pipeline delete"),
          }),
        tableWorkspace: (tableId) =>
          Effect.tryPromise({
            try: async () => Option.fromNullable((await db.select({ workspaceId: schema.tables.workspaceId }).from(schema.tables).where(eq(schema.tables.id, tableId)).limit(1))[0]?.workspaceId ?? null),
            catch: fail("pipeline table lookup"),
          }),
        upsertBinding: (input) =>
          Effect.tryPromise({
            try: async () => {
              const columns = {
                id: schema.pipelineBindings.id,
                workspaceId: schema.pipelineBindings.workspaceId,
                pipelineId: schema.pipelineBindings.pipelineId,
                versionId: schema.pipelineBindings.versionId,
                tableId: schema.pipelineBindings.tableId,
                inputMapping: schema.pipelineBindings.inputMapping,
                outputMapping: schema.pipelineBindings.outputMapping,
                executionTarget: schema.pipelineBindings.executionTarget,
                autoRun: schema.pipelineBindings.autoRun,
                enabled: schema.pipelineBindings.enabled,
                createdAt: schema.pipelineBindings.createdAt,
                updatedAt: schema.pipelineBindings.updatedAt,
              } as const;
              const row = (await db.insert(schema.pipelineBindings).values(input).onConflictDoUpdate({
                target: [schema.pipelineBindings.pipelineId, schema.pipelineBindings.tableId],
                set: {
                  versionId: input.versionId,
                  inputMapping: input.inputMapping,
                  outputMapping: input.outputMapping,
                  executionTarget: input.executionTarget,
                  autoRun: input.autoRun,
                  enabled: input.enabled,
                  updatedAt: input.updatedAt,
                },
              }).returning(columns))[0];
              if (row === undefined) throw new Error("pipeline binding upsert returned no row");
              return { ...row, inputMapping: row.inputMapping as Record<string, string>, outputMapping: row.outputMapping as Record<string, string> };
            },
            catch: fail("pipeline binding upsert"),
          }),
        listBindings: (pipelineId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db.select().from(schema.pipelineBindings).where(eq(schema.pipelineBindings.pipelineId, pipelineId)).orderBy(asc(schema.pipelineBindings.createdAt));
              return rows.map((row) => ({ ...row, inputMapping: row.inputMapping as Record<string, string>, outputMapping: row.outputMapping as Record<string, string> }));
            },
            catch: fail("pipeline binding list"),
          }),
        listBindingsForTable: (tableId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db.select().from(schema.pipelineBindings).where(eq(schema.pipelineBindings.tableId, tableId)).orderBy(asc(schema.pipelineBindings.createdAt));
              return rows.map((row) => ({ ...row, inputMapping: row.inputMapping as Record<string, string>, outputMapping: row.outputMapping as Record<string, string> }));
            },
            catch: fail("pipeline table binding list"),
          }),
        listBindingsForColumn: (columnId) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db.select({ binding: schema.pipelineBindings }).from(schema.pipelineBindings).innerJoin(schema.columns, eq(schema.columns.tableId, schema.pipelineBindings.tableId)).where(eq(schema.columns.id, columnId)).orderBy(asc(schema.pipelineBindings.createdAt));
              return rows.map(({ binding: row }) => ({ ...row, inputMapping: row.inputMapping as Record<string, string>, outputMapping: row.outputMapping as Record<string, string> }));
            },
            catch: fail("pipeline column binding list"),
          }),
        findBinding: (id) =>
          Effect.tryPromise({
            try: async () => {
              const row = (await db.select().from(schema.pipelineBindings).where(eq(schema.pipelineBindings.id, id)).limit(1))[0];
              return Option.fromNullable(row === undefined ? null : { ...row, inputMapping: row.inputMapping as Record<string, string>, outputMapping: row.outputMapping as Record<string, string> });
            },
            catch: fail("pipeline binding lookup"),
          }),
        createRun: (input) =>
          Effect.tryPromise({
            try: async () => {
              const row = (await db.insert(schema.pipelineRuns).values({ ...input, consumedActions: 0, status: input.status as typeof schema.pipelineRuns.$inferInsert.status }).returning())[0];
              if (row === undefined) throw new Error("pipeline run insert returned no row");
              return toRun(row);
            },
            catch: fail("pipeline run create"),
          }),
        findRun: (id) =>
          Effect.tryPromise({
            try: async () => {
              const row = (await db.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, id)).limit(1))[0];
              return Option.fromNullable(row === undefined ? null : toRun(row));
            },
            catch: fail("pipeline run lookup"),
          }),
        listRuns: (pipelineId, limit) =>
          Effect.tryPromise({
            try: async () => (await db.select().from(schema.pipelineRuns).where(eq(schema.pipelineRuns.pipelineId, pipelineId)).orderBy(desc(schema.pipelineRuns.createdAt)).limit(Math.min(100, Math.max(1, limit)))).map(toRun),
            catch: fail("pipeline run list"),
          }),
        deleteTerminalRunsBefore: (cutoff, limit) =>
          Effect.tryPromise({
            try: async () => {
              const terminal = ["cancelled", "succeeded", "partial", "failed", "interrupted"] as const;
              const expired = await db.select({ id: schema.pipelineRuns.id }).from(schema.pipelineRuns).where(and(
                lt(schema.pipelineRuns.createdAt, cutoff),
                inArray(schema.pipelineRuns.status, terminal),
              )).limit(Math.min(10_000, Math.max(1, limit)));
              if (expired.length === 0) return 0;
              const removed = await db.delete(schema.pipelineRuns).where(inArray(schema.pipelineRuns.id, expired.map(({ id }) => id))).returning({ id: schema.pipelineRuns.id });
              return removed.length;
            },
            catch: fail("pipeline run retention"),
          }),
        runDetails: (runId, limit) =>
          Effect.tryPromise({
            try: async () => {
              const bounded = Math.min(500, Math.max(1, limit));
              const rows = await db.select().from(schema.pipelineRowRuns).where(eq(schema.pipelineRowRuns.runId, runId)).orderBy(desc(schema.pipelineRowRuns.startedAt)).limit(bounded);
              const nodes = await db.select().from(schema.pipelineNodeRuns).where(eq(schema.pipelineNodeRuns.runId, runId)).orderBy(desc(schema.pipelineNodeRuns.startedAt)).limit(bounded * 10);
              return { rows, nodes };
            },
            catch: fail("pipeline run details"),
          }),
        markRunStarted: (runId, orchestrationId, now) =>
          Effect.tryPromise({
            try: async () => { await db.update(schema.pipelineRuns).set({ status: "running", orchestrationId, startedAt: now }).where(and(eq(schema.pipelineRuns.id, runId), eq(schema.pipelineRuns.status, "queued"))); },
            catch: fail("pipeline run start"),
          }),
        finalizeRunPlan: (runId, totalRecords, now) =>
          Effect.tryPromise({
            try: async () => { await db.update(schema.pipelineRuns).set({ totalRecords, ...(totalRecords === 0 ? { status: "succeeded" as const, finishedAt: now } : {}) }).where(eq(schema.pipelineRuns.id, runId)); },
            catch: fail("pipeline run plan finalize"),
          }),
        createBatch: (input) =>
          Effect.tryPromise({
            try: async () => {
              const inserted = (await db.insert(schema.pipelineRunBatches).values({ ...input, processedRecords: 0, failedRecords: 0 }).onConflictDoNothing({ target: [schema.pipelineRunBatches.runId, schema.pipelineRunBatches.ordinal] }).returning())[0];
              const row = inserted ?? (await db.select().from(schema.pipelineRunBatches).where(and(eq(schema.pipelineRunBatches.runId, input.runId), eq(schema.pipelineRunBatches.ordinal, input.ordinal))).limit(1))[0];
              if (row === undefined) throw new Error("pipeline batch insert returned no row");
              return { ...row, selector: row.selector };
            },
            catch: fail("pipeline batch create"),
          }),
        markBatchStarted: (batchId) =>
          Effect.tryPromise({
            try: async () => { await db.update(schema.pipelineRunBatches).set({ status: "running", attempts: sql`${schema.pipelineRunBatches.attempts} + 1` }).where(and(eq(schema.pipelineRunBatches.id, batchId), eq(schema.pipelineRunBatches.status, "queued"))); },
            catch: fail("pipeline batch start"),
          }),
        startRowRun: (input) =>
          Effect.tryPromise({
            try: async () => {
              const inserted = (await db.insert(schema.pipelineRowRuns).values({
                workspaceId: input.workspaceId, runId: input.runId, batchId: input.batchId,
                rowId: input.rowId, status: "running", actionsConsumed: 0, startedAt: input.startedAt,
              }).onConflictDoNothing({ target: [schema.pipelineRowRuns.runId, schema.pipelineRowRuns.rowId] }).returning({ id: schema.pipelineRowRuns.id }))[0];
              if (inserted !== undefined) return inserted.id;
              const existing = (await db.select({ id: schema.pipelineRowRuns.id }).from(schema.pipelineRowRuns).where(and(eq(schema.pipelineRowRuns.runId, input.runId), eq(schema.pipelineRowRuns.rowId, input.rowId))).limit(1))[0];
              if (existing === undefined) throw new Error("pipeline row run start returned no row");
              return existing.id;
            },
            catch: fail("pipeline row run start"),
          }),
        recordNodeRun: (input) =>
          Effect.tryPromise({
            try: async () => {
              const startedAt = input.startedAt ?? input.finishedAt ?? Date.now();
              // Persist the (potentially large) jsonb payload only on the
              // terminal transition. The intermediate "running" write is a
              // small status marker — skipping its input/output keeps a node's
              // TOAST-backed columns written exactly once per generation instead
              // of being rewritten (running -> terminal) on every node.
              const isTerminal = input.status !== "running";
              const inputData = isTerminal ? compactPipelineLogValue(input.input) : null;
              const outputData = isTerminal ? compactPipelineLogValue(input.output) : null;
              const durationMs = input.finishedAt === null ? null : Math.max(0, input.finishedAt - startedAt);
              await db.insert(schema.pipelineNodeRuns).values({
                workspaceId: input.workspaceId, runId: input.runId, rowRunId: input.rowRunId, rowId: input.rowId,
                nodeId: input.nodeId, status: input.status, error: input.error, actionConsumed: input.actionConsumed,
                inputData, outputData,
                startedAt, finishedAt: input.finishedAt,
                durationMs,
              }).onConflictDoUpdate({
                target: [schema.pipelineNodeRuns.runId, schema.pipelineNodeRuns.rowId, schema.pipelineNodeRuns.nodeId, schema.pipelineNodeRuns.generation],
                // On the running -> terminal update, only the terminal write
                // carries jsonb; the running upsert leaves prior columns intact.
                set: isTerminal
                  ? { status: input.status, error: input.error ?? null, inputData, outputData, actionConsumed: input.actionConsumed, startedAt, finishedAt: input.finishedAt, durationMs }
                  : { status: input.status, error: input.error ?? null, actionConsumed: input.actionConsumed, startedAt, finishedAt: input.finishedAt, durationMs },
              });
            },
            catch: fail("pipeline node run record"),
          }),
        recordRowResult: (input) =>
          Effect.tryPromise({
            try: () => db.transaction(async (tx) => {
              let rowRun = (await tx.update(schema.pipelineRowRuns).set({
                status: input.status, firstError: input.firstError, actionsConsumed: input.actionsConsumed, finishedAt: input.finishedAt,
              }).where(and(eq(schema.pipelineRowRuns.runId, input.runId), eq(schema.pipelineRowRuns.rowId, input.rowId), eq(schema.pipelineRowRuns.status, "running"))).returning({ id: schema.pipelineRowRuns.id }))[0];
              rowRun ??= (await tx.insert(schema.pipelineRowRuns).values({
                workspaceId: input.workspaceId, runId: input.runId, batchId: input.batchId,
                rowId: input.rowId, status: input.status, firstError: input.firstError,
                actionsConsumed: input.actionsConsumed, startedAt: input.startedAt, finishedAt: input.finishedAt,
              }).onConflictDoNothing({ target: [schema.pipelineRowRuns.runId, schema.pipelineRowRuns.rowId] }).returning({ id: schema.pipelineRowRuns.id }))[0];
              if (rowRun === undefined) return false;
              // Node-level rows (incl. their compacted input/output jsonb) are
              // already persisted by `recordNodeRun` as each node reaches a
              // terminal state, so we do NOT re-insert `input.traces` here.
              // Re-writing them was a redundant third write per node and a
              // needless source of TOAST churn on pipeline_node_runs.
              await tx.update(schema.pipelineRunBatches).set({
                processedRecords: sql`${schema.pipelineRunBatches.processedRecords} + 1`,
                failedRecords: input.status === "failed" ? sql`${schema.pipelineRunBatches.failedRecords} + 1` : schema.pipelineRunBatches.failedRecords,
              }).where(eq(schema.pipelineRunBatches.id, input.batchId));
              await tx.update(schema.pipelineRuns).set({
                processedRecords: sql`${schema.pipelineRuns.processedRecords} + 1`,
                succeededRecords: input.status === "succeeded" ? sql`${schema.pipelineRuns.succeededRecords} + 1` : schema.pipelineRuns.succeededRecords,
                failedRecords: input.status === "failed" ? sql`${schema.pipelineRuns.failedRecords} + 1` : schema.pipelineRuns.failedRecords,
                skippedRecords: input.status === "skipped" ? sql`${schema.pipelineRuns.skippedRecords} + 1` : schema.pipelineRuns.skippedRecords,
                ...(input.firstError === undefined ? {} : { firstError: sql`coalesce(${schema.pipelineRuns.firstError}, ${input.firstError})` }),
              }).where(eq(schema.pipelineRuns.id, input.runId));
              return true;
            }),
            catch: fail("pipeline row result"),
          }),
        completeBatch: (batchId, now) =>
          Effect.tryPromise({
            try: () => db.transaction(async (tx) => {
              const batch = (await tx.update(schema.pipelineRunBatches).set({ status: "succeeded", finishedAt: now }).where(and(eq(schema.pipelineRunBatches.id, batchId), eq(schema.pipelineRunBatches.status, "running"))).returning({ runId: schema.pipelineRunBatches.runId }))[0];
              if (batch === undefined) return;
              const run = (await tx.select({ processed: schema.pipelineRuns.processedRecords, total: schema.pipelineRuns.totalRecords, failed: schema.pipelineRuns.failedRecords }).from(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, batch.runId)).limit(1))[0];
              if (run !== undefined && run.processed >= run.total) await tx.update(schema.pipelineRuns).set({ status: run.failed > 0 ? "partial" : "succeeded", finishedAt: now }).where(eq(schema.pipelineRuns.id, batch.runId));
            }),
            catch: fail("pipeline batch complete"),
          }),
        setOutputStatus: (input) =>
          Effect.tryPromise({
            try: async () => {
              if (input.rowIds.length === 0 || input.columnIds.length === 0) return [];
              return await db.transaction(async (tx) => {
                const values = input.rowIds.flatMap((rowId) => input.columnIds.map((columnId) => ({
                  workspaceId: input.workspaceId,
                  tableId: input.tableId,
                  rowId,
                  columnId,
                  value: null,
                  status: input.status,
                  error: input.error ?? null,
                  updatedAt: input.now,
                })));
                const rows = await tx.insert(schema.cells).values(values).onConflictDoUpdate({
                  target: [schema.cells.rowId, schema.cells.columnId],
                  set: { status: input.status, error: input.error ?? null, updatedAt: input.now },
                }).returning({ rowId: schema.cells.rowId, columnId: schema.cells.columnId, value: schema.cells.value, status: schema.cells.status, error: schema.cells.error });
                return rows;
              });
            },
            catch: fail("pipeline output status"),
          }),
        commitOutputs: (input) =>
          Effect.tryPromise({
            try: () => db.transaction(async (tx) => {
              const columnIds = Object.keys(input.values);
              if (columnIds.length === 0) return;
              const row = (await tx.select({ id: schema.rows.id }).from(schema.rows).where(and(eq(schema.rows.id, input.rowId), eq(schema.rows.tableId, input.tableId), eq(schema.rows.workspaceId, input.workspaceId))).limit(1))[0];
              if (row === undefined) throw new Error("Pipeline output row is outside the run table.");
              for (const columnId of columnIds) {
                const column = (await tx.select({ id: schema.columns.id }).from(schema.columns).where(and(eq(schema.columns.id, columnId), eq(schema.columns.tableId, input.tableId), eq(schema.columns.workspaceId, input.workspaceId))).limit(1))[0];
                if (column === undefined) throw new Error(`Pipeline output column ${columnId} is outside the run table.`);
                await tx.insert(schema.cells).values({ workspaceId: input.workspaceId, tableId: input.tableId, rowId: input.rowId, columnId, value: input.values[columnId], status: "done", error: null, updatedAt: input.now }).onConflictDoUpdate({ target: [schema.cells.rowId, schema.cells.columnId], set: { value: input.values[columnId], status: "done", error: null, updatedAt: input.now } });
              }
            }),
            catch: fail("pipeline output commit"),
          }),
        consumeAction: (input) =>
          Effect.tryPromise({
            try: () => db.transaction(async (tx) => {
              const inserted = await tx.insert(schema.pipelineActionLedger).values({
                workspaceId: input.workspaceId,
                runId: input.runId,
                receiptKey: input.receiptKey,
                rowId: input.rowId,
                nodeId: input.nodeId,
                generation: input.generation,
                actions: 1,
                createdAt: input.now,
              }).onConflictDoNothing({ target: schema.pipelineActionLedger.receiptKey }).returning({ id: schema.pipelineActionLedger.id });
              if (inserted.length === 0) return false;
              const updated = await tx.update(schema.workspaces).set({
                cloudActionsUsed: sql`coalesce(${schema.workspaces.cloudActionsUsed}, 0) + 1`,
              }).where(and(
                eq(schema.workspaces.id, input.workspaceId),
                sql`(${schema.workspaces.cloudActionsLimit} is null or coalesce(${schema.workspaces.cloudActionsUsed}, 0) < ${schema.workspaces.cloudActionsLimit})`,
              )).returning({ id: schema.workspaces.id });
              if (updated.length === 0) throw new PipelineActionsLimitError({ message: "This pipeline would exceed the workspace's remaining cloud actions." });
              await tx.update(schema.pipelineRuns).set({
                consumedActions: sql`${schema.pipelineRuns.consumedActions} + 1`,
              }).where(eq(schema.pipelineRuns.id, input.runId));
              return true;
            }),
            catch: consumeFail,
          }),
      };
    }),
  );

export const pipelineRepoLayer = (
  fixtures: PipelineRepoFixtures = {},
): Layer.Layer<PipelineRepo> => {
  const pipelines = fixtures.pipelines ?? [];
  const versions = fixtures.versions ?? [];
  const bindings = fixtures.bindings ?? [];
  const runs = fixtures.runs ?? [];
  const batches = fixtures.batches ?? [];
  const receipts = fixtures.actionReceipts ?? new Set<string>();
  const quotas = fixtures.cloudActions ?? new Map();
  let counter = pipelines.length + versions.length + bindings.length + runs.length + batches.length;
  const id = (prefix: string) => `${prefix}_${++counter}`;
  return Layer.succeed(PipelineRepo, {
    findPipeline: (pipelineId) => Effect.succeed(Option.fromNullable(pipelines.find((p) => p.id === pipelineId))),
    listByProject: (projectId) => Effect.succeed(pipelines.filter((p) => p.projectId === projectId && !p.archived).sort((a, b) => b.updatedAt - a.updatedAt)),
    findVersion: (versionId) => Effect.succeed(Option.fromNullable(versions.find((v) => v.id === versionId))),
    latestVersion: (pipelineId, status) => Effect.succeed(Option.fromNullable(versions.filter((v) => v.pipelineId === pipelineId && (status === undefined || v.status === status)).sort((a, b) => b.version - a.version)[0])),
    createWithDraft: (input) => Effect.sync(() => {
      const pipeline: PipelineRecord = { id: id("pipeline"), workspaceId: input.workspaceId, projectId: input.projectId, name: input.name, description: input.description, archived: false, createdBy: input.createdBy, createdAt: input.now, updatedAt: input.now };
      const version: PipelineVersionRecord = { id: id("version"), workspaceId: input.workspaceId, pipelineId: pipeline.id, version: 1, status: "draft", graph: input.graph, compiledPlan: input.compiledPlan, graphHash: input.graphHash, createdBy: input.createdBy, createdAt: input.now, deployedAt: null };
      pipelines.push(pipeline);
      versions.push(version);
      return { pipeline, version };
    }),
    createDraftFrom: (input) => Effect.sync(() => {
      const version: PipelineVersionRecord = { ...input.source, id: id("version"), version: input.source.version + 1, status: "draft", createdBy: input.createdBy, createdAt: input.now, deployedAt: null };
      versions.push(version);
      return version;
    }),
    updateDraft: (input) => Effect.try({
      try: () => {
        const index = versions.findIndex((v) => v.id === input.versionId && v.pipelineId === input.pipelineId && v.status === "draft");
        if (index < 0) throw new Error("draft is missing or already deployed");
        const next = { ...versions[index] as PipelineVersionRecord, graph: input.graph, compiledPlan: input.compiledPlan, graphHash: input.graphHash };
        versions[index] = next;
        const pipelineIndex = pipelines.findIndex((p) => p.id === input.pipelineId);
        if (pipelineIndex >= 0) pipelines[pipelineIndex] = { ...pipelines[pipelineIndex] as PipelineRecord, updatedAt: input.now };
        return next;
      },
      catch: fail("pipeline draft update"),
    }),
    deployDraft: (pipelineId, versionId, now) => Effect.try({
      try: () => {
        for (let i = 0; i < versions.length; i += 1) if (versions[i]?.pipelineId === pipelineId && versions[i]?.status === "deployed") versions[i] = { ...versions[i] as PipelineVersionRecord, status: "superseded" };
        const index = versions.findIndex((v) => v.id === versionId && v.pipelineId === pipelineId && v.status === "draft");
        if (index < 0) throw new Error("draft is missing or already deployed");
        const deployed = { ...versions[index] as PipelineVersionRecord, status: "deployed" as const, deployedAt: now };
        versions[index] = deployed;
        for (let i = 0; i < bindings.length; i += 1) {
          if (bindings[i]?.pipelineId === pipelineId) {
            bindings[i] = { ...bindings[i] as PipelineBindingRecord, versionId, updatedAt: now };
          }
        }
        return deployed;
      },
      catch: fail("pipeline deploy"),
    }),
    deletePipeline: (pipelineId) => Effect.sync(() => {
      const runIds = new Set(runs.filter((run) => run.pipelineId === pipelineId).map((run) => run.id));
      for (let index = batches.length - 1; index >= 0; index -= 1) if (runIds.has((batches[index] as PipelineBatchRecord).runId)) batches.splice(index, 1);
      for (let index = runs.length - 1; index >= 0; index -= 1) if (runs[index]?.pipelineId === pipelineId) runs.splice(index, 1);
      for (let index = bindings.length - 1; index >= 0; index -= 1) if (bindings[index]?.pipelineId === pipelineId) bindings.splice(index, 1);
      for (let index = versions.length - 1; index >= 0; index -= 1) if (versions[index]?.pipelineId === pipelineId) versions.splice(index, 1);
      for (let index = pipelines.length - 1; index >= 0; index -= 1) if (pipelines[index]?.id === pipelineId) pipelines.splice(index, 1);
    }),
    tableWorkspace: (tableId) => Effect.succeed(Option.fromNullable(fixtures.tableWorkspaces?.get(tableId))),
    upsertBinding: (input) => Effect.sync(() => {
      const existing = bindings.findIndex((b) => b.pipelineId === input.pipelineId && b.tableId === input.tableId);
      const record: PipelineBindingRecord = { ...input, id: existing >= 0 ? (bindings[existing] as PipelineBindingRecord).id : id("binding") };
      if (existing >= 0) bindings[existing] = record;
      else bindings.push(record);
      return record;
    }),
    listBindings: (pipelineId) => Effect.succeed(bindings.filter((b) => b.pipelineId === pipelineId).sort((a, b) => a.createdAt - b.createdAt)),
    listBindingsForTable: (tableId) => Effect.succeed(bindings.filter((b) => b.tableId === tableId).sort((a, b) => a.createdAt - b.createdAt)),
    listBindingsForColumn: (columnId) => Effect.succeed(bindings.filter((b) => Object.values(b.inputMapping).includes(columnId)).sort((a, b) => a.createdAt - b.createdAt)),
    findBinding: (bindingId) => Effect.succeed(Option.fromNullable(bindings.find((binding) => binding.id === bindingId))),
    createRun: (input) => Effect.sync(() => {
      const run: PipelineRunRecord = { ...input, id: id("run"), consumedActions: 0, processedRecords: 0, succeededRecords: 0, failedRecords: 0, skippedRecords: 0, firstError: null, startedAt: null, finishedAt: null };
      runs.push(run);
      return run;
    }),
    findRun: (runId) => Effect.succeed(Option.fromNullable(runs.find((run) => run.id === runId))),
    listRuns: (pipelineId, limit) => Effect.succeed(runs.filter((run) => run.pipelineId === pipelineId).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)),
    deleteTerminalRunsBefore: (cutoff, limit) => Effect.sync(() => {
      const terminal = new Set<PipelineRunStatus>(["cancelled", "succeeded", "partial", "failed", "interrupted"]);
      const ids = runs.filter((run) => run.createdAt < cutoff && terminal.has(run.status)).slice(0, Math.max(1, limit)).map((run) => run.id);
      const removed = new Set(ids);
      for (let index = batches.length - 1; index >= 0; index -= 1) if (removed.has((batches[index] as PipelineBatchRecord).runId)) batches.splice(index, 1);
      for (let index = runs.length - 1; index >= 0; index -= 1) if (removed.has((runs[index] as PipelineRunRecord).id)) runs.splice(index, 1);
      return ids.length;
    }),
    runDetails: () => Effect.succeed({ rows: [], nodes: [] }),
    markRunStarted: (runId, _orchestrationId, now) => Effect.sync(() => {
      const index = runs.findIndex((run) => run.id === runId && run.status === "queued");
      if (index >= 0) runs[index] = { ...runs[index] as PipelineRunRecord, status: "running", startedAt: now };
    }),
    finalizeRunPlan: (runId, totalRecords, now) => Effect.sync(() => {
      const index = runs.findIndex((run) => run.id === runId);
      if (index >= 0) runs[index] = { ...runs[index] as PipelineRunRecord, totalRecords, ...(totalRecords === 0 ? { status: "succeeded" as const, finishedAt: now } : {}) };
    }),
    createBatch: (input) => Effect.sync(() => {
      const existing = batches.find((batch) => batch.runId === input.runId && batch.ordinal === input.ordinal);
      if (existing !== undefined) return existing;
      const batch: PipelineBatchRecord = { ...input, id: id("batch"), processedRecords: 0, failedRecords: 0, finishedAt: null };
      batches.push(batch);
      return batch;
    }),
    markBatchStarted: (batchId) => Effect.sync(() => {
      const index = batches.findIndex((batch) => batch.id === batchId && batch.status === "queued");
      if (index >= 0) batches[index] = { ...batches[index] as PipelineBatchRecord, status: "running" };
    }),
    startRowRun: () => Effect.succeed(id("row-run")),
    recordNodeRun: () => Effect.void,
    recordRowResult: (input) => Effect.sync(() => {
      const receipt = `row:${input.runId}:${input.rowId}`;
      if (receipts.has(receipt)) return false;
      receipts.add(receipt);
      const batchIndex = batches.findIndex((batch) => batch.id === input.batchId);
      if (batchIndex >= 0) batches[batchIndex] = { ...batches[batchIndex] as PipelineBatchRecord, processedRecords: (batches[batchIndex]?.processedRecords ?? 0) + 1, failedRecords: (batches[batchIndex]?.failedRecords ?? 0) + (input.status === "failed" ? 1 : 0) };
      const runIndex = runs.findIndex((run) => run.id === input.runId);
      if (runIndex >= 0) {
        const run = runs[runIndex] as PipelineRunRecord;
        runs[runIndex] = { ...run, processedRecords: run.processedRecords + 1, succeededRecords: run.succeededRecords + (input.status === "succeeded" ? 1 : 0), failedRecords: run.failedRecords + (input.status === "failed" ? 1 : 0), skippedRecords: run.skippedRecords + (input.status === "skipped" ? 1 : 0), firstError: run.firstError ?? input.firstError ?? null };
      }
      return true;
    }),
    completeBatch: (batchId, now) => Effect.sync(() => {
      const batchIndex = batches.findIndex((batch) => batch.id === batchId);
      if (batchIndex < 0) return;
      const batch = batches[batchIndex] as PipelineBatchRecord;
      batches[batchIndex] = { ...batch, status: "succeeded", finishedAt: now };
      const runIndex = runs.findIndex((run) => run.id === batch.runId);
      if (runIndex >= 0) {
        const run = runs[runIndex] as PipelineRunRecord;
        if (run.processedRecords >= run.totalRecords) runs[runIndex] = { ...run, status: run.failedRecords > 0 ? "partial" : "succeeded", finishedAt: now };
      }
    }),
    setOutputStatus: (input) => Effect.succeed(input.rowIds.flatMap((rowId) => input.columnIds.map((columnId) => ({ rowId, columnId, value: null, status: input.status, error: input.error ?? null })))),
    commitOutputs: () => Effect.void,
    consumeAction: (input) => Effect.gen(function* () {
      if (receipts.has(input.receiptKey)) return false;
      const quota = quotas.get(input.workspaceId) ?? { used: 0, limit: null };
      if (quota.limit !== null && quota.used >= quota.limit) return yield* Effect.fail(new PipelineActionsLimitError({ message: "This pipeline would exceed the workspace's remaining cloud actions." }));
      receipts.add(input.receiptKey);
      quotas.set(input.workspaceId, { ...quota, used: quota.used + 1 });
      const runIndex = runs.findIndex((run) => run.id === input.runId);
      if (runIndex >= 0) runs[runIndex] = { ...runs[runIndex] as PipelineRunRecord, consumedActions: (runs[runIndex]?.consumedActions ?? 0) + 1 };
      return true;
    }),
  });
};
