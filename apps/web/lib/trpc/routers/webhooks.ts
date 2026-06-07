/**
 * The `webhooks` tRPC router — the member-gated webhook CONFIG CRUD surface
 * (the desktop webhook panel). Ports the public queries/mutations of
 * `convex/webhooks.ts`; the headless WORKER paths are NOT here — they live behind
 * the worker-secret bearer at `apps/web/app/api/worker/**`, not the tRPC API.
 *
 * Each procedure runs a `WebhookService` Effect via {@link runEffect}; the
 * service resolves the owning workspace from the parent doc and asserts
 * membership, so authz is enforced inside the Effect (the typed authz failures
 * map to UNAUTHORIZED / FORBIDDEN). NOT metered — config is metadata.
 *
 * `listDeliveriesPaged` uses Drizzle KEYSET pagination: pass the prior page's
 * `nextCursor` back as `cursor` to fetch the next page (newest first).
 */

import { WebhookService } from "@gtmgrid/services";
import { Effect } from "effect";
import { z } from "zod";
import { protectedProcedure, router, runEffect } from "../trpc";

/** A single field-mapping entry: a JSON path -> the target column id. */
const mappingEntry = z.object({
  path: z.string(),
  columnId: z.string().min(1),
});

/** The keyset cursor returned by a prior `listDeliveriesPaged` page. */
const deliveryCursor = z.object({
  receivedAt: z.number(),
  id: z.string().min(1),
});

export const webhooksRouter = router({
  /** Webhooks bound to a table (newest first). Members-only. */
  listWebhooks: protectedProcedure
    .input(z.object({ tableId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          return yield* svc.listWebhooks(input.tableId);
        }),
      ),
    ),

  /** Create a webhook bound to a table (mints token + secret). Members-only. */
  createWebhook: protectedProcedure
    .input(
      z.object({
        tableId: z.string().min(1),
        name: z.string().nullish(),
        mapping: z.array(mappingEntry).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          return yield* svc.createWebhook({
            tableId: input.tableId,
            name: input.name ?? null,
            mapping: input.mapping,
          });
        }),
      ),
    ),

  /** Patch receive behaviour — autoRun, mode, upsertKey. Members-only. */
  updateWebhookConfig: protectedProcedure
    .input(
      z.object({
        webhookId: z.string().min(1),
        autoRun: z.boolean().optional(),
        mode: z.enum(["create", "upsert"]).optional(),
        upsertKey: z.string().nullish(),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          yield* svc.updateWebhookConfig({
            webhookId: input.webhookId,
            ...(input.autoRun !== undefined ? { autoRun: input.autoRun } : {}),
            ...(input.mode !== undefined ? { mode: input.mode } : {}),
            ...(input.upsertKey !== undefined
              ? { upsertKey: input.upsertKey }
              : {}),
          });
          return { ok: true as const };
        }),
      ),
    ),

  /** Replace a webhook's field mapping. Members-only. */
  updateWebhookMapping: protectedProcedure
    .input(
      z.object({
        webhookId: z.string().min(1),
        mapping: z.array(mappingEntry),
      }),
    )
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          yield* svc.updateWebhookMapping({
            webhookId: input.webhookId,
            mapping: input.mapping,
          });
          return { ok: true as const };
        }),
      ),
    ),

  /** Enable/disable a webhook. Members-only. */
  toggleEnabled: protectedProcedure
    .input(z.object({ webhookId: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          yield* svc.toggleEnabled({
            webhookId: input.webhookId,
            enabled: input.enabled,
          });
          return { ok: true as const };
        }),
      ),
    ),

  /** Rotate a webhook's token + signing secret. Members-only. */
  rotateSecret: protectedProcedure
    .input(z.object({ webhookId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          return yield* svc.rotateSecret(input.webhookId);
        }),
      ),
    ),

  /** A KEYSET page of a webhook's deliveries (newest first). Members-only. */
  listDeliveriesPaged: protectedProcedure
    .input(
      z.object({
        webhookId: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: deliveryCursor.nullish(),
      }),
    )
    .query(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          return yield* svc.listDeliveriesPaged({
            webhookId: input.webhookId,
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            cursor: input.cursor ?? null,
          });
        }),
      ),
    ),

  /** Delete a webhook. Members-only. */
  deleteWebhook: protectedProcedure
    .input(z.object({ webhookId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      runEffect(
        ctx.runtime,
        Effect.gen(function* () {
          const svc = yield* WebhookService;
          yield* svc.deleteWebhook(input.webhookId);
          return { ok: true as const };
        }),
      ),
    ),
});
