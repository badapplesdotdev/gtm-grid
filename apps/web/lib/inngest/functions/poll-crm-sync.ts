/**
 * Scheduled CRM→grid sync poller (cloud-only). The desktop has no cron; the
 * recurring daily pull lives here, structured exactly like the Social-Signals
 * poller ({@link pollTrigifySignals}) so the two share one operational model:
 *
 *   - {@link pollCrmSync} runs on a daily cron, collects the bindings whose
 *     schedule is DUE via SQL keyset pagination (the due predicate runs in the
 *     DB), and fans them out in bounded chunks (~{@link FANOUT_CHUNK}/event).
 *   - {@link processCrmBinding} handles each `crm/binding.due` (cron) or
 *     `crm/binding.sync-now` (manual) event: it runs `CrmSyncService.syncPageForWorker`
 *     (membership-free — the Inngest signing key is the trust boundary), captures
 *     the per-run PostHog event, publishes a realtime row-insert so open grids
 *     refresh live, and fans out `crm/row.inserted` enrichment for new rows.
 *   - {@link warmUpCrmBinding} front-loads retries after a binding is created so
 *     the first data lands in seconds, not at the next daily cron.
 *   - {@link enrichCrmRow} runs a newly synced row's function columns in `{{ref}}`
 *     dependency order, reusing the webhook enricher's helpers.
 *
 * `runtime = "nodejs"` for the Effect runtime + credential decrypt (node:crypto).
 */

import {
  type AppServices,
  appLayer,
  type CrmSyncOutcome,
  type CrmSyncPageResult,
  type CrmSyncPageState,
  CrmSyncService,
  DUE_PAGE_SIZE,
  FANOUT_CHUNK,
  FILTER_OPS,
  SUPPORTED_ATTR_TYPES,
} from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import { z } from "zod";
import { inngest } from "../client";
import { onFailure } from "../on-failure";
import { captureServer } from "../../posthog-server";
import { enrichRowInDepOrder } from "../enrich-row";
import { toStepRunner } from "./process-webhook-record";

const crmCheckpointSchema: z.ZodType<CrmSyncPageState> = z.object({
  runId: z.string(),
  bindingId: z.string(),
  cursor: z.string(),
  pages: z.number().int().nonnegative(),
  rowsCreated: z.number().int().nonnegative(),
  rowsUpdated: z.number().int().nonnegative(),
  rowsSkipped: z.number().int().nonnegative(),
  remainingRowBudget: z.number().int().nonnegative(),
  plan: z.object({
    cap: z.number().int().positive(),
    activeCols: z.array(
      z.object({
        attrSlug: z.string(),
        attrType: z.string(),
        columnId: z.string(),
        title: z.string(),
      }),
    ),
    activeFilters: z.array(
      z.object({
        attrSlug: z.string(),
        attrType: z.enum(SUPPORTED_ATTR_TYPES),
        op: z.enum(FILTER_OPS),
        value: z.string(),
      }),
    ),
    pullAttrs: z.array(z.object({ slug: z.string(), type: z.string() })),
    fieldsDropped: z.array(z.string()),
  }),
  members: z.array(z.tuple([z.string(), z.string()])).nullable(),
});

const crmBindingEventSchema = z.object({
  bindingId: z.string().min(1),
  workspaceId: z.string().min(1),
  checkpoint: crmCheckpointSchema.optional(),
  trigger: z.enum(["cron", "manual", "warmup"]).optional(),
  warmupAttempt: z.number().int().nonnegative().optional(),
});

/** Build a per-run Effect runtime (no member identity) and run one program. */
async function withRuntime<A>(run: (exec: <X>(e: Effect.Effect<X, unknown, AppServices>) => Promise<X>) => Promise<A>): Promise<A> {
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    return await run((e) => runtime.runPromise(e));
  } finally {
    await runtime.dispose();
  }
}

// ── Pure helpers (unit-pinned) ─────────────────────────────────────────────────

/**
 * Map the Inngest event that woke {@link processCrmBinding} / {@link warmUpCrmBinding}
 * to the page worker trigger. `sync-now` is a user's manual "Sync now";
 * `binding.created` is the post-create warm-up; everything else (the daily
 * `binding.due` fan-out) is the cron. Total + pure so the mapping is unit-pinned.
 */
