/**
 * Cloud-actions metering domain logic for the Convex cloud tier (C26).
 *
 * HARD RULE: this meter counts CLOUD-project operations ONLY. LOCAL projects run
 * entirely on the user's machine (sidecar + local SQLite, packages/server +
 * packages/engine) and NEVER touch Convex or our cost, so they are inherently
 * excluded — there is deliberately NO metering anywhere on the local path, on
 * ANY tier (free included). Local is unlimited and unmetered, full stop.
 *
 * Because Convex mutations CANNOT make outbound HTTP, we cannot call Autumn from
 * the billable mutation itself. Instead each billable CLOUD mutation does a
 * cheap DB increment of a per-workspace pending counter
 * (`workspaces.cloudActionsPending`), and a scheduled internal ACTION
 * batch-flushes those pending counts to Autumn (`track`) — resetting a
 * workspace's pending to 0 ONLY after the track succeeds (fail-closed: a
 * transport error keeps the pending count for the next flush, so no usage is
 * lost or double-counted).
 *
 * This module is the PURE, unit-tested heart of that flow. Like the rest of
 * @gtmgrid/cloud it has NO Convex import: the "talk to Autumn" capability is the
 * {@link AutumnClient} port (defined alongside the seats gate in seats.ts and
 * extended with `trackUsage` / `checkUsage`). The Convex layer
 * (convex/model/usage.ts) provides it from the real `autumn-js` SDK; tests
 * provide a deterministic in-memory fake. Mirrors the seats seam exactly
 * (docs/effect-conventions.md): typed errors in the error channel, the external
 * dependency behind a `Context.Tag` port, the service as an `Effect.Service`.
 */

import { Effect } from "effect";
import { derivePaidPlanId, type PaidPlanId } from "./plans.js";
import { type AutumnError, AutumnClient } from "./seats.js";

/**
 * The Autumn feature id for the cloud-actions meter. CLOUD-project operations
 * (cell writes, structural inserts/deletes) consume one unit each; free caps at
 * 2000, team/business add metered overage. Single source of truth for the id —
 * lives next to {@link SEATS_FEATURE_ID} so both meter ids are declared in one
 * place.
 */
export const CLOUD_ACTIONS_FEATURE_ID = "cloud_actions" as const;

/**
 * A workspace's pending cloud-actions flush: the per-workspace count the meter
 * has accumulated in `workspaces.cloudActionsPending` since the last successful
 * flush. The flush ACTION reads these and tracks each to Autumn.
 */
export interface PendingWorkspace {
  /** The workspace id — also the Autumn customer id. */
  readonly workspaceId: string;
  /** Units accumulated since the last successful flush (always > 0 here). */
  readonly pending: number;
}

/**
 * The outcome of flushing a single workspace's pending cloud-actions:
 *
 * - `flushed: true`  — Autumn `track` succeeded; the caller MUST reset that
 *   workspace's pending counter to 0 (only now — never before the track lands).
 * - `flushed: false` — the track FAILED (`error` carries the typed
 *   {@link AutumnError}); the caller MUST keep the pending count for retry on
 *   the next flush (fail-closed; no usage lost, none double-counted).
 *
 * `usage` (when present) is the live `{ used, limit }` Autumn reported AFTER the
 * track, which the caller stores on the workspace so the `me` query can surface
 * it with no HTTP.
 *
 * `planId` (C27) is the workspace's active PAID plan id (or `null` for the free
 * tier), read from the same flush so the caller can cache the current plan on
 * the workspace for the `me` query / plan badge — again with no HTTP from the
 * query.
 */
export type FlushResult =
  | {
      readonly workspaceId: string;
      readonly flushed: true;
      readonly tracked: number;
      readonly usage: { readonly used: number; readonly limit: number | null };
      readonly planId: PaidPlanId | null;
    }
  | {
      readonly workspaceId: string;
      readonly flushed: false;
      readonly error: AutumnError;
    };

