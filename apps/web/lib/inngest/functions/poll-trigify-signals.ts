/**
 * Scheduled Social Signals poller (cloud-only). The desktop has no cron; the
 * recurring pull lives here:
 *
 *   - {@link pollTrigifySignals} runs on a cron, lists every enabled binding,
 *     keeps the ones whose schedule is DUE, and fans out one event per binding.
 *   - {@link processSignalBinding} handles each event (per-workspace concurrency)
 *     by running `SignalService.syncForWorker` — fetch Trigify results, map, and
 *     insert new rows/cells. Membership-free: this runs server-side, gated by the
 *     Inngest signing key, exactly like the webhook worker.
 *
 * `runtime = "nodejs"` for the Effect runtime + credential decrypt (node:crypto).
 */

import { type AppServices, appLayer, isBindingDue, SignalService } from "@gtmgrid/services";
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
    const due = await step.run("list-due", () =>
      withRuntime(async (exec) => {
        const bindings = await exec(
          Effect.gen(function* () {
            const svc = yield* SignalService;
            return yield* svc.listAllEnabled();
          }),
        );
        const now = Date.now();
        return bindings
          .filter((b) => isBindingDue({ enabled: b.enabled, schedule: b.schedule as never, lastSyncedAt: b.lastSyncedAt }, now))
          .map((b) => ({ bindingId: b.id, workspaceId: b.workspaceId }));
      }),
    );

    if (due.length === 0) return { due: 0 };
    await step.sendEvent(
      "fan-out-bindings",
      due.map((d) => ({ name: "signals/binding.due", data: d })),
    );
    return { due: due.length };
  },
);

/** Per-binding sync, fanned out from the cron. Per-workspace concurrency. */
export const processSignalBinding = inngest.createFunction(
  {
    id: "process-signal-binding",
    concurrency: { key: "event.data.workspaceId", limit: 2 },
    retries: 2,
    triggers: [{ event: "signals/binding.due" }],
  },
  async ({ event, step }) => {
    const bindingId = (event.data as { bindingId?: string }).bindingId ?? "";
    if (!bindingId) return { bindingId, added: 0 };
    const added = await step.run(`sync:${bindingId}`, () =>
      withRuntime((exec) =>
        exec(
          Effect.gen(function* () {
            const svc = yield* SignalService;
            return yield* svc.syncForWorker(bindingId);
          }).pipe(Effect.catchAll(() => Effect.succeed(0))),
        ),
      ),
    );
    return { bindingId, added };
  },
);