export function crmSyncTrigger(eventName: string): "cron" | "manual" | "warmup" {
  if (eventName === "crm/binding.sync-now") return "manual";
  if (eventName === "crm/binding.created") return "warmup";
  return "cron";
}

/**
 * Map a sync outcome status to the terminal analytics event. `ok` completed;
 * `partial`/`warn` both landed data but degraded (schema drift, row cap, page
 * budget), so both report `crm_sync_partial`; `failed` never landed. Pure so the
 * status→event mapping is unit-pinned independent of PostHog wiring.
 */
export function crmTerminalEvent(
  status: CrmSyncOutcome["status"],
): "crm_sync_completed" | "crm_sync_partial" | "crm_sync_failed" {
  switch (status) {
    case "ok":
      return "crm_sync_completed";
    case "partial":
    case "warn":
      return "crm_sync_partial";
    case "failed":
      return "crm_sync_failed";
  }
}

/**
 * Build the `crm/row.inserted` events to enrich each row a sync just inserted —
 * one per row, idempotent by rowId (dedupes a replayed enqueue), handled by
 * {@link enrichCrmRow}. Gives synced rows the same dependency-ordered function
 * cascade webhook rows get. Empty when nothing was inserted (caller skips the
 * sendEvent). Only new rows carry ids in each page result, so updated rows are
 * not re-enriched here (their function columns already ran on first insert).
 */
export function crmEnrichEvents(outcome: {
  readonly newRowIds: readonly string[];
  readonly tableId: string;
  readonly workspaceId: string;
}): Array<{ name: "crm/row.inserted"; data: { tableId: string; workspaceId: string; rowId: string }; id: string }> {
  const { newRowIds, tableId, workspaceId } = outcome;
  if (newRowIds.length === 0 || !tableId || !workspaceId) return [];
  return newRowIds.map((rowId) => ({
    name: "crm/row.inserted" as const,
    data: { tableId, workspaceId, rowId },
    id: `crm-enrich:${rowId}`,
  }));
}

export function crmContinuationEvent(args: {
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly checkpoint: CrmSyncPageState;
  readonly trigger: "cron" | "manual" | "warmup";
  readonly warmupAttempt?: number;
}) {
  return {
    id: `crm-page:${args.checkpoint.runId}:${args.checkpoint.pages}`,
    name: "crm/binding.page" as const,
    data: {
      bindingId: args.bindingId,
      workspaceId: args.workspaceId,
      checkpoint: args.checkpoint,
      trigger: args.trigger,
      ...(args.warmupAttempt === undefined ? {} : { warmupAttempt: args.warmupAttempt }),
    },
  };
}

/**
 * Capture the per-run PostHog events for one sync outcome: a `crm_sync_started`
 * marker plus the terminal `completed`/`partial`/`failed` event, both keyed by
 * the real `sync_run_id` (only known after the run). Server-side, workspace-grouped,
 * exactly like the webhook worker's `column_run_failed`. No-ops when PostHog is
 * unconfigured. Fire-and-forget (the client flushes each event immediately).
 */
function captureCrmSync(outcome: CrmSyncOutcome, trigger: "cron" | "manual" | "warmup"): void {
  const base = {
    provider: outcome.provider,
    binding_id: outcome.bindingId,
    sync_run_id: outcome.runId,
    trigger,
    workspace_id: outcome.workspaceId,
  };
  const opts = { distinctId: outcome.workspaceId, groups: { workspace: outcome.workspaceId } };
  captureServer("crm_sync_started", { ...opts, properties: base });
  switch (crmTerminalEvent(outcome.status)) {
    case "crm_sync_completed":
      captureServer("crm_sync_completed", {
        ...opts,
        properties: {
          ...base,
          rows_created: outcome.rowsCreated,
          rows_updated: outcome.rowsUpdated,
          rows_skipped: outcome.rowsSkipped,
          rows_staled: outcome.rowsStaled,
        },
      });
      break;
    case "crm_sync_partial":
      captureServer("crm_sync_partial", {
        ...opts,
        properties: {
          ...base,
          rows_created: outcome.rowsCreated,
          rows_updated: outcome.rowsUpdated,
          fields_dropped: outcome.fieldsDropped.length,
          error_tag: outcome.errorTag,
        },
      });
      break;
    case "crm_sync_failed":
      captureServer("crm_sync_failed", { ...opts, properties: { ...base, error_tag: outcome.errorTag } });
      break;
  }
}

