/**
 * Scheduled Social Signals poller (cloud-only). The desktop has no cron; the
 * recurring pull lives here:
 *
 *   - {@link pollTrigifySignals} runs on a cron, collects the bindings whose
 *     schedule is DUE via SQL keyset pagination (the due predicate runs in the
 *     DB), and fans them out in bounded chunks (~{@link FANOUT_CHUNK}/event).
 *   - {@link processSignalBinding} handles each event (per-workspace concurrency)
 *     by running `SignalService.syncForWorker` — fetch Trigify results, map, and
 *     insert new rows/cells. Membership-free: this runs server-side, gated by the
 *     Inngest signing key, exactly like the webhook worker.
 *
 * `runtime = "nodejs"` for the Effect runtime + credential decrypt (node:crypto).
 */

import { type AppServices, appLayer, DUE_PAGE_SIZE, FANOUT_CHUNK, type SignalDueCursor, SignalService } from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import { inngest } from "../client";

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

/** Cron: enumerate due bindings and fan out one event each. Adjust cadence as needed. */
export const pollTrigifySignals = inngest.createFunction(
  // hourly; the per-binding schedule (hourly/daily/weekly) gates actual pulls
  { id: "poll-trigify-signals", retries: 1, triggers: [{ cron: "0 * * * *" }] },
  async ({ step }) => {
    // Collect DUE bindings via SQL keyset pagination — the due predicate runs in
    // the DB with a LIMIT per page, so we never load + JS-filter the whole
    // enabled population. The `now` is captured ONCE so paging is consistent.
    const due = await step.run("collect-due", () =>
      withRuntime(async (exec) => {
        const now = Date.now();
        const out: { bindingId: string; workspaceId: string }[] = [];
        let cursor: SignalDueCursor | null = null;
        // Bound the work per cron tick: at most a fixed number of pages, so a
        // pathological backlog can't make one tick run unbounded (the next tick
        // resumes — bindings stay marked due until synced).
        for (let page = 0; page < 200; page += 1) {
          const result: { items: ReadonlyArray<{ id: string; workspaceId: string; createdAt: number }>; nextCursor: SignalDueCursor | null } =
            await exec(
              Effect.gen(function* () {
                const svc = yield* SignalService;
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
        batch.map((d) => ({ name: "signals/binding.due", data: d })),
      );
      chunks += 1;
    }
    return { due: due.length, chunks };
  },
);

/**
 * Per-binding sync, fanned out from the cron. Two-tier concurrency: a GLOBAL
 * account-scoped cap bounds total in-flight syncs across ALL workspaces
 * (per-workspace limits otherwise multiply unbounded as workspaces grow), while
 * the per-workspace key still keeps any single workspace from monopolising runs.
 */
export const processSignalBinding = inngest.createFunction(
  {
    id: "process-signal-binding",
    concurrency: [
      // Account-scoped limits REQUIRE a key (Inngest rejects the whole app sync
      // without one — "A concurrency key must be specified for Account scoped
      // limits", which left prod functions unregistered). A constant key makes
      // one shared account-wide pool for this function's runs.
      { scope: "account", key: '"signals-sync"', limit: 50 },
      { key: "event.data.workspaceId", limit: 2 },
    ],
    retries: 2,
    triggers: [{ event: "signals/binding.due" }],
  },
  async ({ event, step }) => {
    const bindingId = (event.data as { bindingId?: string }).bindingId ?? "";
    if (!bindingId) return { bindingId, added: 0, error: null };
    const result = await step.run(`sync:${bindingId}`, () =>
      withRuntime((exec) =>
        exec(
          Effect.gen(function* () {
            const svc = yield* SignalService;
            const added = yield* svc.syncForWorker(bindingId);
            return { added, error: null as string | null };
          }).pipe(
            // Isolate per-binding failures so one bad binding can't abort the
            // batch — but make them VISIBLE (log + surface in the step output)
            // rather than silently reporting success. The error tag/message never
            // contains the API key (it lives only in the request header).
            Effect.catchAll((e) => {
              const tag = (e as { _tag?: string })?._tag ?? "Error";
              const message = (e as { message?: string })?.message ?? String(e);
              console.error(`[signals] binding ${bindingId} sync failed: ${tag}: ${message}`);
              return Effect.succeed({ added: 0, error: `${tag}: ${message}` });
            }),
          ),
        ),
      ),
    );
    return { bindingId, ...result };
  },
);

/**
 * Backoff (seconds) between warm-up attempts — front-loaded because Trigify
 * searches usually start returning within ~15-60s of creation, with a longer
 * tail for slow scrapes. Total window ≈ 8 minutes across 10 attempts.
 */
const WARM_UP_BACKOFF_S = [15, 15, 30, 30, 60, 60, 60, 60, 60, 60] as const;

/**
 * Post-create warm-up: a fresh Trigify search returns 0 results for the first
 * ~10-30s (it's still scraping), so the create-time pull almost always seeds
 * nothing. This durable function — triggered by the `signals/binding.created`
 * event the tRPC `createSignalBinding` mutation emits — retries the pull on a
 * front-loaded backoff until the FIRST data lands, mirroring the local
 * sidecar's `warmUpBinding` (30 × 12s in-process retries). Without it a cloud
 * binding waited for the hourly cron at best (and a full schedule interval at
 * worst) before showing any rows.
 *
 * Stops on: first `added > 0`, or exhausting the backoff — at which point the
 * cron's always-due-while-empty predicate takes over. A failed attempt (bad
 * credential, Trigify 5xx, deleted binding) logs and keeps trying; the sync
 * already records `binding.lastError` for the UI.
 */
export const warmUpSignalBinding = inngest.createFunction(
  {
    id: "warm-up-signal-binding",
    concurrency: [{ key: "event.data.workspaceId", limit: 2 }],
    retries: 1,
    triggers: [{ event: "signals/binding.created" }],
  },
  async ({ event, step }) => {
    const bindingId = (event.data as { bindingId?: string }).bindingId ?? "";
    if (!bindingId) return { bindingId, added: 0, attempts: 0 };

    for (let attempt = 0; attempt < WARM_UP_BACKOFF_S.length; attempt += 1) {
      await step.sleep(`backoff-${attempt}`, `${WARM_UP_BACKOFF_S[attempt]}s`);
      const result = await step.run(`warm-up:${bindingId}:${attempt}`, () =>
        withRuntime((exec) =>
          exec(
            Effect.gen(function* () {
              const svc = yield* SignalService;
              const added = yield* svc.syncForWorker(bindingId);
              return { added, error: null as string | null };
            }).pipe(
              Effect.catchAll((e) => {
                const tag = (e as { _tag?: string })?._tag ?? "Error";
                const message = (e as { message?: string })?.message ?? String(e);
                console.error(`[signals] warm-up ${bindingId} attempt ${attempt} failed: ${tag}: ${message}`);
                return Effect.succeed({ added: 0, error: `${tag}: ${message}` });
              }),
            ),
          ),
        ),
      );
      if (result.added > 0) {
        return { bindingId, added: result.added, attempts: attempt + 1 };
      }
    }
    // Exhausted: leave it to the hourly cron (still-empty bindings stay due).
    return { bindingId, added: 0, attempts: WARM_UP_BACKOFF_S.length };
  },
);
