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
 *     retention cap so a hot webhook's log stays bounded.
 *
 * Two Layers, like {@link WebhookRepo}: Drizzle-backed {@link WebhookDeliveryRepoLive}
 * and the in-memory {@link webhookDeliveryRepoLayer} for offline tests.
 */

import { schema } from "@gtmgrid/db";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
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
    /** All deliveries for a webhook, oldest first (the prune source). */
    readonly listByWebhookOldestFirst: (
      webhookId: string,
    ) => Effect.Effect<readonly WebhookDelivery[], WebhookDeliveryRepoError>;
    /** Delete a set of deliveries by id (the prune sink). */
    readonly deleteByIds: (
      ids: readonly string[],
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

      listByWebhookOldestFirst: (webhookId) =>
        !UUID_RE.test(webhookId)
          ? Effect.succeed([] as readonly WebhookDelivery[])
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(schema.webhookDeliveries)
                  .where(eq(schema.webhookDeliveries.webhookId, webhookId))
                  .orderBy(
                    asc(schema.webhookDeliveries.receivedAt),
                    asc(schema.webhookDeliveries.id),
                  );
                return rows.map(rowToDelivery);
              },
              catch: failDelivery("delivery prune-scan failed"),
            }),

      deleteByIds: (ids) =>
        ids.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                for (const id of ids) {
                  await db
                    .delete(schema.webhookDeliveries)
                    .where(eq(schema.webhookDeliveries.id, id));
                }
              },
              catch: failDelivery("delivery prune-delete failed"),
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
    listByWebhookOldestFirst: (webhookId) =>
      Effect.sync(() =>
        deliveries
          .filter((d) => d.webhookId === webhookId)
          .sort(
            (a, b) =>
              a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          ),
      ),
    deleteByIds: (ids) =>
      Effect.sync(() => {
        for (const id of ids) {
          const idx = deliveries.findIndex((d) => d.id === id);
          if (idx >= 0) deliveries.splice(idx, 1);
        }
      }),
  });
};