/** Run one provider page; an Effect failure surfaces as a step failure (Inngest retries). */
function runSyncPageStep(
  bindingId: string,
  trigger: "cron" | "manual" | "warmup",
  checkpoint: CrmSyncPageState | null,
): Promise<CrmSyncPageResult> {
  return withRuntime((exec) =>
    exec(
      Effect.gen(function* () {
        const svc = yield* CrmSyncService;
        return yield* svc.syncPageForWorker(bindingId, trigger, checkpoint);
      }),
    ),
  );
}

// ── Functions ──────────────────────────────────────────────────────────────────

/** Cron (daily 09:00 UTC): enumerate due bindings and fan out one event each. */
export const pollCrmSync = inngest.createFunction(
  { id: "poll-crm-sync", retries: 1, triggers: [{ cron: "0 9 * * *" }], onFailure },
  async ({ step }) => {
    // Collect DUE bindings via SQL keyset pagination — the due predicate (enabled
    // + daily + not paused + lastSyncedAt null-or-≥20h-old) runs in the DB with a
    // LIMIT per page, so we never load + JS-filter the whole enabled population.
    // `now` is captured ONCE so paging is consistent.
    const due = await step.run("collect-due", () =>
      withRuntime(async (exec) => {
        const now = Date.now();
        const out: { bindingId: string; workspaceId: string }[] = [];
        let cursor: { readonly createdAt: number; readonly id: string } | null = null;
        // Bound the work per cron tick: at most a fixed number of pages, so a
        // pathological backlog can't make one tick run unbounded (the next daily
        // tick resumes — bindings stay marked due until synced).
        for (let page = 0; page < 200; page += 1) {
          const result: {
            items: ReadonlyArray<{ id: string; workspaceId: string; createdAt: number }>;
            nextCursor: { readonly createdAt: number; readonly id: string } | null;
          } = await exec(
            Effect.gen(function* () {
              const svc = yield* CrmSyncService;
              return yield* svc.listDuePage({ now, limit: DUE_PAGE_SIZE, cursor });
            }),
          );
          for (const b of result.items) out.push({ bindingId: b.id, workspaceId: b.workspaceId });
          if (result.nextCursor === null) break;
          cursor = result.nextCursor;
        }
        return out;
      }),
    );

    if (due.length === 0) return { due: 0 };

    // Chunk the fan-out into bounded batches across separate steps, rather than
    // one giant sendEvent array — keeps each enqueue payload small and lets the
    // per-binding function's global concurrency cap pace the actual pulls.
    let chunks = 0;
    for (let i = 0; i < due.length; i += FANOUT_CHUNK) {
      const batch = due.slice(i, i + FANOUT_CHUNK);
      await step.sendEvent(
        `fan-out-bindings-${i}`,
        batch.map((d) => ({ name: "crm/binding.due", data: d })),
      );
      chunks += 1;
    }
    return { due: due.length, chunks };
  },
);

/** Front-loaded retry schedule for newly created, still-empty bindings. */
const WARM_UP_BACKOFF_S = [15, 15, 30, 30, 60, 60, 60, 60, 60, 60] as const;

/**
 * Per-binding sync, fanned out from the cron OR triggered by a manual "Sync now"
 * (`crm/binding.sync-now`). Each provider page is a separate durable step.
 * Two-tier concurrency: a GLOBAL account-scoped cap
 * bounds total in-flight syncs across ALL workspaces (per-workspace limits
 * otherwise multiply unbounded as workspaces grow), while the per-workspace key
 * keeps any single workspace from monopolising runs. `syncPageForWorker` never throws
 * for sync-level errors (the outcome carries the status + user copy) — an Effect
 * failure here means a disabled/paused binding or a bookkeeping failure, which we
 * let surface as a step failure so Inngest retries.
 */
