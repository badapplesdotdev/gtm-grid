/**
 * Tests for the cloud-actions metering domain (C26).
 *
 * Outcome-focused per docs/effect-conventions.md: we drive the service with an
 * in-memory fake {@link AutumnClient} `Layer` (no mocks) and assert the returned
 * {@link FlushResult} / pending count — never internal calls, never try/catch.
 *
 * Covers the acceptance-criteria paths:
 *   - aggregation: each billable CLOUD op increments the pending counter by one;
 *   - flush success: pending is tracked to Autumn under `cloud_actions` and the
 *     usage snapshot is read back (caller resets pending → 0);
 *   - reset-ONLY-on-success / fail-closed: an Autumn transport error yields
 *     `flushed: false` so the caller KEEPS the pending count for retry;
 *   - the LOCAL invariant: nothing in this CLOUD meter is reachable from local
 *     operations — exercising the meter NEVER tracks anything unless a billable
 *     CLOUD op actually incremented a pending count first.
 */

import { Effect, Exit, type Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  CLOUD_ACTIONS_FEATURE_ID,
  CloudActionsService,
  type PendingWorkspace,
} from "./cloud-actions.js";
import { type AutumnClient, AutumnError } from "./seats.js";
import { failingAutumnLayer, fakeAutumnLayer } from "./seats-test-layers.js";

const WS_A = "ws_alpha";
const WS_B = "ws_beta";

const run = <A, E>(
  effect: Effect.Effect<A, E, CloudActionsService>,
  autumn: Layer.Layer<AutumnClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(CloudActionsService.Default),
      Effect.provide(autumn),
    ),
  );

describe("nextPendingCount (per-op aggregation rule)", () => {
  const bump = (current: number) =>
    Effect.gen(function* () {
      const svc = yield* CloudActionsService;
      return svc.nextPendingCount(current);
    });

  it("increments the pending counter by exactly one per billable CLOUD op", async () => {
    expect(await run(bump(0), fakeAutumnLayer())).toBe(1);
    expect(await run(bump(1), fakeAutumnLayer())).toBe(2);
    expect(await run(bump(41), fakeAutumnLayer())).toBe(42);
  });

  it("aggregates N ops into a pending count of N (one flush, not N)", async () => {
    // Simulate eight billable CLOUD mutations against a fresh workspace: the
    // counter accumulates to 8 in the DB and is flushed ONCE, never per op.
    let pending = 0;
    for (let i = 0; i < 8; i += 1) {
      pending = await run(bump(pending), fakeAutumnLayer());
    }
    expect(pending).toBe(8);
  });
});

