/**
 * `WebhookDeliveryRepo` — the Effect <-> Drizzle adapter for the per-webhook
 * delivery log (`webhook_deliveries`).
 *
 * Owns three operations the webhook surface needs:
 *   - {@link WebhookDeliveryRepo.insert} — record ONE delivery atomically with the
 *     row write (the worker path).
 *   - {@link WebhookDeliveryRepo.listKeysetByWebhook} — KEYSET (seek) pagination
 *     for the desktop "Recent deliveries" panel, replacing the Convex
 *     `paginationOptsValidator` cursor with a `(receivedAt, id)` seek so paging is
 *     index-friendly and stable under inserts.
 *   - {@link WebhookDeliveryRepo.pruneOldest} — drop the oldest surplus past a
 *     retention cap in ONE set-based DELETE so a hot webhook's log stays bounded
 *     without a fetch-all/slice/per-row-delete round-trip per record.
 *
 * Two Layers, like {@link WebhookRepo}: Drizzle-backed {@link WebhookDeliveryRepoLive}
 * and the in-memory {@link webhookDeliveryRepoLayer} for offline tests.
 */

import { schema } from "@gtmgrid/db";
import { and, desc, eq, lt, notInArray, or } from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { DbClient } from "../db-client.js";

/** Receive behaviour the delivery was logged under. */
export type DeliveryMode = "create" | "upsert";

/** A delivery-log row projection. Mirrors `webhook_deliveries`. */
export interface WebhookDelivery {
  readonly id: string;
  readonly workspaceId: string;
  readonly webhookId: string;
  readonly tableId: string;
  readonly status: number;
  readonly rowsAffected: number;
  readonly mode: DeliveryMode;
  readonly recordId: string | null;
  readonly error: string | null;
  readonly receivedAt: number;
}

/** Fields a delivery insert supplies. */
export interface WebhookDeliveryInsert {
  readonly workspaceId: string;
  readonly webhookId: string;
  readonly tableId: string;
  readonly status: number;
  readonly rowsAffected: number;
  readonly mode: DeliveryMode;
  readonly recordId: string | null;
  readonly error: string | null;
  readonly receivedAt: number;
}

/**
 * A keyset cursor: the (receivedAt, id) of the LAST row of the previous page.
 * Pages are ordered newest-first, so the next page is the rows strictly
 * "older than" this cursor. `null` requests the first page.
 */
export interface DeliveryCursor {
  readonly receivedAt: number;
  readonly id: string;
}

/** One page of deliveries plus the cursor to fetch the next page (or `null`). */
export interface DeliveryPage {
  readonly items: readonly WebhookDelivery[];
  readonly nextCursor: DeliveryCursor | null;
}

/** Raised when a delivery read/write fails (DB/transport error). */
export class WebhookDeliveryRepoError extends Data.TaggedError(
  "WebhookDeliveryRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Reads/writes the `webhook_deliveries` table. Backed by Drizzle in production
 * ({@link WebhookDeliveryRepoLive}); by an in-memory array in tests
 * ({@link webhookDeliveryRepoLayer}).
 */
export class WebhookDeliveryRepo extends Context.Tag("WebhookDeliveryRepo")<
  WebhookDeliveryRepo,
  {
    /** Insert one delivery, returning its id. */
    readonly insert: (
      values: WebhookDeliveryInsert,
    ) => Effect.Effect<string, WebhookDeliveryRepoError>;
    /**
     * One KEYSET page of a webhook's deliveries, newest first. `limit` rows are
     * fetched after the optional `cursor` (the last row of the prior page); the
     * returned `nextCursor` is `null` when the page is the last.
     */
    readonly listKeysetByWebhook: (args: {
      readonly webhookId: string;
      readonly limit: number;
      readonly cursor: DeliveryCursor | null;
    }) => Effect.Effect<DeliveryPage, WebhookDeliveryRepoError>;
    /**
     * Prune a webhook's delivery log down to its `retain` newest rows in ONE
     * set-based statement: delete every row of the webhook whose id is NOT among
     * the `retain` most-recent `(receivedAt DESC, id DESC)` ids. Idempotent — a
     * log already at or under the cap deletes nothing.
     */
    readonly pruneOldest: (
      webhookId: string,
      retain: number,
    ) => Effect.Effect<void, WebhookDeliveryRepoError>;
  }
>() {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const failDelivery = (message: string) => (cause: unknown) =>
  new WebhookDeliveryRepoError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  });

const rowToDelivery = (r: {
  id: string;
  workspaceId: string;
  webhookId: string;
  tableId: string;
  status: number;
  rowsAffected: number;
  mode: DeliveryMode;
  recordId: string | null;
  error: string | null;
  receivedAt: number;
}): WebhookDelivery => r;

/**
 * The Drizzle-backed Layer. Keyset paging orders by `(receivedAt DESC, id DESC)`
 * and seeks strictly past the cursor with
 * `receivedAt < c.receivedAt OR (receivedAt = c.receivedAt AND id < c.id)`, so a
 * tie on `receivedAt` still pages deterministically by id.
 */
export const WebhookDeliveryRepoLive: Layer.Layer<
  WebhookDeliveryRepo,
  never,
  DbClient
