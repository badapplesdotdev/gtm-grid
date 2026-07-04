/**
 * The `presence` tRPC router — one authenticated heartbeat mutation.
 *
 * The desktop app pings this on window focus + a slow interval (see
 * packages/desktop `usePresenceHeartbeat`) so `users.last_active_at` tracks
 * "actually using the app", not merely "holds a session". The lifecycle email
 * system reads it two ways:
 *   - "app currently open"  → last_active_at within ~5 min (suppress the
 *     run-finished / new-signals emails while the user is looking at the grid),
 *   - "dormant"             → last_active_at older than 7 days (re-engagement).
 *
 * Deliberately tiny and fire-and-forget: one indexed UPDATE by primary key, no
 * response payload the client waits on.
 */

import { LifecycleEmailRepo } from "@gtmgrid/services";
import { Effect } from "effect";
import { protectedProcedure, router, runEffect } from "../trpc";

export const presenceRouter = router({
  /** Bump `users.last_active_at` to now for the signed-in user. */
  heartbeat: protectedProcedure.mutation(({ ctx }) =>
    runEffect(
      ctx.runtime,
      Effect.flatMap(LifecycleEmailRepo, (r) => r.touchLastActive(ctx.userId)),
    ),
  ),
});