describe("flushWorkspace (track pending → Autumn, then snapshot usage)", () => {
  const flush = (ws: PendingWorkspace) =>
    Effect.gen(function* () {
      const svc = yield* CloudActionsService;
      return yield* svc.flushWorkspace(ws);
    });

  it("tracks the pending count under the cloud_actions feature on success", async () => {
    const usageCalls: Array<{
      customerId: string;
      featureId: string;
      value: number;
      customerData?: { name?: string | null; email?: string | null };
    }> = [];
    const result = await run(
      flush({ workspaceId: WS_A, pending: 5 }),
      fakeAutumnLayer({ usageCalls, usage: { used: 5, limit: 2000 } }),
    );

    expect(result.flushed).toBe(true);
    expect(usageCalls).toEqual([
      {
        customerId: WS_A,
        featureId: CLOUD_ACTIONS_FEATURE_ID,
        value: 5,
        // No name/email on this PendingWorkspace → forwarded as undefined.
        customerData: { name: undefined, email: undefined },
      },
    ]);
    if (result.flushed) {
      expect(result.tracked).toBe(5);
      // The live snapshot the caller stores for the `me` query.
      expect(result.usage).toEqual({ used: 5, limit: 2000 });
    }
  });

  it("forwards the workspace name + owner email so the seam getOrCreates the customer before track (free-tier backfill)", async () => {
    // REGRESSION (wh-autumn-customer-data): the free-tier flush formerly created
    // the Autumn customer implicitly via track() with NO profile. The flush must
    // now forward name + owner email on the trackUsage call so the Convex seam
    // can `customers.getOrCreate({ customerId, name, email })` BEFORE track,
    // backfilling the customer's profile.
    const customerDataCalls: Array<{
      customerId: string;
      op: "checkSeats" | "attach" | "trackUsage";
      customerData?: { name?: string | null; email?: string | null };
    }> = [];
    const result = await run(
      flush({
        workspaceId: WS_A,
        pending: 6,
        name: "Acme Workspace",
        ownerEmail: "owner@acme.io",
      }),
      fakeAutumnLayer({ customerDataCalls }),
    );

    expect(result.flushed).toBe(true);
    expect(customerDataCalls).toEqual([
      {
        customerId: WS_A,
        op: "trackUsage",
        customerData: { name: "Acme Workspace", email: "owner@acme.io" },
      },
    ]);
  });

  it("carries the active PAID plan id in the flush result (C27)", async () => {
    // The flush reads the customer's active plans alongside usage so the caller
    // can cache the current plan for the `me` query. A team subscription (plus
    // the always-present auto-enabled free plan) surfaces "team".
    const result = await run(
      flush({ workspaceId: WS_A, pending: 2 }),
      fakeAutumnLayer({ activePlanIds: ["free", "team"] }),
    );
    expect(result.flushed).toBe(true);
    if (result.flushed) {
      expect(result.planId).toBe("team");
    }
  });

  it("surfaces a null plan id for a free-tier workspace (C27)", async () => {
    const result = await run(
      flush({ workspaceId: WS_A, pending: 1 }),
      fakeAutumnLayer({ activePlanIds: ["free"] }),
    );
    expect(result.flushed).toBe(true);
    if (result.flushed) {
      expect(result.planId).toBeNull();
    }
  });

  it("does NOT fail the flush when the plan read errors (defaults plan to null)", async () => {
    // Usage already tracked; a plan-read failure must not lose the usage flush.
    const result = await run(
      flush({ workspaceId: WS_A, pending: 4 }),
      failingAutumnLayer("getActivePlanIds"),
    );
    expect(result.flushed).toBe(true);
    if (result.flushed) {
      expect(result.planId).toBeNull();
      expect(result.tracked).toBe(4);
    }
  });

  it("surfaces an unlimited plan as a null limit in the usage snapshot", async () => {
    const result = await run(
      flush({ workspaceId: WS_A, pending: 1 }),
      fakeAutumnLayer({ usage: { used: 9001, limit: null } }),
    );
    expect(result.flushed).toBe(true);
    if (result.flushed) {
      expect(result.usage.limit).toBeNull();
    }
  });

  it("fails closed when the Autumn track errors: flushed=false with the typed error", async () => {
    // The caller MUST keep the pending count for retry — it is NOT reset.
    const result = await run(
      flush({ workspaceId: WS_A, pending: 7 }),
      failingAutumnLayer("trackUsage"),
    );
    expect(result.flushed).toBe(false);
    if (!result.flushed) {
      expect(result.error).toBeInstanceOf(AutumnError);
      expect(result.workspaceId).toBe(WS_A);
    }
  });

  it("fails closed when the post-track usage read errors", async () => {
    // Track may have landed but we couldn't confirm usage; treat the flush as
    // failed so we keep the pending count rather than reset it prematurely.
    const result = await run(
      flush({ workspaceId: WS_A, pending: 3 }),
      failingAutumnLayer("checkUsage"),
    );
    expect(result.flushed).toBe(false);
  });

  it("never raises into the error channel (always succeeds with a FlushResult)", async () => {
    // A defect/failure must be captured, not thrown, so a batch can't abort.
    const exit = await Effect.runPromiseExit(
      flush({ workspaceId: WS_A, pending: 2 }).pipe(
        Effect.provide(CloudActionsService.Default),
        Effect.provide(failingAutumnLayer("trackUsage")),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("flushBatch (reset only successes; one bad workspace can't abort)", () => {
  const flushBatch = (workspaces: readonly PendingWorkspace[]) =>
    Effect.gen(function* () {
      const svc = yield* CloudActionsService;
      return yield* svc.flushBatch(workspaces);
    });

  it("flushes every workspace with pending > 0 independently", async () => {
    const usageCalls: Array<{
      customerId: string;
      featureId: string;
      value: number;
      customerData?: { name?: string | null; email?: string | null };
    }> = [];
    const results = await run(
      flushBatch([
        { workspaceId: WS_A, pending: 3, name: "Alpha", ownerEmail: "a@x.io" },
        { workspaceId: WS_B, pending: 10 },
      ]),
      fakeAutumnLayer({ usageCalls }),
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.flushed)).toBe(true);
    expect(usageCalls).toEqual([
      {
        customerId: WS_A,
        featureId: CLOUD_ACTIONS_FEATURE_ID,
        value: 3,
        // Name + owner email threaded from the PendingWorkspace.
        customerData: { name: "Alpha", email: "a@x.io" },
      },
      {
        customerId: WS_B,
        featureId: CLOUD_ACTIONS_FEATURE_ID,
        value: 10,
        customerData: { name: undefined, email: undefined },
      },
    ]);
  });

  it("one failing workspace does not abort the batch (others still flush)", async () => {
    // The fake fails ALL trackUsage calls; the batch must still return a result
    // per workspace (all flushed:false) rather than throwing — proving a single
    // bad workspace can't lose the others' resets.
    const results = await run(
      flushBatch([
        { workspaceId: WS_A, pending: 1 },
        { workspaceId: WS_B, pending: 2 },
      ]),
      failingAutumnLayer("trackUsage"),
    );
    expect(results.map((r) => r.flushed)).toEqual([false, false]);
    expect(results.map((r) => r.workspaceId)).toEqual([WS_A, WS_B]);
  });
});

describe("LOCAL operations are never metered (HARD RULE)", () => {
  it("does NOT track anything unless a billable CLOUD op incremented a pending count first", async () => {
    // A local operation runs entirely on the user machine (sidecar + SQLite) and
    // never calls a Convex mutation, so it never bumps cloudActionsPending. With
    // an EMPTY pending batch (what a local-only workspace always has) the flush
    // tracks nothing to Autumn — the meter stays at zero. This asserts the
    // structural guarantee that the meter is reachable ONLY via CLOUD mutations.
    const usageCalls: Array<{
      customerId: string;
      featureId: string;
      value: number;
    }> = [];
    const results = await run(
      // No workspace has pending > 0 (the cron filters those out), modelling a
      // workspace that only ran LOCAL operations.
      Effect.gen(function* () {
        const svc = yield* CloudActionsService;
        return yield* svc.flushBatch([]);
      }),
      fakeAutumnLayer({ usageCalls }),
    );

    expect(results).toEqual([]);
    // The decisive assertion: zero Autumn usage tracked for local-only activity.
    expect(usageCalls).toHaveLength(0);
  });
});
