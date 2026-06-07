/**
 * `RealtimePublisher` — the INJECTABLE port that broadcasts grid change events to
 * connected clients, the server side of the Convex `useQuery` live-reactivity
 * replacement (TRI-3251).
 *
 * After a successful grid write, `GridService` calls {@link RealtimePublisher}'s
 * `publish` with the owning workspace + table + a typed {@link GridChangeEvent}.
 * Every other client subscribed to that table's channel receives the event and
 * applies it to its cached snapshot via the pure reducer (`realtime/reducer.ts`),
 * so the grid stays live with NO refetch and NO Postgres-Changes/CDC.
 *
 * Two Layers, the same pattern as {@link MeterService}:
 *   - {@link RealtimePublisherLive} — publishes over Supabase Realtime
 *     **Broadcast** on the per-workspace/per-table channel
 *     (`grid:{workspaceId}:{tableId}`). Best-effort: a transport error is
 *     swallowed so a realtime hiccup never fails the user's grid write (the write
 *     already succeeded; tRPC reads remain the source of truth).
 *   - {@link recordingRealtimePublisherLayer} — the TEST Layer that RECORDS every
 *     published event into a shared array, so `GridService` mutations can be
 *     unit-tested offline (assert "this write published this event") with no
 *     Supabase, no network, no DB.
 *
 * Making the publisher a port (not a direct Supabase call inside the service)
 * keeps `GridService` fully offline-testable and lets the transport be swapped
 * (e.g. fallback option (b), a CRDT provider) without touching the service.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Context, Data, Effect, Layer } from "effect";
import { type GridChangeEvent, GRID_EVENT_NAME, gridChannelName } from "../realtime/events.js";

/** Raised when a publish fails (Supabase transport/config error). */
export class RealtimePublisherError extends Data.TaggedError(
  "RealtimePublisherError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A published-event record the TEST Layer captures, carrying the routing keys so
 * a test can assert BOTH the channel scope and the payload.
 */
export interface RecordedGridEvent {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly event: GridChangeEvent;
}

/** The realtime broadcast port the grid mutations publish through. */
export class RealtimePublisher extends Context.Tag("RealtimePublisher")<
  RealtimePublisher,
  {
    /**
     * Broadcast a grid change event on the workspace+table channel. Call AFTER a
     * successful write; the live implementation is best-effort and never fails
     * the surrounding write.
     */
    readonly publish: (args: {
      readonly workspaceId: string;
      readonly tableId: string;
      readonly event: GridChangeEvent;
    }) => Effect.Effect<void, RealtimePublisherError>;
  }
>() {}

/** Config for {@link RealtimePublisherLive}: the Supabase project URL + key. */
export interface RealtimePublisherConfig {
  /** Supabase project URL (e.g. `https://xyz.supabase.co`). */
  readonly url: string;
  /**
   * The key the SERVER publishes under. The service role key is appropriate here
   * (server-side, trusted) so broadcasts are not gated by client auth/RLS.
   */
  readonly key: string;
}

/**
 * Resolve the live config from the environment. Returns `null` when either var
 * is missing, so {@link realtimePublisherLayerFromEnv} can degrade to a no-op
 * publisher rather than crash a deployment that has not wired Supabase yet.
 */
export const realtimePublisherConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): RealtimePublisherConfig | null => {
  const url = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
};

/**
 * The live publisher. Lazily creates ONE Supabase client and sends each event as
 * a Broadcast message on the table's channel. `send` is best-effort: any rejection
 * is mapped to a typed error which the grid service ignores, so realtime never
 * blocks a write.
 */
export const realtimePublisherLayer = (
  config: RealtimePublisherConfig,
): Layer.Layer<RealtimePublisher> =>
  Layer.sync(RealtimePublisher, () => {
    const client: SupabaseClient = createClient(config.url, config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return {
      publish: (args) =>
        Effect.tryPromise({
          try: async () => {
            const channel = client.channel(
              gridChannelName(args.workspaceId, args.tableId),
            );
            await channel.send({
              type: "broadcast",
              event: GRID_EVENT_NAME,
              payload: args.event,
            });
            await client.removeChannel(channel);
          },
          catch: (cause) =>
            new RealtimePublisherError({
              message:
                cause instanceof Error ? cause.message : "realtime publish failed",
              cause,
            }),
        }),
    };
  });

/**
 * A no-op publisher — the deployment-safe fallback when Supabase is not
 * configured (env vars absent). Swallows every event so grid writes still
 * succeed with no realtime fan-out.
 */
export const noopRealtimePublisherLayer = (): Layer.Layer<RealtimePublisher> =>
  Layer.succeed(RealtimePublisher, { publish: () => Effect.void });

/**
 * The LIVE publisher resolved from the environment, degrading to the no-op layer
 * when Supabase is not configured. This is what {@link appLayer} wires.
 */
export const realtimePublisherLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
): Layer.Layer<RealtimePublisher> => {
  const config = realtimePublisherConfigFromEnv(env);
  return config ? realtimePublisherLayer(config) : noopRealtimePublisherLayer();
};

/**
 * The TEST Layer: RECORDS each published event into the supplied array (shared by
 * reference, so a test reads it back after running grid mutations) instead of
 * touching Supabase. This is how `GridService` mutations are unit-tested offline.
 */
export const recordingRealtimePublisherLayer = (
  recorded: RecordedGridEvent[] = [],
): Layer.Layer<RealtimePublisher> =>
  Layer.succeed(RealtimePublisher, {
    publish: (args) =>
      Effect.sync(() => {
        recorded.push({
          workspaceId: args.workspaceId,
          tableId: args.tableId,
          event: args.event,
        });
      }),
  });
