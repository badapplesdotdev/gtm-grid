/**
 * Convex ↔ Effect bridge for the CLOUD-actions meter flush (C26).
 *
 * The metering business rules live as a PURE Effect service in `@gtmgrid/cloud`
 * (packages/cloud/src/cloud-actions.ts): `CloudActionsService.flushBatch` tracks
 * each workspace's pending count to Autumn and reads back its live usage,
 * talking to Autumn through the `AutumnClient` port. This file is the seam that
 * builds an {@link AutumnClient} Layer from the REAL `autumn-js` SDK (reusing the
 * one in convex/model/seats.ts) and runs the service via `Effect.runPromise`.
 *
 * These calls make outbound HTTP to Autumn, so they run from a Convex ACTION
 * (convex/usage.ts `flushCloudActions`, scheduled by convex/crons.ts) — NEVER
 * from a query/mutation. The billable CLOUD mutations only do a cheap DB
 * increment of `workspaces.cloudActionsPending`; this is where that pending
 * count is converted into Autumn usage.
 *
 * HARD RULE: this is the CLOUD path. LOCAL operations never reach a Convex
 * mutation, never increment the pending counter, and so are never flushed here —
 * local is unlimited and unmetered on every tier.
 */

import {
  CloudActionsService,
  type FlushResult,
  type PendingWorkspace,
} from "@gtmgrid/cloud";
import { Effect, Layer } from "effect";
import { autumnClientLayer, autumnSdk } from "./seats.js";

/** The composed Layer: CloudActionsService provided the real AutumnClient. */
const cloudActionsLayer = (
  client: ReturnType<typeof autumnSdk>,
): Layer.Layer<CloudActionsService> =>
  CloudActionsService.Default.pipe(Layer.provide(autumnClientLayer(client)));

/**
 * Flush a batch of workspaces' pending cloud-actions to Autumn, returning one
 * {@link FlushResult} per workspace. Never throws on a single workspace's Autumn
 * failure — that workspace's result is `flushed: false` (the action keeps its
 * pending count for retry); successes carry the live usage snapshot the action
 * stores on the workspace for the `me` query.
 *
 * `customerId` is the workspace id (the Autumn customer IS the workspace).
 */
export function flushCloudActions(
  workspaces: readonly PendingWorkspace[],
): Promise<readonly FlushResult[]> {
  const client = autumnSdk();
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* CloudActionsService;
      return yield* svc.flushBatch(workspaces);
    }).pipe(Effect.provide(cloudActionsLayer(client))),
  );
}