export const processCrmBinding = inngest.createFunction(
  {
    id: "process-crm-binding",
    concurrency: [
      // Account-scoped limits REQUIRE a key (Inngest rejects the whole app sync
      // without one). A constant key makes one shared account-wide pool.
      { scope: "account", key: '"crm-sync"', limit: 50 },
      { key: "event.data.workspaceId", limit: 2 },
    ],
    retries: 2,
    onFailure,
    triggers: [
      { event: "crm/binding.due" },
      { event: "crm/binding.sync-now" },
      { event: "crm/binding.page" },
    ],
  },
  async ({ event, step }) => {
    const data = crmBindingEventSchema.parse(event.data);
    if (event.name === "crm/binding.page" && data.checkpoint === undefined) {
      throw new Error("CRM continuation event is missing its checkpoint");
    }
    const checkpoint = event.name === "crm/binding.page" ? (data.checkpoint ?? null) : null;
    const trigger = event.name === "crm/binding.page"
      ? (data.trigger ?? "cron")
      : crmSyncTrigger(event.name);
    const pageNumber = checkpoint?.pages ?? 0;
    const page = await step.run(`sync:${data.bindingId}:page:${pageNumber}`, () =>
      runSyncPageStep(data.bindingId, trigger, checkpoint),
    );
    const pageEnrichEvents = crmEnrichEvents(page);
    if (pageEnrichEvents.length > 0) {
      await step.sendEvent(`enqueue-crm-enrich:${pageNumber}`, pageEnrichEvents);
    }

    if (page.next !== null) {
      await step.sendEvent(
        `continue:${page.next.runId}:${page.next.pages}`,
        crmContinuationEvent({
          bindingId: data.bindingId,
          workspaceId: data.workspaceId,
          checkpoint: page.next,
          trigger,
          ...(data.warmupAttempt === undefined ? {} : { warmupAttempt: data.warmupAttempt }),
        }),
      );
      return { bindingId: data.bindingId, status: "continuing", rowsCreated: page.next.rowsCreated };
    }
    const outcome = page.outcome;
    if (outcome === null) throw new Error("CRM sync page returned neither an outcome nor a checkpoint");
    if (outcome.runId === "") {
      // Overlap guard fired (a run for this binding is already in flight) —
      // nothing synced, so no analytics/realtime/enrichment.
      return { bindingId: data.bindingId, status: "skipped", rowsCreated: 0, rowsUpdated: 0 };
    }

    // Each side effect is its own durable step so a retry re-runs only what did
    // not complete (analytics fire once, realtime once, enrichment once).
    await step.run(`analytics:${data.bindingId}:${outcome.runId}`, async () => {
      captureCrmSync(outcome, trigger);
      return null;
    });
    if (
      trigger === "warmup" &&
      outcome.rowsCreated === 0 &&
      (data.warmupAttempt ?? 0) + 1 < WARM_UP_BACKOFF_S.length
    ) {
      const nextAttempt = (data.warmupAttempt ?? 0) + 1;
      await step.sendEvent(`warm-up-retry:${data.bindingId}:${nextAttempt}`, {
        name: "crm/binding.warmup",
        data: {
          bindingId: data.bindingId,
          workspaceId: data.workspaceId,
          warmupAttempt: nextAttempt,
        },
      });
    }
    // Realtime is published from INSIDE CrmSyncService's page worker (row.insert
    // WITH cell values + cell.upsert on updates) — the worker no longer
    // publishes, which would duplicate rows with empty cells.
    return {
      bindingId: data.bindingId,
      status: outcome.status,
      rowsCreated: outcome.rowsCreated,
      rowsUpdated: outcome.rowsUpdated,
    };
  },
);

/**
 * Backoff (seconds) between warm-up attempts — front-loaded because a fresh CRM
 * pull can take a moment to page + flatten, with a longer tail for large sources.
 * Total window ≈ 8 minutes across 10 attempts.
 */
/**
 * Post-create warm-up: front-load the FIRST sync so a newly created binding shows
 * rows in seconds instead of waiting for the daily cron. Triggered by the
 * `crm/binding.created` event the tRPC `create` mutation emits, it retries the
 * pull on a front-loaded backoff until the first data lands (a binding whose
 * `lastSyncedAt` is still null stays due), mirroring {@link warmUpSignalBinding}.
 *
 * Each attempt IS a real sync run (its own `sync_run_id` + `crm_sync_runs` row),
 * so analytics fire per attempt with the `warmup` trigger. Stops on the first
 * attempt that lands rows (publishing realtime + enqueuing enrichment then), or
 * on exhausting the backoff — at which point the daily cron's still-due predicate
 * takes over. An Effect failure (disabled binding, bookkeeping) fails the step
 * and Inngest retries.
 */