> = Layer.effect(
  WebhookDeliveryRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return {
      insert: (values) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .insert(schema.webhookDeliveries)
              .values(values)
              .returning({ id: schema.webhookDeliveries.id });
            const id = rows[0]?.id;
            if (id === undefined) {
              throw new Error("delivery insert returned no id");
            }
            return id;
          },
          catch: failDelivery("delivery insert failed"),
        }),

      listKeysetByWebhook: ({ webhookId, limit, cursor }) =>
        !UUID_RE.test(webhookId)
          ? Effect.succeed<DeliveryPage>({ items: [], nextCursor: null })
          : Effect.tryPromise({
              try: async () => {
                const base = eq(schema.webhookDeliveries.webhookId, webhookId);
                const seek =
                  cursor === null
                    ? base
                    : and(
                        base,
                        or(
                          lt(
                            schema.webhookDeliveries.receivedAt,
                            cursor.receivedAt,
                          ),
                          and(
                            eq(
                              schema.webhookDeliveries.receivedAt,
                              cursor.receivedAt,
                            ),
                            lt(schema.webhookDeliveries.id, cursor.id),
                          ),
                        ),
                      );
                // Fetch one extra to decide whether a next page exists.
                const rows = await db
                  .select()
                  .from(schema.webhookDeliveries)
                  .where(seek)
                  .orderBy(
                    desc(schema.webhookDeliveries.receivedAt),
                    desc(schema.webhookDeliveries.id),
                  )
                  .limit(limit + 1);
                const hasMore = rows.length > limit;
                const page = (hasMore ? rows.slice(0, limit) : rows).map(
                  rowToDelivery,
                );
                const last = page[page.length - 1];
                return {
                  items: page,
                  nextCursor:
                    hasMore && last !== undefined
                      ? { receivedAt: last.receivedAt, id: last.id }
                      : null,
                };
              },
              catch: failDelivery("delivery page failed"),
            }),

      pruneOldest: (webhookId, retain) =>
        !UUID_RE.test(webhookId) || retain < 0
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                // The ids to KEEP: the `retain` newest rows of this webhook,
                // ordered the same way the panel pages them
                // `(receivedAt DESC, id DESC)`. A single DELETE then removes
                // every other row of the webhook in one set-based statement —
                // no fetch-all / slice / per-row delete round-trips.
                const keep = db
                  .select({ id: schema.webhookDeliveries.id })
                  .from(schema.webhookDeliveries)
                  .where(eq(schema.webhookDeliveries.webhookId, webhookId))
                  .orderBy(
                    desc(schema.webhookDeliveries.receivedAt),
                    desc(schema.webhookDeliveries.id),
                  )
                  .limit(retain);
                await db
                  .delete(schema.webhookDeliveries)
                  .where(
                    and(
                      eq(schema.webhookDeliveries.webhookId, webhookId),
                      notInArray(schema.webhookDeliveries.id, keep),
                    ),
                  );
              },
              catch: failDelivery("delivery prune failed"),
            }),
    };
  }),
);

/**
 * In-memory Layer over a MUTABLE delivery array, so a test can record deliveries
 * and observe the prune shrink the array — the same observable behaviour as the
 * Drizzle path with NO live database. Keyset paging applies the same
 * `(receivedAt DESC, id DESC)` order + seek-past-cursor rule in JS.
 */
export const webhookDeliveryRepoLayer = (
  deliveries: WebhookDelivery[] = [],
): Layer.Layer<WebhookDeliveryRepo> => {
  let seq = 0;
  return Layer.succeed(WebhookDeliveryRepo, {
    insert: (values) =>
      Effect.sync(() => {
        const id = `delivery_${++seq}`;
        deliveries.push({ ...values, id });
        return id;
      }),
    listKeysetByWebhook: ({ webhookId, limit, cursor }) =>
      Effect.sync(() => {
        const sorted = deliveries
          .filter((d) => d.webhookId === webhookId)
          .sort(
            (a, b) =>
              b.receivedAt - a.receivedAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
          );
        const past =
          cursor === null
            ? sorted
            : sorted.filter(
                (d) =>
                  d.receivedAt < cursor.receivedAt ||
                  (d.receivedAt === cursor.receivedAt && d.id < cursor.id),
              );
        const page = past.slice(0, limit);
        const hasMore = past.length > limit;
        const last = page[page.length - 1];
        return {
          items: page,
          nextCursor:
            hasMore && last !== undefined
              ? { receivedAt: last.receivedAt, id: last.id }
              : null,
        };
      }),
    pruneOldest: (webhookId, retain) =>
      Effect.sync(() => {
        if (retain < 0) return;
        // Mirror the Drizzle set-based DELETE: keep the `retain` newest rows of
        // this webhook `(receivedAt DESC, id DESC)`, drop every older one in
        // place so a test observes the array shrink to the cap.
        const keep = new Set(
          deliveries
            .filter((d) => d.webhookId === webhookId)
            .sort(
              (a, b) =>
                b.receivedAt - a.receivedAt ||
                (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
            )
            .slice(0, retain)
            .map((d) => d.id),
        );
        for (let i = deliveries.length - 1; i >= 0; i--) {
          const d = deliveries[i];
          if (d.webhookId === webhookId && !keep.has(d.id)) {
            deliveries.splice(i, 1);
          }
        }
      }),
  });
};