/**
 * Cloud-actions metering service. Two responsibilities, both PURE of Convex:
 *
 *   1. {@link CloudActionsService.nextPendingCount} — the aggregation rule the
 *      billable mutation uses to bump the per-workspace pending counter by one
 *      (kept here so "+1 per billable CLOUD op" has a single tested home).
 *   2. {@link CloudActionsService.flushWorkspace} — track a workspace's pending
 *      count to Autumn, then read back its live usage. Returns a
 *      {@link FlushResult} telling the Convex action whether to reset the
 *      pending counter (success) or keep it (failure → retry). It NEVER throws
 *      on a transport error: it captures it so a single bad workspace can't
 *      abort the whole batch and lose other workspaces' resets.
 */
export class CloudActionsService extends Effect.Service<CloudActionsService>()(
  "CloudActionsService",
  {
    effect: Effect.gen(function* () {
      const autumn = yield* AutumnClient;

      /**
       * The pending count after `by` more billable CLOUD actions (default 1).
       * Each billable mutation calls this with the workspace's current pending (0
       * when the field is unset) and writes the result back — single-op writes
       * pass no `by` (+1); a batch (e.g. CSV import of N rows) passes `by = N` so
       * one DB write covers the whole batch. A pure function so the "one unit per
       * billable op" rule is tested independently of Convex.
       */
      const nextPendingCount = (current: number, by = 1): number =>
        current + Math.max(0, by);

      /**
       * Flush ONE workspace's pending cloud-actions to Autumn and read back its
       * live usage.
       *
       * Tracks `pending` units under `cloud_actions`, then reads the live
       * `{ used, limit }`. On success returns `{ flushed: true, tracked, usage }`
       * (caller resets pending to 0 and stores usage). On an Autumn transport
       * error returns `{ flushed: false, error }` (caller keeps pending for
       * retry) — the failure is CAPTURED, not raised, so flushing the rest of
       * the batch still proceeds (fail-closed per workspace).
       */
      const flushWorkspace = (
        ws: PendingWorkspace,
      ): Effect.Effect<FlushResult> =>
        autumn
          .trackUsage({
            customerId: ws.workspaceId,
            featureId: CLOUD_ACTIONS_FEATURE_ID,
            value: ws.pending,
          })
          .pipe(
            // Only after the track lands do we read usage; if the read fails too
            // we still treat the flush as failed and keep the pending count.
            Effect.zipRight(
              autumn.checkUsage({
                customerId: ws.workspaceId,
                featureId: CLOUD_ACTIONS_FEATURE_ID,
              }),
            ),
            // Read the active paid plan (C27) in the same successful flush so the
            // caller can cache it for the `me` query. A plan-read failure does
            // NOT fail the flush (usage already tracked) — it falls back to null,
            // and the next flush re-reads it.
            Effect.zip(
              autumn
                .getActivePlanIds({ customerId: ws.workspaceId })
                .pipe(
                  Effect.map(derivePaidPlanId),
                  Effect.catchAll(() => Effect.succeed(null)),
                ),
            ),
            Effect.map(
              ([usage, planId]): FlushResult => ({
                workspaceId: ws.workspaceId,
                flushed: true,
                tracked: ws.pending,
                usage,
                planId,
              }),
            ),
            // Capture a transport failure as a fail-closed FlushResult instead
            // of failing the effect, so one workspace can't abort the batch.
            Effect.catchAll((error) =>
              Effect.succeed<FlushResult>({
                workspaceId: ws.workspaceId,
                flushed: false,
                error,
              }),
            ),
          );

      /**
       * Flush a batch of workspaces (those with pending > 0). Each is flushed
       * independently — a failing workspace yields a `flushed: false` result but
       * does not stop the others — so the action can reset only the successes.
       */
      const flushBatch = (
        workspaces: readonly PendingWorkspace[],
      ): Effect.Effect<readonly FlushResult[]> =>
        Effect.forEach(workspaces, flushWorkspace);

      return { nextPendingCount, flushWorkspace, flushBatch } as const;
    }),
    dependencies: [],
  },
) {}
