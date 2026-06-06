/**
 * CLOUD-actions meter increment for billable Convex mutations (C26).
 *
 * Convex mutations CANNOT make outbound HTTP, so a billable CLOUD operation
 * cannot call Autumn directly. Instead it does a cheap DB increment of the
 * per-workspace pending counter (`workspaces.cloudActionsPending`) via
 * {@link meterCloudAction}; a scheduled internal ACTION (convex/usage.ts) later
 * batch-flushes those pending counts to Autumn.
 *
 * The "+1 per billable op" rule itself is the unit-tested pure
 * `CloudActionsService.nextPendingCount` (@gtmgrid/cloud); this helper runs that
 * service (no Autumn call, so it runs in the mutation runtime via a stub
 * AutumnClient layer) and wraps it in the ctx-backed DB read-modify-write.
 *
 * HARD RULE — LOCAL is NEVER metered: this runs ONLY inside Convex mutations,
 * which ONLY cloud projects call. LOCAL projects run on the user machine
 * (sidecar + local SQLite, packages/server + packages/engine) and never reach a
 * Convex mutation, so they can never increment this counter. Local is unlimited
 * and unmetered on EVERY tier (free included). Do NOT add any metering to the
 * local sidecar routes or the local engine.
 */

import { AutumnClient, CloudActionsService } from "@gtmgrid/cloud";
import { Effect, Layer } from "effect";
import type { Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";

/**
 * A {@link CloudActionsService} layer whose AutumnClient is a stub that DIES if
 * called. The `nextPendingCount` rule is pure (no Autumn), so this lets the
 * service run inside a MUTATION — which must make no outbound HTTP — while the
 * stub guarantees no Autumn call sneaks into the mutation path. Mirrors the
 * `pureSeatsLayer` pattern in convex/model/seats.ts.
 */
const pureCloudActionsLayer: Layer.Layer<CloudActionsService> =
  CloudActionsService.Default.pipe(
    Layer.provide(
      Layer.succeed(AutumnClient, {
        checkSeats: () =>
          Effect.die("AutumnClient must not be called in a mutation"),
        attach: () =>
          Effect.die("AutumnClient must not be called in a mutation"),
        trackSeats: () =>
          Effect.die("AutumnClient must not be called in a mutation"),
        trackUsage: () =>
          Effect.die("AutumnClient must not be called in a mutation"),
        checkUsage: () =>
          Effect.die("AutumnClient must not be called in a mutation"),
      }),
    ),
  );

/** Apply the pure +1 aggregation rule via the Effect service (no Autumn). */
function nextPendingCount(current: number): Promise<number> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CloudActionsService;
      return svc.nextPendingCount(current);
    }).pipe(Effect.provide(pureCloudActionsLayer)),
  );
}

/**
 * Increment a workspace's pending cloud-actions counter by one. Call from EVERY
 * billable CLOUD mutation (cell writes, structural inserts/deletes) AFTER its
 * authz/validation passes, so only genuine cloud operations are counted.
 *
 * Reads the current pending (undefined → 0), applies the pure +1 rule, and
 * writes it back in the same mutation transaction (a cheap DB patch, no HTTP).
 */
export async function meterCloudAction(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const workspace = await ctx.db.get(workspaceId);
  if (workspace === null) return;
  const current = workspace.cloudActionsPending ?? 0;
  const next = await nextPendingCount(current);
  await ctx.db.patch(workspaceId, { cloudActionsPending: next });
}
