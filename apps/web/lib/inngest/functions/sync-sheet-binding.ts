/**
 * Scheduled Google Sheets importer (cloud-only). The desktop has no cron; a
 * local project re-syncs on demand.
 *
 *   - {@link pollSheetBindings} runs hourly, collects the bindings whose schedule
 *     is DUE via SQL keyset pagination (the due predicate runs in the DB), and
 *     fans them out in bounded chunks.
 *   - {@link processSheetBinding} handles each event by running
 *     `SheetImportService.syncForWorker` — read the range, map rows, insert or
 *     update. Membership-free: gated by the Inngest signing key, exactly like the
 *     signals and webhook workers.
 *
 * PAUSED BINDINGS ARE EXCLUDED IN SQL, not skipped here. A binding whose grant
 * was revoked would otherwise be re-enqueued every hour forever — failing
 * identically each time, burning a worker slot and a Google call per tick, and
 * pushing the workspace toward its API quota for no possible benefit.
 *
 * `runtime = "nodejs"` for the Effect runtime + credential decrypt (node:crypto).
 */

import {
  type AppServices,
  appLayer,
  DUE_PAGE_SIZE,
  FANOUT_CHUNK,
  MAX_DUE_PAGES,
  type SheetDueCursor,
  SheetImportService,
} from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import { inngest } from "../client";
import { onFailure } from "../on-failure";
import { captureServerException } from "../../posthog-server";

/** Build a per-run Effect runtime (no member identity) and run one program. */
async function withRuntime<A>(
  run: (exec: <X>(e: Effect.Effect<X, unknown, AppServices>) => Promise<X>) => Promise<A>,
): Promise<A> {
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    return await run((e) => runtime.runPromise(e));
  } finally {
    await runtime.dispose();
  }
}

/** Cron: enumerate due bindings and fan out one event each. */
export const pollSheetBindings = inngest.createFunction(
  // Hourly; each binding's own schedule (hourly/daily/weekly) gates actual syncs.
  { id: "poll-sheet-bindings", retries: 1, triggers: [{ cron: "15 * * * *" }], onFailure },
  async ({ step }) => {
    const due = await step.run("collect-due", () =>
      withRuntime(async (exec) => {
        // `now` is captured ONCE so paging stays consistent across pages.
        const now = Date.now();
        const out: { bindingId: string; workspaceId: string }[] = [];
        let cursor: SheetDueCursor | null = null;
        // Paging normally ends on a null cursor; the cap only bites on a
        // pathological backlog. Bindings stay due, so the next tick resumes.
        for (let page = 0; page < MAX_DUE_PAGES; page += 1) {
          const result: {
            items: ReadonlyArray<{ id: string; workspaceId: string; createdAt: number }>;
            nextCursor: SheetDueCursor | null;
          } = await exec(
            Effect.gen(function* () {
              const svc = yield* SheetImportService;
              return yield* svc.listDueForWorker({ now, limit: DUE_PAGE_SIZE, cursor });
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

    let chunks = 0;
    for (let i = 0; i < due.length; i += FANOUT_CHUNK) {
      const batch = due.slice(i, i + FANOUT_CHUNK);
      await step.sendEvent(
        `fan-out-sheet-bindings-${i}`,
        batch.map((d) => ({ name: "sheets/binding.due", data: d })),
      );
      chunks += 1;
    }
    return { due: due.length, chunks };
  },
);

/**
 * Per-binding sync, fanned out from the cron.
 *
 * Two-tier concurrency, matching the signals worker: an account-scoped cap
 * bounds total in-flight syncs across ALL workspaces (per-workspace limits
 * multiply unbounded as workspaces grow), and a per-workspace key of 1 stops a
 * single workspace running two syncs at once — which matters more here than for
 * signals, because two concurrent syncs of the same binding would race on the
 * identity map and could double-insert rows.
 */
export const processSheetBinding = inngest.createFunction(
  {
    id: "process-sheet-binding",
    concurrency: [
      // An account-scoped limit REQUIRES a key, or Inngest rejects the whole app
      // sync and every function in it silently goes unregistered.
      { scope: "account", key: '"sheets-sync"', limit: 25 },
      { key: "event.data.workspaceId", limit: 1 },
    ],
    retries: 2,
    onFailure,
    triggers: [{ event: "sheets/binding.due" }],
  },
  async ({ event, step }) => {
    const bindingId = (event.data as { bindingId?: string }).bindingId ?? "";
    if (!bindingId) return { bindingId, rowsCreated: 0, rowsUpdated: 0, error: null };

    const result = await step.run(`sync:${bindingId}`, () =>
      withRuntime((exec) =>
        exec(
          Effect.gen(function* () {
            const svc = yield* SheetImportService;
            const r = yield* svc.syncForWorker(bindingId);
            return {
              rowsCreated: r.rowsCreated,
              rowsUpdated: r.rowsUpdated,
              truncated: r.truncated,
              error: null as string | null,
            };
          }).pipe(
            // Isolate per-binding failures so one bad binding can't abort the
            // batch — but make them VISIBLE rather than reporting a false success.
            // The user-facing explanation is already on the binding's `lastError`
            // (and `pausedReason` when it needs a human); this is for us.
            Effect.catchAll((e) => {
              const tag = (e as { _tag?: string })?._tag ?? "Error";
              const message = (e as { message?: string })?.message ?? String(e);
              console.error(`[sheets] binding ${bindingId} sync failed: ${tag}: ${message}`);
              captureServerException(e, {
                properties: { source: "sheets", phase: "sync", binding_id: bindingId, tag },
              });
              return Effect.succeed({
                rowsCreated: 0,
                rowsUpdated: 0,
                truncated: false,
                error: `${tag}: ${message}`,
              });
            }),
          ),
        ),
      ),
    );

    return { bindingId, ...result };
  },
);