export const warmUpCrmBinding = inngest.createFunction(
  {
    id: "warm-up-crm-binding",
    concurrency: [
      // Same shared account-wide pool as processCrmBinding — mass binding
      // creation must not fan warm-up pulls out unbounded.
      { scope: "account", key: '"crm-sync"', limit: 50 },
      { key: "event.data.workspaceId", limit: 2 },
    ],
    retries: 1,
    onFailure,
    triggers: [{ event: "crm/binding.created" }, { event: "crm/binding.warmup" }],
  },
  async ({ event, step }) => {
    const data = crmBindingEventSchema.parse(event.data);
    const attempt = data.warmupAttempt ?? 0;
    if (attempt >= WARM_UP_BACKOFF_S.length) {
      return { bindingId: data.bindingId, rowsCreated: 0, attempts: attempt };
    }
    await step.sleep(`backoff-${attempt}`, `${WARM_UP_BACKOFF_S[attempt]}s`);
    const page = await step.run(`warm-up:${data.bindingId}:${attempt}:page:0`, () =>
      runSyncPageStep(data.bindingId, "warmup", null),
    );
    const pageEnrichEvents = crmEnrichEvents(page);
    if (pageEnrichEvents.length > 0) {
      await step.sendEvent(`warm-up-enrich:${data.bindingId}:${attempt}`, pageEnrichEvents);
    }
    if (page.next !== null) {
      await step.sendEvent(
        `warm-up-continue:${page.next.runId}:${page.next.pages}`,
        crmContinuationEvent({
          bindingId: data.bindingId,
          workspaceId: data.workspaceId,
          checkpoint: page.next,
          trigger: "warmup",
          warmupAttempt: attempt,
        }),
      );
      return { bindingId: data.bindingId, rowsCreated: page.next.rowsCreated, attempts: attempt + 1 };
    }
    const outcome = page.outcome;
    if (outcome === null) throw new Error("CRM warm-up page returned neither an outcome nor a checkpoint");
    if (outcome.runId !== "") {
      await step.run(`warm-up-analytics:${data.bindingId}:${attempt}`, async () => {
        captureCrmSync(outcome, "warmup");
        return null;
      });
    }
    if (outcome.runId === "" || outcome.rowsCreated === 0) {
      const nextAttempt = attempt + 1;
      if (nextAttempt < WARM_UP_BACKOFF_S.length) {
        await step.sendEvent(`warm-up-retry:${data.bindingId}:${nextAttempt}`, {
          name: "crm/binding.warmup",
          data: {
            bindingId: data.bindingId,
            workspaceId: data.workspaceId,
            warmupAttempt: nextAttempt,
          },
        });
      }
    }
    return { bindingId: data.bindingId, rowsCreated: outcome.rowsCreated, attempts: attempt + 1 };
  },
);

/**
 * Enrich one CRM-inserted row: run its table's function columns in `{{ref}}`
 * dependency order (the SAME cascade as the webhook + signal enrichers, reusing
 * {@link enrichRowInDepOrder}), each in its own durable step so a mid-cascade
 * failure retries only the remaining columns.
 */
export const enrichCrmRow = inngest.createFunction(
  {
    id: "enrich-crm-row",
    concurrency: [
      { scope: "account", key: '"crm-enrich"', limit: 50 },
      { key: "event.data.workspaceId", limit: 4 },
    ],
    retries: 2,
    onFailure,
    triggers: [{ event: "crm/row.inserted" }],
  },
  async ({ event, step }) => {
    const d = event.data as { tableId?: string; workspaceId?: string; rowId?: string };
    if (!d.tableId || !d.workspaceId || !d.rowId) return { enriched: false as const };
    const ran = await enrichRowInDepOrder(toStepRunner(step), {
      tableId: d.tableId,
      workspaceId: d.workspaceId,
      rowId: d.rowId,
      keyPrefix: `crm:${d.rowId}`,
    });
    return { rowId: d.rowId, enriched: true as const, ran };
  },
);
