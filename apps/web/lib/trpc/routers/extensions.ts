/**
 * The `extensions` tRPC router — the member-gated connector-extension surface.
 * Ports `convex/extensions.ts`:
 *   - `listExtensions` — a workspace's installed extensions (members-only).
 *   - `saveExtension` — UPSERT a manifest by (workspaceId, extensionId).
 *
 * Each procedure runs an `ExtensionService` Effect via {@link runEffect}; the
 * service asserts membership before any read/write.
 */

import { ExtensionService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { protectedProcedure, router, runEffect } from "../trpc";

export const extensionsRouter = router({
  /** A workspace's installed extensions. Members-only. */
  listExtensions: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ExtensionService;
          return yield* svc.listExtensions(input.workspaceId);
        }),
      ),
    ),

  /** Install or update an extension manifest in place. Members-only. */
  saveExtension: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        extensionId: z.string().min(1),
        name: z.string(),
        category: z.string().nullish(),
        manifest: z.unknown(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* ExtensionService;
          return yield* svc.saveExtension({
            workspaceId: input.workspaceId,
            extensionId: input.extensionId,
            name: input.name,
            category: input.category ?? null,
            manifest: input.manifest,
          });
        }),
      ),
    ),
});
