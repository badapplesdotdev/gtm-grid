/**
 * `share` router — the "share a table via URL" API surface.
 *
 * Built on the same Effect-DI seam as every other router: each procedure
 * resolves {@link ShareService} from the request runtime and runs an Effect via
 * {@link runEffect}.
 *
 * Auth model:
 *   - `getByToken` is PUBLIC (the token IS the capability) so the `/share/<token>`
 *     page can render the frozen snapshot with no sign-in.
 *   - `create` / `listByTable` / `revoke` are authenticated; the SERVICE resolves
 *     the owning workspace from the table/share and asserts membership (and, for
 *     create, cloud access via `GridService.getTable`).
 *   - `clone` resolves the snapshot by token SERVER-SIDE (so a client can't forge
 *     a snapshot to bypass metering/size limits) and rebuilds it into the
 *     caller's target project, metered in the caller's workspace.
 */

import { ShareNotFoundError, ShareService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router, runEffect } from "../trpc";

export const shareRouter = router({
  /**
   * PUBLIC preview of a share token (no auth). Returns `{ valid:false }` for an
   * unknown / disabled / expired token, else the frozen snapshot to render.
   */
  getByToken: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ShareService;
          return yield* svc.getShareByToken(input.token);
        }),
      ),
    ),

  /**
   * Freeze a table into a snapshot + mint a public link. Member + cloud-access
   * gated inside the service (via `GridService.getTable`).
   */
  create: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        name: z.string().max(200).optional(),
        /** Optional epoch-ms expiry; omit/null for a link that never expires. */
        expiresAt: z.number().int().positive().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ShareService;
          return yield* svc.createShare({
            tableId: input.tableId,
            name: input.name ?? null,
            expiresAt: input.expiresAt ?? null,
          });
        }),
      ),
    ),

  /** A table's share links (member-gated), without the heavy snapshot payload. */
  listByTable: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ShareService;
          return yield* svc.listShares(input.tableId);
        }),
      ),
    ),

  /** Disable a share link (member-gated). The token stops working immediately. */
  revoke: protectedProcedure
    .input(z.object({ shareId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ShareService;
          yield* svc.revokeShare(input.shareId);
          return null;
        }),
      ),
    ),

  /**
   * Clone a shared table into the caller's project. The snapshot is resolved
   * from the token server-side (rejecting an invalid/expired link), then rebuilt
   * via the grid build path (metered in the caller's workspace).
   */
  clone: protectedProcedure
    .input(
      z.object({
        token: z.string().min(1),
        targetProjectId: z.string().min(1),
        includeData: z.boolean().default(true),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ShareService;
          const preview = yield* svc.getShareByToken(input.token);
          if (!preview.valid) {
            return yield* Effect.fail(
              new ShareNotFoundError({
                message: "This share link is no longer valid.",
              }),
            );
          }
          return yield* svc.cloneFromSnapshot({
            snapshot: preview.snapshot,
            targetProjectId: input.targetProjectId,
            includeData: input.includeData,
          });
        }),
      ),
    ),
});
